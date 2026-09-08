/**
 * Ledger rollups and dashboards (PRD 5.9).
 *
 * `usage_events` is the source of truth and is append-only. Everything here is a
 * read model over it; nothing in this module writes.
 *
 * Conventions used throughout:
 *
 * - **Cost per event** is `coalesce(gateway_cost_usd, cost_usd)` — the PRD says
 *   to prefer the gateway's figure when it reported one. `lib/services/ledger`
 *   already writes `cost_usd` that way (gateway when present, else the figure in
 *   `computed_cost_usd`), so the coalesce is belt-and-braces rather than a second
 *   opinion; it also keeps these rollups correct for rows written before that
 *   convention existed.
 * - **Tokens** means billable tokens: `input + output`. Cached input tokens are
 *   already counted inside `input_tokens` by the gateway, and reasoning tokens
 *   inside `output_tokens`, so adding them again would double-count.
 * - **Week attribution** comes from the run's window (`windows.week_no`), not
 *   from `created_at`. A Monday-night run belongs to the week its window opened
 *   in. Events whose window has no week (draft, commissioner) are excluded from
 *   week-scoped queries and included in season totals.
 * - **Corrections** (`corrects_event_id`) are additive delta rows, so a plain
 *   SUM over every row is already the corrected total.
 */
import { and, desc, eq, isNotNull, sql, type SQL } from "drizzle-orm";

import { db, type DbOrTx } from "@/lib/db";
import {
  agentConfigs,
  budgetRollups,
  budgets,
  configVersions,
  leagueRules,
  runs,
  teamResults,
  teams,
  usageEvents,
  windows,
} from "@/lib/db/schema";
import { findModel } from "@/lib/models";

// ---------------------------------------------------------------- fragments

/** Gateway-reported cost when present, else the price-book computation. */
const eventUsd = sql<number>`coalesce(sum(coalesce(${usageEvents.gatewayCostUsd}, ${usageEvents.costUsd})), 0)::float8`;
const eventTokens = sql<number>`coalesce(sum(${usageEvents.inputTokens} + ${usageEvents.outputTokens}), 0)::int`;
const eventInputTokens = sql<number>`coalesce(sum(${usageEvents.inputTokens}), 0)::int`;
const eventOutputTokens = sql<number>`coalesce(sum(${usageEvents.outputTokens}), 0)::int`;
const eventCount = sql<number>`count(*)::int`;
const distinctRuns = sql<number>`count(distinct ${usageEvents.runId})::int`;

export type SpendTotals = {
  usd: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  runCount: number;
  stepCount: number;
};

const ZERO: SpendTotals = {
  usd: 0,
  tokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  runCount: 0,
  stepCount: 0,
};

const totalsSelection = {
  usd: eventUsd,
  tokens: eventTokens,
  inputTokens: eventInputTokens,
  outputTokens: eventOutputTokens,
  runCount: distinctRuns,
  stepCount: eventCount,
};

/** `usage_events` joined to its run's window — the only path to a week number. */
function eventsWithWeek(executor: DbOrTx) {
  return executor
    .select(totalsSelection)
    .from(usageEvents)
    .innerJoin(runs, eq(runs.id, usageEvents.runId))
    .innerJoin(windows, eq(windows.id, runs.windowId));
}

// -------------------------------------------------------------------- team

/** One team's spend inside one league week. */
export async function teamWeekSpend(
  teamId: string,
  weekNo: number,
  executor: DbOrTx = db,
): Promise<SpendTotals & { teamId: string; weekNo: number }> {
  const [row] = await eventsWithWeek(executor).where(
    and(eq(usageEvents.teamId, teamId), eq(windows.weekNo, weekNo)),
  );
  return { ...(row ?? ZERO), teamId, weekNo };
}

export type TeamSeasonSpend = SpendTotals & {
  teamId: string;
  byWeek: Array<SpendTotals & { weekNo: number }>;
};

/** Season-to-date spend for a team, plus the per-week breakdown. */
export async function teamSeasonSpend(
  teamId: string,
  executor: DbOrTx = db,
): Promise<TeamSeasonSpend> {
  const [total] = await executor
    .select(totalsSelection)
    .from(usageEvents)
    .where(eq(usageEvents.teamId, teamId));

  const weekly = await executor
    .select({ weekNo: windows.weekNo, ...totalsSelection })
    .from(usageEvents)
    .innerJoin(runs, eq(runs.id, usageEvents.runId))
    .innerJoin(windows, eq(windows.id, runs.windowId))
    .where(and(eq(usageEvents.teamId, teamId), isNotNull(windows.weekNo)))
    .groupBy(windows.weekNo)
    .orderBy(windows.weekNo);

  return {
    ...(total ?? ZERO),
    teamId,
    byWeek: weekly.map((w) => ({ ...w, weekNo: w.weekNo ?? 0 })),
  };
}

// ------------------------------------------------------------------ league

export type TeamSpendRow = SpendTotals & {
  teamId: string;
  teamName: string;
  abbreviation: string;
  ownerUserId: string | null;
  modelId: string | null;
};

/** Spend by team across the whole league season. Teams with no spend appear as zeroes. */
export async function leagueSpendByTeam(
  leagueId: string,
  executor: DbOrTx = db,
): Promise<TeamSpendRow[]> {
  const leagueTeams = await executor
    .select({
      id: teams.id,
      name: teams.name,
      abbreviation: teams.abbreviation,
      ownerUserId: teams.ownerUserId,
      modelId: configVersions.modelId,
    })
    .from(teams)
    .leftJoin(agentConfigs, eq(agentConfigs.teamId, teams.id))
    .leftJoin(configVersions, eq(configVersions.id, agentConfigs.currentVersionId))
    .where(eq(teams.leagueId, leagueId))
    .orderBy(teams.waiverPriority);

  const spend = await executor
    .select({ teamId: usageEvents.teamId, ...totalsSelection })
    .from(usageEvents)
    .where(and(eq(usageEvents.leagueId, leagueId), isNotNull(usageEvents.teamId)))
    .groupBy(usageEvents.teamId);

  const byTeam = new Map(spend.map((s) => [s.teamId as string, s]));

  return leagueTeams
    .map((t) => ({
      ...(byTeam.get(t.id) ?? ZERO),
      teamId: t.id,
      teamName: t.name,
      abbreviation: t.abbreviation,
      ownerUserId: t.ownerUserId,
      modelId: t.modelId ?? null,
    }))
    .sort((a, b) => b.usd - a.usd);
}

export type ModelSpendRow = SpendTotals & {
  modelId: string;
  provider: string;
  displayName: string;
};

/** Spend by gateway model across the league. */
export async function leagueSpendByModel(
  leagueId: string,
  executor: DbOrTx = db,
): Promise<ModelSpendRow[]> {
  const rows = await executor
    .select({ modelId: usageEvents.modelId, provider: usageEvents.provider, ...totalsSelection })
    .from(usageEvents)
    .where(eq(usageEvents.leagueId, leagueId))
    .groupBy(usageEvents.modelId, usageEvents.provider);

  return rows
    .map((r) => ({
      ...r,
      displayName: findModel(r.modelId)?.displayName ?? r.modelId,
    }))
    .sort((a, b) => b.usd - a.usd);
}

export type ExpensiveRun = {
  runId: string;
  teamId: string | null;
  teamName: string | null;
  modelId: string;
  status: string;
  outcome: string | null;
  windowLabel: string;
  windowType: string;
  weekNo: number | null;
  stepCount: number;
  costUsd: number;
  createdAt: Date;
};

/** The league's priciest runs, newest-cost-first, each linking to its trace. */
export async function mostExpensiveRuns(
  leagueId: string,
  limit = 10,
  executor: DbOrTx = db,
): Promise<ExpensiveRun[]> {
  const rows = await executor
    .select({
      runId: runs.id,
      teamId: runs.teamId,
      teamName: teams.name,
      modelId: runs.modelId,
      status: runs.status,
      outcome: runs.outcome,
      windowLabel: windows.label,
      windowType: windows.type,
      weekNo: windows.weekNo,
      stepCount: runs.stepCount,
      costUsd: runs.totalCostUsd,
      createdAt: runs.createdAt,
    })
    .from(runs)
    .innerJoin(windows, eq(windows.id, runs.windowId))
    .leftJoin(teams, eq(teams.id, runs.teamId))
    .where(eq(runs.leagueId, leagueId))
    .orderBy(desc(runs.totalCostUsd))
    .limit(limit);

  return rows.map((r) => ({ ...r, teamName: r.teamName ?? null }));
}

export type WeekSpendRow = SpendTotals & { weekNo: number };

/** Cost trend by league week. Windows with no week number are excluded. */
export async function costTrendByWeek(
  leagueId: string,
  executor: DbOrTx = db,
): Promise<WeekSpendRow[]> {
  const rows = await executor
    .select({ weekNo: windows.weekNo, ...totalsSelection })
    .from(usageEvents)
    .innerJoin(runs, eq(runs.id, usageEvents.runId))
    .innerJoin(windows, eq(windows.id, runs.windowId))
    .where(and(eq(usageEvents.leagueId, leagueId), isNotNull(windows.weekNo)))
    .groupBy(windows.weekNo)
    .orderBy(windows.weekNo);

  return rows.map((r) => ({ ...r, weekNo: r.weekNo ?? 0 }));
}

// ------------------------------------------------------- efficiency metrics

export type CostPerPoint = {
  teamId: string;
  usd: number;
  points: number;
  /** Null when the team has not scored yet — dividing by zero is not a metric. */
  costPerPoint: number | null;
};

/** Season spend ÷ season fantasy points scored (PRD 5.9, 5.12). */
export async function costPerPoint(
  teamId: string,
  executor: DbOrTx = db,
): Promise<CostPerPoint> {
  const [spend] = await executor
    .select({ usd: eventUsd })
    .from(usageEvents)
    .where(eq(usageEvents.teamId, teamId));

  const [scored] = await executor
    .select({ points: sql<number>`coalesce(sum(${teamResults.pointsFor}), 0)::float8` })
    .from(teamResults)
    .where(eq(teamResults.teamId, teamId));

  const usd = spend?.usd ?? 0;
  const points = scored?.points ?? 0;
  return { teamId, usd, points, costPerPoint: points > 0 ? usd / points : null };
}

export type CostPerWin = {
  teamId: string;
  usd: number;
  wins: number;
  losses: number;
  ties: number;
  costPerWin: number | null;
};

/** Season spend ÷ wins. Null for a winless team. */
export async function costPerWin(teamId: string, executor: DbOrTx = db): Promise<CostPerWin> {
  const [spend] = await executor
    .select({ usd: eventUsd })
    .from(usageEvents)
    .where(eq(usageEvents.teamId, teamId));

  const [record] = await executor
    .select({
      wins: sql<number>`coalesce(sum(case when ${teamResults.won} then 1 else 0 end), 0)::int`,
      losses: sql<number>`coalesce(sum(case when ${teamResults.lost} then 1 else 0 end), 0)::int`,
      ties: sql<number>`coalesce(sum(case when ${teamResults.tied} then 1 else 0 end), 0)::int`,
    })
    .from(teamResults)
    .where(eq(teamResults.teamId, teamId));

  const usd = spend?.usd ?? 0;
  const wins = record?.wins ?? 0;
  return {
    teamId,
    usd,
    wins,
    losses: record?.losses ?? 0,
    ties: record?.ties ?? 0,
    costPerWin: wins > 0 ? usd / wins : null,
  };
}

export type ModelBenchmarkRow = {
  modelId: string;
  displayName: string;
  provider: string;
  teamCount: number;
  teamIds: string[];
  usd: number;
  tokens: number;
  points: number;
  wins: number;
  /** The headline: fantasy points per dollar spent. Null when nothing was spent. */
  pointsPerUsd: number | null;
  costPerPoint: number | null;
  costPerWin: number | null;
};

/**
 * Cost-adjusted performance by model (PRD 5.9 "benchmark view").
 *
 * Attribution: a team is credited to ONE model — the model it ran most often
 * this season (`runs.model_id`, modal), falling back to the model on its current
 * config version when it has not run yet. A team that switched models mid-season
 * therefore lands entirely in one bucket; with a single league's `n` this is
 * noisy by construction, which is why the UI shows the team count next to it.
 */
export async function benchmarkByModel(
  leagueId: string,
  executor: DbOrTx = db,
): Promise<ModelBenchmarkRow[]> {
  const leagueTeams = await executor
    .select({
      id: teams.id,
      currentModelId: configVersions.modelId,
    })
    .from(teams)
    .leftJoin(agentConfigs, eq(agentConfigs.teamId, teams.id))
    .leftJoin(configVersions, eq(configVersions.id, agentConfigs.currentVersionId))
    .where(eq(teams.leagueId, leagueId));

  const runCounts = await executor
    .select({
      teamId: runs.teamId,
      modelId: runs.modelId,
      n: sql<number>`count(*)::int`,
    })
    .from(runs)
    .where(and(eq(runs.leagueId, leagueId), isNotNull(runs.teamId)))
    .groupBy(runs.teamId, runs.modelId);

  const modal = new Map<string, { modelId: string; n: number }>();
  for (const row of runCounts) {
    const teamId = row.teamId;
    if (!teamId) continue;
    const best = modal.get(teamId);
    if (!best || row.n > best.n) modal.set(teamId, { modelId: row.modelId, n: row.n });
  }

  const spendRows = await executor
    .select({ teamId: usageEvents.teamId, usd: eventUsd, tokens: eventTokens })
    .from(usageEvents)
    .where(and(eq(usageEvents.leagueId, leagueId), isNotNull(usageEvents.teamId)))
    .groupBy(usageEvents.teamId);
  const spendByTeam = new Map(spendRows.map((r) => [r.teamId as string, r]));

  const resultRows = await executor
    .select({
      teamId: teamResults.teamId,
      points: sql<number>`coalesce(sum(${teamResults.pointsFor}), 0)::float8`,
      wins: sql<number>`coalesce(sum(case when ${teamResults.won} then 1 else 0 end), 0)::int`,
    })
    .from(teamResults)
    .innerJoin(teams, eq(teams.id, teamResults.teamId))
    .where(eq(teams.leagueId, leagueId))
    .groupBy(teamResults.teamId);
  const resultsByTeam = new Map(resultRows.map((r) => [r.teamId, r]));

  const buckets = new Map<string, ModelBenchmarkRow>();

  for (const team of leagueTeams) {
    const modelId = modal.get(team.id)?.modelId ?? team.currentModelId;
    if (!modelId) continue;

    const catalog = findModel(modelId);
    const bucket =
      buckets.get(modelId) ??
      {
        modelId,
        displayName: catalog?.displayName ?? modelId,
        provider: catalog?.provider ?? modelId.split("/")[0] ?? "unknown",
        teamCount: 0,
        teamIds: [],
        usd: 0,
        tokens: 0,
        points: 0,
        wins: 0,
        pointsPerUsd: null,
        costPerPoint: null,
        costPerWin: null,
      };

    const spend = spendByTeam.get(team.id);
    const results = resultsByTeam.get(team.id);

    bucket.teamCount += 1;
    bucket.teamIds.push(team.id);
    bucket.usd += spend?.usd ?? 0;
    bucket.tokens += spend?.tokens ?? 0;
    bucket.points += results?.points ?? 0;
    bucket.wins += results?.wins ?? 0;

    buckets.set(modelId, bucket);
  }

  return [...buckets.values()]
    .map((b) => ({
      ...b,
      usd: round8(b.usd),
      points: Math.round(b.points * 100) / 100,
      pointsPerUsd: b.usd > 0 ? b.points / b.usd : null,
      costPerPoint: b.points > 0 ? b.usd / b.points : null,
      costPerWin: b.wins > 0 ? b.usd / b.wins : null,
    }))
    .sort((a, b) => (b.pointsPerUsd ?? -1) - (a.pointsPerUsd ?? -1));
}

// ------------------------------------------------------------------ budgets

export type BudgetStatus = {
  teamId: string;
  weekNo: number;
  /** Team tokens burned this week (input + output). */
  tokensUsed: number;
  tokenCap: number | null;
  tokensRemaining: number | null;
  tokensPct: number | null;
  overTokenCap: boolean;
  /** This team's USD this week — informational; the cap below is league-wide. */
  teamWeekUsd: number;
  /** League USD spent season-to-date, against the commissioner's hard cap. */
  leagueUsdUsed: number;
  leagueUsdCap: number | null;
  leagueUsdRemaining: number | null;
  leagueUsdPct: number | null;
  overUsdCap: boolean;
  /** The materialised `budget_rollups` row for this team-week, when one exists. */
  rollup: { tokensUsed: number; usdUsed: number; runCount: number } | null;
};

/**
 * Tokens used vs the weekly cap, and league USD used vs the hard cap (PRD 5.9).
 *
 * Caps resolve most-specific-first: a `budgets` row for (league, team, week)
 * wins over `league_rules.weekly_token_cap_per_team`; a `budgets` row for
 * (league, null team) wins over `league_rules.league_usd_hard_cap`.
 */
export async function budgetStatus(
  teamId: string,
  weekNo: number,
  executor: DbOrTx = db,
): Promise<BudgetStatus> {
  const team = await executor.query.teams.findFirst({ where: eq(teams.id, teamId) });
  if (!team) {
    return {
      teamId,
      weekNo,
      tokensUsed: 0,
      tokenCap: null,
      tokensRemaining: null,
      tokensPct: null,
      overTokenCap: false,
      teamWeekUsd: 0,
      leagueUsdUsed: 0,
      leagueUsdCap: null,
      leagueUsdRemaining: null,
      leagueUsdPct: null,
      overUsdCap: false,
      rollup: null,
    };
  }

  const leagueId = team.leagueId;

  const [week, rules, leagueTotal, teamBudget, leagueBudget, rollupRow] = await Promise.all([
    teamWeekSpend(teamId, weekNo, executor),
    executor.query.leagueRules.findFirst({ where: eq(leagueRules.leagueId, leagueId) }),
    executor
      .select({ usd: eventUsd })
      .from(usageEvents)
      .where(eq(usageEvents.leagueId, leagueId))
      .then((rows) => rows[0]?.usd ?? 0),
    executor.query.budgets.findFirst({
      where: and(
        eq(budgets.leagueId, leagueId),
        eq(budgets.teamId, teamId),
        eq(budgets.period, "week"),
      ),
    }),
    executor.query.budgets.findFirst({
      where: and(eq(budgets.leagueId, leagueId), isNullTeam()),
    }),
    executor.query.budgetRollups.findFirst({
      where: and(
        eq(budgetRollups.leagueId, leagueId),
        eq(budgetRollups.teamId, teamId),
        eq(budgetRollups.weekNo, weekNo),
      ),
    }),
  ]);

  const tokenCap = teamBudget?.tokenCap ?? rules?.weeklyTokenCapPerTeam ?? null;
  const usdCap = leagueBudget?.usdCap ?? rules?.leagueUsdHardCap ?? null;

  return {
    teamId,
    weekNo,
    tokensUsed: week.tokens,
    tokenCap,
    tokensRemaining: tokenCap === null ? null : Math.max(0, tokenCap - week.tokens),
    tokensPct: tokenCap && tokenCap > 0 ? week.tokens / tokenCap : null,
    overTokenCap: tokenCap !== null && week.tokens > tokenCap,
    teamWeekUsd: week.usd,
    leagueUsdUsed: leagueTotal,
    leagueUsdCap: usdCap,
    leagueUsdRemaining: usdCap === null ? null : Math.max(0, usdCap - leagueTotal),
    leagueUsdPct: usdCap && usdCap > 0 ? leagueTotal / usdCap : null,
    overUsdCap: usdCap !== null && leagueTotal >= usdCap,
    rollup: rollupRow
      ? {
          tokensUsed: rollupRow.tokensUsed,
          usdUsed: rollupRow.usdUsed,
          runCount: rollupRow.runCount,
        }
      : null,
  };
}

function isNullTeam(): SQL {
  return sql`${budgets.teamId} is null`;
}

function round8(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

/** League-wide season totals — the header figure on the cost dashboard. */
export async function leagueSpendTotals(
  leagueId: string,
  executor: DbOrTx = db,
): Promise<SpendTotals> {
  const [row] = await executor
    .select(totalsSelection)
    .from(usageEvents)
    .where(eq(usageEvents.leagueId, leagueId));
  return row ?? ZERO;
}
