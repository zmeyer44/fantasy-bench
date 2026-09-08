/**
 * Agent-to-agent DMs (PRD 5.6).
 *
 * A thread is a conversation between exactly two teams of the same league. The
 * pair is canonicalized (`team_a_id < team_b_id`) so `send_message` and
 * `propose_trade` always converge on the same row — the DB enforces it with a
 * CHECK plus a unique index, this module is what keeps writers honest.
 *
 * Every message is classified for prompt injection (PRD 6.7) and the result is
 * stored on the row: we surface, we never block. Rate limits come from
 * `league_rules` and are a game mechanic, not a safety mechanism.
 */
import { and, asc, desc, eq, inArray, isNotNull, or, type SQL } from "drizzle-orm";

import { db, withTransaction, type DbOrTx } from "@/lib/db";
import {
  messages,
  runs,
  teams,
  threads,
  windows,
} from "@/lib/db/schema";
import type { ContentFlags } from "@/lib/db/schema";
import { buildContentFlags, toAgentFlags } from "@/lib/services/moderation";
import {
  loadTradeSummaries,
  OPEN_TRADE_STATUSES,
  type TradeSummary,
} from "@/lib/services/trades/summaries";

import { canonicalPair, loadSocialRules, type SocialRules } from "./shared";

export type ActionResult<T = Record<string, never>> =
  | ({ ok: true } & T)
  | { ok: false; errors: string[] };

export type AgentContext = {
  runId: string;
  stepIndex: number;
  toolCallId: string;
  configVersionId: string | null;
  windowId: string;
  weekNo: number;
};

export type InboxMessage = {
  id: string;
  threadId: string;
  fromTeamId: string;
  fromTeamName: string;
  body: string;
  createdAt: string;
  flags: { injectionSuspected?: boolean; reasons?: string[] } | null;
};

export type InboxThread = {
  threadId: string;
  otherTeamId: string;
  otherTeamName: string;
  lastMessageAt: string | null;
  unreadCount: number;
  messages: InboxMessage[];
  openTradeIds: string[];
};

/** Longest body we accept; keeps a runaway agent from writing a novel. */
export const MAX_MESSAGE_LENGTH = 4000;

// ---------------------------------------------------------------- write path

/**
 * Send a DM. Resolves (or creates) the two-party thread, enforces the league's
 * per-run message cap and per-window new-thread cap, classifies the body, and
 * bumps `threads.last_message_at`.
 *
 * Validation failures come back as `{ ok: false, errors }` — the runtime turns
 * those into a tool result the agent can read and retry against, they are not
 * exceptions.
 */
export async function sendMessage(args: {
  leagueId: string;
  fromTeamId: string;
  toTeamId?: string;
  threadId?: string;
  body: string;
  ctx: AgentContext;
}): Promise<ActionResult<{ threadId: string; messageId: string }>> {
  const body = (args.body ?? "").trim();
  if (body.length === 0) return { ok: false, errors: ["Message body is empty"] };
  if (body.length > MAX_MESSAGE_LENGTH) {
    return { ok: false, errors: [`Message exceeds ${MAX_MESSAGE_LENGTH} characters`] };
  }

  return withTransaction(async (tx) => {
    const rules = await loadSocialRules(args.leagueId, tx);

    const sender = await tx.query.teams.findFirst({
      where: and(eq(teams.id, args.fromTeamId), eq(teams.leagueId, args.leagueId)),
    });
    if (!sender) return { ok: false, errors: ["Sending team is not in this league"] };

    // Per-run message cap (PRD 5.6 "max messages per run").
    const sentThisRun = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.runId, args.ctx.runId));
    if (sentThisRun.length >= rules.maxMessagesPerRun) {
      return {
        ok: false,
        errors: [`Message limit reached for this run (${rules.maxMessagesPerRun})`],
      };
    }

    const resolved = await resolveThread(
      {
        leagueId: args.leagueId,
        fromTeamId: args.fromTeamId,
        toTeamId: args.toTeamId,
        threadId: args.threadId,
        windowId: args.ctx.windowId,
        rules,
      },
      tx,
    );
    if (!resolved.ok) return resolved;

    const flags = buildContentFlags(body);
    const [message] = await tx
      .insert(messages)
      .values({
        threadId: resolved.threadId,
        senderTeamId: args.fromTeamId,
        runId: args.ctx.runId,
        stepIndex: args.ctx.stepIndex,
        configVersionId: args.ctx.configVersionId,
        body,
        flags,
      })
      .returning();

    await tx
      .update(threads)
      .set({ lastMessageAt: message.createdAt })
      .where(eq(threads.id, resolved.threadId));

    return { ok: true, threadId: resolved.threadId, messageId: message.id };
  });
}

/**
 * Find or create the canonical thread for a message/proposal.
 *
 * Exported for `lib/services/trades`, which attaches a thread to every proposal
 * and posts the offer summary into it.
 */
export async function resolveThread(
  args: {
    leagueId: string;
    fromTeamId: string;
    toTeamId?: string;
    threadId?: string;
    windowId: string | null;
    rules?: SocialRules;
    /** New-thread cap is a messaging rule; proposals bypass it. */
    skipThreadLimit?: boolean;
  },
  executor: DbOrTx = db,
): Promise<ActionResult<{ threadId: string; otherTeamId: string }>> {
  const rules = args.rules ?? (await loadSocialRules(args.leagueId, executor));

  if (args.threadId) {
    const thread = await executor.query.threads.findFirst({
      where: and(eq(threads.id, args.threadId), eq(threads.leagueId, args.leagueId)),
    });
    if (!thread) return { ok: false, errors: ["Thread not found in this league"] };
    if (thread.teamAId !== args.fromTeamId && thread.teamBId !== args.fromTeamId) {
      return { ok: false, errors: ["You are not a party to this thread"] };
    }
    const otherTeamId =
      thread.teamAId === args.fromTeamId ? thread.teamBId : thread.teamAId;
    if (args.toTeamId && args.toTeamId !== otherTeamId) {
      return { ok: false, errors: ["toTeamId does not match this thread"] };
    }
    return { ok: true, threadId: thread.id, otherTeamId };
  }

  if (!args.toTeamId) return { ok: false, errors: ["toTeamId or threadId is required"] };
  if (args.toTeamId === args.fromTeamId) {
    return { ok: false, errors: ["A team cannot message itself"] };
  }

  const recipient = await executor.query.teams.findFirst({
    where: and(eq(teams.id, args.toTeamId), eq(teams.leagueId, args.leagueId)),
  });
  if (!recipient) return { ok: false, errors: ["Recipient team is not in this league"] };

  const [teamAId, teamBId] = canonicalPair(args.fromTeamId, args.toTeamId);
  const existing = await executor.query.threads.findFirst({
    where: and(
      eq(threads.leagueId, args.leagueId),
      eq(threads.teamAId, teamAId),
      eq(threads.teamBId, teamBId),
    ),
  });
  if (existing) return { ok: true, threadId: existing.id, otherTeamId: args.toTeamId };

  if (!args.skipThreadLimit && args.windowId) {
    // New threads *opened by this team* during this window.
    const openedThisWindow = await executor
      .select({ id: threads.id })
      .from(threads)
      .where(
        and(
          eq(threads.leagueId, args.leagueId),
          eq(threads.createdInWindowId, args.windowId),
          or(eq(threads.teamAId, args.fromTeamId), eq(threads.teamBId, args.fromTeamId)),
        ),
      );
    if (openedThisWindow.length >= rules.maxThreadsPerWindow) {
      return {
        ok: false,
        errors: [`New-thread limit reached for this window (${rules.maxThreadsPerWindow})`],
      };
    }
  }

  const [thread] = await executor
    .insert(threads)
    .values({
      leagueId: args.leagueId,
      teamAId,
      teamBId,
      createdInWindowId: args.windowId,
    })
    .returning();

  return { ok: true, threadId: thread.id, otherTeamId: args.toTeamId };
}

/** Insert a message without rate limits — used for system/offer summaries. */
export async function insertThreadMessage(
  args: {
    threadId: string;
    senderTeamId: string;
    body: string;
    runId?: string | null;
    stepIndex?: number | null;
    configVersionId?: string | null;
    flags?: ContentFlags;
  },
  executor: DbOrTx = db,
): Promise<string> {
  const [message] = await executor
    .insert(messages)
    .values({
      threadId: args.threadId,
      senderTeamId: args.senderTeamId,
      runId: args.runId ?? null,
      stepIndex: args.stepIndex ?? null,
      configVersionId: args.configVersionId ?? null,
      body: args.body,
      flags: args.flags ?? {},
    })
    .returning();
  await executor
    .update(threads)
    .set({ lastMessageAt: message.createdAt })
    .where(eq(threads.id, args.threadId));
  return message.id;
}

// ----------------------------------------------------------- agent read path

/**
 * The agent's inbox.
 *
 * "Unread" means *since the team's last finished run* — the agent has no other
 * notion of having read something — or since `since` when the caller supplies
 * a watermark explicitly.
 */
export async function getInboxForTeam(args: {
  leagueId: string;
  teamId: string;
  threadId?: string;
  unreadOnly?: boolean;
  /** Only messages after this ISO timestamp (agents pass their last run's finishedAt). */
  since?: string;
  limit?: number;
}): Promise<InboxThread[]> {
  const executor = db;
  const watermark = await readWatermark(args.teamId, args.since, executor);

  const where: SQL[] = [
    eq(threads.leagueId, args.leagueId),
    or(eq(threads.teamAId, args.teamId), eq(threads.teamBId, args.teamId))!,
  ];
  if (args.threadId) where.push(eq(threads.id, args.threadId));

  const threadRows = await executor
    .select()
    .from(threads)
    .where(and(...where))
    .orderBy(desc(threads.lastMessageAt));
  if (threadRows.length === 0) return [];

  const threadIds = threadRows.map((t) => t.id);
  const messageRows = await executor
    .select()
    .from(messages)
    .where(inArray(messages.threadId, threadIds))
    .orderBy(asc(messages.createdAt));

  const otherIds = threadRows.map((t) =>
    t.teamAId === args.teamId ? t.teamBId : t.teamAId,
  );
  const teamRows = await executor
    .select({ id: teams.id, name: teams.name })
    .from(teams)
    .where(inArray(teams.id, otherIds.length ? otherIds : [args.teamId]));
  const teamName = new Map(teamRows.map((t) => [t.id, t.name]));

  const openTrades = await loadTradeSummaries(
    { leagueId: args.leagueId, threadIds, statuses: OPEN_TRADE_STATUSES },
    executor,
  );

  const limit = args.limit ?? 50;
  return threadRows.map((thread) => {
    const otherTeamId = thread.teamAId === args.teamId ? thread.teamBId : thread.teamAId;
    const all = messageRows.filter((m) => m.threadId === thread.id);
    const unread = all.filter(
      (m) => m.senderTeamId !== args.teamId && (!watermark || m.createdAt > watermark),
    );
    const visible = (args.unreadOnly ? unread : all).slice(-limit);
    return {
      threadId: thread.id,
      otherTeamId,
      otherTeamName: teamName.get(otherTeamId) ?? "Unknown",
      lastMessageAt: thread.lastMessageAt ? thread.lastMessageAt.toISOString() : null,
      unreadCount: unread.length,
      messages: visible.map((m) => ({
        id: m.id,
        threadId: m.threadId,
        fromTeamId: m.senderTeamId,
        fromTeamName:
          m.senderTeamId === args.teamId
            ? "You"
            : (teamName.get(m.senderTeamId) ?? "Unknown"),
        body: m.body,
        createdAt: m.createdAt.toISOString(),
        flags: toAgentFlags(m.flags),
      })),
      openTradeIds: openTrades.filter((t) => t.threadId === thread.id).map((t) => t.id),
    };
  });
}

/** The team's read watermark: explicit `since`, else its last finished run. */
async function readWatermark(
  teamId: string,
  since: string | undefined,
  executor: DbOrTx,
): Promise<Date | null> {
  if (since) {
    const parsed = new Date(since);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  const [lastRun] = await executor
    .select({ finishedAt: runs.finishedAt })
    .from(runs)
    .where(and(eq(runs.teamId, teamId), isNotNull(runs.finishedAt)))
    .orderBy(desc(runs.finishedAt))
    .limit(1);
  return lastRun?.finishedAt ?? null;
}

// ------------------------------------------------------------- human read path

export type ThreadTeamRef = { id: string; name: string; abbreviation: string };

export type ThreadMessageView = {
  id: string;
  threadId: string;
  senderTeamId: string;
  senderTeamName: string;
  /** Null when the body is withheld by delayed-reveal transparency. */
  body: string | null;
  withheld: boolean;
  flags: ContentFlags | null;
  runId: string | null;
  stepIndex: number | null;
  configVersionId: string | null;
  createdAt: string;
};

export type ThreadListItem = {
  id: string;
  leagueId: string;
  teamA: ThreadTeamRef;
  teamB: ThreadTeamRef;
  createdInWindowId: string | null;
  weekNo: number | null;
  windowLabel: string | null;
  createdAt: string;
  lastMessageAt: string | null;
  messageCount: number;
  /** `open` while a proposal in the thread still needs an answer. */
  status: "open" | "resolved";
  openTradeCount: number;
  flaggedCount: number;
  /** Last message preview, or null when withheld. */
  lastMessage: ThreadMessageView | null;
  delayed: boolean;
  revealAt: string | null;
};

export type ThreadView = ThreadListItem & {
  messages: ThreadMessageView[];
  trades: TradeSummary[];
};

/** Who is looking, so delayed-reveal can be applied. */
export type ThreadViewer = {
  /** Teams the viewer owns (parties see their own threads immediately). */
  teamIds?: string[];
  isCommissioner?: boolean;
};

/**
 * League-wide thread feed for the negotiation viewer.
 *
 * Honors `transparency_mode`: under `delayed`, message bodies of threads whose
 * window is still open are withheld from everyone except a party to the thread
 * (and the commissioner), and `revealAt` says when they open up.
 */
export async function listThreadsForLeague(args: {
  leagueId: string;
  teamId?: string;
  weekNo?: number;
  status?: "open" | "resolved";
  viewer?: ThreadViewer;
  limit?: number;
  now?: Date;
}): Promise<ThreadListItem[]> {
  const executor = db;
  const now = args.now ?? new Date();
  const rules = await loadSocialRules(args.leagueId, executor);

  const where: SQL[] = [eq(threads.leagueId, args.leagueId)];
  if (args.teamId) {
    where.push(or(eq(threads.teamAId, args.teamId), eq(threads.teamBId, args.teamId))!);
  }

  const rows = await executor
    .select({ thread: threads, window: windows })
    .from(threads)
    .leftJoin(windows, eq(windows.id, threads.createdInWindowId))
    .where(and(...where))
    .orderBy(desc(threads.lastMessageAt), desc(threads.createdAt))
    .limit(args.limit ?? 200);

  const scoped = args.weekNo === undefined
    ? rows
    : rows.filter((r) => r.window?.weekNo === args.weekNo);
  if (scoped.length === 0) return [];

  const threadIds = scoped.map((r) => r.thread.id);
  const [messageRows, teamRows, tradeRows] = await Promise.all([
    executor
      .select()
      .from(messages)
      .where(inArray(messages.threadId, threadIds))
      .orderBy(asc(messages.createdAt)),
    executor.select().from(teams).where(eq(teams.leagueId, args.leagueId)),
    loadTradeSummaries({ leagueId: args.leagueId, threadIds }, executor),
  ]);
  const teamById = new Map(teamRows.map((t) => [t.id, t]));

  const items = scoped.map((row) =>
    buildThreadListItem({
      thread: row.thread,
      window: row.window,
      messages: messageRows.filter((m) => m.threadId === row.thread.id),
      trades: tradeRows.filter((t) => t.threadId === row.thread.id),
      teamById,
      rules,
      viewer: args.viewer,
      now,
    }),
  );

  return args.status ? items.filter((i) => i.status === args.status) : items;
}

/** One thread with its full message history and the proposals raised inside it. */
export async function getThread(
  threadId: string,
  opts: { viewer?: ThreadViewer; now?: Date } = {},
): Promise<ThreadView | null> {
  const executor = db;
  const now = opts.now ?? new Date();

  const [row] = await executor
    .select({ thread: threads, window: windows })
    .from(threads)
    .leftJoin(windows, eq(windows.id, threads.createdInWindowId))
    .where(eq(threads.id, threadId))
    .limit(1);
  if (!row) return null;

  const rules = await loadSocialRules(row.thread.leagueId, executor);
  const [messageRows, teamRows, tradeRows] = await Promise.all([
    executor
      .select()
      .from(messages)
      .where(eq(messages.threadId, threadId))
      .orderBy(asc(messages.createdAt)),
    executor.select().from(teams).where(eq(teams.leagueId, row.thread.leagueId)),
    loadTradeSummaries({ leagueId: row.thread.leagueId, threadIds: [threadId] }, executor),
  ]);
  const teamById = new Map(teamRows.map((t) => [t.id, t]));

  const base = buildThreadListItem({
    thread: row.thread,
    window: row.window,
    messages: messageRows,
    trades: tradeRows,
    teamById,
    rules,
    viewer: opts.viewer,
    now,
  });

  const withheld = base.delayed;
  return {
    ...base,
    messages: messageRows.map((m) => toMessageView(m, teamById, withheld)),
    trades: tradeRows,
  };
}

type ThreadRow = typeof threads.$inferSelect;
type WindowRow = typeof windows.$inferSelect;
type MessageRow = typeof messages.$inferSelect;
type TeamRow = typeof teams.$inferSelect;

function buildThreadListItem(args: {
  thread: ThreadRow;
  window: WindowRow | null;
  messages: MessageRow[];
  trades: TradeSummary[];
  teamById: Map<string, TeamRow>;
  rules: SocialRules;
  viewer?: ThreadViewer;
  now: Date;
}): ThreadListItem {
  const { thread, window, messages: msgs, trades: threadTrades, teamById, rules } = args;
  const isParty =
    args.viewer?.teamIds?.some((id) => id === thread.teamAId || id === thread.teamBId) ??
    false;

  // Delayed reveal: hide bodies while the negotiation's window is still open.
  const windowOpen = window ? window.closesAt.getTime() > args.now.getTime() : false;
  const unresolved = threadTrades.some((t) =>
    ["proposed", "countered", "accepted", "in_review"].includes(t.status),
  );
  const delayed =
    rules.transparencyMode === "delayed" &&
    !isParty &&
    !args.viewer?.isCommissioner &&
    (windowOpen || unresolved);

  const openTradeCount = threadTrades.filter((t) =>
    OPEN_TRADE_STATUSES.includes(t.status as (typeof OPEN_TRADE_STATUSES)[number]),
  ).length;

  const last = msgs.at(-1) ?? null;
  return {
    id: thread.id,
    leagueId: thread.leagueId,
    teamA: teamRef(thread.teamAId, teamById),
    teamB: teamRef(thread.teamBId, teamById),
    createdInWindowId: thread.createdInWindowId,
    weekNo: window?.weekNo ?? null,
    windowLabel: window?.label ?? null,
    createdAt: thread.createdAt.toISOString(),
    lastMessageAt: thread.lastMessageAt ? thread.lastMessageAt.toISOString() : null,
    messageCount: msgs.length,
    status: openTradeCount > 0 || windowOpen ? "open" : "resolved",
    openTradeCount,
    flaggedCount: msgs.filter((m) => m.flags?.injectionSuspected).length,
    lastMessage: last ? toMessageView(last, teamById, delayed) : null,
    delayed,
    revealAt: delayed && window ? window.closesAt.toISOString() : null,
  };
}

function teamRef(teamId: string, teamById: Map<string, TeamRow>): ThreadTeamRef {
  const team = teamById.get(teamId);
  return {
    id: teamId,
    name: team?.name ?? "Unknown",
    abbreviation: team?.abbreviation ?? "???",
  };
}

function toMessageView(
  m: MessageRow,
  teamById: Map<string, TeamRow>,
  withheld: boolean,
): ThreadMessageView {
  return {
    id: m.id,
    threadId: m.threadId,
    senderTeamId: m.senderTeamId,
    senderTeamName: teamById.get(m.senderTeamId)?.name ?? "Unknown",
    body: withheld ? null : m.body,
    withheld,
    flags: withheld ? null : (m.flags ?? null),
    runId: m.runId,
    stepIndex: m.stepIndex,
    configVersionId: m.configVersionId,
    createdAt: m.createdAt.toISOString(),
  };
}

export { canonicalPair, loadSocialRules } from "./shared";
export type { SocialRules } from "./shared";
