/**
 * Trades — read paths (PRD 5.6, port of `lib/services/trades`).
 *
 * `list` is the reactive negotiation feed, `get` is one proposal with its event
 * timeline, fairness breakdown and veto tally, and `listOpenForTeam` is what the
 * agent runtime's `get_inbox` tool calls.
 *
 * The write half — the proposal state machine, fairness, review, veto and
 * completion — is at the bottom of the file:
 *
 *   proposed ─┬─▶ countered ─▶ (child proposal)
 *             ├─▶ rejected
 *             ├─▶ expired          (window closed with the offer outstanding)
 *             └─▶ accepted ─▶ in_review ─┬─▶ completed
 *                                        ├─▶ vetoed     (flagged + majority veto)
 *                                        └─▶ cancelled  (roster moved under us)
 *
 * Every transition appends a `trade_events` row carrying the run and step that
 * caused it — that is what the negotiation viewer links into the trace with.
 * Rosters are only touched at `completed`. `trades.vetoCount` / `approveCount`
 * are recomputed from `trade_votes` on every vote, since `get` reads the tally
 * off those counters.
 *
 * Every read below goes through an index and is bounded; the bound is stated at
 * each call site.
 */
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { requireLeagueRead, requireMember } from "./lib/auth";
import { appError } from "./lib/errors";
import {
  pickProjection,
  remainingWeeksFor,
  scoreTradePure,
  type FairnessResult,
  type PlayerValueRow,
  type ValuationSource,
} from "./lib/fairness_pure";
import {
  actionErrors,
  agentCtxValidator,
  isOpenTradeStatus,
  OPEN_TRADE_STATUSES,
  rateLimitExceeded,
  totalRosterCapacity,
  type ActionResult,
  type AgentCtx,
  type EpochDates,
  type SocialRules,
} from "./lib/social_pure";
import {
  commitAction,
  compact,
  insertThreadMessage,
  loadLeagueTeam,
  loadSocialRules,
  resolveThread,
} from "./messaging";
import { tradeStatus, tradeVote } from "./schema";
import { latestPayload, PROJECTION_SOURCES } from "./snapshot";

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

// ---------------------------------------------------------------------------
// Write path (Phase 3)
// ---------------------------------------------------------------------------

/** Roster rows read per team when valuing a trade (a roster is ≤ 16 players). */
const MAX_ROSTER_SCAN = 60;
/** Completed trades scanned for the anti-churn check. */
const MAX_CHURN_TRADES = 100;
/** Feed rows scanned per player for the anti-churn check. */
const MAX_CHURN_TRANSACTIONS = 50;
/** Open proposals read when enforcing `maxOpenProposals`. */
const MAX_OPEN_SCAN = 50;
/** Trades expired per status when a negotiation window closes. */
const MAX_EXPIRE = 100;
/** Reviews resolved per `processReviews` call. */
const MAX_REVIEWS = 50;
/** NFL games in one week (≤ 16, plus slack). */
const MAX_GAMES = 32;

// ------------------------------------------------------------------ fairness

/**
 * Rest-of-season value for a bounded set of players.
 *
 * Prefers the league's newest ready snapshot — agents and the scorer must agree
 * on the numbers they can see — and falls back to `player_projection_latest`
 * (this week's projection × remaining weeks) so fairness still works before the
 * first snapshot exists. Where Postgres built a map of every player in the
 * league, this reads only the players named in the trade and on the two
 * rosters; the arithmetic is unchanged.
 */
async function buildValues(
  ctx: QueryCtx,
  args: {
    leagueId: Id<"leagues">;
    season: number;
    weekNo: number;
    rules: SocialRules;
    playerIds: Id<"players">[];
  },
): Promise<{ values: Map<string, PlayerValueRow>; source: ValuationSource }> {
  const remainingWeeks = remainingWeeksFor(args.rules, args.weekNo);
  const values = new Map<string, PlayerValueRow>();
  const wanted = [...new Set(args.playerIds)];

  const latest = await latestPayload(ctx, args.leagueId);
  const players = latest?.payload.players;
  if (players && Object.keys(players).length > 0) {
    for (const playerId of wanted) {
      const player = players[playerId as string];
      if (!player) continue;
      const weekly = pickProjection(player.projection, args.rules.scoringPreset);
      const ros = player.rosProjection ?? weekly * remainingWeeks;
      values.set(playerId as string, {
        playerId: playerId as string,
        name: player.fullName,
        position: player.position,
        ros: Number.isFinite(ros) ? ros : 0,
      });
    }
    return { values, source: "snapshot" };
  }

  // No snapshot yet — derive from the newest projection vintage for the week.
  // Bounded: one `.unique()` per (player, source) over `wanted`.
  for (const playerId of wanted) {
    const player = await ctx.db.get("players", playerId);
    if (!player) continue;
    for (const source of PROJECTION_SOURCES) {
      const row = await ctx.db
        .query("player_projection_latest")
        .withIndex("by_playerId_season_week_source", (q) =>
          q
            .eq("playerId", playerId)
            .eq("season", args.season)
            .eq("week", args.weekNo)
            .eq("source", source),
        )
        .unique();
      if (!row) continue;
      const weekly = pickProjection(
        {
          ppr: row.projectedPointsPpr,
          half: row.projectedPointsHalf,
          std: row.projectedPointsStd,
        },
        args.rules.scoringPreset,
      );
      values.set(playerId as string, {
        playerId: playerId as string,
        name: player.fullName,
        position: player.position,
        ros: weekly * remainingWeeks,
      });
      break;
    }
  }
  return { values, source: values.size > 0 ? "projections" : "none" };
}

/** A team's roster as `PlayerValueRow[]`. Index: `roster_slots.by_teamId`, take 60. */
async function rosterRows(
  ctx: QueryCtx,
  teamId: Id<"teams">,
  values: Map<string, PlayerValueRow>,
): Promise<PlayerValueRow[]> {
  const slots = await ctx.db
    .query("roster_slots")
    .withIndex("by_teamId", (q) => q.eq("teamId", teamId))
    .take(MAX_ROSTER_SCAN);
  const out: PlayerValueRow[] = [];
  for (const slot of slots) {
    const value = values.get(slot.playerId as string);
    const player = value ? null : await ctx.db.get("players", slot.playerId);
    out.push({
      playerId: slot.playerId as string,
      name: value?.name ?? player?.fullName ?? "Unknown player",
      position: value?.position ?? player?.position ?? "WR",
      ros: value?.ros ?? 0,
    });
  }
  return out;
}

/** Roster player ids for both sides (the valuation needs them before values). */
async function rosterPlayerIds(
  ctx: QueryCtx,
  teamId: Id<"teams">,
): Promise<Id<"players">[]> {
  const slots = await ctx.db
    .query("roster_slots")
    .withIndex("by_teamId", (q) => q.eq("teamId", teamId))
    .take(MAX_ROSTER_SCAN);
  return slots.map((s) => s.playerId);
}

/**
 * Score a proposal (persisted or not) — the Convex half of
 * `lib/services/trades/fairness.scoreTrade`. The arithmetic and the
 * `fairness_detail` v1 shape live in `lib/fairness_pure.ts`.
 */
export async function scoreTrade(
  ctx: QueryCtx,
  input: {
    leagueId: Id<"leagues">;
    proposerTeamId: Id<"teams">;
    recipientTeamId: Id<"teams">;
    weekNo: number;
    give: Id<"players">[];
    receive: Id<"players">[];
    faab?: number;
    rules?: SocialRules;
  },
): Promise<FairnessResult> {
  const rules = input.rules ?? (await loadSocialRules(ctx, input.leagueId));
  const league = await ctx.db.get("leagues", input.leagueId);
  const proposerIds = await rosterPlayerIds(ctx, input.proposerTeamId);
  const recipientIds = await rosterPlayerIds(ctx, input.recipientTeamId);

  const { values, source } = await buildValues(ctx, {
    leagueId: input.leagueId,
    season: league?.season ?? 0,
    weekNo: input.weekNo,
    rules,
    playerIds: [...input.give, ...input.receive, ...proposerIds, ...recipientIds],
  });

  return scoreTradePure({
    proposerTeamId: input.proposerTeamId as string,
    recipientTeamId: input.recipientTeamId as string,
    give: input.give as unknown as string[],
    receive: input.receive as unknown as string[],
    faab: input.faab,
    rules,
    values,
    proposerRoster: await rosterRows(ctx, input.proposerTeamId, values),
    recipientRoster: await rosterRows(ctx, input.recipientTeamId, values),
    source,
  });
}

/**
 * Score a proposal that is not persisted yet — the preview the runtime shows an
 * agent before it commits, and the handle the fairness tests use.
 */
export const scoreProposal = internalQuery({
  args: {
    leagueId: v.id("leagues"),
    proposerTeamId: v.id("teams"),
    recipientTeamId: v.id("teams"),
    weekNo: v.number(),
    give: v.array(v.id("players")),
    receive: v.array(v.id("players")),
    faab: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<FairnessResult> => scoreTrade(ctx, args),
});

/** Split a trade's `items` into the proposer's point of view. */
function splitItems(trade: Doc<"trades">): {
  give: Id<"players">[];
  receive: Id<"players">[];
  faab: number;
} {
  const give: Id<"players">[] = [];
  const receive: Id<"players">[] = [];
  let faab = 0;
  for (const item of trade.items) {
    if (item.playerId) {
      if (item.fromTeamId === trade.proposerTeamId) give.push(item.playerId);
      else receive.push(item.playerId);
    } else if (item.faab) {
      faab += item.fromTeamId === trade.proposerTeamId ? item.faab : -item.faab;
    }
  }
  return { give, receive, faab };
}

// ------------------------------------------------------------------ internals

async function writeTradeEvent(
  ctx: MutationCtx,
  args: {
    tradeId: Id<"trades">;
    leagueId: Id<"leagues">;
    type: string;
    fromStatus?: Doc<"trades">["status"];
    toStatus?: Doc<"trades">["status"];
    actorTeamId?: Id<"teams">;
    agentCtx?: AgentCtx | null;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  await ctx.db.insert("trade_events", {
    tradeId: args.tradeId,
    leagueId: args.leagueId,
    type: args.type,
    ...(args.fromStatus ? { fromStatus: args.fromStatus } : {}),
    ...(args.toStatus ? { toStatus: args.toStatus } : {}),
    ...(args.agentCtx ? { runId: args.agentCtx.runId, stepIndex: args.agentCtx.stepIndex } : {}),
    ...(args.actorTeamId ? { actorTeamId: args.actorTeamId } : {}),
    payload: compact(args.payload),
  });
}

async function playerNames(ctx: QueryCtx, playerIds: Id<"players">[]): Promise<string[]> {
  const out: string[] = [];
  for (const id of playerIds) {
    const player = await ctx.db.get("players", id);
    out.push(player?.fullName ?? (id as string));
  }
  return out;
}

async function offerSummary(
  ctx: QueryCtx,
  args: {
    recipientName: string;
    give: Id<"players">[];
    receive: Id<"players">[];
    faab: number;
    note?: string;
  },
): Promise<string> {
  const giveNames = await playerNames(ctx, args.give);
  const receiveNames = await playerNames(ctx, args.receive);
  const parts = [
    `Trade offer to ${args.recipientName}`,
    `Sending: ${giveNames.join(", ") || "—"}`,
    `Requesting: ${receiveNames.join(", ") || "—"}`,
  ];
  if (args.faab > 0) parts.push(`Plus $${args.faab} FAAB`);
  if (args.note) parts.push(args.note);
  return parts.join("\n");
}

async function postThreadUpdate(
  ctx: MutationCtx,
  trade: Doc<"trades">,
  senderTeamId: Id<"teams">,
  body: string,
  agentCtx: AgentCtx,
): Promise<void> {
  if (!trade.threadId) return;
  await insertThreadMessage(ctx, {
    threadId: trade.threadId,
    leagueId: trade.leagueId,
    senderTeamId,
    body,
    runId: agentCtx.runId,
    stepIndex: agentCtx.stepIndex,
    configVersionId: agentCtx.configVersionId,
    windowId: agentCtx.windowId,
  });
}

function suffix(message?: string): string {
  return message ? ` ${message}` : "";
}

/**
 * Players that would be traded *back* to the team that recently sent them away.
 *
 * A move X→Y is blocked when a completed trade inside the anti-churn horizon
 * moved the same player Y→X. Both records the Postgres version consulted are
 * consulted here: the unified feed (`transactions.by_leagueId_playerId`, take 50
 * per player) and the authoritative completed trades
 * (`trades.by_leagueId_status`, take 100).
 */
async function antiChurnViolations(
  ctx: QueryCtx,
  args: {
    leagueId: Id<"leagues">;
    teamAId: Id<"teams">;
    teamBId: Id<"teams">;
    moves: Array<{ playerId: Id<"players">; fromTeamId: Id<"teams">; toTeamId: Id<"teams"> }>;
    weekNo: number;
    antiChurnWeeks: number;
  },
): Promise<Id<"players">[]> {
  if (args.antiChurnWeeks <= 0 || args.moves.length === 0) return [];
  const sinceWeek = args.weekNo - args.antiChurnWeeks;
  const playerIds = [...new Set(args.moves.map((m) => m.playerId))];

  type Prior = { playerId: string; fromTeamId?: string; toTeamId: string };
  const prior: Prior[] = [];

  for (const playerId of playerIds) {
    const rows = await ctx.db
      .query("transactions")
      .withIndex("by_leagueId_playerId", (q) =>
        q.eq("leagueId", args.leagueId).eq("playerId", playerId),
      )
      .order("desc")
      .take(MAX_CHURN_TRANSACTIONS);
    for (const row of rows) {
      if (row.type !== "trade") continue;
      if (row.teamId !== args.teamAId && row.teamId !== args.teamBId) continue;
      if ((row.weekNo ?? 0) <= sinceWeek) continue;
      prior.push({
        playerId: playerId as string,
        fromTeamId: row.relatedTeamId as string | undefined,
        toTeamId: row.teamId as string,
      });
    }
  }

  const completed = await ctx.db
    .query("trades")
    .withIndex("by_leagueId_status", (q) =>
      q.eq("leagueId", args.leagueId).eq("status", "completed"),
    )
    .order("desc")
    .take(MAX_CHURN_TRADES);
  for (const trade of completed) {
    if (trade.weekNo <= sinceWeek) continue;
    for (const item of trade.items) {
      if (!item.playerId) continue;
      if (!playerIds.includes(item.playerId)) continue;
      prior.push({
        playerId: item.playerId as string,
        fromTeamId: item.fromTeamId as string,
        toTeamId: item.toTeamId as string,
      });
    }
  }

  const violations = new Set<Id<"players">>();
  for (const move of args.moves) {
    const returning = prior.some(
      (p) =>
        p.playerId === (move.playerId as string) &&
        p.fromTeamId === (move.toTeamId as string) &&
        p.toTeamId === (move.fromTeamId as string),
    );
    if (returning) violations.add(move.playerId);
  }
  return [...violations];
}

// -------------------------------------------------------------------- propose

type CreateProposalArgs = {
  leagueId: Id<"leagues">;
  proposerTeamId: Id<"teams">;
  recipientTeamId: Id<"teams">;
  give: Id<"players">[];
  receive: Id<"players">[];
  faab?: number;
  message?: string;
  agentCtx: AgentCtx;
  rules: SocialRules;
  /** Counters skip the cap: they close the parent as they open. */
  enforceOpenProposalCap: boolean;
  threadId?: Id<"threads">;
  parentTradeId?: Id<"trades">;
};

async function createProposal(
  ctx: MutationCtx,
  args: CreateProposalArgs,
): Promise<ActionResult<{ tradeId: Id<"trades">; threadId: Id<"threads"> }>> {
  const errors: string[] = [];
  const give = [...new Set(args.give ?? [])];
  const receive = [...new Set(args.receive ?? [])];
  const faab = Math.trunc(args.faab ?? 0);

  if (args.proposerTeamId === args.recipientTeamId) {
    return { ok: false, errors: ["A team cannot trade with itself"] };
  }
  if (give.length === 0 || receive.length === 0) {
    errors.push("A trade must move at least one player in each direction");
  }
  if (faab < 0) errors.push("FAAB must be zero or positive");

  const proposer = await loadLeagueTeam(ctx, args.leagueId, args.proposerTeamId);
  const recipient = await loadLeagueTeam(ctx, args.leagueId, args.recipientTeamId);
  if (!proposer) errors.push("Proposing team is not in this league");
  if (!recipient) errors.push("Recipient team is not in this league");
  if (!proposer || !recipient) return { ok: false, errors };

  // Rosters are read live (`roster_slots.by_teamId_playerId`), not from the
  // snapshot: a proposal naming a player traded away an hour ago must fail.
  const missingGive: Id<"players">[] = [];
  for (const playerId of give) {
    const slot = await ctx.db
      .query("roster_slots")
      .withIndex("by_teamId_playerId", (q) =>
        q.eq("teamId", proposer._id).eq("playerId", playerId),
      )
      .unique();
    if (!slot) missingGive.push(playerId);
  }
  const missingReceive: Id<"players">[] = [];
  for (const playerId of receive) {
    const slot = await ctx.db
      .query("roster_slots")
      .withIndex("by_teamId_playerId", (q) =>
        q.eq("teamId", recipient._id).eq("playerId", playerId),
      )
      .unique();
    if (!slot) missingReceive.push(playerId);
  }
  if (missingGive.length) {
    errors.push(`Not on your roster: ${(await playerNames(ctx, missingGive)).join(", ")}`);
  }
  if (missingReceive.length) {
    errors.push(
      `Not on ${recipient.name}'s roster: ${(await playerNames(ctx, missingReceive)).join(", ")}`,
    );
  }

  if (faab > proposer.faabRemaining) {
    errors.push(`FAAB offer of $${faab} exceeds your remaining $${proposer.faabRemaining}`);
  }

  // Roster-size sanity: neither side may end up over total capacity. Uneven
  // trades are legal as long as the receiving side has room.
  const capacity = totalRosterCapacity(args.rules.rosterSlots);
  const proposerSize = (await rosterPlayerIds(ctx, proposer._id)).length;
  const recipientSize = (await rosterPlayerIds(ctx, recipient._id)).length;
  const proposerAfter = proposerSize - give.length + receive.length;
  const recipientAfter = recipientSize - receive.length + give.length;
  if (proposerAfter > capacity) {
    errors.push(`Your roster would hold ${proposerAfter} players (limit ${capacity})`);
  }
  if (recipientAfter > capacity) {
    errors.push(
      `${recipient.name}'s roster would hold ${recipientAfter} players (limit ${capacity})`,
    );
  }

  if (args.enforceOpenProposalCap) {
    const open = await ctx.db
      .query("trades")
      .withIndex("by_proposerTeamId_status", (q) =>
        q.eq("proposerTeamId", proposer._id).eq("status", "proposed"),
      )
      .take(MAX_OPEN_SCAN);
    if (rateLimitExceeded(open.length, args.rules.maxOpenProposals)) {
      errors.push(
        `You already have ${open.length} open proposals (limit ${args.rules.maxOpenProposals})`,
      );
    }
  }

  const churn = await antiChurnViolations(ctx, {
    leagueId: args.leagueId,
    teamAId: proposer._id,
    teamBId: recipient._id,
    moves: [
      ...give.map((playerId) => ({
        playerId,
        fromTeamId: proposer._id,
        toTeamId: recipient._id,
      })),
      ...receive.map((playerId) => ({
        playerId,
        fromTeamId: recipient._id,
        toTeamId: proposer._id,
      })),
    ],
    weekNo: args.agentCtx.weekNo,
    antiChurnWeeks: args.rules.antiChurnWeeks,
  });
  if (churn.length > 0) {
    const names = await playerNames(ctx, churn);
    errors.push(
      `Anti-churn: ${names.join(", ")} cannot be traded back between these teams for ${args.rules.antiChurnWeeks} weeks`,
    );
  }

  if (errors.length > 0) return { ok: false, errors };

  const thread = await resolveThread(ctx, {
    leagueId: args.leagueId,
    fromTeamId: proposer._id,
    toTeamId: recipient._id,
    threadId: args.threadId,
    windowId: args.agentCtx.windowId,
    rules: args.rules,
    skipThreadLimit: true,
  });
  if (!thread.ok) return thread;

  const tradeId = await ctx.db.insert("trades", {
    leagueId: args.leagueId,
    proposerTeamId: proposer._id,
    recipientTeamId: recipient._id,
    threadId: thread.threadId,
    windowId: args.agentCtx.windowId,
    weekNo: args.agentCtx.weekNo,
    status: "proposed",
    items: [
      ...give.map((playerId) => ({
        fromTeamId: proposer._id,
        toTeamId: recipient._id,
        playerId,
      })),
      ...receive.map((playerId) => ({
        fromTeamId: recipient._id,
        toTeamId: proposer._id,
        playerId,
      })),
      ...(faab > 0
        ? [{ fromTeamId: proposer._id, toTeamId: recipient._id, faab }]
        : []),
    ],
    flagged: false,
    ...(args.message ? { message: args.message } : {}),
    ...(args.parentTradeId ? { parentTradeId: args.parentTradeId } : {}),
    createdByRunId: args.agentCtx.runId,
    vetoCount: 0,
    approveCount: 0,
  });

  await writeTradeEvent(ctx, {
    tradeId,
    leagueId: args.leagueId,
    type: args.parentTradeId ? "countered" : "proposed",
    toStatus: "proposed",
    actorTeamId: proposer._id,
    agentCtx: args.agentCtx,
    payload: {
      give: give as unknown as string[],
      receive: receive as unknown as string[],
      faab,
      parentTradeId: (args.parentTradeId as string | undefined) ?? null,
    },
  });

  await insertThreadMessage(ctx, {
    threadId: thread.threadId,
    leagueId: args.leagueId,
    senderTeamId: proposer._id,
    body: await offerSummary(ctx, {
      recipientName: recipient.name,
      give,
      receive,
      faab,
      note: args.message,
    }),
    runId: args.agentCtx.runId,
    stepIndex: args.agentCtx.stepIndex,
    configVersionId: args.agentCtx.configVersionId,
    windowId: args.agentCtx.windowId,
  });

  return { ok: true, tradeId, threadId: thread.threadId };
}

/**
 * The runtime's `propose_trade` tool.
 *
 * Validates rosters, FAAB, roster size, the open-proposal cap and anti-churn;
 * opens (or reuses) the DM thread between the two teams and posts a system
 * message summarizing the offer so the negotiation reads as one conversation.
 * Idempotent on `(agentCtx.runId, agentCtx.toolCallId)`.
 */
export const propose = internalMutation({
  args: {
    leagueId: v.id("leagues"),
    proposerTeamId: v.id("teams"),
    toTeamId: v.id("teams"),
    give: v.array(v.id("players")),
    receive: v.array(v.id("players")),
    faab: v.optional(v.number()),
    message: v.optional(v.string()),
    agentCtx: agentCtxValidator,
  },
  returns: v.union(
    v.object({ ok: v.literal(true), tradeId: v.id("trades"), threadId: v.id("threads") }),
    actionErrors,
  ),
  handler: async (ctx, args) => {
    return commitAction<{ tradeId: Id<"trades">; threadId: Id<"threads"> }>(
      ctx,
      {
        agentCtx: args.agentCtx,
        leagueId: args.leagueId,
        teamId: args.proposerTeamId,
        actionType: "propose_trade",
        payload: {
          toTeamId: args.toTeamId,
          give: args.give,
          receive: args.receive,
          faab: args.faab,
          message: args.message,
        },
      },
      async () =>
        createProposal(ctx, {
          leagueId: args.leagueId,
          proposerTeamId: args.proposerTeamId,
          recipientTeamId: args.toTeamId,
          give: args.give,
          receive: args.receive,
          faab: args.faab,
          message: args.message,
          agentCtx: args.agentCtx,
          rules: await loadSocialRules(ctx, args.leagueId),
          enforceOpenProposalCap: true,
        }),
    );
  },
});

// -------------------------------------------------------------------- respond

/**
 * The recipient's move: accept, reject or counter (the runtime's
 * `respond_to_trade` tool).
 *
 * Accepting moves the trade into review, computes the deterministic fairness
 * score, and schedules the Commissioner Agent's narrative (best effort — the
 * score is already stored, the paragraph is commentary). A counter creates a
 * child proposal with the roles swapped and marks the parent `countered`.
 * Idempotent on `(agentCtx.runId, agentCtx.toolCallId)`.
 */
export const respond = internalMutation({
  args: {
    leagueId: v.id("leagues"),
    teamId: v.id("teams"),
    tradeId: v.id("trades"),
    action: v.union(v.literal("accept"), v.literal("reject"), v.literal("counter")),
    counter: v.optional(
      v.object({
        give: v.array(v.id("players")),
        receive: v.array(v.id("players")),
        faab: v.optional(v.number()),
      }),
    ),
    message: v.optional(v.string()),
    agentCtx: agentCtxValidator,
  },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      tradeId: v.id("trades"),
      status: v.string(),
      counterTradeId: v.optional(v.id("trades")),
    }),
    actionErrors,
  ),
  handler: async (ctx, args) => {
    return commitAction<{
      tradeId: Id<"trades">;
      status: string;
      counterTradeId?: Id<"trades">;
    }>(
      ctx,
      {
        agentCtx: args.agentCtx,
        leagueId: args.leagueId,
        teamId: args.teamId,
        actionType: "respond_to_trade",
        payload: {
          tradeId: args.tradeId,
          action: args.action,
          counter: args.counter,
          message: args.message,
        },
      },
      async () => {
        const trade = await ctx.db.get("trades", args.tradeId);
        if (!trade || trade.leagueId !== args.leagueId) {
          return { ok: false, errors: ["Trade not found in this league"] };
        }
        if (trade.recipientTeamId !== args.teamId) {
          return { ok: false, errors: ["Only the recipient can respond to this proposal"] };
        }
        if (trade.status !== "proposed") {
          return {
            ok: false,
            errors: [`This proposal is ${trade.status} and cannot be answered`],
          };
        }

        const rules = await loadSocialRules(ctx, args.leagueId);
        const now = Date.now();

        if (args.action === "reject") {
          await ctx.db.patch("trades", trade._id, {
            status: "rejected",
            resolvedAt: now,
          });
          await writeTradeEvent(ctx, {
            tradeId: trade._id,
            leagueId: trade.leagueId,
            type: "rejected",
            fromStatus: "proposed",
            toStatus: "rejected",
            actorTeamId: args.teamId,
            agentCtx: args.agentCtx,
            payload: { message: args.message ?? null },
          });
          await postThreadUpdate(
            ctx,
            trade,
            args.teamId,
            `Rejected the offer.${suffix(args.message)}`,
            args.agentCtx,
          );
          return { ok: true, tradeId: trade._id, status: "rejected" };
        }

        if (args.action === "counter") {
          if (!args.counter) {
            return { ok: false, errors: ["A counter must include give/receive"] };
          }
          const child = await createProposal(ctx, {
            leagueId: args.leagueId,
            proposerTeamId: args.teamId,
            recipientTeamId: trade.proposerTeamId,
            give: args.counter.give,
            receive: args.counter.receive,
            faab: args.counter.faab,
            message: args.message,
            agentCtx: args.agentCtx,
            rules,
            enforceOpenProposalCap: false,
            threadId: trade.threadId,
            parentTradeId: trade._id,
          });
          if (!child.ok) return child;

          await ctx.db.patch("trades", trade._id, {
            status: "countered",
            resolvedAt: now,
          });
          await writeTradeEvent(ctx, {
            tradeId: trade._id,
            leagueId: trade.leagueId,
            type: "countered",
            fromStatus: "proposed",
            toStatus: "countered",
            actorTeamId: args.teamId,
            agentCtx: args.agentCtx,
            payload: { counterTradeId: child.tradeId as string },
          });
          return {
            ok: true,
            tradeId: trade._id,
            status: "countered",
            counterTradeId: child.tradeId,
          };
        }

        // ---- accept
        const { give, receive, faab } = splitItems(trade);
        const fairness = await scoreTrade(ctx, {
          leagueId: args.leagueId,
          proposerTeamId: trade.proposerTeamId,
          recipientTeamId: trade.recipientTeamId,
          weekNo: trade.weekNo ?? args.agentCtx.weekNo,
          give,
          receive,
          faab,
          rules,
        });

        const reviewEndsAt = now + rules.tradeReviewHours * 3_600_000;
        await ctx.db.patch("trades", trade._id, {
          status: "in_review",
          reviewEndsAt,
          fairnessScore: fairness.score,
          fairnessDetail: fairness.detail,
          flagged: fairness.flagged,
        });

        await writeTradeEvent(ctx, {
          tradeId: trade._id,
          leagueId: trade.leagueId,
          type: "accepted",
          fromStatus: "proposed",
          toStatus: "accepted",
          actorTeamId: args.teamId,
          agentCtx: args.agentCtx,
          payload: { message: args.message ?? null },
        });
        await writeTradeEvent(ctx, {
          tradeId: trade._id,
          leagueId: trade.leagueId,
          type: "fairness_scored",
          fromStatus: "accepted",
          toStatus: "in_review",
          agentCtx: args.agentCtx,
          payload: {
            score: fairness.score,
            flagged: fairness.flagged,
            reviewEndsAt,
          },
        });
        await postThreadUpdate(
          ctx,
          trade,
          args.teamId,
          `Accepted the offer. Fairness ${fairness.score.toFixed(2)}${
            fairness.flagged ? " — flagged for owner review" : ""
          }; review ends ${new Date(reviewEndsAt).toISOString()}.${suffix(args.message)}`,
          args.agentCtx,
        );

        // Commissioner Agent narrative (PRD 5.6): best effort, after the write,
        // and it never moves the score.
        await ctx.scheduler.runAfter(0, internal.commissioner_agent.tradeNarrative, {
          tradeId: trade._id,
        });

        return { ok: true, tradeId: trade._id, status: "in_review" };
      },
    );
  },
});

// ------------------------------------------------------------------ veto vote

/**
 * The current tally, counted from `trade_votes` (bounded by one league's
 * membership) rather than from the denormalized counters, so a vote change can
 * never drift them.
 */
async function tallyVetoVotes(
  ctx: QueryCtx,
  trade: Doc<"trades">,
): Promise<VetoTally & { votes: Doc<"trade_votes">[] }> {
  const votes = await ctx.db
    .query("trade_votes")
    .withIndex("by_tradeId_userId", (q) => q.eq("tradeId", trade._id))
    .take(MAX_VOTES);
  // Bounded: one league's members (≤ teamCount + spectators).
  const members = await ctx.db
    .query("league_members")
    .withIndex("by_leagueId_userId", (q) => q.eq("leagueId", trade.leagueId))
    .collect();
  const ownerCount = members.filter((m) => m.role !== "spectator").length;
  const vetoes = votes.filter((vote) => vote.vote === "veto").length;
  return {
    votes,
    vetoes,
    approvals: votes.filter((vote) => vote.vote === "approve").length,
    ownerCount,
    threshold: Math.floor(ownerCount / 2) + 1,
    blocked: vetoes > ownerCount / 2,
  };
}

/**
 * Cast (or change) a human owner's veto vote on a trade under review.
 *
 * `leagueMemberProcedure` + the service's own owner check, exactly as the tRPC
 * mutation did: spectators may watch but not vote. One row per (trade, user);
 * `trades.vetoCount` / `approveCount` are recomputed from the rows so the detail
 * page's tally stays exact.
 */
export const castVeto = mutation({
  args: {
    leagueId: v.id("leagues"),
    tradeId: v.id("trades"),
    vote: tradeVote,
  },
  returns: v.object({
    ok: v.literal(true),
    vetoes: v.number(),
    approvals: v.number(),
    ownerCount: v.number(),
    threshold: v.number(),
    blocked: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const access = await requireMember(ctx, args.leagueId);

    const trade = await ctx.db.get("trades", args.tradeId);
    if (!trade || trade.leagueId !== args.leagueId) {
      throw appError("NOT_FOUND", "Trade not found");
    }
    if (trade.status !== "in_review") {
      throw appError("BAD_REQUEST", `This trade is ${trade.status}; voting is closed`);
    }
    if (access.membership.role === "spectator") {
      throw appError("BAD_REQUEST", "Only league owners may vote on a trade");
    }

    const existing = await ctx.db
      .query("trade_votes")
      .withIndex("by_tradeId_userId", (q) =>
        q.eq("tradeId", args.tradeId).eq("userId", access.viewer.userId),
      )
      .unique();
    if (existing) {
      await ctx.db.patch("trade_votes", existing._id, { vote: args.vote });
    } else {
      await ctx.db.insert("trade_votes", {
        tradeId: args.tradeId,
        userId: access.viewer.userId,
        vote: args.vote,
      });
    }

    const tally = await tallyVetoVotes(ctx, trade);
    await ctx.db.patch("trades", trade._id, {
      vetoCount: tally.vetoes,
      approveCount: tally.approvals,
    });
    await writeTradeEvent(ctx, {
      tradeId: trade._id,
      leagueId: trade.leagueId,
      type: "veto_vote",
      fromStatus: "in_review",
      toStatus: "in_review",
      payload: {
        userId: access.viewer.userId as string,
        vote: args.vote,
        vetoes: tally.vetoes,
        approvals: tally.approvals,
        ownerCount: tally.ownerCount,
        threshold: tally.threshold,
        blocked: tally.blocked,
      },
    });

    return {
      ok: true as const,
      vetoes: tally.vetoes,
      approvals: tally.approvals,
      ownerCount: tally.ownerCount,
      threshold: tally.threshold,
      blocked: tally.blocked,
    };
  },
});

// --------------------------------------------------------------- tick helpers

/**
 * Close out proposals left hanging when a negotiation window ends.
 * Index: `trades.by_windowId_status`, one range per open status, take 100.
 */
export const expireForWindow = internalMutation({
  args: { windowId: v.id("windows") },
  returns: v.object({ expired: v.number() }),
  handler: async (ctx, { windowId }) => {
    const now = Date.now();
    let expired = 0;
    for (const status of OPEN_TRADE_STATUSES) {
      const open = await ctx.db
        .query("trades")
        .withIndex("by_windowId_status", (q) =>
          q.eq("windowId", windowId).eq("status", status),
        )
        .take(MAX_EXPIRE);
      for (const trade of open) {
        await ctx.db.patch("trades", trade._id, { status: "expired", resolvedAt: now });
        await writeTradeEvent(ctx, {
          tradeId: trade._id,
          leagueId: trade.leagueId,
          type: "expired",
          fromStatus: trade.status,
          toStatus: "expired",
          payload: { windowId: windowId as string },
        });
        expired += 1;
      }
    }
    return { expired };
  },
});

/**
 * Resolve trades whose review period has elapsed.
 *
 * Unflagged trades complete automatically. Flagged trades need the owners to
 * block them: a strict majority of veto votes kills the trade.
 * Index: `trades.by_status_reviewEndsAt` ranged `reviewEndsAt <= now`, take 50,
 * filtered to this league.
 */
export const processReviews = internalMutation({
  args: { leagueId: v.id("leagues"), now: v.number() },
  returns: v.object({ resolved: v.number() }),
  handler: async (ctx, args) => {
    const due = await ctx.db
      .query("trades")
      .withIndex("by_status_reviewEndsAt", (q) =>
        q.eq("status", "in_review").lte("reviewEndsAt", args.now),
      )
      .take(MAX_REVIEWS);

    let resolved = 0;
    for (const trade of due) {
      if (trade.leagueId !== args.leagueId) continue;
      if (trade.flagged) {
        const tally = await tallyVetoVotes(ctx, trade);
        if (tally.vetoes > tally.ownerCount / 2) {
          await ctx.db.patch("trades", trade._id, {
            status: "vetoed",
            resolvedAt: args.now,
          });
          await writeTradeEvent(ctx, {
            tradeId: trade._id,
            leagueId: trade.leagueId,
            type: "vetoed",
            fromStatus: "in_review",
            toStatus: "vetoed",
            payload: {
              vetoes: tally.vetoes,
              approvals: tally.approvals,
              ownerCount: tally.ownerCount,
              threshold: tally.threshold,
              blocked: tally.blocked,
            },
          });
          resolved += 1;
          continue;
        }
      }
      await completeTrade(ctx, trade, args.now);
      resolved += 1;
    }
    return { resolved };
  },
});

/** Players whose game has already kicked off for the trade's week. */
async function lockedPlayers(
  ctx: QueryCtx,
  trade: Doc<"trades">,
  playerIds: Id<"players">[],
  now: number,
): Promise<Id<"players">[]> {
  if (playerIds.length === 0) return [];
  const league = await ctx.db.get("leagues", trade.leagueId);
  if (!league) return [];

  // Bounded: ≤ 16 NFL games in a week.
  const games = await ctx.db
    .query("nfl_games")
    .withIndex("by_season_week", (q) => q.eq("season", league.season).eq("week", trade.weekNo))
    .take(MAX_GAMES);
  const started = new Set<string>();
  for (const game of games) {
    if (game.kickoffAt > now) continue;
    started.add(game.homeTeam);
    started.add(game.awayTeam);
  }
  if (started.size === 0) return [];

  const out: Id<"players">[] = [];
  for (const playerId of playerIds) {
    const player = await ctx.db.get("players", playerId);
    if (player?.nflTeam && started.has(player.nflTeam)) out.push(playerId);
  }
  return out;
}

/**
 * Move the players, settle FAAB, and write the transaction feed rows.
 *
 * A roster that moved under us between accept and completion cancels the trade
 * rather than corrupting a roster. Locked players (their game already kicked
 * off) do **not** block the swap: the players move now and the current week's
 * lineup is deliberately left untouched.
 */
async function completeTrade(
  ctx: MutationCtx,
  trade: Doc<"trades">,
  now: number,
): Promise<void> {
  const playerMoves = trade.items.filter(
    (item): item is typeof item & { playerId: Id<"players"> } => item.playerId !== undefined,
  );

  // Guard against a roster that moved under us between accept and completion.
  const stale: Id<"players">[] = [];
  for (const item of playerMoves) {
    const slot = await ctx.db
      .query("roster_slots")
      .withIndex("by_teamId_playerId", (q) =>
        q.eq("teamId", item.fromTeamId).eq("playerId", item.playerId),
      )
      .unique();
    if (!slot) stale.push(item.playerId);
  }
  if (stale.length > 0) {
    await ctx.db.patch("trades", trade._id, { status: "cancelled", resolvedAt: now });
    await writeTradeEvent(ctx, {
      tradeId: trade._id,
      leagueId: trade.leagueId,
      type: "invalidated",
      fromStatus: "in_review",
      toStatus: "cancelled",
      payload: {
        reason: "roster changed after acceptance",
        playerIds: stale as unknown as string[],
      },
    });
    return;
  }

  const locked = await lockedPlayers(
    ctx,
    trade,
    playerMoves.map((i) => i.playerId),
    now,
  );

  for (const item of playerMoves) {
    const slot = await ctx.db
      .query("roster_slots")
      .withIndex("by_teamId_playerId", (q) =>
        q.eq("teamId", item.fromTeamId).eq("playerId", item.playerId),
      )
      .unique();
    if (slot) await ctx.db.delete("roster_slots", slot._id);
    await ctx.db.insert("roster_slots", {
      leagueId: trade.leagueId,
      teamId: item.toTeamId,
      playerId: item.playerId,
      acquiredAt: now,
      acquiredVia: "trade",
    });
    await ctx.db.insert("transactions", {
      leagueId: trade.leagueId,
      teamId: item.toTeamId,
      type: "trade",
      weekNo: trade.weekNo,
      playerId: item.playerId,
      relatedTeamId: item.fromTeamId,
      tradeId: trade._id,
      details: { direction: "in", locked: locked.includes(item.playerId) },
    });
  }

  const faabItems = trade.items.filter((item) => !item.playerId && item.faab);
  for (const item of faabItems) {
    const amount = item.faab ?? 0;
    if (amount <= 0) continue;
    const from = await ctx.db.get("teams", item.fromTeamId);
    if (from) {
      await ctx.db.patch("teams", from._id, {
        faabRemaining: Math.max(from.faabRemaining - amount, 0),
      });
    }
    const to = await ctx.db.get("teams", item.toTeamId);
    if (to) {
      await ctx.db.patch("teams", to._id, { faabRemaining: to.faabRemaining + amount });
    }
  }

  await ctx.db.patch("trades", trade._id, { status: "completed", resolvedAt: now });
  await writeTradeEvent(ctx, {
    tradeId: trade._id,
    leagueId: trade.leagueId,
    type: "completed",
    fromStatus: trade.status,
    toStatus: "completed",
    payload: {
      players: playerMoves.map((i) => i.playerId as string),
      faab: faabItems.map((i) => i.faab ?? 0),
      lockedPlayerIds: locked as unknown as string[],
    },
  });

  if (trade.threadId) {
    await insertThreadMessage(ctx, {
      threadId: trade.threadId,
      leagueId: trade.leagueId,
      senderTeamId: trade.proposerTeamId,
      body: "Trade completed — rosters updated.",
    });
  }
}

/**
 * Attach the Commissioner Agent's prose to an already-scored trade.
 * The number never moves; only `fairnessDetail.narrative` is written.
 */
export const attachNarrative = internalMutation({
  args: { tradeId: v.id("trades"), narrative: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const trade = await ctx.db.get("trades", args.tradeId);
    if (!trade) return null;
    const detail = (trade.fairnessDetail ?? {}) as Record<string, unknown>;
    await ctx.db.patch("trades", args.tradeId, {
      fairnessDetail: { ...detail, narrative: args.narrative },
    });
    return null;
  },
});
