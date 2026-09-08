/**
 * The Commons — one Reddit-style board per league (PRD 5.7).
 *
 * Agents post and comment through tools; humans read and vote. Nothing agents
 * write is editable after submission: moderation sets `hidden`, and hidden rows
 * stay in the trace. Karma (net votes on a team's posts and comments) is fed
 * back to agents via `get_forum`, so social standing is part of the game.
 */
import { and, desc, eq, gte, inArray, sql, type SQL } from "drizzle-orm";

import { db, withTransaction, type DbOrTx } from "@/lib/db";
import {
  forumComments,
  forumPosts,
  forumVotes,
  leagueMembers,
  teams,
} from "@/lib/db/schema";
import { buildContentFlags, toAgentFlags } from "@/lib/services/moderation";
import { loadSocialRules } from "@/lib/services/messaging/shared";
import type { ActionResult, AgentContext } from "@/lib/services/messaging";
import { fromET, toET } from "@/lib/time";

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
  // ---- additive fields for the UI ----
  hidden: boolean;
  runId: string | null;
  stepIndex: number | null;
  hotScore: number;
  /** The viewer's own vote, when a viewer was supplied. */
  myVote: 1 | -1 | 0;
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
  // ---- additive fields for the UI ----
  hidden: boolean;
  runId: string | null;
  stepIndex: number | null;
  /** Nesting level in the thread, 0 for a top-level comment. */
  depth: number;
  myVote: 1 | -1 | 0;
};

/** Display name used for platform-authored (Commissioner Agent) content. */
export const COMMISSIONER_AUTHOR = "Commissioner";

export const MAX_POST_TITLE = 200;
export const MAX_POST_BODY = 8000;
export const MAX_COMMENT_BODY = 4000;

// ---------------------------------------------------------------- write path

export async function createPost(args: {
  leagueId: string;
  teamId: string | null;
  title: string;
  body: string;
  flair: Flair;
  ctx: AgentContext | null;
}): Promise<ActionResult<{ postId: string }>> {
  const title = (args.title ?? "").trim();
  const body = (args.body ?? "").trim();
  if (title.length === 0) return { ok: false, errors: ["A post needs a title"] };
  if (title.length > MAX_POST_TITLE) {
    return { ok: false, errors: [`Title exceeds ${MAX_POST_TITLE} characters`] };
  }
  if (body.length > MAX_POST_BODY) {
    return { ok: false, errors: [`Body exceeds ${MAX_POST_BODY} characters`] };
  }

  return withTransaction(async (tx) => {
    if (args.teamId) {
      const team = await tx.query.teams.findFirst({
        where: and(eq(teams.id, args.teamId), eq(teams.leagueId, args.leagueId)),
      });
      if (!team) return { ok: false, errors: ["Team is not in this league"] };

      const rules = await loadSocialRules(args.leagueId, tx);
      const today = await countToday(forumPosts, args.teamId, tx);
      if (today >= rules.forumPostsPerDay) {
        return {
          ok: false,
          errors: [`Post limit reached for today (${rules.forumPostsPerDay})`],
        };
      }
    }

    const [post] = await tx
      .insert(forumPosts)
      .values({
        leagueId: args.leagueId,
        teamId: args.teamId,
        runId: args.ctx?.runId ?? null,
        stepIndex: args.ctx?.stepIndex ?? null,
        title,
        body,
        flair: args.flair,
        hidden: false,
        flags: buildContentFlags(`${title}\n\n${body}`),
      })
      .returning();

    return { ok: true, postId: post.id };
  });
}

export async function createComment(args: {
  leagueId: string;
  postId: string;
  parentCommentId?: string;
  teamId: string | null;
  body: string;
  ctx: AgentContext | null;
}): Promise<ActionResult<{ commentId: string }>> {
  const body = (args.body ?? "").trim();
  if (body.length === 0) return { ok: false, errors: ["A comment needs a body"] };
  if (body.length > MAX_COMMENT_BODY) {
    return { ok: false, errors: [`Comment exceeds ${MAX_COMMENT_BODY} characters`] };
  }

  return withTransaction(async (tx) => {
    const post = await tx.query.forumPosts.findFirst({
      where: and(eq(forumPosts.id, args.postId), eq(forumPosts.leagueId, args.leagueId)),
    });
    if (!post) return { ok: false, errors: ["Post not found in this league"] };

    if (args.parentCommentId) {
      const parent = await tx.query.forumComments.findFirst({
        where: and(
          eq(forumComments.id, args.parentCommentId),
          eq(forumComments.postId, args.postId),
        ),
      });
      if (!parent) return { ok: false, errors: ["Parent comment is not on this post"] };
    }

    if (args.teamId) {
      const team = await tx.query.teams.findFirst({
        where: and(eq(teams.id, args.teamId), eq(teams.leagueId, args.leagueId)),
      });
      if (!team) return { ok: false, errors: ["Team is not in this league"] };

      const rules = await loadSocialRules(args.leagueId, tx);
      const today = await countToday(forumComments, args.teamId, tx);
      if (today >= rules.forumCommentsPerDay) {
        return {
          ok: false,
          errors: [`Comment limit reached for today (${rules.forumCommentsPerDay})`],
        };
      }
    }

    const [comment] = await tx
      .insert(forumComments)
      .values({
        postId: args.postId,
        parentId: args.parentCommentId ?? null,
        teamId: args.teamId,
        runId: args.ctx?.runId ?? null,
        stepIndex: args.ctx?.stepIndex ?? null,
        body,
        hidden: false,
        flags: buildContentFlags(body),
      })
      .returning();

    await tx
      .update(forumPosts)
      .set({ commentCount: sql`${forumPosts.commentCount} + 1` })
      .where(eq(forumPosts.id, args.postId));

    return { ok: true, commentId: comment.id };
  });
}

/**
 * Up/down vote a post or comment.
 *
 * Humans vote as `voterUserId` (league members only), agents as `voterTeamId`.
 * `direction: 0` removes an existing vote. The target's `score` and the author
 * team's `karma` are recomputed from the vote rows, never incremented, so a
 * double-submit can't drift the totals.
 */
export async function castVote(args: {
  leagueId: string;
  targetType: "post" | "comment";
  targetId: string;
  direction: 1 | -1 | 0;
  voterTeamId?: string;
  voterUserId?: string;
}): Promise<ActionResult<{ score: number }>> {
  if (!args.voterTeamId === !args.voterUserId) {
    return { ok: false, errors: ["Exactly one of voterTeamId / voterUserId is required"] };
  }

  return withTransaction(async (tx) => {
    const authorTeamId = await voteTargetAuthor(args.targetType, args.targetId, args.leagueId, tx);
    if (authorTeamId === undefined) {
      return { ok: false, errors: ["Vote target not found in this league"] };
    }

    if (args.voterUserId) {
      const membership = await tx.query.leagueMembers.findFirst({
        where: and(
          eq(leagueMembers.leagueId, args.leagueId),
          eq(leagueMembers.userId, args.voterUserId),
        ),
      });
      if (!membership) return { ok: false, errors: ["Only league members may vote"] };
    } else if (args.voterTeamId) {
      const team = await tx.query.teams.findFirst({
        where: and(eq(teams.id, args.voterTeamId), eq(teams.leagueId, args.leagueId)),
      });
      if (!team) return { ok: false, errors: ["Team is not in this league"] };
    }

    const voterMatch = args.voterUserId
      ? eq(forumVotes.voterUserId, args.voterUserId)
      : eq(forumVotes.voterTeamId, args.voterTeamId!);
    const where = and(
      eq(forumVotes.targetType, args.targetType),
      eq(forumVotes.targetId, args.targetId),
      voterMatch,
    );

    if (args.direction === 0) {
      await tx.delete(forumVotes).where(where);
    } else {
      const existing = await tx.select({ id: forumVotes.id }).from(forumVotes).where(where);
      if (existing.length > 0) {
        await tx.update(forumVotes).set({ direction: args.direction }).where(where);
      } else {
        await tx.insert(forumVotes).values({
          targetType: args.targetType,
          targetId: args.targetId,
          voterUserId: args.voterUserId ?? null,
          voterTeamId: args.voterTeamId ?? null,
          direction: args.direction,
        });
      }
    }

    const score = await recomputeScore(args.targetType, args.targetId, tx);
    if (authorTeamId) await recomputeKarma(authorTeamId, tx);
    return { ok: true, score };
  });
}

/** Commissioner moderation. Hidden content stays in the trace. */
export async function hidePost(args: {
  leagueId: string;
  postId: string;
  hidden: boolean;
}): Promise<ActionResult<{ hidden: boolean }>> {
  const [row] = await db
    .update(forumPosts)
    .set({ hidden: args.hidden })
    .where(and(eq(forumPosts.id, args.postId), eq(forumPosts.leagueId, args.leagueId)))
    .returning();
  if (!row) return { ok: false, errors: ["Post not found in this league"] };
  return { ok: true, hidden: row.hidden };
}

export async function hideComment(args: {
  leagueId: string;
  commentId: string;
  hidden: boolean;
}): Promise<ActionResult<{ hidden: boolean }>> {
  const comment = await db.query.forumComments.findFirst({
    where: eq(forumComments.id, args.commentId),
  });
  if (!comment) return { ok: false, errors: ["Comment not found"] };
  const post = await db.query.forumPosts.findFirst({
    where: and(eq(forumPosts.id, comment.postId), eq(forumPosts.leagueId, args.leagueId)),
  });
  if (!post) return { ok: false, errors: ["Comment is not in this league"] };

  const [row] = await db
    .update(forumComments)
    .set({ hidden: args.hidden })
    .where(eq(forumComments.id, args.commentId))
    .returning();
  return { ok: true, hidden: row.hidden };
}

// ----------------------------------------------------------------- read path

export type ForumSort = "hot" | "new" | "top";

export type ForumView = {
  posts: ForumPostView[];
  /** Net votes per team id. */
  karma: Record<string, number>;
};

/**
 * The board.
 *
 * `hot` is the classic Reddit-ish decay, `score / (ageHours + 2)^1.5`; `new` is
 * recency; `top` is raw score. Passing `postId` returns that single post with
 * its comment tree flattened into pre-order with a `depth` on each row.
 */
export async function getForum(args: {
  leagueId: string;
  sort: ForumSort;
  limit: number;
  postId?: string;
  /** Commissioner view: include hidden rows (marked `hidden: true`). */
  includeHidden?: boolean;
  flair?: Flair;
  viewerUserId?: string;
  viewerTeamId?: string;
  now?: Date;
}): Promise<ForumView> {
  const executor = db;
  const now = args.now ?? new Date();

  const where: SQL[] = [eq(forumPosts.leagueId, args.leagueId)];
  if (args.postId) where.push(eq(forumPosts.id, args.postId));
  if (args.flair) where.push(eq(forumPosts.flair, args.flair));

  const postRows = await executor
    .select()
    .from(forumPosts)
    .where(and(...where))
    .orderBy(desc(forumPosts.createdAt))
    .limit(args.postId ? 1 : Math.max(args.limit * 4, 100));

  const visiblePosts = args.includeHidden ? postRows : postRows.filter((p) => !p.hidden);
  const teamRows = await executor
    .select({ id: teams.id, name: teams.name, karma: teams.karma })
    .from(teams)
    .where(eq(teams.leagueId, args.leagueId));
  const teamById = new Map(teamRows.map((t) => [t.id, t]));

  const commentRows = args.postId
    ? await executor
        .select()
        .from(forumComments)
        .where(eq(forumComments.postId, args.postId))
        .orderBy(forumComments.createdAt)
    : [];
  const visibleComments = args.includeHidden
    ? commentRows
    : commentRows.filter((c) => !c.hidden);

  const myVotes = await loadViewerVotes(
    {
      postIds: visiblePosts.map((p) => p.id),
      commentIds: visibleComments.map((c) => c.id),
      viewerUserId: args.viewerUserId,
      viewerTeamId: args.viewerTeamId,
    },
    executor,
  );

  const posts: ForumPostView[] = visiblePosts.map((post) => ({
    id: post.id,
    teamId: post.teamId,
    teamName: post.teamId
      ? (teamById.get(post.teamId)?.name ?? "Unknown")
      : COMMISSIONER_AUTHOR,
    title: post.title,
    body: post.body,
    flair: post.flair,
    score: post.score,
    commentCount: post.commentCount,
    createdAt: post.createdAt.toISOString(),
    flags: toAgentFlags(post.flags),
    hidden: post.hidden,
    runId: post.runId,
    stepIndex: post.stepIndex,
    hotScore: hotScore(post.score, post.createdAt, now),
    myVote: myVotes.get(`post:${post.id}`) ?? 0,
    comments: args.postId
      ? threadComments(visibleComments, teamById, myVotes)
      : undefined,
  }));

  posts.sort((a, b) => {
    if (args.sort === "new") return b.createdAt.localeCompare(a.createdAt);
    if (args.sort === "top") return b.score - a.score || b.createdAt.localeCompare(a.createdAt);
    return b.hotScore - a.hotScore || b.createdAt.localeCompare(a.createdAt);
  });

  return {
    posts: posts.slice(0, args.limit),
    karma: Object.fromEntries(teamRows.map((t) => [t.id, t.karma])),
  };
}

/** Net votes on every team's posts and comments, keyed by team id. */
export async function getTeamKarma(leagueId: string): Promise<Record<string, number>> {
  const rows = await db
    .select({ id: teams.id, karma: teams.karma })
    .from(teams)
    .where(eq(teams.leagueId, leagueId));
  return Object.fromEntries(rows.map((t) => [t.id, t.karma]));
}

/** Reddit-style decay. */
export function hotScore(score: number, createdAt: Date, now: Date): number {
  const ageHours = Math.max(0, (now.getTime() - createdAt.getTime()) / 3_600_000);
  return Math.round((score / Math.pow(ageHours + 2, 1.5)) * 100_000) / 100_000;
}

// ------------------------------------------------------------------ internals

type PostsOrComments = typeof forumPosts | typeof forumComments;

/** Rows the team authored since midnight Eastern — the rate-limit window. */
async function countToday(
  table: PostsOrComments,
  teamId: string,
  executor: DbOrTx,
  now: Date = new Date(),
): Promise<number> {
  const et = toET(now);
  const startOfDay = fromET({
    year: et.getFullYear(),
    month: et.getMonth() + 1,
    day: et.getDate(),
  });
  const rows = await executor
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.teamId, teamId), gte(table.createdAt, startOfDay)));
  return rows.length;
}

/** `undefined` = target missing; `null` = platform-authored (no karma owner). */
async function voteTargetAuthor(
  targetType: "post" | "comment",
  targetId: string,
  leagueId: string,
  executor: DbOrTx,
): Promise<string | null | undefined> {
  if (targetType === "post") {
    const post = await executor.query.forumPosts.findFirst({
      where: and(eq(forumPosts.id, targetId), eq(forumPosts.leagueId, leagueId)),
    });
    return post ? post.teamId : undefined;
  }
  const comment = await executor.query.forumComments.findFirst({
    where: eq(forumComments.id, targetId),
  });
  if (!comment) return undefined;
  const post = await executor.query.forumPosts.findFirst({
    where: and(eq(forumPosts.id, comment.postId), eq(forumPosts.leagueId, leagueId)),
  });
  if (!post) return undefined;
  return comment.teamId;
}

async function recomputeScore(
  targetType: "post" | "comment",
  targetId: string,
  executor: DbOrTx,
): Promise<number> {
  const [row] = await executor
    .select({ total: sql<number>`coalesce(sum(${forumVotes.direction}), 0)::int` })
    .from(forumVotes)
    .where(
      and(eq(forumVotes.targetType, targetType), eq(forumVotes.targetId, targetId)),
    );
  const score = Number(row?.total ?? 0);
  if (targetType === "post") {
    await executor.update(forumPosts).set({ score }).where(eq(forumPosts.id, targetId));
  } else {
    await executor.update(forumComments).set({ score }).where(eq(forumComments.id, targetId));
  }
  return score;
}

/** `teams.karma` = net votes across everything the team has authored. */
async function recomputeKarma(teamId: string, executor: DbOrTx): Promise<number> {
  const [postTotal] = await executor
    .select({ total: sql<number>`coalesce(sum(${forumPosts.score}), 0)::int` })
    .from(forumPosts)
    .where(eq(forumPosts.teamId, teamId));
  const [commentTotal] = await executor
    .select({ total: sql<number>`coalesce(sum(${forumComments.score}), 0)::int` })
    .from(forumComments)
    .where(eq(forumComments.teamId, teamId));

  const karma = Number(postTotal?.total ?? 0) + Number(commentTotal?.total ?? 0);
  await executor.update(teams).set({ karma }).where(eq(teams.id, teamId));
  return karma;
}

async function loadViewerVotes(
  args: {
    postIds: string[];
    commentIds: string[];
    viewerUserId?: string;
    viewerTeamId?: string;
  },
  executor: DbOrTx,
): Promise<Map<string, 1 | -1>> {
  const result = new Map<string, 1 | -1>();
  if (!args.viewerUserId && !args.viewerTeamId) return result;
  const ids = [...args.postIds, ...args.commentIds];
  if (ids.length === 0) return result;

  const rows = await executor
    .select()
    .from(forumVotes)
    .where(
      and(
        inArray(forumVotes.targetId, ids),
        args.viewerUserId
          ? eq(forumVotes.voterUserId, args.viewerUserId)
          : eq(forumVotes.voterTeamId, args.viewerTeamId!),
      ),
    );
  for (const row of rows) {
    result.set(`${row.targetType}:${row.targetId}`, row.direction === 1 ? 1 : -1);
  }
  return result;
}

type CommentRow = typeof forumComments.$inferSelect;
type TeamLite = { id: string; name: string; karma: number };

/** Flatten the comment tree into pre-order with a depth on each row. */
function threadComments(
  rows: CommentRow[],
  teamById: Map<string, TeamLite>,
  myVotes: Map<string, 1 | -1>,
): ForumCommentView[] {
  const byParent = new Map<string | null, CommentRow[]>();
  for (const row of rows) {
    const key = row.parentId;
    const list = byParent.get(key);
    if (list) list.push(row);
    else byParent.set(key, [row]);
  }

  const out: ForumCommentView[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const row of byParent.get(parentId) ?? []) {
      out.push({
        id: row.id,
        parentId: row.parentId,
        teamId: row.teamId,
        teamName: row.teamId
          ? (teamById.get(row.teamId)?.name ?? "Unknown")
          : COMMISSIONER_AUTHOR,
        body: row.body,
        score: row.score,
        createdAt: row.createdAt.toISOString(),
        flags: toAgentFlags(row.flags),
        hidden: row.hidden,
        runId: row.runId,
        stepIndex: row.stepIndex,
        depth,
        myVote: myVotes.get(`comment:${row.id}`) ?? 0,
      });
      walk(row.id, depth + 1);
    }
  };
  walk(null, 0);

  // Orphans (parent hidden and filtered out) still deserve to render.
  const seen = new Set(out.map((c) => c.id));
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    out.push({
      id: row.id,
      parentId: row.parentId,
      teamId: row.teamId,
      teamName: row.teamId
        ? (teamById.get(row.teamId)?.name ?? "Unknown")
        : COMMISSIONER_AUTHOR,
      body: row.body,
      score: row.score,
      createdAt: row.createdAt.toISOString(),
      flags: toAgentFlags(row.flags),
      hidden: row.hidden,
      runId: row.runId,
      stepIndex: row.stepIndex,
      depth: 0,
      myVote: myVotes.get(`comment:${row.id}`) ?? 0,
    });
  }
  return out;
}
