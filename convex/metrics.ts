/**
 * The film room (PRD §5.5) — the port of `lib/services/cost/film-room.ts`.
 *
 * The owner's Tuesday landing page: what the agent did last week, how well it
 * did it, and what it cost. Lineup efficiency is a *decision-quality* metric,
 * not hindsight: the optimal lineup is the best call available from the week's
 * snapshot, scored on the same basis as the lineup the agent actually set.
 *
 * `team_week_metrics` (written by the window-close mutation in Phase 5) is used
 * for the headline figures when it exists; the slot-by-slot breakdown always
 * comes from the stored snapshot plus `convex/lib/lineup_pure.ts`, which is the
 * same code the runtime uses.
 */
import { v } from "convex/values";

import type { LineupSlot, SnapshotPayload } from "../lib/snapshot/types";
import type { Doc, Id } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import { requireLeagueRead } from "./lib/auth";
import { appError } from "./lib/errors";
import {
  BENCH_SLOTS,
  computeOptimalLineup,
  lineupEfficiency,
  pointsLeftOnBench,
  projectedPoints,
  startingOnly,
} from "./lib/lineup_pure";
import { budgetStatus, type BudgetStatus, type SpendTotals } from "./ledger";
import { readPayload } from "./snapshot";

const MAX_WEEK = 22;
const MAX_TEAM_TRADES_SCAN = 100;

export type FilmRoomRun = {
  runId: Id<"runs">;
  windowLabel: string;
  windowType: string;
  opensAt: number;
  status: string;
  outcome: string | null;
  rationale: string | null;
  stepCount: number;
  costUsd: number;
  modelId: string;
  fallback: string | null;
};

export type FilmRoomSlot = {
  slot: string;
  playerId: string | null;
  playerName: string | null;
  points: number;
};

export type FilmRoomEfficiency = {
  /** "actual" once the week has stat lines; "projected" while it is still open. */
  basis: "actual" | "projected";
  actual: number;
  optimal: number;
  efficiency: number;
  pointsLeftOnBench: number;
  actualSlots: FilmRoomSlot[];
  optimalSlots: FilmRoomSlot[];
  snapshotTakenAt: number;
  /** True when the headline figures came from `team_week_metrics`. */
  fromMetrics: boolean;
};

export type FilmRoomWaiver = {
  id: Id<"waiver_claims">;
  addPlayerName: string | null;
  dropPlayerName: string | null;
  bid: number;
  status: string;
  resultReason: string | null;
  runId: Id<"runs"> | null;
};

export type FilmRoomTrade = {
  id: Id<"trades">;
  status: string;
  counterpartyName: string | null;
  proposedByMe: boolean;
  fairnessScore: number | null;
  flagged: boolean;
  createdAt: number;
};

export type FilmRoom = {
  team: {
    id: Id<"teams">;
    name: string;
    abbreviation: string;
    ownerUserId: Id<"users"> | null;
  };
  leagueId: Id<"leagues">;
  weekNo: number;
  /** Every week that has data, for the week picker. */
  availableWeeks: number[];
  runs: FilmRoomRun[];
  efficiency: FilmRoomEfficiency | null;
  /** Why efficiency is null, for the "n/a" copy. */
  efficiencyUnavailableReason: string | null;
  result: {
    pointsFor: number;
    pointsAgainst: number;
    won: boolean;
    lost: boolean;
    tied: boolean;
  } | null;
  waivers: FilmRoomWaiver[];
  trades: FilmRoomTrade[];
  spend: SpendTotals & { teamId: Id<"teams">; weekNo: number };
  seasonSpend: number;
  budget: BudgetStatus;
  noteToAgent: string | null;
};

function scoreWith(slots: LineupSlot[], points: Record<string, number>): number {
  let total = 0;
  for (const entry of startingOnly(slots)) {
    if (entry.playerId) total += points[entry.playerId] ?? 0;
  }
  return Math.round(total * 100) / 100;
}

/** The most recently *finished* league week, falling back to the first week. */
async function defaultFilmRoomWeek(
  ctx: QueryCtx,
  leagueId: Id<"leagues">,
  now: number,
): Promise<{ weekNo: number; weeks: number[] }> {
  // Bounded: a season has at most ~22 weeks.
  const weeks = await ctx.db
    .query("weeks")
    .withIndex("by_leagueId_weekNo", (q) => q.eq("leagueId", leagueId))
    .take(MAX_WEEK + 1);
  const ordered = weeks.slice().sort((a, b) => a.weekNo - b.weekNo);
  const finished = ordered.filter((week) => week.endsAt <= now);
  return {
    weekNo: finished.at(-1)?.weekNo ?? ordered[0]?.weekNo ?? 1,
    weeks: ordered.map((week) => week.weekNo),
  };
}

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

export const filmRoom = query({
  args: { teamId: v.id("teams"), weekNo: v.optional(v.number()) },
  handler: async (ctx, args): Promise<FilmRoom> => {
    const team = await ctx.db.get("teams", args.teamId);
    if (!team) throw appError("NOT_FOUND", "Team not found");
    const { league } = await requireLeagueRead(ctx, team.leagueId);
    const now = Date.now();

    const defaults = await defaultFilmRoomWeek(ctx, team.leagueId, now);
    const weekNo = args.weekNo ?? defaults.weekNo;

    // ---- runs for the team-week (weekNo is denormalised onto the run)
    const runRows = await ctx.db
      .query("runs")
      .withIndex("by_leagueId_teamId", (q) =>
        q.eq("leagueId", team.leagueId).eq("teamId", args.teamId),
      )
      .filter((q) => q.eq(q.field("weekNo"), weekNo))
      .take(60);
    const runs: FilmRoomRun[] = [];
    for (const run of runRows) {
      const window = await ctx.db.get("windows", run.windowId);
      runs.push({
        runId: run._id,
        windowLabel: run.windowLabel,
        windowType: run.windowType,
        opensAt: window?.opensAt ?? run._creationTime,
        status: run.status,
        outcome: run.outcome ?? null,
        rationale: run.rationale ?? null,
        stepCount: run.stepCount,
        costUsd: run.totalCostUsd ?? 0,
        modelId: run.modelId,
        fallback: run.fallbackApplied?.kind ?? null,
      });
    }
    runs.sort((a, b) => a.opensAt - b.opensAt);

    // ---- lineup efficiency
    let efficiency: FilmRoomEfficiency | null = null;
    let efficiencyUnavailableReason: string | null = null;

    const snapshot = await snapshotForWeek(ctx, team.leagueId, weekNo);
    if (!snapshot) {
      efficiencyUnavailableReason = `No snapshot was stored for week ${weekNo}, so there is nothing to compare against.`;
    } else if (!snapshot.payload.teams.some((t) => t.id === args.teamId)) {
      efficiencyUnavailableReason = `This team is not in week ${weekNo}'s snapshot.`;
    } else {
      const payload = snapshot.payload;
      const snapshotTeam = payload.teams.find((t) => t.id === args.teamId)!;
      const stored = await ctx.db
        .query("lineups")
        .withIndex("by_teamId_weekNo_version", (q) =>
          q.eq("teamId", args.teamId).eq("weekNo", weekNo),
        )
        .order("desc")
        .first();
      const actualSlots: LineupSlot[] = stored
        ? stored.slots.map((s) => ({ slot: s.slot, playerId: s.playerId as string | null }))
        : (snapshotTeam.lineup ?? []);
      const optimalSlots = computeOptimalLineup({
        snapshot: payload,
        teamId: args.teamId,
        current: actualSlots,
        now: new Date(payload.takenAt),
      });

      const rosterIds = snapshotTeam.rosterPlayerIds ?? [];
      const actualPoints: Record<string, number> = {};
      for (const playerId of rosterIds) {
        const stat = await ctx.db
          .query("player_stats_weekly")
          .withIndex("by_playerId_season_week", (q) =>
            q
              .eq("playerId", playerId as Id<"players">)
              .eq("season", league.season)
              .eq("week", weekNo),
          )
          .first();
        if (!stat) continue;
        const preset = payload.rules.scoringPreset;
        actualPoints[playerId] =
          preset === "half_ppr"
            ? stat.fantasyPointsHalf
            : preset === "standard"
              ? stat.fantasyPointsStd
              : stat.fantasyPointsPpr;
      }

      const haveActuals = Object.values(actualPoints).some((value) => value !== 0);
      const points: Record<string, number> = haveActuals
        ? actualPoints
        : Object.fromEntries(
            rosterIds.map((id) => [
              id,
              projectedPoints(payload.players[id], payload.rules.scoringPreset),
            ]),
          );

      const metrics = await ctx.db
        .query("team_week_metrics")
        .withIndex("by_teamId_season_weekNo", (q) =>
          q.eq("teamId", args.teamId).eq("season", league.season).eq("weekNo", weekNo),
        )
        .unique();

      const computedActual = scoreWith(actualSlots, points);
      const computedOptimal = scoreWith(optimalSlots, points);
      const useMetrics =
        metrics !== null &&
        typeof metrics.actualPoints === "number" &&
        typeof metrics.optimalPoints === "number";
      const actual = useMetrics ? (metrics!.actualPoints as number) : computedActual;
      const optimal = useMetrics ? (metrics!.optimalPoints as number) : computedOptimal;

      const nameOf = (id: string | null) => (id ? (payload.players[id]?.fullName ?? null) : null);
      const decorate = (slots: LineupSlot[]): FilmRoomSlot[] =>
        startingOnly(slots).map((s) => ({
          slot: s.slot,
          playerId: s.playerId,
          playerName: nameOf(s.playerId),
          points: s.playerId ? Math.round((points[s.playerId] ?? 0) * 100) / 100 : 0,
        }));

      efficiency = {
        basis: haveActuals ? "actual" : "projected",
        actual,
        optimal,
        efficiency: metrics?.lineupEfficiency ?? lineupEfficiency({ actual, optimal }),
        pointsLeftOnBench: metrics?.pointsLeftOnBench ?? pointsLeftOnBench({ actual, optimal }),
        actualSlots: decorate(actualSlots),
        optimalSlots: decorate(optimalSlots),
        snapshotTakenAt: snapshot.row.takenAt,
        fromMetrics: useMetrics,
      };
    }

    // ---- waivers
    const claimRows = await ctx.db
      .query("waiver_claims")
      .withIndex("by_teamId_weekNo", (q) => q.eq("teamId", args.teamId).eq("weekNo", weekNo))
      .take(50);
    const waivers: FilmRoomWaiver[] = [];
    for (const claim of claimRows.sort((a, b) => a.priority - b.priority)) {
      const add = await ctx.db.get("players", claim.addPlayerId);
      const drop = claim.dropPlayerId ? await ctx.db.get("players", claim.dropPlayerId) : null;
      waivers.push({
        id: claim._id,
        addPlayerName: add?.fullName ?? null,
        dropPlayerName: drop?.fullName ?? null,
        bid: claim.bid,
        status: claim.status,
        resultReason: claim.resultReason ?? null,
        runId: claim.runId ?? null,
      });
    }

    // ---- trades this team is a party to (newest first)
    const tradeRows = await ctx.db
      .query("trades")
      .withIndex("by_leagueId", (q) => q.eq("leagueId", team.leagueId))
      .order("desc")
      .take(MAX_TEAM_TRADES_SCAN);
    const trades: FilmRoomTrade[] = [];
    for (const trade of tradeRows) {
      const mine =
        trade.proposerTeamId === args.teamId || trade.recipientTeamId === args.teamId;
      if (!mine) continue;
      const counterpartyId =
        trade.proposerTeamId === args.teamId ? trade.recipientTeamId : trade.proposerTeamId;
      const counterparty = await ctx.db.get("teams", counterpartyId);
      trades.push({
        id: trade._id,
        status: trade.status,
        counterpartyName: counterparty?.name ?? null,
        proposedByMe: trade.proposerTeamId === args.teamId,
        fairnessScore: trade.fairnessScore ?? null,
        flagged: trade.flagged,
        createdAt: trade._creationTime,
      });
      if (trades.length >= 20) break;
    }

    // ---- spend, result, note
    const weekRollup = await ctx.db
      .query("team_week_rollups")
      .withIndex("by_teamId_season_weekNo", (q) =>
        q.eq("teamId", args.teamId).eq("season", league.season).eq("weekNo", weekNo),
      )
      .unique();
    let seasonSpend = 0;
    for (let week = 0; week <= MAX_WEEK; week++) {
      const row = await ctx.db
        .query("team_week_rollups")
        .withIndex("by_teamId_season_weekNo", (q) =>
          q.eq("teamId", args.teamId).eq("season", league.season).eq("weekNo", week),
        )
        .unique();
      if (row) seasonSpend += row.costUsd;
    }

    const result = await ctx.db
      .query("team_results")
      .withIndex("by_teamId_weekNo", (q) => q.eq("teamId", args.teamId).eq("weekNo", weekNo))
      .first();
    const config = await ctx.db
      .query("agent_configs")
      .withIndex("by_teamId", (q) => q.eq("teamId", args.teamId))
      .unique();

    return {
      team: {
        id: team._id,
        name: team.name,
        abbreviation: team.abbreviation,
        ownerUserId: team.ownerUserId ?? null,
      },
      leagueId: team.leagueId,
      weekNo,
      availableWeeks: defaults.weeks,
      runs,
      efficiency,
      efficiencyUnavailableReason,
      result: result
        ? {
            pointsFor: result.pointsFor,
            pointsAgainst: result.pointsAgainst,
            won: result.won,
            lost: result.lost,
            tied: result.tied,
          }
        : null,
      waivers,
      trades,
      spend: {
        usd: weekRollup?.costUsd ?? 0,
        tokens: weekRollup ? weekRollup.inputTokens + weekRollup.outputTokens : 0,
        inputTokens: weekRollup?.inputTokens ?? 0,
        outputTokens: weekRollup?.outputTokens ?? 0,
        runCount: weekRollup?.runCount ?? 0,
        stepCount: weekRollup?.stepCount ?? 0,
        teamId: args.teamId,
        weekNo,
      },
      seasonSpend,
      budget: await budgetStatus(ctx, team, league.season, weekNo),
      noteToAgent: config?.noteToAgent ?? null,
    };
  },
});

/** Re-exported so callers do not need to know where the bench labels live. */
export { BENCH_SLOTS };
