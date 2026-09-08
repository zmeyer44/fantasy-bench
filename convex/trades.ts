/**
 * Trades — read paths (PRD 5.6, port of `lib/services/trades`).
 *
 * `list` is the reactive negotiation feed, `get` is one proposal with its event
 * timeline, fairness breakdown and veto tally, and `listOpenForTeam` is what the
 * agent runtime's `get_inbox` tool calls.
 *
 * Phase 3 adds the mutations (`propose`, `respond`, `castVeto`,
 * `expireForWindow`, `processReviews`) to this same file. They must keep
 * `trades.vetoCount` / `trades.approveCount` in step with `trade_votes`, since
 * `get` reads the tally off the denormalized counters.
 *
 * Every read below goes through an index and is bounded; the bound is stated at
 * each call site.
 */
import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { internalQuery, query, type QueryCtx } from "./_generated/server";
import { requireLeagueRead } from "./lib/auth";
import { appError } from "./lib/errors";
import { isOpenTradeStatus, type EpochDates } from "./lib/social_pure";
import { tradeStatus } from "./schema";

import type { FairnessDetailV1 } from "../lib/services/trades/fairness";
import type {
  TradeDetail as PgTradeDetail,
  TradeEventView as PgTradeEventView,
  TradeVoteView as PgTradeVoteView,
  VetoTally,
} from "../lib/services/trades";
import type {
  TradePlayerRef,
  TradeSummary as PgTradeSummary,
} from "../lib/services/trades/summaries";

// ---------------------------------------------------------------------------
// Return types — the old service types with epoch-ms dates
// ---------------------------------------------------------------------------

export type { TradePlayerRef, VetoTally };

export type TradeSummary = EpochDates<
  PgTradeSummary,
  "createdAt" | "reviewEndsAt" | "resolvedAt"
>;

export type TradeEventView = EpochDates<PgTradeEventView, "createdAt">;
export type TradeVoteView = EpochDates<PgTradeVoteView, "createdAt">;

/**
 * `TradeDetail` minus the fields we retype, plus:
 * - `myVote`: the viewer's own veto vote (additive; the review panel needs it to
 *   render the toggle without scanning `votes`).
 */
export type TradeDetail = TradeSummary &
  Omit<PgTradeDetail, keyof PgTradeSummary | "events" | "votes" | "fairnessDetail"> & {
    fairnessDetail: FairnessDetailV1 | null;
    events: TradeEventView[];
    votes: TradeVoteView[];
    myVote: "veto" | "approve" | null;
  };

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Hard cap on the feed, whatever the caller asks for. */
const MAX_FEED = 100;
/** A trade's timeline: propose → counter* → accept → review → resolve. */
const MAX_EVENTS = 200;
/** One vote per league member; a league has at most 14 teams plus spectators. */
const MAX_VOTES = 64;
/** Open proposals per team are capped by `league_rules.maxOpenProposals`. */
const MAX_OPEN_PER_SIDE = 25;

// ---------------------------------------------------------------------------
// Shared loader
// ---------------------------------------------------------------------------

/**
 * Shape trade documents into `TradeSummary[]`, newest first.
 *
 * Player names are resolved with one `db.get` per distinct player id; the set is
 * bounded by the number of items across the (already bounded) trade list.
 */
async function toSummaries(
  ctx: QueryCtx,
  leagueId: Id<"leagues">,
  rows: Doc<"trades">[],
): Promise<TradeSummary[]> {
  if (rows.length === 0) return [];

  // Bounded: one league has at most `teamCount` (≤ 14) teams.
  const teams = await ctx.db
    .query("teams")
    .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
    .collect();
  const teamName = new Map(teams.map((t) => [t._id as string, t.name]));

  const playerIds = new Set<Id<"players">>();
  for (const trade of rows) {
    for (const item of trade.items) if (item.playerId) playerIds.add(item.playerId);
  }
  const players = new Map<string, Doc<"players">>();
  for (const id of playerIds) {
    const player = await ctx.db.get("players", id);
    if (player) players.set(id as string, player);
  }

  return rows.map((t) => {
    const give: TradePlayerRef[] = [];
    const receive: TradePlayerRef[] = [];
    let faab = 0;
    for (const item of t.items) {
      if (item.playerId) {
        const player = players.get(item.playerId as string);
        const ref: TradePlayerRef = {
          playerId: item.playerId as string,
          playerName: player?.fullName,
          position: player?.position,
          nflTeam: player?.nflTeam ?? null,
        };
        if (item.fromTeamId === t.proposerTeamId) give.push(ref);
        else receive.push(ref);
      } else if (item.faab) {
        faab += item.fromTeamId === t.proposerTeamId ? item.faab : -item.faab;
      }
    }
    return {
      id: t._id as string,
      status: t.status,
      proposerTeamId: t.proposerTeamId as string,
      recipientTeamId: t.recipientTeamId as string,
      threadId: (t.threadId as string | undefined) ?? null,
      give,
      receive,
      faab: faab === 0 ? null : faab,
      message: t.message ?? null,
      fairnessScore: t.fairnessScore ?? null,
      flagged: t.flagged,
      createdAt: t._creationTime,
      reviewEndsAt: t.reviewEndsAt ?? null,
      leagueId: t.leagueId as string,
      weekNo: t.weekNo,
      windowId: (t.windowId as string | undefined) ?? null,
      proposerTeamName: teamName.get(t.proposerTeamId as string) ?? "Unknown",
      recipientTeamName: teamName.get(t.recipientTeamId as string) ?? "Unknown",
      parentTradeId: (t.parentTradeId as string | undefined) ?? null,
      resolvedAt: t.resolvedAt ?? null,
      fairnessDetail: (t.fairnessDetail as FairnessDetailV1 | undefined) ?? null,
      createdByRunId: (t.createdByRunId as string | undefined) ?? null,
    };
  });
}

/**
 * Fetch the newest `limit` trades of a league, choosing the most selective index
 * available. Ordering is by `_creationTime` desc (the Convex stand-in for the
 * old `created_at`), which is the last field of each of these indexes.
 */
async function loadLeagueTrades(
  ctx: QueryCtx,
  args: { leagueId: Id<"leagues">; weekNo?: number; status?: Doc<"trades">["status"] },
  limit: number,
): Promise<Doc<"trades">[]> {
  if (args.status !== undefined) {
    return ctx.db
      .query("trades")
      .withIndex("by_leagueId_status", (q) =>
        q.eq("leagueId", args.leagueId).eq("status", args.status!),
      )
      .order("desc")
      .take(limit);
  }
  if (args.weekNo !== undefined) {
    return ctx.db
      .query("trades")
      .withIndex("by_leagueId_weekNo", (q) =>
        q.eq("leagueId", args.leagueId).eq("weekNo", args.weekNo!),
      )
      .order("desc")
      .take(limit);
  }
  return ctx.db
    .query("trades")
    .withIndex("by_leagueId", (q) => q.eq("leagueId", args.leagueId))
    .order("desc")
    .take(limit);
}

// ---------------------------------------------------------------------------
// Public queries
// ---------------------------------------------------------------------------

/**
 * The league-wide negotiation feed, newest first.
 *
 * Index: `by_leagueId_status` when `status` is given, else `by_leagueId_weekNo`
 * when `weekNo` is given, else `by_leagueId`. Bound: `take(min(limit, 100))`.
 * `teamId` filters inside that range (as the Postgres version did), so a team
 * filter narrows the page rather than paging further back.
 */
export const list = query({
  args: {
    leagueId: v.id("leagues"),
    teamId: v.optional(v.id("teams")),
    weekNo: v.optional(v.number()),
    status: v.optional(tradeStatus),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<TradeSummary[]> => {
    await requireLeagueRead(ctx, args.leagueId);
    const limit = Math.min(Math.max(args.limit ?? MAX_FEED, 1), MAX_FEED);

    const rows = await loadLeagueTrades(ctx, args, limit);
    const filtered = args.teamId
      ? rows.filter(
          (t) => t.proposerTeamId === args.teamId || t.recipientTeamId === args.teamId,
        )
      : rows;
    return toSummaries(ctx, args.leagueId, filtered);
  },
});

/**
 * One trade: summary + timeline + veto tally + fairness breakdown.
 *
 * Indexes/bounds: `trade_events.by_tradeId` take 200; `trade_votes.by_tradeId_userId`
 * take 64 for the roll-up and `.unique()` on `(tradeId, viewerUserId)` for the
 * viewer's own vote; `trades.by_parentTradeId` take 25 for counter-offers;
 * `league_members.by_leagueId_userId` collected over one league (bounded).
 */
export const get = query({
  args: { leagueId: v.id("leagues"), tradeId: v.id("trades") },
  handler: async (ctx, args): Promise<TradeDetail> => {
    const access = await requireLeagueRead(ctx, args.leagueId);

    const trade = await ctx.db.get("trades", args.tradeId);
    if (!trade || trade.leagueId !== args.leagueId) {
      throw appError("NOT_FOUND", "Trade not found");
    }
    const [summary] = await toSummaries(ctx, args.leagueId, [trade]);

    const events = await ctx.db
      .query("trade_events")
      .withIndex("by_tradeId", (q) => q.eq("tradeId", args.tradeId))
      .take(MAX_EVENTS);

    const votes = await ctx.db
      .query("trade_votes")
      .withIndex("by_tradeId_userId", (q) => q.eq("tradeId", args.tradeId))
      .take(MAX_VOTES);

    const counters = await ctx.db
      .query("trades")
      .withIndex("by_parentTradeId", (q) => q.eq("parentTradeId", args.tradeId))
      .take(MAX_OPEN_PER_SIDE);

    // Bounded: one league has at most `teamCount` (≤ 14) teams.
    const teams = await ctx.db
      .query("teams")
      .withIndex("by_leagueId", (q) => q.eq("leagueId", args.leagueId))
      .collect();
    const teamName = new Map(teams.map((t) => [t._id as string, t.name]));

    const myVote = access.viewer
      ? await ctx.db
          .query("trade_votes")
          .withIndex("by_tradeId_userId", (q) =>
            q.eq("tradeId", args.tradeId).eq("userId", access.viewer!.userId),
          )
          .unique()
      : null;

    return {
      ...summary,
      fairnessDetail: summary.fairnessDetail as FairnessDetailV1 | null,
      events: events.map((e) => ({
        id: e._id as string,
        type: e.type,
        fromStatus: e.fromStatus ?? null,
        toStatus: e.toStatus ?? null,
        runId: (e.runId as string | undefined) ?? null,
        stepIndex: e.stepIndex ?? null,
        actorTeamId: (e.actorTeamId as string | undefined) ?? null,
        actorTeamName: e.actorTeamId
          ? (teamName.get(e.actorTeamId as string) ?? null)
          : null,
        payload: e.payload ?? {},
        createdAt: e._creationTime,
      })),
      votes: votes.map((vote) => ({
        userId: vote.userId as string,
        vote: vote.vote,
        createdAt: vote._creationTime,
      })),
      tally:
        trade.status === "in_review"
          ? await tallyFor(ctx, trade)
          : null,
      counterTradeIds: counters.map((c) => c._id as string),
      myVote: myVote?.vote ?? null,
    };
  },
});

/**
 * The current veto tally, read off the denormalized counters on the trade
 * (Phase 3's `castVeto` maintains them alongside the `trade_votes` row).
 *
 * `ownerCount` still needs the membership roll: `league_members.by_leagueId_userId`
 * ranged on `leagueId` only and collected — bounded by one league's membership.
 */
async function tallyFor(ctx: QueryCtx, trade: Doc<"trades">): Promise<VetoTally> {
  // Bounded: one league's members (≤ teamCount + spectators).
  const members = await ctx.db
    .query("league_members")
    .withIndex("by_leagueId_userId", (q) => q.eq("leagueId", trade.leagueId))
    .collect();
  const ownerCount = members.filter((m) => m.role !== "spectator").length;
  return {
    vetoes: trade.vetoCount,
    approvals: trade.approveCount,
    ownerCount,
    threshold: Math.floor(ownerCount / 2) + 1,
    blocked: trade.vetoCount > ownerCount / 2,
  };
}

// ---------------------------------------------------------------------------
// Internal queries (agent runtime)
// ---------------------------------------------------------------------------

/**
 * Open (`proposed` / `countered`) proposals involving a team — the trade half of
 * the runtime's `get_inbox` tool and of the prompt context.
 *
 * Indexes: `by_proposerTeamId_status` and `by_recipientTeamId_status`, one range
 * per (side, status) pair — four ranges, `take(25)` each, deduped and sorted
 * newest first.
 */
export const listOpenForTeam = internalQuery({
  args: { leagueId: v.id("leagues"), teamId: v.id("teams") },
  handler: async (ctx, args): Promise<TradeSummary[]> => {
    const byId = new Map<string, Doc<"trades">>();
    for (const status of ["proposed", "countered"] as const) {
      const proposed = await ctx.db
        .query("trades")
        .withIndex("by_proposerTeamId_status", (q) =>
          q.eq("proposerTeamId", args.teamId).eq("status", status),
        )
        .order("desc")
        .take(MAX_OPEN_PER_SIDE);
      const received = await ctx.db
        .query("trades")
        .withIndex("by_recipientTeamId_status", (q) =>
          q.eq("recipientTeamId", args.teamId).eq("status", status),
        )
        .order("desc")
        .take(MAX_OPEN_PER_SIDE);
      for (const trade of [...proposed, ...received]) {
        if (trade.leagueId === args.leagueId) byId.set(trade._id as string, trade);
      }
    }
    const rows = [...byId.values()].sort((a, b) => b._creationTime - a._creationTime);
    return toSummaries(ctx, args.leagueId, rows);
  },
});

/**
 * Open proposals raised inside a set of threads — used by `messaging` to render
 * inline proposal cards and by the inbox's `openTradeIds`.
 *
 * Index: `trades.by_threadId`, `take(25)` per thread.
 */
export async function openTradeIdsForThread(
  ctx: QueryCtx,
  threadId: Id<"threads">,
): Promise<string[]> {
  const rows = await ctx.db
    .query("trades")
    .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
    .take(MAX_OPEN_PER_SIDE);
  return rows.filter((t) => isOpenTradeStatus(t.status)).map((t) => t._id as string);
}

/** Every trade raised in a thread (bounded), shaped for the thread views. */
export async function tradesForThread(
  ctx: QueryCtx,
  leagueId: Id<"leagues">,
  threadId: Id<"threads">,
): Promise<TradeSummary[]> {
  const rows = await ctx.db
    .query("trades")
    .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
    .take(MAX_OPEN_PER_SIDE);
  return toSummaries(ctx, leagueId, rows);
}

/** Raw trade documents of a thread, for callers that only need statuses. */
export async function tradeDocsForThread(
  ctx: QueryCtx,
  threadId: Id<"threads">,
): Promise<Doc<"trades">[]> {
  return ctx.db
    .query("trades")
    .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
    .take(MAX_OPEN_PER_SIDE);
}
