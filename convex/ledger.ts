/**
 * Cost dashboards (PRD §5.9) — the read half of the ledger.
 *
 * Every figure here used to be a `SUM` over `usage_events` (aggregations A1–A15
 * in the migration plan). None of them are computed at query time any more:
 * `team_week_rollups`, `model_week_rollups` and `league_week_rollups` are
 * maintained by `internal.ledger.recordStep` (Phase 4), and records come from
 * `team_standings`. Spend is public within the league — it is part of the
 * transparency contract (PRD 1.2) — so every query is `requireLeagueRead`.
 *
 * Phase 4 added the write half below the dashboards: `internal.ledger.recordStep`
 * is the ONLY function in the codebase that inserts `usage_events`, and it folds
 * every event into the three rollup tables in the same transaction. The
 * reconciliation action at the bottom is the "verify" button: it re-sums the
 * events page by page and reports any drift.
 */
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";

import { MODEL_CATALOG, findModel } from "../lib/models";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { requireCommissioner, requireLeagueRead } from "./lib/auth";
import { appError } from "./lib/errors";
import {
  catalogPrice,
  round8,
  computeCostUsd,
  type ResolvedModelPrice,
} from "./lib/pricing_pure";
import { runStatus } from "./schema";

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

// ===========================================================================
// Phase 4 — the write half
// ===========================================================================

/**
 * Price in effect for `modelId` at `at`, the same lookup as the runtime's
 * `getModelPrice`: the newest `model_prices` row with `effectiveFrom <= at`,
 * else the catalog, else a zero price (an unknown model must never abort a run).
 */
export async function resolvePriceAt(
  ctx: QueryCtx,
  modelId: string,
  at: number,
): Promise<ResolvedModelPrice> {
  const row = await ctx.db
    .query("model_prices")
    .withIndex("by_modelId_effectiveFrom", (q) => q.eq("modelId", modelId).lte("effectiveFrom", at))
    .order("desc")
    .first();
  if (!row) return catalogPrice(modelId);
  return {
    modelId: row.modelId,
    provider: row.provider,
    displayName: row.displayName,
    inputPerM: row.inputPerM,
    outputPerM: row.outputPerM,
    cachedInputPerM: row.cachedInputPerM ?? null,
    reasoningPerM: row.reasoningPerM ?? null,
    supportsReasoning: row.supportsReasoning,
    source: "model_prices",
  };
}

/** One event's contribution to a rollup row. Every field of `rollupCounters`. */
type RollupDelta = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  costUsd: number;
  computedCostUsd: number;
  gatewayCostUsd: number;
  runCount: number;
  stepCount: number;
  fallbackCount: number;
  invalidActionCount: number;
};

const ZERO_DELTA: RollupDelta = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  reasoningTokens: 0,
  costUsd: 0,
  computedCostUsd: 0,
  gatewayCostUsd: 0,
  runCount: 0,
  stepCount: 0,
  fallbackCount: 0,
  invalidActionCount: 0,
};

/**
 * `existing + delta`, with the three USD figures rounded back to 8 decimals so a
 * rollup always equals `round8(sum of its events)` and never drifts by an ulp.
 */
function accumulate(existing: RollupDelta, delta: RollupDelta): RollupDelta & { updatedAt: number } {
  return {
    inputTokens: existing.inputTokens + delta.inputTokens,
    outputTokens: existing.outputTokens + delta.outputTokens,
    cachedInputTokens: existing.cachedInputTokens + delta.cachedInputTokens,
    reasoningTokens: existing.reasoningTokens + delta.reasoningTokens,
    costUsd: round8(existing.costUsd + delta.costUsd),
    computedCostUsd: round8(existing.computedCostUsd + delta.computedCostUsd),
    gatewayCostUsd: round8(existing.gatewayCostUsd + delta.gatewayCostUsd),
    runCount: existing.runCount + delta.runCount,
    stepCount: existing.stepCount + delta.stepCount,
    fallbackCount: existing.fallbackCount + delta.fallbackCount,
    invalidActionCount: existing.invalidActionCount + delta.invalidActionCount,
    updatedAt: Date.now(),
  };
}

async function bumpTeamWeek(
  ctx: MutationCtx,
  key: { leagueId: Id<"leagues">; teamId: Id<"teams">; season: number; weekNo: number },
  delta: RollupDelta,
): Promise<void> {
  const row = await ctx.db
    .query("team_week_rollups")
    .withIndex("by_teamId_season_weekNo", (q) =>
      q.eq("teamId", key.teamId).eq("season", key.season).eq("weekNo", key.weekNo),
    )
    .unique();
  if (row) await ctx.db.patch("team_week_rollups", row._id, accumulate(row, delta));
  else await ctx.db.insert("team_week_rollups", { ...key, ...accumulate(ZERO_DELTA, delta) });
}

async function bumpModelWeek(
  ctx: MutationCtx,
  key: {
    leagueId: Id<"leagues"> | undefined;
    modelId: string;
    provider: string;
    season: number;
    weekNo: number;
  },
  delta: RollupDelta,
): Promise<void> {
  const row = await ctx.db
    .query("model_week_rollups")
    .withIndex("by_leagueId_modelId_season_weekNo", (q) =>
      q
        .eq("leagueId", key.leagueId)
        .eq("modelId", key.modelId)
        .eq("season", key.season)
        .eq("weekNo", key.weekNo),
    )
    .unique();
  if (row) await ctx.db.patch("model_week_rollups", row._id, accumulate(row, delta));
  else await ctx.db.insert("model_week_rollups", { ...key, ...accumulate(ZERO_DELTA, delta) });
}

async function bumpLeagueWeek(
  ctx: MutationCtx,
  key: { leagueId: Id<"leagues">; season: number; weekNo: number },
  delta: RollupDelta,
): Promise<Id<"league_week_rollups">> {
  const row = await ctx.db
    .query("league_week_rollups")
    .withIndex("by_leagueId_season_weekNo", (q) =>
      q.eq("leagueId", key.leagueId).eq("season", key.season).eq("weekNo", key.weekNo),
    )
    .unique();
  if (row) {
    await ctx.db.patch("league_week_rollups", row._id, accumulate(row, delta));
    return row._id;
  }
  return ctx.db.insert("league_week_rollups", { ...key, ...accumulate(ZERO_DELTA, delta) });
}

/** Fold one delta into all four rollup rows for a step (team row skipped for commissioner runs). */
async function bumpAllRollups(
  ctx: MutationCtx,
  key: {
    leagueId: Id<"leagues">;
    teamId: Id<"teams"> | undefined;
    modelId: string;
    provider: string;
    season: number;
    weekNo: number;
  },
  delta: RollupDelta,
): Promise<void> {
  const { leagueId, teamId, modelId, provider, season, weekNo } = key;
  if (teamId) await bumpTeamWeek(ctx, { leagueId, teamId, season, weekNo }, delta);
  // Per-league dashboard row and the cross-league benchmark row (leagueId undefined).
  await bumpModelWeek(ctx, { leagueId, modelId, provider, season, weekNo }, delta);
  await bumpModelWeek(ctx, { leagueId: undefined, modelId, provider, season, weekNo }, delta);
  await bumpLeagueWeek(ctx, { leagueId, season, weekNo }, delta);
}

export const usageStep = v.object({
  inputTokens: v.number(),
  outputTokens: v.number(),
  cachedInputTokens: v.optional(v.number()),
  reasoningTokens: v.optional(v.number()),
});

/**
 * Append one `usage_events` row and fold it into every rollup, in one transaction.
 *
 * **This is the only function that inserts `usage_events`.** `internal.runs.persistStep`
 * calls it once per model step; `convex/commissioner_agent.ts` must call it too
 * (its local `recordStep` was a temporary Phase 3 stand-in).
 *
 * Idempotent on `(runId, stepIndex)`: a Workpool retry that replays a step it
 * already persisted gets the stored figures back and writes nothing, so no
 * rollup is ever double-counted.
 */
export const recordStep = internalMutation({
  args: {
    runId: v.id("runs"),
    stepIndex: v.number(),
    modelId: v.string(),
    /** Overrides the price book's provider (custom providers). */
    provider: v.optional(v.string()),
    usage: usageStep,
    latencyMs: v.optional(v.number()),
    /** The AI Gateway's own figure, when it reports one. Preferred over the computed cost. */
    gatewayCostUsd: v.optional(v.number()),
    /** True for a step taken on the league's fallback model. */
    isFallbackStep: v.optional(v.boolean()),
    /** Write-tool calls this step that failed validation. */
    invalidActionCount: v.optional(v.number()),
    createdAt: v.optional(v.number()),
  },
  returns: v.object({
    eventId: v.id("usage_events"),
    costUsd: v.number(),
    computedCostUsd: v.number(),
  }),
  handler: async (ctx, args) => {
    const run = await ctx.db.get("runs", args.runId);
    if (!run) throw appError("NOT_FOUND", "Run not found");

    // Replay guard: the event is the idempotency key for the whole transaction.
    const existing = await ctx.db
      .query("usage_events")
      .withIndex("by_runId_stepIndex", (q) =>
        q.eq("runId", args.runId).eq("stepIndex", args.stepIndex),
      )
      .first();
    if (existing) {
      return {
        eventId: existing._id,
        costUsd: existing.costUsd,
        computedCostUsd: existing.computedCostUsd,
      };
    }

    const league = await ctx.db.get("leagues", run.leagueId);
    if (!league) throw appError("NOT_FOUND", "League not found");
    const season = league.season;
    const weekNo = run.weekNo;
    const createdAt = args.createdAt ?? Date.now();

    // A run is counted once, on its first recorded event — regardless of which
    // step index that is (a resumed run may start at lastPersistedStep + 1).
    const priorEventForRun = await ctx.db
      .query("usage_events")
      .withIndex("by_runId_stepIndex", (q) => q.eq("runId", args.runId))
      .first();

    const price = await resolvePriceAt(ctx, args.modelId, createdAt);
    const provider = args.provider ?? price.provider;

    const inputTokens = Math.max(0, Math.round(args.usage.inputTokens));
    const outputTokens = Math.max(0, Math.round(args.usage.outputTokens));
    const cachedInputTokens = Math.min(
      Math.max(0, Math.round(args.usage.cachedInputTokens ?? 0)),
      inputTokens,
    );
    const reasoningTokens = Math.min(
      Math.max(0, Math.round(args.usage.reasoningTokens ?? 0)),
      outputTokens,
    );

    const computedCostUsd = computeCostUsd({
      price,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      reasoningTokens,
    });
    const gatewayCostUsd =
      args.gatewayCostUsd == null || !Number.isFinite(args.gatewayCostUsd)
        ? undefined
        : round8(args.gatewayCostUsd);
    const costUsd = gatewayCostUsd ?? computedCostUsd;

    const eventId = await ctx.db.insert("usage_events", {
      runId: args.runId,
      stepIndex: args.stepIndex,
      leagueId: run.leagueId,
      teamId: run.teamId,
      season,
      weekNo,
      modelId: args.modelId,
      provider,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      reasoningTokens,
      latencyMs: args.latencyMs,
      computedCostUsd,
      gatewayCostUsd,
      costUsd,
      createdAt,
    });

    const isFallbackStep = args.isFallbackStep === true;
    await bumpAllRollups(
      ctx,
      {
        leagueId: run.leagueId,
        teamId: run.teamId,
        modelId: args.modelId,
        provider,
        season,
        weekNo,
      },
      {
        ...ZERO_DELTA,
        inputTokens,
        outputTokens,
        cachedInputTokens,
        reasoningTokens,
        costUsd,
        computedCostUsd,
        gatewayCostUsd: gatewayCostUsd ?? 0,
        stepCount: 1,
        // A run is counted once, on its first step — the same "distinct run ids"
        // figure the golden importer produced.
        runCount: priorEventForRun ? 0 : 1,
        fallbackCount: isFallbackStep && !run.ledgerOutcomeRecorded ? 1 : 0,
        invalidActionCount: Math.max(0, Math.round(args.invalidActionCount ?? 0)),
      },
    );

    // Claim the run's fallback accounting so `recordRunOutcome` does not count it twice.
    if (isFallbackStep && !run.ledgerOutcomeRecorded) {
      await ctx.db.patch("runs", args.runId, { ledgerOutcomeRecorded: true });
    }

    return { eventId, costUsd, computedCostUsd };
  },
});

/**
 * Count a run that ended in `fallback` but never took a step flagged as one —
 * a lineup that fell through to the safety autopilot, a budget-exhausted run, a
 * run that died before its first model call. Called once from
 * `internal.runs.onComplete`; idempotent through `runs.ledgerOutcomeRecorded`.
 */
export const recordRunOutcome = internalMutation({
  args: {
    runId: v.id("runs"),
    status: runStatus,
    fallbackApplied: v.optional(v.boolean()),
  },
  returns: v.object({ counted: v.boolean() }),
  handler: async (ctx, args) => {
    const run = await ctx.db.get("runs", args.runId);
    if (!run) throw appError("NOT_FOUND", "Run not found");
    if (run.ledgerOutcomeRecorded) return { counted: false };

    await ctx.db.patch("runs", args.runId, { ledgerOutcomeRecorded: true });

    const isFallback =
      args.status === "fallback" || args.fallbackApplied === true || run.fallbackApplied != null;
    if (!isFallback) return { counted: false };

    const league = await ctx.db.get("leagues", run.leagueId);
    if (!league) throw appError("NOT_FOUND", "League not found");

    const price = await resolvePriceAt(ctx, run.modelId, Date.now());
    await bumpAllRollups(
      ctx,
      {
        leagueId: run.leagueId,
        teamId: run.teamId,
        modelId: run.modelId,
        provider: price.provider,
        season: league.season,
        weekNo: run.weekNo,
      },
      { ...ZERO_DELTA, fallbackCount: 1 },
    );
    return { counted: true };
  },
});

// ------------------------------------------------------------------ budgets

export type RemainingBudget = {
  teamTokensRemaining: number | null;
  teamTokensUsed: number;
  teamTokenCap: number | null;
  leagueUsdRemaining: number | null;
  leagueUsdUsed: number;
  leagueUsdCap: number | null;
  leagueCapReached: boolean;
};

/**
 * Shared by `remainingBudget` and `notifyCommissionerOfCap`.
 *
 * Caps come from `league_rules` (the port of `getRemainingBudget`, which read
 * nothing else); usage comes from the rollups and never from `usage_events`.
 * The team token cap is weekly, so it reads one team-week row. The league USD cap
 * is a season-level safety net, so it sums the league's week rows — the same
 * figure `budgetStatus` shows on the dashboard, kept identical on purpose.
 */
async function remainingBudgetFor(
  ctx: QueryCtx,
  args: { leagueId: Id<"leagues">; teamId?: Id<"teams">; weekNo: number },
): Promise<RemainingBudget> {
  const league = await ctx.db.get("leagues", args.leagueId);
  if (!league) throw appError("NOT_FOUND", "League not found");
  const rules = await ctx.db
    .query("league_rules")
    .withIndex("by_leagueId", (q) => q.eq("leagueId", args.leagueId))
    .unique();

  const teamRollup = args.teamId
    ? await ctx.db
        .query("team_week_rollups")
        .withIndex("by_teamId_season_weekNo", (q) =>
          q
            .eq("teamId", args.teamId as Id<"teams">)
            .eq("season", league.season)
            .eq("weekNo", args.weekNo),
        )
        .unique()
    : null;

  const leagueRows = await leagueWeekRollups(ctx, args.leagueId, league.season);
  const leagueUsdUsed = round8(leagueRows.reduce((sum, row) => sum + row.costUsd, 0));

  const teamTokenCap = rules?.weeklyTokenCapPerTeam ?? null;
  const leagueUsdCap = rules?.leagueUsdHardCap ?? null;
  const teamTokensUsed = teamRollup ? teamRollup.inputTokens + teamRollup.outputTokens : 0;

  const teamTokensRemaining =
    teamTokenCap === null ? null : Math.max(0, teamTokenCap - teamTokensUsed);
  // Not clamped at zero: the executor wants to see how far past the cap it went.
  const leagueUsdRemaining = leagueUsdCap === null ? null : round8(leagueUsdCap - leagueUsdUsed);

  return {
    teamTokensRemaining,
    teamTokensUsed,
    teamTokenCap,
    leagueUsdRemaining,
    leagueUsdUsed,
    leagueUsdCap,
    leagueCapReached: leagueUsdRemaining !== null && leagueUsdRemaining <= 0,
  };
}

const remainingBudgetShape = v.object({
  teamTokensRemaining: v.union(v.number(), v.null()),
  teamTokensUsed: v.number(),
  teamTokenCap: v.union(v.number(), v.null()),
  leagueUsdRemaining: v.union(v.number(), v.null()),
  leagueUsdUsed: v.number(),
  leagueUsdCap: v.union(v.number(), v.null()),
  leagueCapReached: v.boolean(),
});

/**
 * What the executor checks before every model step (aggregation A31).
 *
 * Reads `league_rules` plus rollup rows only — never `usage_events`.
 */
export const remainingBudget = internalQuery({
  args: {
    leagueId: v.id("leagues"),
    teamId: v.optional(v.id("teams")),
    weekNo: v.number(),
  },
  returns: remainingBudgetShape,
  handler: (ctx, args) => remainingBudgetFor(ctx, args),
});

/**
 * Post the "league USD hard cap reached" announcement to The Commons, at most
 * once per league-week.
 *
 * The guard is `league_week_rollups.capNotifiedAt`, claimed inside this
 * transaction so two concurrent runs cannot both post. The forum row is written
 * inline rather than through `convex/forum.ts`: this is a system announcement
 * with no author team, and the ledger must not depend on the forum's rate limits
 * or moderation path.
 */
export const notifyCommissionerOfCap = internalMutation({
  args: { leagueId: v.id("leagues"), weekNo: v.optional(v.number()) },
  returns: v.object({ notified: v.boolean() }),
  handler: async (ctx, args) => {
    const league = await ctx.db.get("leagues", args.leagueId);
    if (!league) throw appError("NOT_FOUND", "League not found");
    const weekNo = args.weekNo ?? 0;
    const now = Date.now();

    // The guard lives on the league-week rollup; spend may have landed in an
    // earlier week, so create the row when it is missing.
    const rollupId = await bumpLeagueWeek(
      ctx,
      { leagueId: args.leagueId, season: league.season, weekNo },
      ZERO_DELTA,
    );
    const rollup = await ctx.db.get("league_week_rollups", rollupId);
    if (!rollup || rollup.capNotifiedAt != null) return { notified: false };
    await ctx.db.patch("league_week_rollups", rollupId, { capNotifiedAt: now });

    const budget = await remainingBudgetFor(ctx, { leagueId: args.leagueId, weekNo });
    const capText =
      budget.leagueUsdCap === null ? "the configured cap" : `$${budget.leagueUsdCap.toFixed(2)}`;

    await ctx.db.insert("forum_posts", {
      leagueId: args.leagueId,
      teamId: undefined,
      title: "League spend cap reached — agents are on fallbacks",
      body:
        `The league's USD hard cap (${capText}) has been reached; ` +
        `$${budget.leagueUsdUsed.toFixed(4)} has been spent so far. ` +
        "Remaining runs this week will not call a model: lineup windows fall back to the safety " +
        "autopilot, and waiver/trade windows take no action. The commissioner can raise the cap in " +
        "league settings.",
      flair: "announcement",
      score: 0,
      commentCount: 0,
      hidden: false,
      createdAt: now,
    });

    return { notified: true };
  },
});

// ---------------------------------------------------------- reconciliation

/** Page size for the reconciliation scan. `usage_events` rows are small. */
export const VERIFY_PAGE_SIZE = 500;
/** Hard stop so a corrupt cursor can never spin an action forever. */
const VERIFY_MAX_PAGES = 200;

/** The counters a `usage_events` scan can reproduce. */
type EventSums = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  costUsd: number;
  computedCostUsd: number;
  gatewayCostUsd: number;
  stepCount: number;
  runCount: number;
};

const COMPARED_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cachedInputTokens",
  "reasoningTokens",
  "costUsd",
  "computedCostUsd",
  "gatewayCostUsd",
  "stepCount",
  "runCount",
] as const satisfies readonly (keyof EventSums)[];

function zeroSums(): EventSums & { runIds: Set<string> } {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
    computedCostUsd: 0,
    gatewayCostUsd: 0,
    stepCount: 0,
    runCount: 0,
    runIds: new Set<string>(),
  };
}

export type LedgerDiff = { field: string; rollup: number; events: number };

const diffShape = v.object({ field: v.string(), rollup: v.number(), events: v.number() });
const verifyShape = v.object({ ok: v.boolean(), diffs: v.array(diffShape) });

/** USD comparisons tolerate the last stored decimal; counts must match exactly. */
function differs(field: string, a: number, b: number): boolean {
  const usd = field.endsWith("CostUsd") || field.endsWith("costUsd");
  return usd ? Math.abs(a - b) > 1e-8 : a !== b;
}

function compare(prefix: string, rollup: EventSums | null, events: EventSums): LedgerDiff[] {
  const diffs: LedgerDiff[] = [];
  for (const field of COMPARED_FIELDS) {
    const left = rollup ? rollup[field] : 0;
    const right = events[field];
    if (differs(field, left, right)) {
      diffs.push({ field: `${prefix}${field}`, rollup: left, events: right });
    }
  }
  return diffs;
}

/**
 * One page of `usage_events` for a team-week or a league-week, projected down to
 * the fields reconciliation needs (the full documents never cross the action
 * boundary).
 */
export const usagePage = internalQuery({
  args: {
    teamId: v.optional(v.id("teams")),
    leagueId: v.optional(v.id("leagues")),
    season: v.number(),
    weekNo: v.number(),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const base =
      args.teamId !== undefined
        ? ctx.db
            .query("usage_events")
            .withIndex("by_teamId_season_weekNo", (q) =>
              q
                .eq("teamId", args.teamId as Id<"teams">)
                .eq("season", args.season)
                .eq("weekNo", args.weekNo),
            )
        : ctx.db
            .query("usage_events")
            .withIndex("by_leagueId_season_weekNo", (q) =>
              q
                .eq("leagueId", args.leagueId as Id<"leagues">)
                .eq("season", args.season)
                .eq("weekNo", args.weekNo),
            );
    const result = await base.paginate(args.paginationOpts);
    return {
      ...result,
      page: result.page.map((row) => ({
        runId: row.runId as string,
        modelId: row.modelId,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cachedInputTokens: row.cachedInputTokens,
        reasoningTokens: row.reasoningTokens,
        costUsd: row.costUsd,
        computedCostUsd: row.computedCostUsd,
        gatewayCostUsd: row.gatewayCostUsd ?? 0,
      })),
    };
  },
});

type EventRow = {
  runId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  costUsd: number;
  computedCostUsd: number;
  gatewayCostUsd: number;
};

function fold(into: EventSums & { runIds: Set<string> }, row: EventRow): void {
  into.inputTokens += row.inputTokens;
  into.outputTokens += row.outputTokens;
  into.cachedInputTokens += row.cachedInputTokens;
  into.reasoningTokens += row.reasoningTokens;
  into.costUsd = round8(into.costUsd + row.costUsd);
  into.computedCostUsd = round8(into.computedCostUsd + row.computedCostUsd);
  into.gatewayCostUsd = round8(into.gatewayCostUsd + row.gatewayCostUsd);
  into.stepCount += 1;
  into.runIds.add(row.runId);
  into.runCount = into.runIds.size;
}

/** Page through the scope's events, folding them into a total and a per-model split. */
async function scanEvents(
  ctx: ActionCtx,
  scope: { teamId?: Id<"teams">; leagueId?: Id<"leagues">; season: number; weekNo: number },
): Promise<{ total: EventSums; byModel: Map<string, EventSums> }> {
  const total = zeroSums();
  const byModel = new Map<string, EventSums & { runIds: Set<string> }>();
  let cursor: string | null = null;

  for (let page = 0; page < VERIFY_MAX_PAGES; page++) {
    const result: {
      page: EventRow[];
      isDone: boolean;
      continueCursor: string;
    } = await ctx.runQuery(internal.ledger.usagePage, {
      ...scope,
      paginationOpts: { numItems: VERIFY_PAGE_SIZE, cursor },
    });
    for (const row of result.page) {
      fold(total, row);
      const bucket = byModel.get(row.modelId) ?? zeroSums();
      fold(bucket, row);
      byModel.set(row.modelId, bucket);
    }
    if (result.isDone) break;
    cursor = result.continueCursor;
  }
  return { total, byModel };
}

/** The stored `team_week_rollups` row a team-week verification compares against. */
export const teamWeekRollup = internalQuery({
  args: { teamId: v.id("teams"), season: v.number(), weekNo: v.number() },
  handler: (ctx, args) =>
    ctx.db
      .query("team_week_rollups")
      .withIndex("by_teamId_season_weekNo", (q) =>
        q.eq("teamId", args.teamId).eq("season", args.season).eq("weekNo", args.weekNo),
      )
      .unique(),
});

/** The stored league-week rollup plus its per-league model rows. */
export const leagueWeekRollup = internalQuery({
  args: { leagueId: v.id("leagues"), season: v.number(), weekNo: v.number() },
  handler: async (ctx, args) => {
    const league = await ctx.db
      .query("league_week_rollups")
      .withIndex("by_leagueId_season_weekNo", (q) =>
        q.eq("leagueId", args.leagueId).eq("season", args.season).eq("weekNo", args.weekNo),
      )
      .unique();
    // Bounded: one row per model a league ran in one week (≤ the allowlist).
    const models = await ctx.db
      .query("model_week_rollups")
      .withIndex("by_leagueId_season_weekNo", (q) =>
        q.eq("leagueId", args.leagueId).eq("season", args.season).eq("weekNo", args.weekNo),
      )
      .take(50);
    return { league, models };
  },
});

/**
 * Re-sum a team-week's `usage_events` and compare with `team_week_rollups`.
 *
 * `fallbackCount` and `invalidActionCount` are deliberately not compared: they
 * are run-level facts the event rows do not carry, so a scan cannot reproduce them.
 */
export const verifyTeamWeek = internalAction({
  args: { teamId: v.id("teams"), season: v.number(), weekNo: v.number() },
  returns: verifyShape,
  handler: async (ctx, args): Promise<{ ok: boolean; diffs: LedgerDiff[] }> => {
    const { total } = await scanEvents(ctx, args);
    const stored: Doc<"team_week_rollups"> | null = await ctx.runQuery(
      internal.ledger.teamWeekRollup,
      args,
    );
    const diffs = compare("", stored, total);
    return { ok: diffs.length === 0, diffs };
  },
});

/**
 * Re-sum a league-week's `usage_events` and compare with `league_week_rollups`
 * and the per-league `model_week_rollups` rows.
 *
 * Diff fields are prefixed: `league.costUsd`, `model[openai/gpt-5].stepCount`.
 */
export const verifyLeagueWeek = internalAction({
  args: { leagueId: v.id("leagues"), season: v.number(), weekNo: v.number() },
  returns: verifyShape,
  handler: async (ctx, args): Promise<{ ok: boolean; diffs: LedgerDiff[] }> => {
    const { total, byModel } = await scanEvents(ctx, args);
    const stored: {
      league: Doc<"league_week_rollups"> | null;
      models: Array<Doc<"model_week_rollups">>;
    } = await ctx.runQuery(internal.ledger.leagueWeekRollup, args);

    const diffs = compare("league.", stored.league, total);
    const seen = new Set<string>();
    for (const row of stored.models) {
      seen.add(row.modelId);
      diffs.push(
        ...compare(
          `model[${row.modelId}].`,
          row,
          byModel.get(row.modelId) ?? zeroSums(),
        ),
      );
    }
    for (const [modelId, sums] of byModel) {
      if (seen.has(modelId)) continue;
      diffs.push(...compare(`model[${modelId}].`, null, sums));
    }
    return { ok: diffs.length === 0, diffs };
  },
});

/** Commissioner check + the league's teams, for the public `verify` action. */
export const verifyScope = internalQuery({
  args: { leagueId: v.id("leagues") },
  returns: v.object({
    season: v.number(),
    teams: v.array(v.object({ teamId: v.id("teams"), name: v.string() })),
  }),
  handler: async (ctx, { leagueId }) => {
    const { league } = await requireCommissioner(ctx, leagueId);
    // Bounded: ≤ 14 teams.
    const teams = await ctx.db
      .query("teams")
      .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
      .collect();
    return {
      season: league.season,
      teams: teams.map((team) => ({ teamId: team._id, name: team.name })),
    };
  },
});

export type LedgerVerifyReport = {
  leagueId: Id<"leagues">;
  season: number;
  weekNo: number;
  ok: boolean;
  league: { ok: boolean; diffs: LedgerDiff[] };
  teams: Array<{ teamId: Id<"teams">; teamName: string; ok: boolean; diffs: LedgerDiff[] }>;
};

/**
 * The commissioner's "verify" button (PRD 5.9): re-sum every `usage_events` row
 * for the week and prove the dashboards' rollups match it.
 *
 * Public, commissioner-only, and read-only — it reports drift, it never repairs it.
 */
export const verify = action({
  args: { leagueId: v.id("leagues"), weekNo: v.number() },
  returns: v.object({
    leagueId: v.id("leagues"),
    season: v.number(),
    weekNo: v.number(),
    ok: v.boolean(),
    league: verifyShape,
    teams: v.array(
      v.object({
        teamId: v.id("teams"),
        teamName: v.string(),
        ok: v.boolean(),
        diffs: v.array(diffShape),
      }),
    ),
  }),
  handler: async (ctx, { leagueId, weekNo }): Promise<LedgerVerifyReport> => {
    const scope: {
      season: number;
      teams: Array<{ teamId: Id<"teams">; name: string }>;
    } = await ctx.runQuery(internal.ledger.verifyScope, { leagueId });
    const season = scope.season;

    const league: { ok: boolean; diffs: LedgerDiff[] } = await ctx.runAction(
      internal.ledger.verifyLeagueWeek,
      { leagueId, season, weekNo },
    );

    const teams: LedgerVerifyReport["teams"] = [];
    // Bounded: ≤ 14 teams.
    for (const team of scope.teams) {
      const result: { ok: boolean; diffs: LedgerDiff[] } = await ctx.runAction(
        internal.ledger.verifyTeamWeek,
        { teamId: team.teamId, season, weekNo },
      );
      teams.push({ teamId: team.teamId, teamName: team.name, ...result });
    }

    return {
      leagueId,
      season,
      weekNo,
      ok: league.ok && teams.every((team) => team.ok),
      league,
      teams,
    };
  },
});
