/**
 * The live draft board (PRD §5.2).
 *
 * Reactive by construction: the page subscribes to this query, which replaces
 * the old 15-second `draft-refresher` poll. Every read is one bounded index
 * range (a draft is at most 14 teams × 16 rounds = 224 picks).
 */
import { v } from "convex/values";

import { findModel, leagueDefaultModelId } from "../lib/models";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { agentCtxValidator, fail, withAgentAction } from "./lib/agent_action";
import { appError } from "./lib/errors";
import { requireLeagueRead } from "./lib/auth";
import {
  resolveSealedBids,
  rosterCapacity,
  seededShuffle,
  snakeBoard,
  validatePickPosition,
} from "./lib/draft_pure";
import { computeOptimalLineup } from "./lib/lineup_pure";
import { withLiveRosterOwnership } from "./lib/snapshot_live";
import { round2 } from "./lib/views_shared";
import { draftType } from "./schema";
import { PROJECTION_SOURCES, readPayload } from "./snapshot";
import { currentWeekNoFor } from "./weeks";

/** 14 teams × 16 rounds, the largest draft the rules allow. */
const MAX_PICKS = 300;
/** The largest league the rules allow. */
const MAX_TEAMS = 20;

export type DraftBoardPick = {
  id: Id<"draft_picks">;
  round: number;
  pickNo: number;
  overallNo: number;
  teamId: Id<"teams">;
  teamName: string;
  teamAbbreviation: string;
  playerId: Id<"players"> | null;
  playerName: string | null;
  position: string | null;
  nflTeam: string | null;
  price: number | null;
  auto: boolean;
  rationale: string | null;
  runId: Id<"runs"> | null;
  costUsd: number | null;
  madeAt: number | null;
};

export type DraftBoard = {
  leagueId: Id<"leagues">;
  draftType: Doc<"leagues">["draftType"];
  status: Doc<"leagues">["status"];
  scheduledAt: number | null;
  rounds: number;
  teams: Array<{ id: Id<"teams">; name: string; abbreviation: string; slotIndex: number }>;
  picks: DraftBoardPick[];
  /** `grid[round - 1][slotIndex]` — the pick for that cell, or null. */
  grid: Array<Array<DraftBoardPick | null>>;
  onTheClock: {
    teamId: Id<"teams">;
    teamName: string;
    overallNo: number;
    round: number;
    pickNo: number;
    deadlineAt: number | null;
  } | null;
  picksMade: number;
  totalPicks: number;
  runningCostUsd: number;
  auction: {
    phase: "setup" | "nomination" | "bidding" | "complete";
    currentLot: {
      lotNo: number;
      status: "pending" | "bidding";
      nominatorTeamId: Id<"teams">;
      nominatorTeamName: string;
      nominatorTeamAbbreviation: string;
      playerId: Id<"players"> | null;
      playerName: string | null;
      position: string | null;
      nflTeam: string | null;
      openingBid: number;
      deadlineAt: number | null;
      nominationRunId: Id<"runs"> | null;
    } | null;
    budgets: Array<{
      teamId: Id<"teams">;
      teamName: string;
      abbreviation: string;
      remaining: number;
    }>;
    bidsSealed: true;
  } | null;
  startReview: {
    teamCount: number;
    rosterSize: number;
    totalRosterSpots: number;
    scoringPreset: Doc<"league_rules">["scoringPreset"];
    superflex: boolean;
    tePremium: boolean;
    draftPickSeconds: number;
    draftBudget: number;
    unownedTeams: number;
    modelAssignments: Array<{ modelId: string; teamCount: number; paid: boolean }>;
  };
};

export const board = query({
  args: { leagueId: v.id("leagues") },
  handler: async (ctx, { leagueId }): Promise<DraftBoard> => {
    const { league } = await requireLeagueRead(ctx, leagueId);
    const rules = await leagueRules(ctx, leagueId);
    if (!rules) throw appError("NOT_FOUND", "League rules not found.");

    // Bounded: ≤ 14 teams.
    const teamRows = (
      await ctx.db
        .query("teams")
        .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
        .collect()
    ).sort((a, b) => a.waiverPriority - b.waiverPriority);
    const teamById = new Map(teamRows.map((t) => [t._id as string, t]));

    const modelCounts = new Map<string, number>();
    for (const team of teamRows) {
      const config = await ctx.db
        .query("agent_configs")
        .withIndex("by_teamId", (q) => q.eq("teamId", team._id))
        .unique();
      const version = config?.currentVersionId
        ? await ctx.db.get("config_versions", config.currentVersionId)
        : null;
      const modelId = version?.modelId ?? leagueDefaultModelId(rules.modelAllowlist);
      modelCounts.set(modelId, (modelCounts.get(modelId) ?? 0) + 1);
    }

    const pickRows = await ctx.db
      .query("draft_picks")
      .withIndex("by_leagueId_overallNo", (q) => q.eq("leagueId", leagueId))
      .take(MAX_PICKS);

    const picks: DraftBoardPick[] = [];
    let runningCostUsd = 0;
    const countedRuns = new Set<string>();
    for (const row of pickRows) {
      const player = row.playerId ? await ctx.db.get("players", row.playerId) : null;
      const run = row.madeByRunId ? await ctx.db.get("runs", row.madeByRunId) : null;
      if (run && !countedRuns.has(run._id)) {
        countedRuns.add(run._id);
        runningCostUsd += run.totalCostUsd ?? 0;
      }
      picks.push({
        id: row._id,
        round: row.round,
        pickNo: row.pickNo,
        overallNo: row.overallNo,
        teamId: row.teamId,
        teamName: teamById.get(row.teamId)?.name ?? "Unknown",
        teamAbbreviation: teamById.get(row.teamId)?.abbreviation ?? "??",
        playerId: row.playerId ?? null,
        playerName: player?.fullName ?? null,
        position: player?.position ?? null,
        nflTeam: player?.nflTeam ?? null,
        price: row.price ?? null,
        auto: row.auto,
        rationale: row.rationale ?? null,
        runId: row.madeByRunId ?? null,
        costUsd: run?.totalCostUsd ?? null,
        madeAt: row.madeAt ?? null,
      });
    }
    picks.sort((a, b) => a.overallNo - b.overallNo);

    // Draft-order slot index comes from round 1, falling back to waiver priority
    // so the grid still lines up before the order is generated.
    const roundOne = picks.filter((p) => p.round === 1).sort((a, b) => a.pickNo - b.pickNo);
    const slotOrder =
      league.draftType === "snake" && roundOne.length > 0
        ? roundOne.map((p) => p.teamId)
        : teamRows.map((t) => t._id);
    const boardTeams = slotOrder
      .map((teamId, index) => {
        const team = teamById.get(teamId);
        return team
          ? { id: team._id, name: team.name, abbreviation: team.abbreviation, slotIndex: index }
          : null;
      })
      .filter((t): t is NonNullable<typeof t> => t !== null);
    const slotIndexByTeam = new Map(boardTeams.map((t) => [t.id as string, t.slotIndex]));

    const rounds = league.draftType === "snake"
      ? picks.reduce((max, pick) => Math.max(max, pick.round), 0)
      : rosterCapacity(rules.rosterSlots);
    const grid: Array<Array<DraftBoardPick | null>> = league.draftType === "auction"
      ? []
      : Array.from({ length: rounds }, () =>
          new Array<DraftBoardPick | null>(boardTeams.length).fill(null),
        );
    if (league.draftType === "snake") {
      for (const pick of picks) {
        const slot = slotIndexByTeam.get(pick.teamId);
        if (slot === undefined || pick.round < 1 || pick.round > rounds) continue;
        grid[pick.round - 1]![slot] = pick;
      }
    }

    // On the clock = the lowest unmade pick. Its deadline is the open draft window's close.
    const next = league.draftType === "snake"
      ? picks.find((pick) => pick.playerId === null) ?? null
      : null;
    let onTheClock: DraftBoard["onTheClock"] = null;
    if (next && league.status === "drafting") {
      const openWindows: Doc<"windows">[] = [];
      for (const status of ["scheduled", "open", "closing"] as const) {
        openWindows.push(
          ...(await ctx.db
            .query("windows")
            .withIndex("by_leagueId_status", (q) =>
              q.eq("leagueId", leagueId).eq("status", status),
            )
            .take(20)),
        );
      }
      const draftWindow = openWindows
        .filter((w) => w.type === "draft")
        .sort((a, b) => a.closesAt - b.closesAt)[0];
      onTheClock = {
        teamId: next.teamId,
        teamName: next.teamName,
        overallNo: next.overallNo,
        round: next.round,
        pickNo: next.pickNo,
        deadlineAt: draftWindow?.closesAt ?? null,
      };
    }

    let auction: DraftBoard["auction"] = null;
    if (league.draftType === "auction") {
      const lots = await ctx.db
        .query("auction_nominations")
        .withIndex("by_leagueId_lotNo", (q) => q.eq("leagueId", leagueId))
        .take(MAX_PICKS);
      const activeLot = lots
        .filter((lot) => lot.status === "pending" || lot.status === "bidding")
        .sort((a, b) => a.lotNo - b.lotNo)[0] ?? null;
      const activeWindows: Doc<"windows">[] = [];
      for (const status of ["scheduled", "open", "closing"] as const) {
        activeWindows.push(
          ...(await ctx.db
            .query("windows")
            .withIndex("by_leagueId_status", (q) => q.eq("leagueId", leagueId).eq("status", status))
            .take(20)),
        );
      }
      const activeWindow = activeLot
        ? activeWindows
            .filter(
              (window) =>
                window.type === "draft" &&
                window.roundNo === activeLot.lotNo &&
                window.label === (activeLot.status === "pending" ? "auction_nominate" : "auction_bid"),
            )
            .sort((a, b) => a.closesAt - b.closesAt)[0] ?? null
        : null;
      const player = activeLot?.playerId ? await ctx.db.get("players", activeLot.playerId) : null;
      const nominator = activeLot ? teamById.get(activeLot.nominatingTeamId) : null;
      const phase = league.status === "complete" || league.status === "in_season"
        ? "complete"
        : activeLot?.status === "bidding"
          ? "bidding"
          : activeLot?.status === "pending"
            ? "nomination"
            : "setup";

      auction = {
        phase,
        currentLot: activeLot && nominator
          ? {
              lotNo: activeLot.lotNo,
              status: activeLot.status as "pending" | "bidding",
              nominatorTeamId: nominator._id,
              nominatorTeamName: nominator.name,
              nominatorTeamAbbreviation: nominator.abbreviation,
              playerId: activeLot.playerId ?? null,
              playerName: player?.fullName ?? null,
              position: player?.position ?? null,
              nflTeam: player?.nflTeam ?? null,
              openingBid: activeLot.openingBid,
              deadlineAt: activeWindow?.closesAt ?? null,
              nominationRunId: activeLot.runId ?? null,
            }
          : null,
        budgets: teamRows.map((team) => ({
          teamId: team._id,
          teamName: team.name,
          abbreviation: team.abbreviation,
          remaining: team.draftBudgetRemaining ?? rules.draftBudget,
        })),
        bidsSealed: true,
      };
    }

    const rosterSize = rosterCapacity(rules.rosterSlots);
    const totalPicks = league.draftType === "auction" ? rosterSize * teamRows.length : picks.length;

    return {
      leagueId,
      draftType: league.draftType,
      status: league.status,
      scheduledAt: league.draftScheduledAt ?? null,
      rounds,
      teams: boardTeams,
      picks,
      grid,
      onTheClock,
      picksMade: picks.filter((p) => p.playerId !== null).length,
      totalPicks,
      runningCostUsd: round2(runningCostUsd),
      auction,
      startReview: {
        teamCount: teamRows.length,
        rosterSize,
        totalRosterSpots: rosterSize * teamRows.length,
        scoringPreset: rules.scoringPreset,
        superflex: rules.superflex,
        tePremium: rules.tePremium,
        draftPickSeconds: rules.draftPickSeconds,
        draftBudget: rules.draftBudget,
        unownedTeams: teamRows.filter((team) => team.ownerUserId == null).length,
        modelAssignments: [...modelCounts.entries()]
          .map(([modelId, teamCount]) => {
            const model = findModel(modelId);
            return {
              modelId,
              teamCount,
              paid: !model || model.inputPerM > 0 || model.outputPerM > 0,
            };
          })
          .sort((a, b) => a.modelId.localeCompare(b.modelId)),
      },
    };
  },
});

// ---------------------------------------------------------------------------
// Write paths — picks, nominations, bids and lot resolution, plus the
// state-machine half of the draft (PRD §5.2).
//
// The whole board is materialised up front, so "who is on the clock" is a query
// and the live page renders before a single pick is made. Window scheduling is
// Phase 5's job: `windows.close` for a draft window calls `recordPick({ auto:
// true })` with `bestAvailable`, then `nextPick` to open the next one.
//
// Auction lot statuses map onto the Convex schema as: `pending` = awaiting a
// nomination, `bidding` = nominated and taking sealed bids, then `resolved` or
// `abandoned`.
// ---------------------------------------------------------------------------

/** Rostered rows in one league: 14 teams × 16 roster slots, with headroom. */
const MAX_ROSTER_ROWS = 400;
/** Ranked candidates pulled from `player_projection_latest` per source. */
const RANKED_TAKE = 600;

type Ranked = { id: Id<"players">; position: string; points: number };

function teamSortKey(team: Doc<"teams">): [number, string] {
  return [team.createdAt ?? team._creationTime, team.name];
}

/** League teams in their stable creation order — the input to the draft shuffle. */
async function orderedTeams(ctx: QueryCtx, leagueId: Id<"leagues">): Promise<Doc<"teams">[]> {
  // Bounded: ≤ 14 teams.
  const rows = await ctx.db
    .query("teams")
    .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
    .collect();
  return rows.sort((a, b) => {
    const [ac, an] = teamSortKey(a);
    const [bc, bn] = teamSortKey(b);
    return ac - bc || an.localeCompare(bn);
  });
}

async function leagueRules(ctx: QueryCtx, leagueId: Id<"leagues">) {
  return ctx.db
    .query("league_rules")
    .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
    .unique();
}

/** Every pick row for a league, in board order (bounded: 14 × 16 = 224). */
async function allPicks(ctx: QueryCtx, leagueId: Id<"leagues">): Promise<Doc<"draft_picks">[]> {
  return ctx.db
    .query("draft_picks")
    .withIndex("by_leagueId_overallNo", (q) => q.eq("leagueId", leagueId))
    .take(MAX_PICKS);
}

async function draftedPlayerIds(ctx: QueryCtx, leagueId: Id<"leagues">): Promise<Set<string>> {
  const rows = await ctx.db
    .query("draft_picks")
    .withIndex("by_leagueId_playerId", (q) => q.eq("leagueId", leagueId))
    .take(MAX_PICKS);
  const out = new Set<string>();
  for (const row of rows) if (row.playerId) out.add(row.playerId);
  return out;
}

async function leagueRosterRows(ctx: QueryCtx, leagueId: Id<"leagues">) {
  return ctx.db
    .query("roster_slots")
    .withIndex("by_leagueId_playerId", (q) => q.eq("leagueId", leagueId))
    .take(MAX_ROSTER_ROWS);
}

/** Positions currently on a team's roster (bounded: one roster). */
async function rosterPositions(ctx: QueryCtx, teamId: Id<"teams">): Promise<string[]> {
  const rows = await ctx.db
    .query("roster_slots")
    .withIndex("by_teamId", (q) => q.eq("teamId", teamId))
    .take(MAX_ROSTER_ROWS);
  const positions: string[] = [];
  for (const row of rows) {
    const player = await ctx.db.get("players", row.playerId);
    if (player) positions.push(player.position);
  }
  return positions;
}

// ------------------------------------------------------------------ start

/**
 * Materialise the board and open the draft.
 *
 * Idempotent: a league whose picks (or lot 1) already exist keeps them, so a
 * second `start` only re-stamps the league status. The order is derived from a
 * recorded seed, which is returned so the commissioner console can show it.
 */
export const start = internalMutation({
  args: {
    leagueId: v.id("leagues"),
    type: v.optional(draftType),
    scheduledAt: v.optional(v.number()),
    seed: v.optional(v.number()),
  },
  returns: v.object({
    order: v.array(v.id("teams")),
    rounds: v.number(),
    picks: v.number(),
    seed: v.number(),
    type: draftType,
  }),
  handler: async (ctx, args) => {
    const league = await ctx.db.get("leagues", args.leagueId);
    const rules = await leagueRules(ctx, args.leagueId);
    if (!league || !rules) throw appError("NOT_FOUND", `League ${args.leagueId} not found`);

    const teams = await orderedTeams(ctx, args.leagueId);
    if (teams.length < 2) throw appError("BAD_REQUEST", "A draft needs at least two teams");

    const type = args.type ?? league.draftType;
    const seed = args.seed ?? Math.floor(Math.random() * 2 ** 31);
    const rounds = rosterCapacity(rules.rosterSlots);
    const order = seededShuffle(
      teams.map((t) => t._id),
      seed,
    );

    const existing = await allPicks(ctx, args.leagueId);
    let picksCreated = 0;

    if (type === "snake" && existing.length === 0) {
      for (const slot of snakeBoard(order.length, rounds)) {
        await ctx.db.insert("draft_picks", {
          leagueId: args.leagueId,
          round: slot.round,
          pickNo: slot.pickNo,
          overallNo: slot.overallNo,
          teamId: order[slot.teamIndex],
          auto: false,
        });
        picksCreated++;
      }
    }

    if (type === "auction") {
      for (const team of teams) {
        await ctx.db.patch("teams", team._id, { draftBudgetRemaining: rules.draftBudget });
      }
      const lots = await ctx.db
        .query("auction_nominations")
        .withIndex("by_leagueId_lotNo", (q) => q.eq("leagueId", args.leagueId))
        .take(MAX_PICKS);
      if (lots.length === 0) {
        await ctx.db.insert("auction_nominations", {
          leagueId: args.leagueId,
          lotNo: 1,
          nominatingTeamId: order[0],
          openingBid: 1,
          status: "pending",
        });
      }
    }

    const now = Date.now();
    await ctx.db.patch("leagues", args.leagueId, {
      status: "drafting",
      draftType: type,
      draftScheduledAt: args.scheduledAt ?? league.draftScheduledAt ?? now,
      updatedAt: now,
    });
    // Rules become immutable once the draft begins (PRD 5.1).
    await ctx.db.patch("league_rules", rules._id, { rulesLockedAt: rules.rulesLockedAt ?? now });

    return { order, rounds, picks: picksCreated, seed, type };
  },
});

// ------------------------------------------------------------- board reads

/** The next unfilled snake pick, or null when the board is complete. */
export const nextPick = internalQuery({
  args: { leagueId: v.id("leagues") },
  returns: v.union(
    v.null(),
    v.object({
      pickId: v.id("draft_picks"),
      round: v.number(),
      pickNo: v.number(),
      overallNo: v.number(),
      teamId: v.id("teams"),
      picksMade: v.number(),
      totalPicks: v.number(),
    }),
  ),
  handler: async (ctx, { leagueId }) => {
    const picks = await allPicks(ctx, leagueId);
    const made = picks.filter((p) => p.playerId).length;
    const next = picks.find((p) => !p.playerId);
    if (!next) return null;
    return {
      pickId: next._id,
      round: next.round,
      pickNo: next.pickNo,
      overallNo: next.overallNo,
      teamId: next.teamId,
      picksMade: made,
      totalPicks: picks.length,
    };
  },
});

/**
 * Draft-value ordering, best first.
 *
 * Prefers the window's snapshot (so an auto-pick sees exactly what the agent
 * saw); otherwise the latest projection per player for the league's current
 * week, read as one bounded index range per source. There is no unbounded
 * "every player by search rank" fallback — that would scan the whole players
 * table, which the read rules forbid.
 */
async function rankedAvailable(
  ctx: QueryCtx,
  leagueId: Id<"leagues">,
  snapshotId: Id<"snapshots"> | undefined,
): Promise<Ranked[]> {
  const league = await ctx.db.get("leagues", leagueId);
  if (!league) return [];

  const snapshot = snapshotId ? await readPayload(ctx, snapshotId) : null;
  if (snapshot) {
    const rows: Ranked[] = [];
    for (const [id, player] of Object.entries(snapshot.players)) {
      rows.push({
        id: id as Id<"players">,
        position: player.position,
        points: player.projection?.ppr ?? 0,
      });
    }
    rows.sort((a, b) => b.points - a.points || a.id.localeCompare(b.id));
    return rows;
  }

  const weekNo = await currentWeekNoFor(ctx, leagueId, Date.now());
  for (const source of PROJECTION_SOURCES) {
    const rows = await ctx.db
      .query("player_projection_latest")
      .withIndex("by_season_week_source_projectedPointsPpr", (q) =>
        q.eq("season", league.season).eq("week", weekNo).eq("source", source),
      )
      .order("desc")
      .take(RANKED_TAKE);
    if (rows.length === 0) continue;
    return rows.map((r) => ({
      id: r.playerId,
      position: r.position,
      points: r.projectedPointsPpr,
    }));
  }
  return [];
}

/**
 * Best available player for `teamId` (PRD 5.2 auto-pick).
 *
 * Positional sanity is applied when a team is given; if every remaining
 * candidate breaks a rule the best one is taken anyway rather than stalling the
 * draft, exactly as the old auto-pick did.
 */
export const bestAvailable = internalQuery({
  args: {
    leagueId: v.id("leagues"),
    teamId: v.optional(v.id("teams")),
    snapshotId: v.optional(v.id("snapshots")),
  },
  returns: v.union(v.null(), v.object({ playerId: v.id("players"), position: v.string(), points: v.number() })),
  handler: async (ctx, args) => {
    const rules = await leagueRules(ctx, args.leagueId);
    if (!rules) return null;

    const taken = await draftedPlayerIds(ctx, args.leagueId);
    for (const row of await leagueRosterRows(ctx, args.leagueId)) taken.add(row.playerId);

    const ranked = (await rankedAvailable(ctx, args.leagueId, args.snapshotId)).filter(
      (c) => !taken.has(c.id),
    );
    if (ranked.length === 0) return null;
    if (!args.teamId) {
      const [best] = ranked;
      return { playerId: best.id, position: best.position, points: best.points };
    }

    const currentPositions = await rosterPositions(ctx, args.teamId);
    const remaining = (await allPicks(ctx, args.leagueId)).filter(
      (p) => p.teamId === args.teamId && !p.playerId,
    ).length;
    const picksRemainingAfter = Math.max(0, remaining - 1);

    for (const candidate of ranked) {
      const problem = validatePickPosition({
        position: candidate.position,
        currentPositions,
        rosterShape: rules.rosterSlots,
        picksRemainingAfter,
        superflex: rules.superflex,
      });
      if (!problem) {
        return { playerId: candidate.id, position: candidate.position, points: candidate.points };
      }
    }
    const [fallback] = ranked;
    return { playerId: fallback.id, position: fallback.position, points: fallback.points };
  },
});

// --------------------------------------------------------------- recordPick

/**
 * `make_draft_pick`. On-the-clock, undrafted and position-sanity checks, then
 * the pick row, the roster slot and the transaction, all in one transaction.
 *
 * `auto: true` (the platform pick at clock expiry) skips the positional veto —
 * the draft must not stall — but every other check still applies.
 */
export const recordPick = internalMutation({
  args: {
    leagueId: v.id("leagues"),
    windowId: v.optional(v.id("windows")),
    teamId: v.id("teams"),
    playerId: v.id("players"),
    agentCtx: v.optional(agentCtxValidator),
    auto: v.optional(v.boolean()),
    rationale: v.optional(v.string()),
    now: v.optional(v.number()),
  },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      pickId: v.id("draft_picks"),
      overallNo: v.number(),
      pickNo: v.number(),
      round: v.number(),
    }),
    v.object({ ok: v.literal(false), errors: v.array(v.string()) }),
  ),
  handler: async (ctx, args) => {
    return withAgentAction(
      ctx,
      args.agentCtx,
      {
        actionType: "make_draft_pick",
        payload: { teamId: args.teamId, playerId: args.playerId, auto: args.auto ?? false },
      },
      async () => {
        const { leagueId, teamId, playerId } = args;
        const now = args.now ?? Date.now();
        const windowId = args.windowId ?? args.agentCtx?.windowId;

        if (windowId) {
          const window = await ctx.db.get("windows", windowId);
          if (!window || window.leagueId !== leagueId || window.type !== "draft") {
            return fail(`Window ${windowId} is not a draft window in this league.`);
          }
          const picks = await allPicks(ctx, leagueId);
          const next = picks.find((p) => !p.playerId);
          if (
            next &&
            window.scope.pickNo !== undefined &&
            window.scope.pickNo !== next.overallNo
          ) {
            return fail("That window is for a different pick.");
          }
        }

        const picks = await allPicks(ctx, leagueId);
        const pick = picks.find((p) => !p.playerId);
        if (!pick) return fail("The draft is already complete.");
        if (pick.teamId !== teamId) return fail("You are not on the clock.");

        if ((await draftedPlayerIds(ctx, leagueId)).has(playerId)) {
          return fail("That player is already drafted.");
        }
        const rostered = await ctx.db
          .query("roster_slots")
          .withIndex("by_leagueId_playerId", (q) =>
            q.eq("leagueId", leagueId).eq("playerId", playerId),
          )
          .first();
        if (rostered) return fail("That player is already rostered in this league.");

        const player = await ctx.db.get("players", playerId);
        if (!player) return fail(`Unknown player ${playerId}.`);

        const rules = await leagueRules(ctx, leagueId);
        if (!rules) return fail("League rules are missing.");

        const currentPositions = await rosterPositions(ctx, teamId);
        const remaining = picks.filter((p) => p.teamId === teamId && !p.playerId).length;
        const positionError = validatePickPosition({
          position: player.position,
          currentPositions,
          rosterShape: rules.rosterSlots,
          picksRemainingAfter: Math.max(0, remaining - 1),
          superflex: rules.superflex,
        });
        if (positionError && !args.auto) return fail(positionError);

        await ctx.db.patch("draft_picks", pick._id, {
          playerId,
          madeByRunId: args.agentCtx?.runId,
          windowId: windowId ?? undefined,
          auto: args.auto ?? false,
          rationale: args.rationale ?? undefined,
          madeAt: now,
        });
        await ctx.db.insert("roster_slots", {
          leagueId,
          teamId,
          playerId,
          acquiredVia: "draft",
          acquiredAt: now,
        });
        await ctx.db.insert("transactions", {
          leagueId,
          teamId,
          type: "draft",
          playerId,
          runId: args.agentCtx?.runId,
          details: {
            round: pick.round,
            pickNo: pick.pickNo,
            overallNo: pick.overallNo,
            auto: args.auto ?? false,
          },
        });

        return {
          ok: true as const,
          pickId: pick._id,
          overallNo: pick.overallNo,
          pickNo: pick.pickNo,
          round: pick.round,
        };
      },
    );
  },
});

// ----------------------------------------------------------------- auction

/** `nominate_player`: claim the open lot and lodge the opening bid as your own. */
export const nominate = internalMutation({
  args: {
    leagueId: v.id("leagues"),
    windowId: v.optional(v.id("windows")),
    teamId: v.id("teams"),
    playerId: v.id("players"),
    openingBid: v.number(),
    agentCtx: v.optional(agentCtxValidator),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), nominationId: v.id("auction_nominations"), lotNo: v.number() }),
    v.object({ ok: v.literal(false), errors: v.array(v.string()) }),
  ),
  handler: async (ctx, args) => {
    return withAgentAction(
      ctx,
      args.agentCtx,
      {
        actionType: "nominate_player",
        payload: { teamId: args.teamId, playerId: args.playerId, openingBid: args.openingBid },
      },
      async () => {
        const windowId = args.windowId ?? args.agentCtx?.windowId;
        if (windowId) {
          const window = await ctx.db.get("windows", windowId);
          if (!window || window.leagueId !== args.leagueId || window.type !== "draft") {
            return fail("That is not an open draft window.");
          }
        }
        const lots = await ctx.db
          .query("auction_nominations")
          .withIndex("by_leagueId_status", (q) =>
            q.eq("leagueId", args.leagueId).eq("status", "pending"),
          )
          .take(MAX_PICKS);
        const lot = lots.sort((a, b) => a.lotNo - b.lotNo)[0];
        if (!lot) return fail("There is no lot awaiting nomination.");
        if (lot.nominatingTeamId !== args.teamId) return fail("It is not your nomination.");
        if ((await draftedPlayerIds(ctx, args.leagueId)).has(args.playerId)) {
          return fail("That player is already drafted.");
        }

        const team = await ctx.db.get("teams", args.teamId);
        const bid = Math.max(1, Math.trunc(args.openingBid));
        if (!team || bid > team.draftBudgetRemaining) {
          return fail("Opening bid exceeds your remaining budget.");
        }

        await ctx.db.patch("auction_nominations", lot._id, {
          playerId: args.playerId,
          openingBid: bid,
          status: "bidding",
          windowId: windowId ?? undefined,
          runId: args.agentCtx?.runId,
        });
        // The nominator's opening bid stands as their sealed bid.
        await upsertBid(ctx, {
          nominationId: lot._id,
          leagueId: args.leagueId,
          teamId: args.teamId,
          amount: bid,
          runId: args.agentCtx?.runId,
          windowId: windowId ?? undefined,
        });

        return { ok: true as const, nominationId: lot._id, lotNo: lot.lotNo };
      },
    );
  },
});

async function upsertBid(
  ctx: MutationCtx,
  args: {
    nominationId: Id<"auction_nominations">;
    leagueId: Id<"leagues">;
    teamId: Id<"teams">;
    amount: number;
    runId?: Id<"runs">;
    windowId?: Id<"windows">;
  },
): Promise<Id<"auction_bids">> {
  const existing = await ctx.db
    .query("auction_bids")
    .withIndex("by_nominationId_teamId", (q) =>
      q.eq("nominationId", args.nominationId).eq("teamId", args.teamId),
    )
    .first();
  if (existing) {
    await ctx.db.patch("auction_bids", existing._id, {
      amount: args.amount,
      runId: args.runId,
      windowId: args.windowId,
    });
    return existing._id;
  }
  return ctx.db.insert("auction_bids", {
    nominationId: args.nominationId,
    leagueId: args.leagueId,
    teamId: args.teamId,
    amount: args.amount,
    runId: args.runId,
    windowId: args.windowId,
  });
}

/** `submit_bid`: one sealed bid per team per lot; a resubmission replaces it. */
export const bid = internalMutation({
  args: {
    leagueId: v.id("leagues"),
    windowId: v.optional(v.id("windows")),
    teamId: v.id("teams"),
    playerId: v.id("players"),
    amount: v.number(),
    agentCtx: v.optional(agentCtxValidator),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), bidId: v.id("auction_bids"), amount: v.number() }),
    v.object({ ok: v.literal(false), errors: v.array(v.string()) }),
  ),
  handler: async (ctx, args) => {
    return withAgentAction(
      ctx,
      args.agentCtx,
      {
        actionType: "submit_bid",
        payload: { teamId: args.teamId, playerId: args.playerId, amount: args.amount },
      },
      async () => {
        const lots = await ctx.db
          .query("auction_nominations")
          .withIndex("by_leagueId_status", (q) =>
            q.eq("leagueId", args.leagueId).eq("status", "bidding"),
          )
          .take(MAX_PICKS);
        const lot = lots
          .filter((l) => l.playerId === args.playerId)
          .sort((a, b) => a.lotNo - b.lotNo)[0];
        if (!lot) return fail("No open lot for that player.");

        const team = await ctx.db.get("teams", args.teamId);
        if (!team || team.leagueId !== args.leagueId) return fail("Unknown team.");

        const amount = Math.trunc(args.amount);
        if (amount < 0) return fail("Bid must be zero or more.");
        if (amount > team.draftBudgetRemaining) {
          return fail(`Bid ${amount} exceeds your remaining budget (${team.draftBudgetRemaining}).`);
        }

        const bidId = await upsertBid(ctx, {
          nominationId: lot._id,
          leagueId: args.leagueId,
          teamId: args.teamId,
          amount,
          runId: args.agentCtx?.runId,
          windowId: args.windowId ?? args.agentCtx?.windowId,
        });
        return { ok: true as const, bidId, amount };
      },
    );
  },
});

/**
 * Resolve a sealed-bid lot at window close: highest bid wins, ties break on the
 * smallest roster and then on a seeded random recorded on the lot, and the next
 * lot rotates the nomination to the next team in draft order.
 */
export const resolveLot = internalMutation({
  args: { nominationId: v.id("auction_nominations"), now: v.optional(v.number()) },
  returns: v.object({
    winnerTeamId: v.union(v.null(), v.id("teams")),
    price: v.union(v.null(), v.number()),
    nextLotNo: v.union(v.null(), v.number()),
  }),
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const lot = await ctx.db.get("auction_nominations", args.nominationId);
    if (!lot || lot.status !== "bidding" || !lot.playerId) {
      return { winnerTeamId: null, price: null, nextLotNo: null };
    }

    // Bounded: one bid per team per lot.
    const bids = await ctx.db
      .query("auction_bids")
      .withIndex("by_nominationId_teamId", (q) => q.eq("nominationId", args.nominationId))
      .take(MAX_TEAMS);
    if (bids.length === 0) {
      await ctx.db.patch("auction_nominations", args.nominationId, {
        status: "abandoned",
        resolvedAt: now,
      });
      const abandonedNext = await createNextLot(ctx, lot.leagueId, lot.lotNo);
      return { winnerTeamId: null, price: null, nextLotNo: abandonedNext };
    }

    const rosterRows = await leagueRosterRows(ctx, lot.leagueId);
    const rosterSizeByTeam: Record<string, number> = {};
    for (const row of rosterRows) {
      rosterSizeByTeam[row.teamId] = (rosterSizeByTeam[row.teamId] ?? 0) + 1;
    }

    const resolution = resolveSealedBids({
      bids: bids.map((b) => ({ teamId: b.teamId as string, amount: b.amount })),
      lotNo: lot.lotNo,
      rosterSizeByTeam,
    });
    const winner = resolution.winner;
    if (!winner) return { winnerTeamId: null, price: null, nextLotNo: null };
    const winningBid = bids.find((b) => b.teamId === winner.teamId && b.amount === winner.amount)!;
    const winnerTeamId = winningBid.teamId;

    const picks = await allPicks(ctx, lot.leagueId);
    const nextOverall = picks.reduce((max, p) => Math.max(max, p.overallNo), 0) + 1;

    await ctx.db.insert("draft_picks", {
      leagueId: lot.leagueId,
      round: 1,
      pickNo: lot.lotNo,
      overallNo: nextOverall,
      teamId: winnerTeamId,
      playerId: lot.playerId,
      price: winner.amount,
      madeByRunId: winningBid.runId,
      windowId: winningBid.windowId,
      auto: false,
      madeAt: now,
    });
    const alreadyRostered = await ctx.db
      .query("roster_slots")
      .withIndex("by_teamId_playerId", (q) =>
        q.eq("teamId", winnerTeamId).eq("playerId", lot.playerId!),
      )
      .first();
    if (!alreadyRostered) {
      await ctx.db.insert("roster_slots", {
        leagueId: lot.leagueId,
        teamId: winnerTeamId,
        playerId: lot.playerId,
        acquiredVia: "draft",
        acquiredAt: now,
      });
    }
    const winnerTeam = await ctx.db.get("teams", winnerTeamId);
    if (winnerTeam) {
      await ctx.db.patch("teams", winnerTeamId, {
        draftBudgetRemaining: winnerTeam.draftBudgetRemaining - winner.amount,
      });
    }
    await ctx.db.insert("transactions", {
      leagueId: lot.leagueId,
      teamId: winnerTeamId,
      type: "draft",
      playerId: lot.playerId,
      runId: winningBid.runId,
      details: { auction: true, lotNo: lot.lotNo, price: winner.amount },
    });
    await ctx.db.patch("auction_nominations", args.nominationId, {
      status: "resolved",
      winningTeamId: winnerTeamId,
      winningBid: winner.amount,
      tiebreak: resolution.tiebreak,
      resolvedAt: now,
    });

    const nextLotNo = await createNextLot(ctx, lot.leagueId, lot.lotNo);
    return { winnerTeamId, price: winner.amount, nextLotNo };
  },
});

/** The next lot rotates the nomination to the next team in draft order. */
async function createNextLot(
  ctx: MutationCtx,
  leagueId: Id<"leagues">,
  previousLotNo: number,
): Promise<number | null> {
  const rules = await leagueRules(ctx, leagueId);
  if (!rules) return null;
  const teams = await orderedTeams(ctx, leagueId);
  if (teams.length === 0) return null;

  const capacity = rosterCapacity(rules.rosterSlots);
  const filled = (await leagueRosterRows(ctx, leagueId)).length;
  if (filled >= capacity * teams.length) return null; // auction complete

  const existing = await ctx.db
    .query("auction_nominations")
    .withIndex("by_leagueId_lotNo", (q) =>
      q.eq("leagueId", leagueId).eq("lotNo", previousLotNo + 1),
    )
    .first();
  if (existing) return existing.lotNo;

  await ctx.db.insert("auction_nominations", {
    leagueId,
    lotNo: previousLotNo + 1,
    nominatingTeamId: teams[previousLotNo % teams.length]._id,
    openingBid: 1,
    status: "pending",
  });
  return previousLotNo + 1;
}

// -------------------------------------------------------- draft completion

/**
 * The last pick landed: give everyone a default week-1 lineup from the snapshot,
 * build the regular-season schedule, and open the season.
 *
 * Idempotent: `generateSchedule` skips weeks that already have matchups, and a
 * second `finalize` leaves the lineups alone once the league is in season —
 * the week-1 defaults are only written while the league is still `drafting`,
 * so a re-run after the weekly lock can never overwrite agent-set lineups
 * (`lineups.commit` would reject them anyway).
 */
export const finalize = internalMutation({
  args: { leagueId: v.id("leagues"), snapshotId: v.optional(v.id("snapshots")) },
  returns: v.object({ lineups: v.number(), matchups: v.number(), weeks: v.number() }),
  handler: async (
    ctx,
    args,
  ): Promise<{ lineups: number; matchups: number; weeks: number }> => {
    const league = await ctx.db.get("leagues", args.leagueId);
    if (!league) return { lineups: 0, matchups: 0, weeks: 0 };

    const frozenSnapshot = args.snapshotId ? await readPayload(ctx, args.snapshotId) : null;
    const snapshot = frozenSnapshot
      ? withLiveRosterOwnership(frozenSnapshot, await leagueRosterRows(ctx, args.leagueId))
      : null;
    const teams = await orderedTeams(ctx, args.leagueId);

    let lineupCount = 0;
    if (snapshot && league.status !== "in_season" && league.status !== "complete") {
      for (const team of teams) {
        const slots = computeOptimalLineup({ snapshot, teamId: team._id });
        if (slots.length === 0) continue;
        const result = await ctx.runMutation(internal.lineups.commit, {
          teamId: team._id,
          weekNo: 1,
          slots: slots.map((s) => ({
            slot: s.slot,
            playerId: (s.playerId as Id<"players"> | null) ?? null,
          })),
          source: "draft_default" as const,
        });
        if (result.ok) lineupCount++;
      }
    }

    const schedule = await ctx.runMutation(internal.standings.generateSchedule, {
      leagueId: args.leagueId,
    });
    await ctx.db.patch("leagues", args.leagueId, {
      status: "in_season",
      updatedAt: Date.now(),
    });

    return { lineups: lineupCount, matchups: schedule.matchups, weeks: schedule.weeks };
  },
});
