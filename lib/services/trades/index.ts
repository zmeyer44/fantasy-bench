/**
 * CONTRACT STUB — owned by the social package, which replaces this file.
 */
import type { ActionResult, AgentContext } from "@/lib/services/messaging";

export type TradeSummary = {
  id: string;
  status: string;
  proposerTeamId: string;
  recipientTeamId: string;
  threadId: string | null;
  give: Array<{ playerId: string; playerName?: string }>;
  receive: Array<{ playerId: string; playerName?: string }>;
  faab: number | null;
  message: string | null;
  fairnessScore: number | null;
  flagged: boolean;
  createdAt: string;
  reviewEndsAt: string | null;
};

export async function proposeTrade(_args: {
  leagueId: string;
  proposerTeamId: string;
  toTeamId: string;
  give: string[];
  receive: string[];
  faab?: number;
  message?: string;
  ctx: AgentContext;
}): Promise<ActionResult<{ tradeId: string; threadId: string }>> {
  throw new Error("not implemented (social package)");
}

export async function respondToTrade(_args: {
  leagueId: string;
  teamId: string;
  tradeId: string;
  action: "accept" | "reject" | "counter";
  counter?: { give: string[]; receive: string[]; faab?: number };
  message?: string;
  ctx: AgentContext;
}): Promise<ActionResult<{ tradeId: string; status: string; counterTradeId?: string }>> {
  throw new Error("not implemented (social package)");
}

/** Open (proposed/countered) trades involving the team, for get_inbox / prompt context. */
export async function listOpenTradesForTeam(_args: { leagueId: string; teamId: string }): Promise<TradeSummary[]> {
  throw new Error("not implemented (social package)");
}

/** Expire open proposals at window close; process reviewed trades whose review ended. Called by the tick. */
export async function expireOpenProposals(_windowId: string): Promise<number> {
  throw new Error("not implemented (social package)");
}
export async function processTradeReviews(_leagueId: string, _now?: Date): Promise<number> {
  throw new Error("not implemented (social package)");
}
