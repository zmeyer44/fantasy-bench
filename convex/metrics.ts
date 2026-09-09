/**
 * Process metrics (PRD §5.12): the `team_week_metrics` writer that runs when a
 * window closes. Lineup efficiency is a *decision-quality* metric, not
 * hindsight: the optimal lineup is the best call available from the week's
 * snapshot, scored on the same basis as the lineup the agent actually set. The
 * slot logic is `convex/lib/lineup_pure.ts`, the same code the runtime uses.
 */
import { v } from "convex/values";

import type { LineupSlot, SnapshotPayload } from "../lib/snapshot/types";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import { appError } from "./lib/errors";
import {
  computeOptimalLineup,
  lineupEfficiency,
  pointsLeftOnBench,
  projectedPoints,
  startingOnly,
} from "./lib/lineup_pure";
import { runStatus } from "./schema";
import { readPayload } from "./snapshot";

/** The last snapshot taken for a league week — the fullest picture the agent saw. */
async function snapshotForWeek(
  ctx: QueryCtx,
  leagueId: Id<"leagues">,
  weekNo: number,
): Promise<{ row: Doc<"snapshots">; payload: SnapshotPayload } | null> {
  const rows = await ctx.db
    .query("snapshots")
    .withIndex("by_leagueId_takenAt", (q) => q.eq("leagueId", leagueId))
    .order("desc")
    .take(40);
  const row = rows.find((snapshot) => snapshot.weekNo === weekNo && snapshot.status === "ready");
  if (!row) return null;
  const payload = await readPayload(ctx, row._id);
  return payload ? { row, payload } : null;
}

/** Sum a lineup's starters under a points table (actuals or projections). */
function scoreWith(slots: LineupSlot[], points: Record<string, number>): number {
  let total = 0;
  for (const entry of startingOnly(slots)) {
    if (entry.playerId) total += points[entry.playerId] ?? 0;
  }
  return Math.round(total * 100) / 100;
}

// ===========================================================================
// Phase 4 — the process-metrics writer (PRD §5.12)
// ===========================================================================

/**
 * The measurable half of `team_week_metrics`. Every figure is optional except the
 * two run counters: a team-week always has a run count, but a week that never
 * produced a stat line has no efficiency to report yet.
 */
export const teamWeekMetricValues = v.object({
  actualPoints: v.optional(v.number()),
  optimalPoints: v.optional(v.number()),
  lineupEfficiency: v.optional(v.number()),
  projectionCapture: v.optional(v.number()),
  pointsLeftOnBench: v.optional(v.number()),
  waiverValue: v.optional(v.number()),
  tradeDelta: v.optional(v.number()),
  invalidActionRate: v.optional(v.number()),
  runCount: v.number(),
  fallbackCount: v.number(),
});

async function upsertTeamWeek(
  ctx: MutationCtx,
  args: {
    leagueId: Id<"leagues">;
    teamId: Id<"teams">;
    season: number;
    weekNo: number;
    values: {
      actualPoints?: number;
      optimalPoints?: number;
      lineupEfficiency?: number;
      projectionCapture?: number;
      pointsLeftOnBench?: number;
      waiverValue?: number;
      tradeDelta?: number;
      invalidActionRate?: number;
      runCount: number;
      fallbackCount: number;
    };
  },
): Promise<Id<"team_week_metrics">> {
  const existing = await ctx.db
    .query("team_week_metrics")
    .withIndex("by_teamId_season_weekNo", (q) =>
      q.eq("teamId", args.teamId).eq("season", args.season).eq("weekNo", args.weekNo),
    )
    .unique();
  const doc = {
    leagueId: args.leagueId,
    teamId: args.teamId,
    season: args.season,
    weekNo: args.weekNo,
    ...args.values,
    updatedAt: Date.now(),
  };
  if (existing) {
    // `replace`, not `patch`: a recomputation that no longer has a figure must
    // clear the stale one rather than leave the old value standing.
    await ctx.db.replace("team_week_metrics", existing._id, doc);
    return existing._id;
  }
  return ctx.db.insert("team_week_metrics", doc);
}

/** Upsert one team-week's process metrics. The only writer of `team_week_metrics`. */
export const writeTeamWeek = internalMutation({
  args: {
    leagueId: v.id("leagues"),
    teamId: v.id("teams"),
    season: v.number(),
    weekNo: v.number(),
    values: teamWeekMetricValues,
  },
  returns: v.id("team_week_metrics"),
  handler: (ctx, args) => upsertTeamWeek(ctx, args),
});

/** Every `runStatus` literal, so a window's runs can be read through `by_windowId_status`. */
const RUN_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "partial",
  "failed",
  "timed_out",
  "fallback",
  "skipped",
] as const satisfies readonly (typeof runStatus.type)[];

/** Runs per (window, status) read before the scan gives up. 14 teams + retries. */
const RUNS_PER_STATUS = 40;
/** Roster slots scanned for stat lines per team. */
const MAX_ROSTER = 40;

/**
 * Compute and store `team_week_metrics` for every team of a closing window.
 *
 * Called from `internal.windows.close` (Phase 5) once the window's runs are
 * terminal. Idempotent: it recomputes from stored state, so a re-close — or a
 * second call after the week's stat lines land — simply overwrites the row.
 *
 * Efficiency is a *decision-quality* metric: the optimal lineup is the best call
 * available from the window's own snapshot (`convex/lib/lineup_pure.ts`, the same
 * code the runtime uses), and both lineups are then scored on actual stat lines.
 * Before those exist there is nothing honest to compare, so the four points
 * fields are left unset until stat lines land.
 */
export const computeForWindowClose = internalMutation({
  args: { windowId: v.id("windows") },
  returns: v.object({ teamCount: v.number(), weekNo: v.number() }),
  handler: async (ctx, { windowId }) => {
    const window = await ctx.db.get("windows", windowId);
    if (!window) throw appError("NOT_FOUND", "Window not found");
    const league = await ctx.db.get("leagues", window.leagueId);
    if (!league) throw appError("NOT_FOUND", "League not found");
    const season = league.season;
    const weekNo = window.weekNo;

    // ---- the window's runs, by team. Bounded: 8 statuses × RUNS_PER_STATUS.
    const runsByTeam = new Map<string, Array<Doc<"runs">>>();
    for (const status of RUN_STATUSES) {
      const rows = await ctx.db
        .query("runs")
        .withIndex("by_windowId_status", (q) => q.eq("windowId", windowId).eq("status", status))
        .take(RUNS_PER_STATUS);
      for (const run of rows) {
        if (!run.teamId) continue; // commissioner runs have no team-week metric
        const key = run.teamId as string;
        runsByTeam.set(key, [...(runsByTeam.get(key) ?? []), run]);
      }
    }

    // ---- the snapshot the agents actually saw for this window
    const payload = window.snapshotId
      ? await readPayload(ctx, window.snapshotId)
      : ((await snapshotForWeek(ctx, window.leagueId, weekNo))?.payload ?? null);

    // Bounded: ≤ 14 teams.
    const teams = await ctx.db
      .query("teams")
      .withIndex("by_leagueId", (q) => q.eq("leagueId", window.leagueId))
      .collect();

    for (const team of teams) {
      const runs = runsByTeam.get(team._id as string) ?? [];
      const runCount = runs.length;
      const fallbackCount = runs.filter(
        (run) => run.fallbackApplied != null || run.status === "fallback",
      ).length;
      const committed = runs.reduce((sum, run) => sum + run.committedActionCount, 0);
      const rejected = runs.reduce((sum, run) => sum + run.rejectedActionCount, 0);
      const attempted = committed + rejected;
      const invalidActionRate = attempted > 0 ? rejected / attempted : undefined;

      let actualPoints: number | undefined;
      let optimalPoints: number | undefined;
      let efficiency: number | undefined;
      let leftOnBench: number | undefined;
      let projectionCapture: number | undefined;

      const snapshotTeam = payload?.teams.find((entry) => entry.id === team._id);
      if (payload && snapshotTeam) {
        const stored = await ctx.db
          .query("lineups")
          .withIndex("by_teamId_weekNo_version", (q) =>
            q.eq("teamId", team._id).eq("weekNo", weekNo),
          )
          .order("desc")
          .first();
        const actualSlots: LineupSlot[] = stored
          ? stored.slots.map((slot) => ({ slot: slot.slot, playerId: slot.playerId as string | null }))
          : (snapshotTeam.lineup ?? []);

        const rosterIds = (snapshotTeam.rosterPlayerIds ?? []).slice(0, MAX_ROSTER);
        const actuals: Record<string, number> = {};
        let haveActuals = false;
        // Bounded: one roster's players.
        for (const playerId of rosterIds) {
          const stat = await ctx.db
            .query("player_stats_weekly")
            .withIndex("by_playerId_season_week", (q) =>
              q.eq("playerId", playerId as Id<"players">).eq("season", season).eq("week", weekNo),
            )
            .first();
          if (!stat) continue;
          const preset = payload.rules.scoringPreset;
          actuals[playerId] =
            preset === "half_ppr"
              ? stat.fantasyPointsHalf
              : preset === "standard"
                ? stat.fantasyPointsStd
                : stat.fantasyPointsPpr;
          haveActuals = true;
        }

        if (haveActuals) {
          const optimalSlots = computeOptimalLineup({
            snapshot: payload,
            teamId: team._id,
            current: actualSlots,
            now: new Date(payload.takenAt),
          });
          actualPoints = scoreWith(actualSlots, actuals);
          optimalPoints = scoreWith(optimalSlots, actuals);
          efficiency = lineupEfficiency({ actual: actualPoints, optimal: optimalPoints });
          leftOnBench = pointsLeftOnBench({ actual: actualPoints, optimal: optimalPoints });

          // How much of what the agent was *promised* it actually banked: the
          // started lineup's real points over the same lineup's projection.
          const projected = scoreWith(
            actualSlots,
            Object.fromEntries(
              rosterIds.map((id) => [
                id,
                projectedPoints(payload.players[id], payload.rules.scoringPreset),
              ]),
            ),
          );
          projectionCapture = projected > 0 ? Math.round((actualPoints / projected) * 1e4) / 1e4 : undefined;
        }
      }

      await upsertTeamWeek(ctx, {
        leagueId: window.leagueId,
        teamId: team._id,
        season,
        weekNo,
        values: {
          actualPoints,
          optimalPoints,
          lineupEfficiency: efficiency,
          projectionCapture,
          pointsLeftOnBench: leftOnBench,
          // v1: waiver value and trade delta need a "what would this roster have
          // scored without the move" counterfactual across the rest of the season.
          // Deliberately unset until that model exists (PRD 5.12 second pass).
          waiverValue: undefined,
          tradeDelta: undefined,
          invalidActionRate,
          runCount,
          fallbackCount,
        },
      });
    }

    return { teamCount: teams.length, weekNo };
  },
});
