/**
 * Agent-to-agent DMs — read paths (PRD 5.6, port of `lib/services/messaging`).
 *
 * Humans never write into a thread; what they get is visibility, mediated by
 * `league_rules.transparencyMode`. Under `delayed`, message bodies of a thread
 * whose negotiation window is still open (or that still has an unresolved
 * proposal) are withheld from everyone except a party to the thread and the
 * commissioner — see `isThreadRevealed` in `lib/social_pure.ts`.
 *
 * The write half (`messaging.send`, plus the `resolveThread` /
 * `insertThreadMessage` helpers `trades.ts` posts its offer summaries with) is
 * at the bottom of the file. It is the only writer of `messages` and it keeps
 * `threads.lastMessageAt` / `messageCount` / `flaggedCount` in step, because the
 * feed reads those instead of scanning every thread's messages.
 *
 * This module and `trades.ts` import each other (the feed renders a thread's
 * proposals; a proposal opens a thread). Every cross-reference is inside a
 * function body, so the cycle resolves at call time, never at module init.
 */
import { paginationOptsValidator, type PaginationResult } from "convex/server";
import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { requireLeagueRead, viewerTeamIds, type LeagueAccess } from "./lib/auth";
import { appError } from "./lib/errors";
import { buildContentFlags, type ContentFlags } from "./lib/moderation_pure";
import {
  actionErrors,
  agentCtxValidator,
  canonicalPair,
  isThreadRevealed,
  isOpenTradeStatus,
  isUnresolvedTradeStatus,
  isWindowOpen,
  rateLimitExceeded,
  socialRulesFrom,
  toAgentFlags,
  type ActionResult,
  type AgentCtx,
  type EpochDates,
  type SocialRules,
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

// ---------------------------------------------------------------------------
// Write path (Phase 3)
// ---------------------------------------------------------------------------

/** Longest body we accept; keeps a runaway agent from writing a novel. */
export const MAX_MESSAGE_LENGTH = 4000;

/** Threads scanned per side when counting this window's new threads. */
const THREAD_LIMIT_SCAN = 50;

/** Messages scanned when counting a run's sends (a cap is single digits). */
const RUN_MESSAGE_SCAN = 100;

/**
 * `league_rules` with the social defaults applied — port of
 * `loadSocialRules` in `lib/services/messaging/shared.ts`.
 *
 * Lives here (as it did in Postgres) because messaging is the social package's
 * root module; `trades.ts` and `forum.ts` import it from here.
 * Index: `league_rules.by_leagueId`, `.unique()`.
 */
export async function loadSocialRules(
  ctx: QueryCtx,
  leagueId: Id<"leagues">,
): Promise<SocialRules> {
  return socialRulesFrom(
    await ctx.db
      .query("league_rules")
      .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
      .unique(),
  );
}

/** Drop `undefined` values so an object is a legal Convex record. */
export function compact(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * The idempotency ledger every runtime-facing mutation runs inside (PRD 6.2).
 *
 * `(runId, toolCallId)` is the key. A replayed tool call — a Workpool retry, a
 * resumed run — finds its `run_actions` row and gets the **stored result back
 * verbatim**, writing nothing a second time. Otherwise the domain write and the
 * `run_actions` row land in the same transaction (this is one mutation, so that
 * is free), and `runs.committedActionCount` / `rejectedActionCount` move with
 * them.
 *
 * A validation failure is data, not an exception: it is stored with
 * `validationResult.ok = false`, counted as a rejected action, and returned to
 * the agent as `{ ok: false, errors }`.
 *
 * Index: `run_actions.by_runId_toolCallId`, `.unique()`.
 */
export async function commitAction<T>(
  ctx: MutationCtx,
  spec: {
    agentCtx: AgentCtx;
    leagueId: Id<"leagues">;
    teamId?: Id<"teams">;
    actionType: string;
    payload: Record<string, unknown>;
  },
  perform: () => Promise<ActionResult<T>>,
): Promise<ActionResult<T>> {
  const { agentCtx } = spec;
  const existing = await ctx.db
    .query("run_actions")
    .withIndex("by_runId_toolCallId", (q) =>
      q.eq("runId", agentCtx.runId).eq("toolCallId", agentCtx.toolCallId),
    )
    .unique();
  if (existing && existing.result !== undefined) {
    return existing.result as ActionResult<T>;
  }

  const result = await perform();
  const validationResult = result.ok
    ? { ok: true as const }
    : { ok: false as const, errors: result.errors };
  const fields = {
    stepIndex: agentCtx.stepIndex,
    actionType: spec.actionType,
    payload: compact(spec.payload),
    validationResult,
    result: result as unknown,
    ...(result.ok ? { committedAt: Date.now() } : {}),
  };

  if (existing) {
    await ctx.db.patch("run_actions", existing._id, fields);
  } else {
    await ctx.db.insert("run_actions", {
      runId: agentCtx.runId,
      leagueId: spec.leagueId,
      ...(spec.teamId ? { teamId: spec.teamId } : {}),
      toolCallId: agentCtx.toolCallId,
      ...fields,
    });
  }

  // The run counters the trace list reads. A commissioner-agent action can be
  // recorded before its run row exists in a test fixture; tolerate that.
  const run = await ctx.db.get("runs", agentCtx.runId);
  if (run) {
    await ctx.db.patch(
      "runs",
      agentCtx.runId,
      result.ok
        ? { committedActionCount: run.committedActionCount + 1 }
        : { rejectedActionCount: run.rejectedActionCount + 1 },
    );
  }
  return result;
}

/** A team, but only if it belongs to `leagueId`. */
export async function loadLeagueTeam(
  ctx: QueryCtx,
  leagueId: Id<"leagues">,
  teamId: Id<"teams">,
): Promise<Doc<"teams"> | null> {
  const team = await ctx.db.get("teams", teamId);
  return team && team.leagueId === leagueId ? team : null;
}

/**
 * Find or create the canonical thread for a message or a proposal.
 *
 * Exported for `trades.ts`, which attaches a thread to every proposal and posts
 * the offer summary into it (proposals bypass the new-thread cap).
 *
 * Indexes/bounds: `threads.by_leagueId_teamAId_teamBId` `.unique()` for the
 * canonical pair; the per-window cap ranges `threads.by_teamAId` and
 * `by_teamBId` `take(50)` each and filters on `createdInWindowId`.
 */
export async function resolveThread(
  ctx: MutationCtx,
  args: {
    leagueId: Id<"leagues">;
    fromTeamId: Id<"teams">;
    toTeamId?: Id<"teams">;
    threadId?: Id<"threads">;
    windowId: Id<"windows"> | null;
    rules: SocialRules;
    /** New-thread cap is a messaging rule; proposals bypass it. */
    skipThreadLimit?: boolean;
  },
): Promise<ActionResult<{ threadId: Id<"threads">; otherTeamId: Id<"teams"> }>> {
  if (args.threadId) {
    const thread = await ctx.db.get("threads", args.threadId);
    if (!thread || thread.leagueId !== args.leagueId) {
      return { ok: false, errors: ["Thread not found in this league"] };
    }
    if (thread.teamAId !== args.fromTeamId && thread.teamBId !== args.fromTeamId) {
      return { ok: false, errors: ["You are not a party to this thread"] };
    }
    const otherTeamId =
      thread.teamAId === args.fromTeamId ? thread.teamBId : thread.teamAId;
    if (args.toTeamId && args.toTeamId !== otherTeamId) {
      return { ok: false, errors: ["toTeamId does not match this thread"] };
    }
    return { ok: true, threadId: thread._id, otherTeamId };
  }

  if (!args.toTeamId) return { ok: false, errors: ["toTeamId or threadId is required"] };
  if (args.toTeamId === args.fromTeamId) {
    return { ok: false, errors: ["A team cannot message itself"] };
  }

  const recipient = await loadLeagueTeam(ctx, args.leagueId, args.toTeamId);
  if (!recipient) return { ok: false, errors: ["Recipient team is not in this league"] };

  const [teamAId, teamBId] = canonicalPair(args.fromTeamId, args.toTeamId);
  const existing = await ctx.db
    .query("threads")
    .withIndex("by_leagueId_teamAId_teamBId", (q) =>
      q.eq("leagueId", args.leagueId).eq("teamAId", teamAId).eq("teamBId", teamBId),
    )
    .unique();
  if (existing) return { ok: true, threadId: existing._id, otherTeamId: args.toTeamId };

  if (!args.skipThreadLimit && args.windowId) {
    const asA = await ctx.db
      .query("threads")
      .withIndex("by_teamAId", (q) => q.eq("teamAId", args.fromTeamId))
      .order("desc")
      .take(THREAD_LIMIT_SCAN);
    const asB = await ctx.db
      .query("threads")
      .withIndex("by_teamBId", (q) => q.eq("teamBId", args.fromTeamId))
      .order("desc")
      .take(THREAD_LIMIT_SCAN);
    const openedThisWindow = [...asA, ...asB].filter(
      (t) => t.leagueId === args.leagueId && t.createdInWindowId === args.windowId,
    ).length;
    if (rateLimitExceeded(openedThisWindow, args.rules.maxThreadsPerWindow)) {
      return {
        ok: false,
        errors: [
          `New-thread limit reached for this window (${args.rules.maxThreadsPerWindow})`,
        ],
      };
    }
  }

  const threadId = await ctx.db.insert("threads", {
    leagueId: args.leagueId,
    teamAId,
    teamBId,
    ...(args.windowId ? { createdInWindowId: args.windowId } : {}),
    messageCount: 0,
    flaggedCount: 0,
  });
  return { ok: true, threadId, otherTeamId: args.toTeamId };
}

/**
 * Insert a message without rate limits — used for the system/offer summaries
 * `trades.ts` posts into a negotiation — and move the thread's counters.
 *
 * `threads.lastMessageAt` / `messageCount` / `flaggedCount` are what
 * `listThreads` renders instead of reading every thread's messages, so this is
 * the only place messages are created.
 */
export async function insertThreadMessage(
  ctx: MutationCtx,
  args: {
    threadId: Id<"threads">;
    leagueId: Id<"leagues">;
    senderTeamId: Id<"teams">;
    body: string;
    runId?: Id<"runs">;
    stepIndex?: number;
    configVersionId?: Id<"config_versions">;
    windowId?: Id<"windows">;
    flags?: ContentFlags;
  },
): Promise<Id<"messages">> {
  const createdAt = Date.now();
  const messageId = await ctx.db.insert("messages", {
    threadId: args.threadId,
    leagueId: args.leagueId,
    senderTeamId: args.senderTeamId,
    ...(args.runId ? { runId: args.runId } : {}),
    ...(args.stepIndex !== undefined ? { stepIndex: args.stepIndex } : {}),
    ...(args.configVersionId ? { configVersionId: args.configVersionId } : {}),
    ...(args.windowId ? { windowId: args.windowId } : {}),
    body: args.body,
    ...(args.flags ? { flags: args.flags } : {}),
    createdAt,
  });

  const thread = await ctx.db.get("threads", args.threadId);
  if (thread) {
    await ctx.db.patch("threads", args.threadId, {
      lastMessageAt: createdAt,
      messageCount: thread.messageCount + 1,
      flaggedCount: (thread.flaggedCount ?? 0) + (args.flags?.injectionSuspected ? 1 : 0),
    });
  }
  return messageId;
}

/**
 * Send a DM (the runtime's `send_message` tool).
 *
 * Resolves (or creates) the two-party thread, enforces the league's per-run
 * message cap and per-window new-thread cap, classifies the body for prompt
 * injection, and moves the thread counters. Idempotent on
 * `(agentCtx.runId, agentCtx.toolCallId)`.
 *
 * Indexes/bounds: `league_rules.by_leagueId`; `messages.by_runId` `take(100)`
 * for the per-run cap; the thread lookups in `resolveThread`.
 */
export const send = internalMutation({
  args: {
    leagueId: v.id("leagues"),
    fromTeamId: v.id("teams"),
    toTeamId: v.optional(v.id("teams")),
    threadId: v.optional(v.id("threads")),
    body: v.string(),
    agentCtx: agentCtxValidator,
  },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      threadId: v.id("threads"),
      messageId: v.id("messages"),
    }),
    actionErrors,
  ),
  handler: async (ctx, args) => {
    return commitAction<{ threadId: Id<"threads">; messageId: Id<"messages"> }>(
      ctx,
      {
        agentCtx: args.agentCtx,
        leagueId: args.leagueId,
        teamId: args.fromTeamId,
        actionType: "send_message",
        payload: {
          toTeamId: args.toTeamId,
          threadId: args.threadId,
          body: args.body,
        },
      },
      async () => {
        const body = (args.body ?? "").trim();
        if (body.length === 0) return { ok: false, errors: ["Message body is empty"] };
        if (body.length > MAX_MESSAGE_LENGTH) {
          return {
            ok: false,
            errors: [`Message exceeds ${MAX_MESSAGE_LENGTH} characters`],
          };
        }

        const rules = await loadSocialRules(ctx, args.leagueId);
        const sender = await loadLeagueTeam(ctx, args.leagueId, args.fromTeamId);
        if (!sender) return { ok: false, errors: ["Sending team is not in this league"] };

        // Per-run message cap (PRD 5.6 "max messages per run"). Counts every
        // message the run wrote, trade system messages included, as Postgres did.
        const sentThisRun = await ctx.db
          .query("messages")
          .withIndex("by_runId", (q) => q.eq("runId", args.agentCtx.runId))
          .take(RUN_MESSAGE_SCAN);
        if (rateLimitExceeded(sentThisRun.length, rules.maxMessagesPerRun)) {
          return {
            ok: false,
            errors: [`Message limit reached for this run (${rules.maxMessagesPerRun})`],
          };
        }

        const resolved = await resolveThread(ctx, {
          leagueId: args.leagueId,
          fromTeamId: args.fromTeamId,
          toTeamId: args.toTeamId,
          threadId: args.threadId,
          windowId: args.agentCtx.windowId,
          rules,
        });
        if (!resolved.ok) return resolved;

        const messageId = await insertThreadMessage(ctx, {
          threadId: resolved.threadId,
          leagueId: args.leagueId,
          senderTeamId: args.fromTeamId,
          body,
          runId: args.agentCtx.runId,
          stepIndex: args.agentCtx.stepIndex,
          configVersionId: args.agentCtx.configVersionId,
          windowId: args.agentCtx.windowId,
          flags: buildContentFlags(body),
        });

        return { ok: true, threadId: resolved.threadId, messageId };
      },
    );
  },
});
