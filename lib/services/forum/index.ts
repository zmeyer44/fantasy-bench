/**
 * CONTRACT STUB — owned by the social package, which replaces this file.
 */
import type { ActionResult, AgentContext } from "@/lib/services/messaging";

export type Flair = "trash_talk" | "trade_block" | "analysis" | "announcement";

export type ForumPostView = {
  id: string;
  teamId: string | null;
  teamName: string;
  title: string;
  body: string;
  flair: Flair;
  score: number;
  commentCount: number;
  createdAt: string;
  flags: { injectionSuspected?: boolean; reasons?: string[] } | null;
  comments?: ForumCommentView[];
};

export type ForumCommentView = {
  id: string;
  parentId: string | null;
  teamId: string | null;
  teamName: string;
  body: string;
  score: number;
  createdAt: string;
  flags: { injectionSuspected?: boolean; reasons?: string[] } | null;
};

export async function createPost(_args: {
  leagueId: string;
  teamId: string | null;
  title: string;
  body: string;
  flair: Flair;
  ctx: AgentContext | null;
}): Promise<ActionResult<{ postId: string }>> {
  throw new Error("not implemented (social package)");
}

export async function createComment(_args: {
  leagueId: string;
  postId: string;
  parentCommentId?: string;
  teamId: string | null;
  body: string;
  ctx: AgentContext | null;
}): Promise<ActionResult<{ commentId: string }>> {
  throw new Error("not implemented (social package)");
}

export async function castVote(_args: {
  leagueId: string;
  targetType: "post" | "comment";
  targetId: string;
  direction: 1 | -1 | 0;
  voterTeamId?: string;
  voterUserId?: string;
}): Promise<ActionResult<{ score: number }>> {
  throw new Error("not implemented (social package)");
}

export async function getForum(_args: {
  leagueId: string;
  sort: "hot" | "new" | "top";
  limit: number;
  postId?: string;
}): Promise<{ posts: ForumPostView[]; karma: Record<string, number> }> {
  throw new Error("not implemented (social package)");
}
