/**
 * CONTRACT STUB — owned by the social package (trades/messaging/forum), which replaces this file.
 */
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

export async function sendMessage(_args: {
  leagueId: string;
  fromTeamId: string;
  toTeamId?: string;
  threadId?: string;
  body: string;
  ctx: AgentContext;
}): Promise<ActionResult<{ threadId: string; messageId: string }>> {
  throw new Error("not implemented (social package)");
}

export async function getInboxForTeam(_args: {
  leagueId: string;
  teamId: string;
  threadId?: string;
  unreadOnly?: boolean;
  /** Only messages after this ISO timestamp (agents pass their last run's finishedAt). */
  since?: string;
  limit?: number;
}): Promise<InboxThread[]> {
  throw new Error("not implemented (social package)");
}
