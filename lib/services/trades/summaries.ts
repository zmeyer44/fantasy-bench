/**
 * Trade read models.
 *
 * Split out of `lib/services/trades/index.ts` so `lib/services/messaging` can
 * render inline proposal cards without importing the trade state machine (which
 * imports messaging types) and creating a module cycle.
 */
import { and, desc, eq, inArray, type SQL } from "drizzle-orm";

import { db, type DbOrTx } from "@/lib/db";
import { players, teams, tradeItems, trades } from "@/lib/db/schema";
import type { FairnessDetail } from "@/lib/db/schema";
import type { TradeStatus } from "@/lib/db/types";

export type TradePlayerRef = {
  playerId: string;
  playerName?: string;
  position?: string;
  nflTeam?: string | null;
};

/**
 * One proposal, from the **proposer's** point of view: `give` is what the
 * proposer sends, `receive` is what it gets back. `faab` is net FAAB moving
 * proposer → recipient (negative means the recipient is paying).
 */
export type TradeSummary = {
  id: string;
  status: string;
  proposerTeamId: string;
  recipientTeamId: string;
  threadId: string | null;
  give: TradePlayerRef[];
  receive: TradePlayerRef[];
  faab: number | null;
  message: string | null;
  fairnessScore: number | null;
  flagged: boolean;
  createdAt: string;
  reviewEndsAt: string | null;
  // ---- additive fields (the agent contract only requires the ones above) ----
  leagueId: string;
  weekNo: number | null;
  windowId: string | null;
  proposerTeamName: string;
  recipientTeamName: string;
  parentTradeId: string | null;
  resolvedAt: string | null;
  fairnessDetail: FairnessDetail | null;
  createdByRunId: string | null;
};

export type TradeFilter = {
  leagueId?: string;
  tradeIds?: string[];
  threadIds?: string[];
  /** Trades where the team is either side. */
  teamId?: string;
  weekNo?: number;
  statuses?: TradeStatus[];
  limit?: number;
};

/** Load trade summaries matching `filter`, newest first. */
export async function loadTradeSummaries(
  filter: TradeFilter,
  executor: DbOrTx = db,
): Promise<TradeSummary[]> {
  const where: SQL[] = [];
  if (filter.leagueId) where.push(eq(trades.leagueId, filter.leagueId));
  if (filter.tradeIds) {
    if (filter.tradeIds.length === 0) return [];
    where.push(inArray(trades.id, filter.tradeIds));
  }
  if (filter.threadIds) {
    if (filter.threadIds.length === 0) return [];
    where.push(inArray(trades.threadId, filter.threadIds));
  }
  if (filter.weekNo !== undefined) where.push(eq(trades.weekNo, filter.weekNo));
  if (filter.statuses) {
    if (filter.statuses.length === 0) return [];
    where.push(inArray(trades.status, filter.statuses));
  }

  const rows = await executor
    .select()
    .from(trades)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(trades.createdAt))
    .limit(filter.limit ?? 200);

  const filtered = filter.teamId
    ? rows.filter(
        (t) => t.proposerTeamId === filter.teamId || t.recipientTeamId === filter.teamId,
      )
    : rows;
  if (filtered.length === 0) return [];

  const tradeIds = filtered.map((t) => t.id);
  const items = await executor
    .select({
      tradeId: tradeItems.tradeId,
      fromTeamId: tradeItems.fromTeamId,
      toTeamId: tradeItems.toTeamId,
      playerId: tradeItems.playerId,
      faab: tradeItems.faab,
      playerName: players.fullName,
      position: players.position,
      nflTeam: players.nflTeam,
    })
    .from(tradeItems)
    .leftJoin(players, eq(players.id, tradeItems.playerId))
    .where(inArray(tradeItems.tradeId, tradeIds));

  const teamIds = new Set<string>();
  for (const t of filtered) {
    teamIds.add(t.proposerTeamId);
    teamIds.add(t.recipientTeamId);
  }
  const teamRows = await executor
    .select({ id: teams.id, name: teams.name })
    .from(teams)
    .where(inArray(teams.id, [...teamIds]));
  const teamName = new Map(teamRows.map((t) => [t.id, t.name]));

  return filtered.map((t) => {
    const mine = items.filter((i) => i.tradeId === t.id);
    const give: TradePlayerRef[] = [];
    const receive: TradePlayerRef[] = [];
    let faab = 0;
    for (const item of mine) {
      if (item.playerId) {
        const ref: TradePlayerRef = {
          playerId: item.playerId,
          playerName: item.playerName ?? undefined,
          position: item.position ?? undefined,
          nflTeam: item.nflTeam ?? null,
        };
        if (item.fromTeamId === t.proposerTeamId) give.push(ref);
        else receive.push(ref);
      } else if (item.faab) {
        faab += item.fromTeamId === t.proposerTeamId ? item.faab : -item.faab;
      }
    }
    return {
      id: t.id,
      status: t.status,
      proposerTeamId: t.proposerTeamId,
      recipientTeamId: t.recipientTeamId,
      threadId: t.threadId,
      give,
      receive,
      faab: faab === 0 ? null : faab,
      message: t.message,
      fairnessScore: t.fairnessScore ?? null,
      flagged: t.flagged,
      createdAt: t.createdAt.toISOString(),
      reviewEndsAt: t.reviewEndsAt ? t.reviewEndsAt.toISOString() : null,
      leagueId: t.leagueId,
      weekNo: t.weekNo,
      windowId: t.windowId,
      proposerTeamName: teamName.get(t.proposerTeamId) ?? "Unknown",
      recipientTeamName: teamName.get(t.recipientTeamId) ?? "Unknown",
      parentTradeId: t.parentTradeId,
      resolvedAt: t.resolvedAt ? t.resolvedAt.toISOString() : null,
      fairnessDetail: t.fairnessDetail ?? null,
      createdByRunId: t.createdByRunId,
    };
  });
}

/** Statuses that still need someone to act. */
export const OPEN_TRADE_STATUSES: TradeStatus[] = ["proposed", "countered"];
/** Statuses that are live in the league (open + awaiting review). */
export const LIVE_TRADE_STATUSES: TradeStatus[] = ["proposed", "countered", "in_review"];
