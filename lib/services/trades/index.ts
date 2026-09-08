/**
 * Trades: the proposal state machine, review, veto and completion (PRD 5.6).
 *
 *   proposed ─┬─▶ countered ─▶ (child proposal)
 *             ├─▶ rejected
 *             ├─▶ expired          (window closed with the offer outstanding)
 *             └─▶ accepted ─▶ in_review ─┬─▶ completed
 *                                        └─▶ vetoed   (flagged + majority veto)
 *
 * Every transition appends a `trade_events` row carrying the run and step that
 * caused it — that is what the negotiation viewer links into the trace with.
 * Rosters are only touched at `completed`.
 */
import { and, eq, gt, inArray, lte, ne, or, sql } from "drizzle-orm";

import { db, withTransaction, type DbOrTx, type Tx } from "@/lib/db";
import {
  leagueMembers,
  leagues,
  nflGames,
  players,
  rosterSlots,
  teams,
  tradeEvents,
  tradeItems,
  tradeVotes,
  trades,
  transactions,
} from "@/lib/db/schema";
import type { Trade, TradeStatus } from "@/lib/db/types";
import {
  insertThreadMessage,
  resolveThread,
  type ActionResult,
  type AgentContext,
} from "@/lib/services/messaging";
import { loadSocialRules, totalRosterCapacity, type SocialRules } from "@/lib/services/messaging/shared";

import { scoreTrade, type FairnessDetailV1 } from "./fairness";
import {
  loadTradeSummaries,
  OPEN_TRADE_STATUSES,
  type TradeSummary,
} from "./summaries";

export type { TradePlayerRef, TradeSummary } from "./summaries";
export { OPEN_TRADE_STATUSES, LIVE_TRADE_STATUSES } from "./summaries";

// ------------------------------------------------------------------- propose

/**
 * Create a proposal. Validates rosters, FAAB, roster size, the open-proposal
 * cap and anti-churn; opens (or reuses) the DM thread between the two teams and
 * posts a system message summarizing the offer so the negotiation reads as one
 * conversation.
 */
export async function proposeTrade(args: {
  leagueId: string;
  proposerTeamId: string;
  toTeamId: string;
  give: string[];
  receive: string[];
  faab?: number;
  message?: string;
  ctx: AgentContext;
}): Promise<ActionResult<{ tradeId: string; threadId: string }>> {
  return withTransaction(async (tx) => {
    const rules = await loadSocialRules(args.leagueId, tx);
    const created = await createProposal(
      {
        leagueId: args.leagueId,
        proposerTeamId: args.proposerTeamId,
        recipientTeamId: args.toTeamId,
        give: args.give,
        receive: args.receive,
        faab: args.faab,
        message: args.message,
        ctx: args.ctx,
        rules,
        enforceOpenProposalCap: true,
      },
      tx,
    );
    if (!created.ok) return created;
    return { ok: true, tradeId: created.tradeId, threadId: created.threadId };
  });
}

type CreateProposalArgs = {
  leagueId: string;
  proposerTeamId: string;
  recipientTeamId: string;
  give: string[];
  receive: string[];
  faab?: number;
  message?: string;
  ctx: AgentContext;
  rules: SocialRules;
  /** Counters skip the cap: they close the parent as they open. */
  enforceOpenProposalCap: boolean;
  threadId?: string;
  parentTradeId?: string;
};

async function createProposal(
  args: CreateProposalArgs,
  tx: Tx,
): Promise<ActionResult<{ tradeId: string; threadId: string }>> {
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

  const [proposer, recipient] = await Promise.all([
    tx.query.teams.findFirst({
      where: and(eq(teams.id, args.proposerTeamId), eq(teams.leagueId, args.leagueId)),
    }),
    tx.query.teams.findFirst({
      where: and(eq(teams.id, args.recipientTeamId), eq(teams.leagueId, args.leagueId)),
    }),
  ]);
  if (!proposer) errors.push("Proposing team is not in this league");
  if (!recipient) errors.push("Recipient team is not in this league");
  if (!proposer || !recipient) return { ok: false, errors };

  // Rosters are read live (`roster_slots`), not from the snapshot: a proposal
  // that names a player traded away an hour ago must fail.
  const rosterRows = await tx
    .select({ teamId: rosterSlots.teamId, playerId: rosterSlots.playerId })
    .from(rosterSlots)
    .where(inArray(rosterSlots.teamId, [proposer.id, recipient.id]));
  const proposerRoster = new Set(
    rosterRows.filter((r) => r.teamId === proposer.id).map((r) => r.playerId),
  );
  const recipientRoster = new Set(
    rosterRows.filter((r) => r.teamId === recipient.id).map((r) => r.playerId),
  );

  const missingGive = give.filter((p) => !proposerRoster.has(p));
  const missingReceive = receive.filter((p) => !recipientRoster.has(p));
  if (missingGive.length) {
    errors.push(`Not on your roster: ${(await playerNames(missingGive, tx)).join(", ")}`);
  }
  if (missingReceive.length) {
    errors.push(
      `Not on ${recipient.name}'s roster: ${(await playerNames(missingReceive, tx)).join(", ")}`,
    );
  }

  if (faab > proposer.faabRemaining) {
    errors.push(`FAAB offer of $${faab} exceeds your remaining $${proposer.faabRemaining}`);
  }

  // Roster-size sanity: neither side may end up over total capacity. Uneven
  // trades are legal as long as the receiving side has room.
  const capacity = totalRosterCapacity(args.rules.rosterSlots);
  const proposerAfter = proposerRoster.size - give.length + receive.length;
  const recipientAfter = recipientRoster.size - receive.length + give.length;
  if (proposerAfter > capacity) {
    errors.push(`Your roster would hold ${proposerAfter} players (limit ${capacity})`);
  }
  if (recipientAfter > capacity) {
    errors.push(
      `${recipient.name}'s roster would hold ${recipientAfter} players (limit ${capacity})`,
    );
  }

  if (args.enforceOpenProposalCap) {
    const open = await tx
      .select({ id: trades.id })
      .from(trades)
      .where(
        and(
          eq(trades.proposerTeamId, proposer.id),
          eq(trades.status, "proposed"),
        ),
      );
    if (open.length >= args.rules.maxOpenProposals) {
      errors.push(
        `You already have ${open.length} open proposals (limit ${args.rules.maxOpenProposals})`,
      );
    }
  }

  const churn = await antiChurnViolations(
    {
      leagueId: args.leagueId,
      teamAId: proposer.id,
      teamBId: recipient.id,
      moves: [
        ...give.map((playerId) => ({ playerId, fromTeamId: proposer.id, toTeamId: recipient.id })),
        ...receive.map((playerId) => ({
          playerId,
          fromTeamId: recipient.id,
          toTeamId: proposer.id,
        })),
      ],
      weekNo: args.ctx.weekNo,
      antiChurnWeeks: args.rules.antiChurnWeeks,
    },
    tx,
  );
  if (churn.length > 0) {
    const names = await playerNames(churn, tx);
    errors.push(
      `Anti-churn: ${names.join(", ")} cannot be traded back between these teams for ${args.rules.antiChurnWeeks} weeks`,
    );
  }

  if (errors.length > 0) return { ok: false, errors };

  const thread = await resolveThread(
    {
      leagueId: args.leagueId,
      fromTeamId: proposer.id,
      toTeamId: recipient.id,
      threadId: args.threadId,
      windowId: args.ctx.windowId,
      rules: args.rules,
      skipThreadLimit: true,
    },
    tx,
  );
  if (!thread.ok) return thread;

  const [trade] = await tx
    .insert(trades)
    .values({
      leagueId: args.leagueId,
      proposerTeamId: proposer.id,
      recipientTeamId: recipient.id,
      threadId: thread.threadId,
      windowId: args.ctx.windowId,
      weekNo: args.ctx.weekNo,
      status: "proposed",
      message: args.message ?? null,
      parentTradeId: args.parentTradeId ?? null,
      createdByRunId: args.ctx.runId,
    })
    .returning();

  await tx.insert(tradeItems).values([
    ...give.map((playerId) => ({
      tradeId: trade.id,
      fromTeamId: proposer.id,
      toTeamId: recipient.id,
      playerId,
    })),
    ...receive.map((playerId) => ({
      tradeId: trade.id,
      fromTeamId: recipient.id,
      toTeamId: proposer.id,
      playerId,
    })),
    ...(faab > 0
      ? [{ tradeId: trade.id, fromTeamId: proposer.id, toTeamId: recipient.id, faab }]
      : []),
  ]);

  await writeTradeEvent(
    {
      tradeId: trade.id,
      type: args.parentTradeId ? "countered" : "proposed",
      fromStatus: null,
      toStatus: "proposed",
      actorTeamId: proposer.id,
      ctx: args.ctx,
      payload: { give, receive, faab, parentTradeId: args.parentTradeId ?? null },
    },
    tx,
  );

  await insertThreadMessage(
    {
      threadId: thread.threadId,
      senderTeamId: proposer.id,
      body: await offerSummary(
        { proposerName: proposer.name, recipientName: recipient.name, give, receive, faab, note: args.message },
        tx,
      ),
      runId: args.ctx.runId,
      stepIndex: args.ctx.stepIndex,
      configVersionId: args.ctx.configVersionId,
    },
    tx,
  );

  return { ok: true, tradeId: trade.id, threadId: thread.threadId };
}

// -------------------------------------------------------------------- respond

/**
 * The recipient's move: accept, reject or counter.
 *
 * Accepting moves the trade into review and computes the (deterministic)
 * fairness score; a counter creates a child proposal with the roles swapped and
 * marks the parent `countered`.
 */
export async function respondToTrade(args: {
  leagueId: string;
  teamId: string;
  tradeId: string;
  action: "accept" | "reject" | "counter";
  counter?: { give: string[]; receive: string[]; faab?: number };
  message?: string;
  ctx: AgentContext;
}): Promise<ActionResult<{ tradeId: string; status: string; counterTradeId?: string }>> {
  const result = await respondToTradeInner(args);
  // Commissioner Agent narrative for a published fairness score (PRD 5.6). Runs
  // after the transaction and best-effort: the score itself is deterministic
  // and already stored; the paragraph is commentary.
  if (result.ok && args.action === "accept") {
    try {
      const { scoreTradeNarrative } = await import("@/lib/services/commissioner-agent");
      await scoreTradeNarrative(result.tradeId);
    } catch (error) {
      console.error(`[trades] commissioner narrative failed for trade ${result.tradeId}:`, error);
    }
  }
  return result;
}

async function respondToTradeInner(args: {
  leagueId: string;
  teamId: string;
  tradeId: string;
  action: "accept" | "reject" | "counter";
  counter?: { give: string[]; receive: string[]; faab?: number };
  message?: string;
  ctx: AgentContext;
}): Promise<ActionResult<{ tradeId: string; status: string; counterTradeId?: string }>> {
  return withTransaction(async (tx) => {
    const trade = await tx.query.trades.findFirst({
      where: and(eq(trades.id, args.tradeId), eq(trades.leagueId, args.leagueId)),
    });
    if (!trade) return { ok: false, errors: ["Trade not found in this league"] };
    if (trade.recipientTeamId !== args.teamId) {
      return { ok: false, errors: ["Only the recipient can respond to this proposal"] };
    }
    if (trade.status !== "proposed") {
      return { ok: false, errors: [`This proposal is ${trade.status} and cannot be answered`] };
    }

    const rules = await loadSocialRules(args.leagueId, tx);
    const now = new Date();

    if (args.action === "reject") {
      await tx
        .update(trades)
        .set({ status: "rejected", resolvedAt: now })
        .where(eq(trades.id, trade.id));
      await writeTradeEvent(
        {
          tradeId: trade.id,
          type: "rejected",
          fromStatus: "proposed",
          toStatus: "rejected",
          actorTeamId: args.teamId,
          ctx: args.ctx,
          payload: { message: args.message ?? null },
        },
        tx,
      );
      await postThreadUpdate(trade, args.teamId, `Rejected the offer.${suffix(args.message)}`, args.ctx, tx);
      return { ok: true, tradeId: trade.id, status: "rejected" };
    }

    if (args.action === "counter") {
      if (!args.counter) return { ok: false, errors: ["A counter must include give/receive"] };
      const child = await createProposal(
        {
          leagueId: args.leagueId,
          proposerTeamId: args.teamId,
          recipientTeamId: trade.proposerTeamId,
          give: args.counter.give,
          receive: args.counter.receive,
          faab: args.counter.faab,
          message: args.message,
          ctx: args.ctx,
          rules,
          enforceOpenProposalCap: false,
          threadId: trade.threadId ?? undefined,
          parentTradeId: trade.id,
        },
        tx,
      );
      if (!child.ok) return child;

      await tx
        .update(trades)
        .set({ status: "countered", resolvedAt: now })
        .where(eq(trades.id, trade.id));
      await writeTradeEvent(
        {
          tradeId: trade.id,
          type: "countered",
          fromStatus: "proposed",
          toStatus: "countered",
          actorTeamId: args.teamId,
          ctx: args.ctx,
          payload: { counterTradeId: child.tradeId },
        },
        tx,
      );
      return {
        ok: true,
        tradeId: trade.id,
        status: "countered",
        counterTradeId: child.tradeId,
      };
    }

    // ---- accept
    const items = await tx.select().from(tradeItems).where(eq(tradeItems.tradeId, trade.id));
    const give = items
      .filter((i) => i.playerId && i.fromTeamId === trade.proposerTeamId)
      .map((i) => i.playerId!);
    const receive = items
      .filter((i) => i.playerId && i.fromTeamId === trade.recipientTeamId)
      .map((i) => i.playerId!);
    const faab = items.reduce(
      (sum, i) =>
        i.playerId
          ? sum
          : sum + (i.fromTeamId === trade.proposerTeamId ? (i.faab ?? 0) : -(i.faab ?? 0)),
      0,
    );

    const fairness = await scoreTrade(
      {
        leagueId: args.leagueId,
        proposerTeamId: trade.proposerTeamId,
        recipientTeamId: trade.recipientTeamId,
        weekNo: trade.weekNo ?? args.ctx.weekNo,
        give,
        receive,
        faab,
      },
      tx,
    );

    const reviewEndsAt = new Date(now.getTime() + rules.tradeReviewHours * 3_600_000);
    await tx
      .update(trades)
      .set({
        status: "in_review",
        reviewEndsAt,
        fairnessScore: fairness.score,
        fairnessDetail: fairness.detail,
        flagged: fairness.flagged,
      })
      .where(eq(trades.id, trade.id));

    await writeTradeEvent(
      {
        tradeId: trade.id,
        type: "accepted",
        fromStatus: "proposed",
        toStatus: "accepted",
        actorTeamId: args.teamId,
        ctx: args.ctx,
        payload: { message: args.message ?? null },
      },
      tx,
    );
    await writeTradeEvent(
      {
        tradeId: trade.id,
        type: "fairness_scored",
        fromStatus: "accepted",
        toStatus: "in_review",
        actorTeamId: null,
        ctx: args.ctx,
        payload: {
          score: fairness.score,
          flagged: fairness.flagged,
          reviewEndsAt: reviewEndsAt.toISOString(),
        },
      },
      tx,
    );
    await postThreadUpdate(
      trade,
      args.teamId,
      `Accepted the offer. Fairness ${fairness.score.toFixed(2)}${
        fairness.flagged ? " — flagged for owner review" : ""
      }; review ends ${reviewEndsAt.toISOString()}.${suffix(args.message)}`,
      args.ctx,
      tx,
    );

    return { ok: true, tradeId: trade.id, status: "in_review" };
  });
}

// ------------------------------------------------------------- agent read model

/** Open (proposed/countered) trades involving the team, for get_inbox / prompt context. */
export async function listOpenTradesForTeam(args: {
  leagueId: string;
  teamId: string;
}): Promise<TradeSummary[]> {
  return loadTradeSummaries({
    leagueId: args.leagueId,
    teamId: args.teamId,
    statuses: OPEN_TRADE_STATUSES,
  });
}

// --------------------------------------------------------------- tick helpers

/**
 * Close out proposals left hanging when a negotiation window ends.
 * Returns the number of trades expired.
 */
export async function expireOpenProposals(windowId: string): Promise<number> {
  return withTransaction(async (tx) => {
    const open = await tx
      .select()
      .from(trades)
      .where(and(eq(trades.windowId, windowId), inArray(trades.status, OPEN_TRADE_STATUSES)));
    if (open.length === 0) return 0;

    const now = new Date();
    await tx
      .update(trades)
      .set({ status: "expired", resolvedAt: now })
      .where(inArray(trades.id, open.map((t) => t.id)));

    for (const trade of open) {
      await writeTradeEvent(
        {
          tradeId: trade.id,
          type: "expired",
          fromStatus: trade.status,
          toStatus: "expired",
          actorTeamId: null,
          ctx: null,
          payload: { windowId },
        },
        tx,
      );
    }
    return open.length;
  });
}

/**
 * Resolve trades whose review period has elapsed.
 *
 * Unflagged trades complete automatically. Flagged trades need the owners to
 * fail to block them: a strict majority of veto votes kills the trade.
 * Returns the number of trades resolved.
 */
export async function processTradeReviews(leagueId: string, now: Date = new Date()): Promise<number> {
  const due = await db
    .select({ id: trades.id })
    .from(trades)
    .where(
      and(
        eq(trades.leagueId, leagueId),
        eq(trades.status, "in_review"),
        lte(trades.reviewEndsAt, now),
      ),
    );

  let resolved = 0;
  for (const row of due) {
    const outcome = await resolveReviewedTrade(row.id, now);
    if (outcome) resolved += 1;
  }
  return resolved;
}

async function resolveReviewedTrade(tradeId: string, now: Date): Promise<boolean> {
  return withTransaction(async (tx) => {
    const trade = await tx.query.trades.findFirst({ where: eq(trades.id, tradeId) });
    if (!trade || trade.status !== "in_review") return false;

    if (trade.flagged) {
      const tally = await tallyVetoVotes(trade.id, trade.leagueId, tx);
      if (tally.vetoes > tally.ownerCount / 2) {
        await tx
          .update(trades)
          .set({ status: "vetoed", resolvedAt: now })
          .where(eq(trades.id, trade.id));
        await writeTradeEvent(
          {
            tradeId: trade.id,
            type: "vetoed",
            fromStatus: "in_review",
            toStatus: "vetoed",
            actorTeamId: null,
            ctx: null,
            payload: { ...tally },
          },
          tx,
        );
        return true;
      }
    }

    await completeTrade(trade, now, tx);
    return true;
  });
}

/** Move the players, settle FAAB, and write the transaction feed rows. */
async function completeTrade(trade: Trade, now: Date, tx: Tx): Promise<void> {
  const items = await tx.select().from(tradeItems).where(eq(tradeItems.tradeId, trade.id));
  const playerMoves = items.filter((i) => i.playerId);

  // Guard against a roster that moved under us between accept and completion.
  const rosterRows = await tx
    .select({ teamId: rosterSlots.teamId, playerId: rosterSlots.playerId })
    .from(rosterSlots)
    .where(inArray(rosterSlots.teamId, [trade.proposerTeamId, trade.recipientTeamId]));
  const owns = new Set(rosterRows.map((r) => `${r.teamId}:${r.playerId}`));
  const stale = playerMoves.filter((i) => !owns.has(`${i.fromTeamId}:${i.playerId}`));
  if (stale.length > 0) {
    await tx
      .update(trades)
      .set({ status: "cancelled", resolvedAt: now })
      .where(eq(trades.id, trade.id));
    await writeTradeEvent(
      {
        tradeId: trade.id,
        type: "invalidated",
        fromStatus: "in_review",
        toStatus: "cancelled",
        actorTeamId: null,
        ctx: null,
        payload: { reason: "roster changed after acceptance", playerIds: stale.map((s) => s.playerId) },
      },
      tx,
    );
    return;
  }

  const lockedPlayerIds = await lockedPlayers(
    trade,
    playerMoves.map((i) => i.playerId!),
    now,
    tx,
  );

  for (const item of playerMoves) {
    await tx
      .delete(rosterSlots)
      .where(
        and(eq(rosterSlots.teamId, item.fromTeamId), eq(rosterSlots.playerId, item.playerId!)),
      );
    await tx.insert(rosterSlots).values({
      teamId: item.toTeamId,
      playerId: item.playerId!,
      acquiredVia: "trade",
      acquiredAt: now,
    });
    await tx.insert(transactions).values({
      leagueId: trade.leagueId,
      teamId: item.toTeamId,
      type: "trade",
      weekNo: trade.weekNo,
      playerId: item.playerId,
      relatedTeamId: item.fromTeamId,
      tradeId: trade.id,
      details: { direction: "in", locked: lockedPlayerIds.includes(item.playerId!) },
    });
  }

  const faabItems = items.filter((i) => !i.playerId && i.faab);
  for (const item of faabItems) {
    const amount = item.faab ?? 0;
    if (amount <= 0) continue;
    await tx
      .update(teams)
      .set({ faabRemaining: sql`greatest(${teams.faabRemaining} - ${amount}, 0)` })
      .where(eq(teams.id, item.fromTeamId));
    await tx
      .update(teams)
      .set({ faabRemaining: sql`${teams.faabRemaining} + ${amount}` })
      .where(eq(teams.id, item.toTeamId));
  }

  await tx
    .update(trades)
    .set({ status: "completed", resolvedAt: now })
    .where(eq(trades.id, trade.id));

  await writeTradeEvent(
    {
      tradeId: trade.id,
      type: "completed",
      fromStatus: trade.status,
      toStatus: "completed",
      actorTeamId: null,
      ctx: null,
      payload: {
        players: playerMoves.map((i) => i.playerId),
        faab: faabItems.map((i) => i.faab),
        // Locked players have already kicked off this week: the swap happens now
        // but the current week's lineup is deliberately left untouched.
        lockedPlayerIds,
      },
    },
    tx,
  );

  if (trade.threadId) {
    await insertThreadMessage(
      {
        threadId: trade.threadId,
        senderTeamId: trade.proposerTeamId,
        body: "Trade completed — rosters updated.",
      },
      tx,
    );
  }
}

/** Players whose game has already kicked off for the trade's week. */
async function lockedPlayers(
  trade: Trade,
  playerIds: string[],
  now: Date,
  tx: Tx,
): Promise<string[]> {
  if (playerIds.length === 0 || trade.weekNo === null) return [];
  const league = await tx.query.leagues.findFirst({ where: eq(leagues.id, trade.leagueId) });
  if (!league) return [];

  const roster = await tx
    .select({ id: players.id, nflTeam: players.nflTeam })
    .from(players)
    .where(inArray(players.id, playerIds));
  const kickedOff = await tx
    .select({ home: nflGames.homeTeam, away: nflGames.awayTeam })
    .from(nflGames)
    .where(
      and(
        eq(nflGames.season, league.season),
        eq(nflGames.week, trade.weekNo),
        lte(nflGames.kickoffAt, now),
      ),
    );
  const started = new Set(kickedOff.flatMap((g) => [g.home, g.away]));
  return roster.filter((p) => p.nflTeam && started.has(p.nflTeam)).map((p) => p.id);
}

// ------------------------------------------------------------------ veto vote

export type VetoTally = {
  vetoes: number;
  approvals: number;
  ownerCount: number;
  /** Votes needed to block: strictly more than half the owners. */
  threshold: number;
  blocked: boolean;
};

async function tallyVetoVotes(
  tradeId: string,
  leagueId: string,
  executor: DbOrTx,
): Promise<VetoTally> {
  const [votes, owners] = await Promise.all([
    executor.select().from(tradeVotes).where(eq(tradeVotes.tradeId, tradeId)),
    executor
      .select({ userId: leagueMembers.userId })
      .from(leagueMembers)
      .where(
        and(eq(leagueMembers.leagueId, leagueId), ne(leagueMembers.role, "spectator")),
      ),
  ]);
  const vetoes = votes.filter((v) => v.vote === "veto").length;
  const ownerCount = owners.length;
  return {
    vetoes,
    approvals: votes.filter((v) => v.vote === "approve").length,
    ownerCount,
    threshold: Math.floor(ownerCount / 2) + 1,
    blocked: vetoes > ownerCount / 2,
  };
}

/** Cast (or change) a human owner's veto vote on a trade under review. */
export async function castVetoVote(args: {
  tradeId: string;
  userId: string;
  vote: "veto" | "approve";
}): Promise<ActionResult<VetoTally>> {
  return withTransaction(async (tx) => {
    const trade = await tx.query.trades.findFirst({ where: eq(trades.id, args.tradeId) });
    if (!trade) return { ok: false, errors: ["Trade not found"] };
    if (trade.status !== "in_review") {
      return { ok: false, errors: [`This trade is ${trade.status}; voting is closed`] };
    }

    const membership = await tx.query.leagueMembers.findFirst({
      where: and(
        eq(leagueMembers.leagueId, trade.leagueId),
        eq(leagueMembers.userId, args.userId),
      ),
    });
    if (!membership || membership.role === "spectator") {
      return { ok: false, errors: ["Only league owners may vote on a trade"] };
    }

    await tx
      .insert(tradeVotes)
      .values({ tradeId: args.tradeId, userId: args.userId, vote: args.vote })
      .onConflictDoUpdate({
        target: [tradeVotes.tradeId, tradeVotes.userId],
        set: { vote: args.vote, createdAt: new Date() },
      });

    const tally = await tallyVetoVotes(args.tradeId, trade.leagueId, tx);
    await writeTradeEvent(
      {
        tradeId: args.tradeId,
        type: "veto_vote",
        fromStatus: "in_review",
        toStatus: "in_review",
        actorTeamId: null,
        ctx: null,
        payload: { userId: args.userId, vote: args.vote, ...tally },
      },
      tx,
    );
    return { ok: true, ...tally };
  });
}

/** Current veto tally, for the review panel. */
export async function getVetoTally(tradeId: string): Promise<VetoTally | null> {
  const trade = await db.query.trades.findFirst({ where: eq(trades.id, tradeId) });
  if (!trade) return null;
  return tallyVetoVotes(tradeId, trade.leagueId, db);
}

// ------------------------------------------------------------- human read models

export type TradeEventView = {
  id: string;
  type: string;
  fromStatus: string | null;
  toStatus: string | null;
  runId: string | null;
  stepIndex: number | null;
  actorTeamId: string | null;
  actorTeamName: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type TradeVoteView = {
  userId: string;
  vote: "veto" | "approve";
  createdAt: string;
};

export type TradeDetail = TradeSummary & {
  fairnessDetail: FairnessDetailV1 | null;
  events: TradeEventView[];
  votes: TradeVoteView[];
  tally: VetoTally | null;
  counterTradeIds: string[];
};

export async function getTrade(tradeId: string): Promise<TradeDetail | null> {
  const [summary] = await loadTradeSummaries({ tradeIds: [tradeId] });
  if (!summary) return null;

  const [eventRows, voteRows, teamRows, counters] = await Promise.all([
    db
      .select()
      .from(tradeEvents)
      .where(eq(tradeEvents.tradeId, tradeId))
      .orderBy(tradeEvents.createdAt),
    db.select().from(tradeVotes).where(eq(tradeVotes.tradeId, tradeId)),
    db.select({ id: teams.id, name: teams.name }).from(teams).where(eq(teams.leagueId, summary.leagueId)),
    db.select({ id: trades.id }).from(trades).where(eq(trades.parentTradeId, tradeId)),
  ]);
  const teamName = new Map(teamRows.map((t) => [t.id, t.name]));

  return {
    ...summary,
    fairnessDetail: (summary.fairnessDetail as FairnessDetailV1 | null) ?? null,
    events: eventRows.map((e) => ({
      id: e.id,
      type: e.type,
      fromStatus: e.fromStatus,
      toStatus: e.toStatus,
      runId: e.runId,
      stepIndex: e.stepIndex,
      actorTeamId: e.actorTeamId,
      actorTeamName: e.actorTeamId ? (teamName.get(e.actorTeamId) ?? null) : null,
      payload: e.payload,
      createdAt: e.createdAt.toISOString(),
    })),
    votes: voteRows.map((v) => ({
      userId: v.userId,
      vote: v.vote,
      createdAt: v.createdAt.toISOString(),
    })),
    tally: summary.status === "in_review" ? await getVetoTally(tradeId) : null,
    counterTradeIds: counters.map((c) => c.id),
  };
}

export async function listTradesForLeague(args: {
  leagueId: string;
  teamId?: string;
  weekNo?: number;
  status?: TradeStatus;
  limit?: number;
}): Promise<TradeSummary[]> {
  return loadTradeSummaries({
    leagueId: args.leagueId,
    teamId: args.teamId,
    weekNo: args.weekNo,
    statuses: args.status ? [args.status] : undefined,
    limit: args.limit,
  });
}

/** Attach the Commissioner Agent's prose to an already-scored trade. */
export async function attachFairnessNarrative(
  tradeId: string,
  narrative: string,
  executor: DbOrTx = db,
): Promise<void> {
  const trade = await executor.query.trades.findFirst({ where: eq(trades.id, tradeId) });
  if (!trade) return;
  const detail = { ...(trade.fairnessDetail ?? {}), narrative };
  await executor.update(trades).set({ fairnessDetail: detail }).where(eq(trades.id, tradeId));
}

// ------------------------------------------------------------------ internals

async function writeTradeEvent(
  args: {
    tradeId: string;
    type: string;
    fromStatus: TradeStatus | null;
    toStatus: TradeStatus | null;
    actorTeamId: string | null;
    ctx: AgentContext | null;
    payload: Record<string, unknown>;
  },
  executor: DbOrTx,
): Promise<void> {
  await executor.insert(tradeEvents).values({
    tradeId: args.tradeId,
    type: args.type,
    fromStatus: args.fromStatus,
    toStatus: args.toStatus,
    runId: args.ctx?.runId ?? null,
    stepIndex: args.ctx?.stepIndex ?? null,
    actorTeamId: args.actorTeamId,
    payload: args.payload,
  });
}

/**
 * Players that would be traded *back* to the team that recently sent them away.
 * A move X→Y is blocked when a completed trade inside the anti-churn horizon
 * moved the same player Y→X.
 */
async function antiChurnViolations(
  args: {
    leagueId: string;
    teamAId: string;
    teamBId: string;
    moves: Array<{ playerId: string; fromTeamId: string; toTeamId: string }>;
    weekNo: number;
    antiChurnWeeks: number;
  },
  executor: DbOrTx,
): Promise<string[]> {
  if (args.antiChurnWeeks <= 0 || args.moves.length === 0) return [];
  const sinceWeek = args.weekNo - args.antiChurnWeeks;
  const playerIds = args.moves.map((m) => m.playerId);

  // The unified feed records the receiving side of every completed trade leg.
  const priorFeed = await executor
    .select({
      playerId: transactions.playerId,
      toTeamId: transactions.teamId,
      fromTeamId: transactions.relatedTeamId,
      weekNo: transactions.weekNo,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.leagueId, args.leagueId),
        eq(transactions.type, "trade"),
        inArray(transactions.playerId, playerIds),
        or(
          eq(transactions.teamId, args.teamAId),
          eq(transactions.teamId, args.teamBId),
        ),
        gt(transactions.weekNo, sinceWeek),
      ),
    );

  // …and `trade_items` of completed trades is the authoritative record.
  const priorItems = await executor
    .select({
      playerId: tradeItems.playerId,
      fromTeamId: tradeItems.fromTeamId,
      toTeamId: tradeItems.toTeamId,
      weekNo: trades.weekNo,
    })
    .from(tradeItems)
    .innerJoin(trades, eq(trades.id, tradeItems.tradeId))
    .where(
      and(
        eq(trades.leagueId, args.leagueId),
        eq(trades.status, "completed"),
        inArray(tradeItems.playerId, playerIds),
        gt(trades.weekNo, sinceWeek),
      ),
    );

  const prior = [...priorFeed, ...priorItems];
  const violations = new Set<string>();
  for (const move of args.moves) {
    const returning = prior.some(
      (p) =>
        p.playerId === move.playerId &&
        p.fromTeamId === move.toTeamId &&
        p.toTeamId === move.fromTeamId,
    );
    if (returning) violations.add(move.playerId);
  }
  return [...violations];
}

async function playerNames(playerIds: string[], executor: DbOrTx): Promise<string[]> {
  if (playerIds.length === 0) return [];
  const rows = await executor
    .select({ id: players.id, name: players.fullName })
    .from(players)
    .where(inArray(players.id, playerIds));
  const byId = new Map(rows.map((r) => [r.id, r.name]));
  return playerIds.map((id) => byId.get(id) ?? id);
}

async function offerSummary(
  args: {
    proposerName: string;
    recipientName: string;
    give: string[];
    receive: string[];
    faab: number;
    note?: string;
  },
  executor: DbOrTx,
): Promise<string> {
  const [giveNames, receiveNames] = await Promise.all([
    playerNames(args.give, executor),
    playerNames(args.receive, executor),
  ]);
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
  trade: Trade,
  senderTeamId: string,
  body: string,
  ctx: AgentContext,
  tx: Tx,
): Promise<void> {
  if (!trade.threadId) return;
  await insertThreadMessage(
    {
      threadId: trade.threadId,
      senderTeamId,
      body,
      runId: ctx.runId,
      stepIndex: ctx.stepIndex,
      configVersionId: ctx.configVersionId,
    },
    tx,
  );
}

function suffix(message?: string): string {
  return message ? ` ${message}` : "";
}

/** Kept for callers that only need the raw rows. */
export async function listTradeEvents(tradeId: string): Promise<TradeEventView[]> {
  const detail = await getTrade(tradeId);
  return detail?.events ?? [];
}
