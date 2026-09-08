/**
 * Agent-to-agent DMs — read paths (PRD 5.6, port of `lib/services/messaging`).
 *
 * Humans never write into a thread; what they get is visibility, mediated by
 * `league_rules.transparencyMode`. Under `delayed`, message bodies of a thread
 * whose negotiation window is still open (or that still has an unresolved
 * proposal) are withheld from everyone except a party to the thread and the
 * commissioner — see `isThreadRevealed` in `lib/social_pure.ts`.
 *
 * Phase 3 adds `messaging.send` to this file. It must maintain
 * `threads.lastMessageAt`, `threads.messageCount` and `threads.flaggedCount`,
 * which the list below reads instead of scanning every thread's messages.
 */
import { paginationOptsValidator, type PaginationResult } from "convex/server";
import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { internalQuery, query, type QueryCtx } from "./_generated/server";
import { requireLeagueRead, viewerTeamIds, type LeagueAccess } from "./lib/auth";
import { appError } from "./lib/errors";
import {
  isThreadRevealed,
  isOpenTradeStatus,
  isUnresolvedTradeStatus,
  isWindowOpen,
  toAgentFlags,
  type EpochDates,
} from "./lib/social_pure";
import { tradeDocsForThread, tradesForThread, type TradeSummary } from "./trades";

import type {
  InboxMessage as PgInboxMessage,
  InboxThread as PgInboxThread,
  ThreadListItem as PgThreadListItem,
  ThreadMessageView as PgThreadMessageView,
  ThreadTeamRef,
} from "../lib/services/messaging";

// ---------------------------------------------------------------------------
// Return types — the old service types with epoch-ms dates
// ---------------------------------------------------------------------------

export type { ThreadTeamRef };

export type ThreadMessageView = EpochDates<PgThreadMessageView, "createdAt">;

export type ThreadListItem = Omit<
  EpochDates<PgThreadListItem, "createdAt" | "lastMessageAt" | "revealAt">,
  "lastMessage"
> & { lastMessage: ThreadMessageView | null };

/**
 * `getThread` returns the same header as a list row, plus the thread's
 * proposals, plus one **page** of messages (the Postgres version returned all of
 * them; threads are short, so the first page is normally the whole transcript).
 */
export type ThreadView = ThreadListItem & {
  messages: PaginationResult<ThreadMessageView>;
  trades: TradeSummary[];
};

export type InboxMessage = EpochDates<PgInboxMessage, "createdAt">;
export type InboxThread = Omit<
  EpochDates<PgInboxThread, "lastMessageAt">,
  "messages"
> & { messages: InboxMessage[] };

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Hard cap on the thread feed, whatever the caller asks for. */
const MAX_THREADS = 100;
/** Threads per side of the inbox (`by_teamAId` / `by_teamBId`). */
const MAX_INBOX_THREADS = 50;
/** Messages returned per thread by the agent inbox. */
const MAX_INBOX_MESSAGES = 20;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type TeamMap = Map<string, Doc<"teams">>;

async function loadTeams(ctx: QueryCtx, leagueId: Id<"leagues">): Promise<TeamMap> {
  // Bounded: one league has at most `teamCount` (≤ 14) teams.
  const teams = await ctx.db
    .query("teams")
    .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
    .collect();
  return new Map(teams.map((t) => [t._id as string, t]));
}

async function transparencyMode(
  ctx: QueryCtx,
  leagueId: Id<"leagues">,
): Promise<"live" | "delayed"> {
  const rules = await ctx.db
    .query("league_rules")
    .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
    .unique();
  // `SOCIAL_RULE_DEFAULTS.transparencyMode` — a league whose rules row is
  // missing behaves as `live`.
  return rules?.transparencyMode ?? "live";
}

function teamRef(teamId: Id<"teams">, teams: TeamMap): ThreadTeamRef {
  const team = teams.get(teamId as string);
  return {
    id: teamId as string,
    name: team?.name ?? "Unknown",
    abbreviation: team?.abbreviation ?? "???",
  };
}

function toMessageView(
  m: Doc<"messages">,
  teams: TeamMap,
  withheld: boolean,
): ThreadMessageView {
  return {
    id: m._id as string,
    threadId: m.threadId as string,
    senderTeamId: m.senderTeamId as string,
    senderTeamName: teams.get(m.senderTeamId as string)?.name ?? "Unknown",
    body: withheld ? null : m.body,
    withheld,
    flags: withheld ? null : (m.flags ?? null),
    runId: (m.runId as string | undefined) ?? null,
    stepIndex: m.stepIndex ?? null,
    configVersionId: (m.configVersionId as string | undefined) ?? null,
    createdAt: m.createdAt,
  };
}

/**
 * Build one thread card.
 *
 * Reads per thread (all indexed and bounded): the creating window by id, the
 * last message via `messages.by_threadId_createdAt` desc `take(1)`, and the
 * thread's proposals via `trades.by_threadId` `take(25)`.
 */
async function buildThreadListItem(
  ctx: QueryCtx,
  args: {
    thread: Doc<"threads">;
    teams: TeamMap;
    mode: "live" | "delayed";
    viewerTeams: Id<"teams">[];
    isCommissioner: boolean;
    now: number;
  },
): Promise<{ item: ThreadListItem; window: Doc<"windows"> | null; withheld: boolean }> {
  const { thread } = args;
  const window = thread.createdInWindowId
    ? await ctx.db.get("windows", thread.createdInWindowId)
    : null;

  const tradeDocs = await tradeDocsForThread(ctx, thread._id);
  const openTradeCount = tradeDocs.filter((t) => isOpenTradeStatus(t.status)).length;
  const hasUnresolvedTrade = tradeDocs.some((t) => isUnresolvedTradeStatus(t.status));

  const reveal = isThreadRevealed({
    transparencyMode: args.mode,
    windowClosesAt: window?.closesAt ?? null,
    windowStatus: window?.status ?? null,
    viewerTeamIds: args.viewerTeams as unknown as string[],
    threadTeams: [thread.teamAId as string, thread.teamBId as string],
    hasUnresolvedTrade,
    isCommissioner: args.isCommissioner,
    now: args.now,
  });

  const [last] = await ctx.db
    .query("messages")
    .withIndex("by_threadId_createdAt", (q) => q.eq("threadId", thread._id))
    .order("desc")
    .take(1);

  const windowOpen = isWindowOpen(window?.closesAt ?? null, window?.status ?? null, args.now);

  return {
    window,
    withheld: reveal.delayed,
    item: {
      id: thread._id as string,
      leagueId: thread.leagueId as string,
      teamA: teamRef(thread.teamAId, args.teams),
      teamB: teamRef(thread.teamBId, args.teams),
      createdInWindowId: (thread.createdInWindowId as string | undefined) ?? null,
      weekNo: window?.weekNo ?? null,
      windowLabel: window?.label ?? null,
      createdAt: thread._creationTime,
      lastMessageAt: thread.lastMessageAt ?? null,
      messageCount: thread.messageCount,
      status: openTradeCount > 0 || windowOpen ? "open" : "resolved",
      openTradeCount,
      // Denormalized: `listThreads` cannot read every thread's messages.
      flaggedCount: thread.flaggedCount ?? 0,
      lastMessage: last ? toMessageView(last, args.teams, reveal.delayed) : null,
      delayed: reveal.delayed,
      revealAt: reveal.revealAt,
    },
  };
}

/** The viewer facts the transparency rule needs. */
async function viewerFor(
  ctx: QueryCtx,
  leagueId: Id<"leagues">,
  access: LeagueAccess,
): Promise<{ viewerTeams: Id<"teams">[]; isCommissioner: boolean }> {
  return {
    viewerTeams: await viewerTeamIds(ctx, leagueId, access.viewer),
    isCommissioner: access.isCommissioner,
  };
}

// ---------------------------------------------------------------------------
// Public queries
// ---------------------------------------------------------------------------

/**
 * The negotiation feed: every thread in the league, newest activity first.
 *
 * Index: `threads.by_leagueId_lastMessageAt` desc, `take(min(limit, 100))`. When
 * `teamId` is given the two team-side indexes (`by_teamAId` / `by_teamBId`) are
 * ranged instead, `take(min(limit, 100))` each, so a team filter still reaches
 * back through that team's whole history rather than only the league's newest
 * page. `weekNo` and `status` are applied in memory over that bounded set (as
 * the Postgres version did — both derive from joined rows).
 *
 * Threads with no messages yet sort last (Convex orders a missing
 * `lastMessageAt` before every value; Postgres put NULLs first under DESC).
 */
export const listThreads = query({
  args: {
    leagueId: v.id("leagues"),
    teamId: v.optional(v.id("teams")),
    weekNo: v.optional(v.number()),
    status: v.optional(v.union(v.literal("open"), v.literal("resolved"))),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<ThreadListItem[]> => {
    const access = await requireLeagueRead(ctx, args.leagueId);
    const limit = Math.min(Math.max(args.limit ?? MAX_THREADS, 1), MAX_THREADS);
    const now = Date.now();

    let threads: Doc<"threads">[];
    if (args.teamId) {
      const asA = await ctx.db
        .query("threads")
        .withIndex("by_teamAId", (q) => q.eq("teamAId", args.teamId!))
        .order("desc")
        .take(limit);
      const asB = await ctx.db
        .query("threads")
        .withIndex("by_teamBId", (q) => q.eq("teamBId", args.teamId!))
        .order("desc")
        .take(limit);
      threads = [...asA, ...asB]
        .filter((t) => t.leagueId === args.leagueId)
        .sort(byRecency)
        .slice(0, limit);
    } else {
      threads = await ctx.db
        .query("threads")
        .withIndex("by_leagueId_lastMessageAt", (q) => q.eq("leagueId", args.leagueId))
        .order("desc")
        .take(limit);
    }
    if (threads.length === 0) return [];

    const teams = await loadTeams(ctx, args.leagueId);
    const mode = await transparencyMode(ctx, args.leagueId);
    const viewer = await viewerFor(ctx, args.leagueId, access);

    const items: ThreadListItem[] = [];
    for (const thread of threads) {
      const built = await buildThreadListItem(ctx, {
        thread,
        teams,
        mode,
        viewerTeams: viewer.viewerTeams,
        isCommissioner: viewer.isCommissioner,
        now,
      });
      if (args.weekNo !== undefined && built.window?.weekNo !== args.weekNo) continue;
      if (args.status !== undefined && built.item.status !== args.status) continue;
      items.push(built.item);
    }
    return items;
  },
});

function byRecency(a: Doc<"threads">, b: Doc<"threads">): number {
  return (b.lastMessageAt ?? b._creationTime) - (a.lastMessageAt ?? a._creationTime);
}

/**
 * One thread: the same header as a feed row, one page of its messages and the
 * proposals raised inside it.
 *
 * Index: `messages.by_threadId_createdAt` ascending, `.paginate(paginationOpts)`
 * — oldest first, so the first page reads as the start of the transcript, the
 * way the Postgres version returned the whole array. Bodies come back `null`
 * with `withheld: true` while delayed reveal applies; `revealAt` says when the
 * thread opens up.
 */
export const getThread = query({
  args: {
    leagueId: v.id("leagues"),
    threadId: v.id("threads"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args): Promise<ThreadView> => {
    const access = await requireLeagueRead(ctx, args.leagueId);

    const thread = await ctx.db.get("threads", args.threadId);
    if (!thread || thread.leagueId !== args.leagueId) {
      throw appError("NOT_FOUND", "Thread not found");
    }

    const teams = await loadTeams(ctx, args.leagueId);
    const mode = await transparencyMode(ctx, args.leagueId);
    const viewer = await viewerFor(ctx, args.leagueId, access);
    const built = await buildThreadListItem(ctx, {
      thread,
      teams,
      mode,
      viewerTeams: viewer.viewerTeams,
      isCommissioner: viewer.isCommissioner,
      now: Date.now(),
    });

    const page = await ctx.db
      .query("messages")
      .withIndex("by_threadId_createdAt", (q) => q.eq("threadId", args.threadId))
      .order("asc")
      .paginate(args.paginationOpts);

    return {
      ...built.item,
      messages: {
        ...page,
        page: page.page.map((m) => toMessageView(m, teams, built.withheld)),
      },
      trades: await tradesForThread(ctx, args.leagueId, args.threadId),
    };
  },
});

// ---------------------------------------------------------------------------
// Internal queries (agent runtime)
// ---------------------------------------------------------------------------

/**
 * The agent's inbox (`get_inbox`, and the prompt's DM context).
 *
 * Agents only ever see threads their own team is a party to, and transparency
 * mode does not apply — a party always reads its own conversation.
 *
 * "Unread" means since the team's last finished run, or since `since` (epoch ms)
 * when the caller supplies a watermark.
 *
 * Indexes/bounds: `threads.by_teamAId` and `threads.by_teamBId` `take(50)` each;
 * per thread `messages.by_threadId_createdAt` desc `take(20)` (so `unreadCount`
 * counts within the last 20 messages — the Postgres version scanned them all)
 * and `trades.by_threadId` `take(25)`; the watermark comes from `runs.by_teamId`
 * desc `take(20)`.
 */
export const inboxForTeam = internalQuery({
  args: {
    leagueId: v.id("leagues"),
    teamId: v.id("teams"),
    threadId: v.optional(v.id("threads")),
    unreadOnly: v.optional(v.boolean()),
    since: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<InboxThread[]> => {
    const watermark = await readWatermark(ctx, args.teamId, args.since);

    const asA = await ctx.db
      .query("threads")
      .withIndex("by_teamAId", (q) => q.eq("teamAId", args.teamId))
      .order("desc")
      .take(MAX_INBOX_THREADS);
    const asB = await ctx.db
      .query("threads")
      .withIndex("by_teamBId", (q) => q.eq("teamBId", args.teamId))
      .order("desc")
      .take(MAX_INBOX_THREADS);

    const threads = [...asA, ...asB]
      .filter((t) => t.leagueId === args.leagueId)
      .filter((t) => (args.threadId ? t._id === args.threadId : true))
      .sort(byRecency);
    if (threads.length === 0) return [];

    const teams = await loadTeams(ctx, args.leagueId);
    // `limit` is messages per thread (the Postgres default was 50; we only read
    // the newest 20, so that is the cap here).
    const limit = Math.min(Math.max(args.limit ?? MAX_INBOX_MESSAGES, 1), MAX_INBOX_MESSAGES);

    const out: InboxThread[] = [];
    for (const thread of threads) {
      const otherTeamId =
        thread.teamAId === args.teamId ? thread.teamBId : thread.teamAId;

      // Newest `MAX_INBOX_MESSAGES` first, then flipped back to chronological.
      const recent = await ctx.db
        .query("messages")
        .withIndex("by_threadId_createdAt", (q) => q.eq("threadId", thread._id))
        .order("desc")
        .take(MAX_INBOX_MESSAGES);
      const all = recent.slice().reverse();

      const unread = all.filter(
        (m) => m.senderTeamId !== args.teamId && (!watermark || m.createdAt > watermark),
      );
      const visible = (args.unreadOnly ? unread : all).slice(-limit);

      const openTradeIds = (await tradeDocsForThread(ctx, thread._id))
        .filter((t) => isOpenTradeStatus(t.status))
        .map((t) => t._id as string);

      out.push({
        threadId: thread._id as string,
        otherTeamId: otherTeamId as string,
        otherTeamName: teams.get(otherTeamId as string)?.name ?? "Unknown",
        lastMessageAt: thread.lastMessageAt ?? null,
        unreadCount: unread.length,
        messages: visible.map((m) => ({
          id: m._id as string,
          threadId: m.threadId as string,
          fromTeamId: m.senderTeamId as string,
          fromTeamName:
            m.senderTeamId === args.teamId
              ? "You"
              : (teams.get(m.senderTeamId as string)?.name ?? "Unknown"),
          body: m.body,
          createdAt: m.createdAt,
          flags: toAgentFlags(m.flags),
        })),
        openTradeIds,
      });
    }
    return out;
  },
});

/**
 * The team's read watermark: the explicit `since`, else the finish time of its
 * most recent finished run. Index `runs.by_teamId` desc `take(20)` — a run that
 * finished more than 20 runs ago is not a useful watermark.
 */
async function readWatermark(
  ctx: QueryCtx,
  teamId: Id<"teams">,
  since: number | undefined,
): Promise<number | null> {
  if (since !== undefined && Number.isFinite(since)) return since;
  const recent = await ctx.db
    .query("runs")
    .withIndex("by_teamId", (q) => q.eq("teamId", teamId))
    .order("desc")
    .take(20);
  let latest: number | null = null;
  for (const run of recent) {
    if (run.finishedAt !== undefined && (latest === null || run.finishedAt > latest)) {
      latest = run.finishedAt;
    }
  }
  return latest;
}
