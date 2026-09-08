/**
 * Cost dashboards (PRD §5.9) — the read half of `lib/services/cost/index.ts`.
 *
 * Every figure here used to be a `SUM` over `usage_events` (aggregations A1–A15
 * in the migration plan). None of them are computed at query time any more:
 * `team_week_rollups`, `model_week_rollups` and `league_week_rollups` are
 * maintained by `internal.ledger.recordStep` (Phase 4), and records come from
 * `team_standings`. Spend is public within the league — it is part of the
 * transparency contract (PRD 1.2) — so every query is `requireLeagueRead`.
 *
 * `recordStep` itself lands in Phase 4; this file is queries only.
 */
import { v } from "convex/values";

import { MODEL_CATALOG, findModel } from "../lib/models";
import type { Doc, Id } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import { requireLeagueRead } from "./lib/auth";
import { appError } from "./lib/errors";

/** Weeks a rollup scan covers: 0 (draft / commissioner) through the playoffs. */
const MAX_WEEK = 22;
/** Runs read before the most-expensive list is sorted in memory. */
export const EXPENSIVE_RUN_SCAN = 200;

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

type RollupCounters = {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  runCount: number;
  stepCount: number;
};

/** Billable tokens are `input + output`; cached and reasoning tokens sit inside them. */
function totalsOf(rows: RollupCounters[]): SpendTotals {
  const out = { ...ZERO };
  for (const row of rows) {
    out.usd += row.costUsd;
    out.inputTokens += row.inputTokens;
    out.outputTokens += row.outputTokens;
    out.runCount += row.runCount;
    out.stepCount += row.stepCount;
  }
  out.tokens = out.inputTokens + out.outputTokens;
  return out;
}

async function teamWeekRollups(
  ctx: QueryCtx,
  teamId: Id<"teams">,
  season: number,
): Promise<Array<Doc<"team_week_rollups">>> {
  const rows: Array<Doc<"team_week_rollups">> = [];
  // Bounded: one row per week for one team-season.
  for (let week = 0; week <= MAX_WEEK; week++) {
    const row = await ctx.db
      .query("team_week_rollups")
      .withIndex("by_teamId_season_weekNo", (q) =>
        q.eq("teamId", teamId).eq("season", season).eq("weekNo", week),
      )
      .unique();
    if (row) rows.push(row);
  }
  return rows;
}

// --------------------------------------------------------------- team page

export type TeamDashboard = {
  week: SpendTotals & { teamId: Id<"teams">; weekNo: number };
  season: SpendTotals & { teamId: Id<"teams">; byWeek: Array<SpendTotals & { weekNo: number }> };
  costPerPoint: { teamId: Id<"teams">; usd: number; points: number; costPerPoint: number | null };
  costPerWin: {
    teamId: Id<"teams">;
    usd: number;
    wins: number;
    losses: number;
    ties: number;
    costPerWin: number | null;
  };
  budget: BudgetStatus;
};

export type BudgetStatus = {
  teamId: Id<"teams">;
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
  /** The materialised team-week rollup, when one exists. */
  rollup: { tokensUsed: number; usdUsed: number; runCount: number } | null;
};

/**
 * Tokens used vs the weekly cap, and league USD used vs the hard cap.
 *
 * Caps resolve most-specific-first: a `budgets` row for (league, team, week)
 * wins over `league_rules.weeklyTokenCapPerTeam`; a `budgets` row for
 * (league, no team) wins over `league_rules.leagueUsdHardCap`.
 */
export async function budgetStatus(
  ctx: QueryCtx,
  team: Doc<"teams">,
  season: number,
  weekNo: number,
): Promise<BudgetStatus> {
  const leagueId = team.leagueId;
  const rules = await ctx.db
    .query("league_rules")
    .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
    .unique();

  const weekRollup = await ctx.db
    .query("team_week_rollups")
    .withIndex("by_teamId_season_weekNo", (q) =>
      q.eq("teamId", team._id).eq("season", season).eq("weekNo", weekNo),
    )
    .unique();

  const leagueRows = await leagueWeekRollups(ctx, leagueId, season);
  const leagueUsdUsed = leagueRows.reduce((sum, row) => sum + row.costUsd, 0);

  const teamBudget = await ctx.db
    .query("budgets")
    .withIndex("by_leagueId_teamId_period", (q) =>
      q.eq("leagueId", leagueId).eq("teamId", team._id).eq("period", "week"),
    )
    .unique();
  let leagueBudget: Doc<"budgets"> | null = null;
  for (const period of ["season", "week"] as const) {
    leagueBudget =
      leagueBudget ??
      (await ctx.db
        .query("budgets")
        .withIndex("by_leagueId_teamId_period", (q) =>
          q.eq("leagueId", leagueId).eq("teamId", undefined).eq("period", period),
        )
        .unique());
  }

  const tokensUsed = weekRollup ? weekRollup.inputTokens + weekRollup.outputTokens : 0;
  const tokenCap = teamBudget?.tokenCap ?? rules?.weeklyTokenCapPerTeam ?? null;
  const usdCap = leagueBudget?.usdCap ?? rules?.leagueUsdHardCap ?? null;

  return {
    teamId: team._id,
    weekNo,
    tokensUsed,
    tokenCap,
    tokensRemaining: tokenCap === null ? null : Math.max(0, tokenCap - tokensUsed),
    tokensPct: tokenCap && tokenCap > 0 ? tokensUsed / tokenCap : null,
    overTokenCap: tokenCap !== null && tokensUsed > tokenCap,
    teamWeekUsd: weekRollup?.costUsd ?? 0,
    leagueUsdUsed,
    leagueUsdCap: usdCap,
    leagueUsdRemaining: usdCap === null ? null : Math.max(0, usdCap - leagueUsdUsed),
    leagueUsdPct: usdCap && usdCap > 0 ? leagueUsdUsed / usdCap : null,
    overUsdCap: usdCap !== null && leagueUsdUsed >= usdCap,
    rollup: weekRollup
      ? {
          tokensUsed,
          usdUsed: weekRollup.costUsd,
          runCount: weekRollup.runCount,
        }
      : null,
  };
}

export const teamDashboard = query({
  args: { leagueId: v.id("leagues"), teamId: v.id("teams"), weekNo: v.number() },
  handler: async (ctx, { leagueId, teamId, weekNo }): Promise<TeamDashboard> => {
    const { league } = await requireLeagueRead(ctx, leagueId);
    const team = await ctx.db.get("teams", teamId);
    if (!team || team.leagueId !== leagueId) throw appError("NOT_FOUND", "Team not found");

    const rows = await teamWeekRollups(ctx, teamId, league.season);
    const week = rows.find((row) => row.weekNo === weekNo);
    const season = totalsOf(rows);

    const standing = await ctx.db
      .query("team_standings")
      .withIndex("by_teamId_season", (q) => q.eq("teamId", teamId).eq("season", league.season))
      .unique();
    const points = standing?.pointsFor ?? 0;
    const wins = standing?.wins ?? 0;

    return {
      week: { ...(week ? totalsOf([week]) : ZERO), teamId, weekNo },
      season: {
        ...season,
        teamId,
        byWeek: rows
          .filter((row) => row.weekNo > 0)
          .sort((a, b) => a.weekNo - b.weekNo)
          .map((row) => ({ ...totalsOf([row]), weekNo: row.weekNo })),
      },
      costPerPoint: {
        teamId,
        usd: season.usd,
        points,
        costPerPoint: points > 0 ? season.usd / points : null,
      },
      costPerWin: {
        teamId,
        usd: season.usd,
        wins,
        losses: standing?.losses ?? 0,
        ties: standing?.ties ?? 0,
        costPerWin: wins > 0 ? season.usd / wins : null,
      },
      budget: await budgetStatus(ctx, team, league.season, weekNo),
    };
  },
});

// ------------------------------------------------------------ league page

async function leagueWeekRollups(
  ctx: QueryCtx,
  leagueId: Id<"leagues">,
  season: number,
): Promise<Array<Doc<"league_week_rollups">>> {
  const rows: Array<Doc<"league_week_rollups">> = [];
  // Bounded: one row per league week.
  for (let week = 0; week <= MAX_WEEK; week++) {
    const row = await ctx.db
      .query("league_week_rollups")
      .withIndex("by_leagueId_season_weekNo", (q) =>
        q.eq("leagueId", leagueId).eq("season", season).eq("weekNo", week),
      )
      .unique();
    if (row) rows.push(row);
  }
  return rows;
}

export type TeamSpendRow = SpendTotals & {
  teamId: Id<"teams">;
  teamName: string;
  abbreviation: string;
  ownerUserId: Id<"users"> | null;
  modelId: string | null;
};

export type ModelSpendRow = SpendTotals & {
  modelId: string;
  provider: string;
  displayName: string;
};

export type ExpensiveRun = {
  runId: Id<"runs">;
  teamId: Id<"teams"> | null;
  teamName: string | null;
  modelId: string;
  status: string;
  outcome: string | null;
  windowLabel: string;
  windowType: string;
  weekNo: number;
  stepCount: number;
  costUsd: number;
  createdAt: number;
};

export type LeagueDashboard = {
  totals: SpendTotals;
  byTeam: TeamSpendRow[];
  byModel: ModelSpendRow[];
  expensive: ExpensiveRun[];
  trend: Array<SpendTotals & { weekNo: number }>;
};

export const leagueDashboard = query({
  args: { leagueId: v.id("leagues"), limit: v.optional(v.number()) },
  handler: async (ctx, { leagueId, limit }): Promise<LeagueDashboard> => {
    const { league } = await requireLeagueRead(ctx, leagueId);
    const season = league.season;
    const take = Math.min(50, Math.max(1, limit ?? 10));

    const leagueRows = await leagueWeekRollups(ctx, leagueId, season);

    // ---- by team (teams with no spend appear as zeroes)
    // Bounded: ≤ 14 teams.
    const teamRows = (
      await ctx.db
        .query("teams")
        .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
        .collect()
    ).sort((a, b) => a.waiverPriority - b.waiverPriority);

    const byTeam: TeamSpendRow[] = [];
    for (const team of teamRows) {
      const config = await ctx.db
        .query("agent_configs")
        .withIndex("by_teamId", (q) => q.eq("teamId", team._id))
        .unique();
      const version = config?.currentVersionId
        ? await ctx.db.get("config_versions", config.currentVersionId)
        : null;
      byTeam.push({
        ...totalsOf(await teamWeekRollups(ctx, team._id, season)),
        teamId: team._id,
        teamName: team.name,
        abbreviation: team.abbreviation,
        ownerUserId: team.ownerUserId ?? null,
        modelId: version?.modelId ?? null,
      });
    }
    byTeam.sort((a, b) => b.usd - a.usd);

    // ---- by model (per-league rows of model_week_rollups)
    const modelRows = new Map<string, { provider: string; rows: RollupCounters[] }>();
    for (let week = 0; week <= MAX_WEEK; week++) {
      const rows = await ctx.db
        .query("model_week_rollups")
        .withIndex("by_leagueId_season_weekNo", (q) =>
          q.eq("leagueId", leagueId).eq("season", season).eq("weekNo", week),
        )
        .take(50);
      for (const row of rows) {
        const bucket = modelRows.get(row.modelId) ?? { provider: row.provider, rows: [] };
        bucket.rows.push(row);
        modelRows.set(row.modelId, bucket);
      }
    }
    const byModel: ModelSpendRow[] = [...modelRows.entries()]
      .map(([modelId, bucket]) => ({
        ...totalsOf(bucket.rows),
        modelId,
        provider: bucket.provider,
        displayName: findModel(modelId)?.displayName ?? modelId,
      }))
      .sort((a, b) => b.usd - a.usd);

    // ---- most expensive runs: newest 200, sorted by cost in memory
    const recentRuns = await ctx.db
      .query("runs")
      .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
      .order("desc")
      .take(EXPENSIVE_RUN_SCAN);
    const expensive: ExpensiveRun[] = [];
    for (const run of recentRuns
      .slice()
      .sort((a, b) => (b.totalCostUsd ?? 0) - (a.totalCostUsd ?? 0))
      .slice(0, take)) {
      const team = run.teamId ? await ctx.db.get("teams", run.teamId) : null;
      expensive.push({
        runId: run._id,
        teamId: run.teamId ?? null,
        teamName: team?.name ?? null,
        modelId: run.modelId,
        status: run.status,
        outcome: run.outcome ?? null,
        windowLabel: run.windowLabel,
        windowType: run.windowType,
        weekNo: run.weekNo,
        stepCount: run.stepCount,
        costUsd: run.totalCostUsd ?? 0,
        createdAt: run._creationTime,
      });
    }

    return {
      totals: totalsOf(leagueRows),
      byTeam,
      byModel,
      expensive,
      // Week 0 is draft / commissioner spend: excluded from the trend, as before.
      trend: leagueRows
        .filter((row) => row.weekNo > 0)
        .sort((a, b) => a.weekNo - b.weekNo)
        .map((row) => ({ ...totalsOf([row]), weekNo: row.weekNo })),
    };
  },
});

// -------------------------------------------------------------- benchmark

export type ModelBenchmarkRow = {
  modelId: string;
  displayName: string;
  provider: string;
  teamCount: number;
  teamIds: Id<"teams">[];
  usd: number;
  tokens: number;
  points: number;
  wins: number;
  /** The headline: fantasy points per dollar spent. Null when nothing was spent. */
  pointsPerUsd: number | null;
  costPerPoint: number | null;
  costPerWin: number | null;
};

function round8(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

/**
 * Cost-adjusted performance by model (PRD 5.9 "benchmark view").
 *
 * Attribution deviates from the old service: it credited a team to the model it
 * ran most often (a `GROUP BY runs.team_id, runs.model_id` count), which has no
 * rollup equivalent — `model_week_rollups` is not keyed by team. Teams are
 * therefore credited to the model on their current config version, which is
 * exactly the old code's fallback. Spend comes from `team_week_rollups`, record
 * from `team_standings`.
 */
export const benchmark = query({
  args: { leagueId: v.id("leagues") },
  handler: async (ctx, { leagueId }): Promise<ModelBenchmarkRow[]> => {
    const { league } = await requireLeagueRead(ctx, leagueId);
    // Bounded: ≤ 14 teams.
    const teamRows = await ctx.db
      .query("teams")
      .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
      .collect();

    const buckets = new Map<string, ModelBenchmarkRow>();
    for (const team of teamRows) {
      const config = await ctx.db
        .query("agent_configs")
        .withIndex("by_teamId", (q) => q.eq("teamId", team._id))
        .unique();
      const version = config?.currentVersionId
        ? await ctx.db.get("config_versions", config.currentVersionId)
        : null;
      const modelId = version?.modelId;
      if (!modelId) continue;

      const catalog = findModel(modelId);
      const bucket = buckets.get(modelId) ?? {
        modelId,
        displayName: catalog?.displayName ?? modelId,
        provider: catalog?.provider ?? modelId.split("/")[0] ?? "unknown",
        teamCount: 0,
        teamIds: [] as Id<"teams">[],
        usd: 0,
        tokens: 0,
        points: 0,
        wins: 0,
        pointsPerUsd: null,
        costPerPoint: null,
        costPerWin: null,
      };

      const spend = totalsOf(await teamWeekRollups(ctx, team._id, league.season));
      const standing = await ctx.db
        .query("team_standings")
        .withIndex("by_teamId_season", (q) =>
          q.eq("teamId", team._id).eq("season", league.season),
        )
        .unique();

      bucket.teamCount += 1;
      bucket.teamIds.push(team._id);
      bucket.usd += spend.usd;
      bucket.tokens += spend.tokens;
      bucket.points += standing?.pointsFor ?? 0;
      bucket.wins += standing?.wins ?? 0;
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
  },
});

// ------------------------------------------------------------ model prices

export type ModelPriceRow = {
  modelId: string;
  provider: string;
  displayName: string;
  inputPerM: number;
  outputPerM: number;
  cachedInputPerM: number | null;
  reasoningPerM: number | null;
  supportsReasoning: boolean;
  effectiveFrom: number | null;
};

/** The price book as of now: the newest row per model id (`/bench` and the estimator). */
export const modelPrices = query({
  args: {},
  handler: async (ctx): Promise<ModelPriceRow[]> => {
    const now = Date.now();
    const out: ModelPriceRow[] = [];
    // Bounded: one range per catalogued model.
    for (const entry of MODEL_CATALOG) {
      const row = await ctx.db
        .query("model_prices")
        .withIndex("by_modelId_effectiveFrom", (q) =>
          q.eq("modelId", entry.modelId).lte("effectiveFrom", now),
        )
        .order("desc")
        .first();
      out.push({
        modelId: entry.modelId,
        provider: row?.provider ?? entry.provider,
        displayName: row?.displayName ?? entry.displayName,
        inputPerM: row?.inputPerM ?? entry.inputPerM,
        outputPerM: row?.outputPerM ?? entry.outputPerM,
        cachedInputPerM: row?.cachedInputPerM ?? entry.cachedInputPerM,
        reasoningPerM: row?.reasoningPerM ?? entry.reasoningPerM,
        supportsReasoning: row?.supportsReasoning ?? entry.supportsReasoning,
        effectiveFrom: row?.effectiveFrom ?? null,
      });
    }
    return out;
  },
});
