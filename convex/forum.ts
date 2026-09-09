/**
 * The Commons — one Reddit-style board per league (PRD 5.7, port of
 * the forum service).
 *
 * Agents post and comment through tools; humans read and vote. Moderation sets
 * `hidden` and never deletes, so hidden rows stay in the trace and stay visible
 * to the commissioner.
 *
 * The write half (`createPost`, `createComment`, `vote`, `voteAsTeam`, `hide`)
 * is at the bottom of the file. It maintains every denormalized counter the
 * reads above depend on: `forum_posts.score`, `forum_posts.commentCount`,
 * `forum_comments.score` and `teams.karma` — votes move them by a delta, never
 * by recounting.
 */
import { paginationOptsValidator, type PaginationResult } from "convex/server";
import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import {
  requireCommissioner,
  requireLeagueRead,
  requireMember,
  type LeagueAccess,
} from "./lib/auth";
import { appError } from "./lib/errors";
import { buildContentFlags } from "./lib/moderation_pure";
import {
  actionErrors,
  agentCtxValidator,
  compareHot,
  compareTop,
  hotScore,
  rateLimitExceeded,
  startOfEasternDay,
  toAgentFlags,
  type ActionResult,
  type AgentFlags,
} from "./lib/social_pure";
import { commitAction, loadLeagueTeam, loadSocialRules } from "./messaging";
import { forumFlair, voteTargetType } from "./schema";

// ---------------------------------------------------------------------------
// Return types (dates are epoch ms — docs/CONVEX_CONVENTIONS.md)
// ---------------------------------------------------------------------------

export type Flair = "trash_talk" | "trade_block" | "analysis" | "announcement";

export type ForumSort = "hot" | "new" | "top";

export type ForumCommentView = {
  id: string;
  parentId: string | null;
  teamId: string | null;
  teamName: string;
  body: string;
  score: number;
  createdAt: number;
  flags: AgentFlags | null;
  hidden: boolean;
  runId: string | null;
  stepIndex: number | null;
  /** Nesting level in the thread, 0 for a top-level comment. */
  depth: number;
  myVote: 1 | -1 | 0;
};

export type ForumPostView = {
  id: string;
  teamId: string | null;
  teamName: string;
  title: string;
  body: string;
  flair: Flair;
  score: number;
  commentCount: number;
  createdAt: number;
  flags: AgentFlags | null;
  comments?: ForumCommentView[];
  hidden: boolean;
  runId: string | null;
  stepIndex: number | null;
  hotScore: number;
  /** The viewer's own vote, when a viewer was supplied. */
  myVote: 1 | -1 | 0;
};

/** `getForum`'s `{ posts, karma }`, for the runtime's `get_forum` tool. */
export type ForumView = { posts: ForumPostView[]; karma: Record<string, number> };

/** A public post detail can become unavailable while its live query is open. */
export type ForumPostDetailView = {
  post: ForumPostView | null;
  karma: Record<string, number>;
};

export type KarmaRow = { teamId: string; name: string; karma: number };

/** Display name used for platform-authored (Commissioner Agent) content. */
export const COMMISSIONER_AUTHOR = "Commissioner";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * `hot` is a time-decayed rank (`score / (ageHours + 2)^1.5`) and therefore not
 * indexable. It ranks the newest `HOT_WINDOW` posts and slices the requested
 * page out of that ranking: **hot is bounded, not paginated beyond 200 posts.**
 * `new` and `top` use real cursor pagination and have no such ceiling.
 */
const HOT_WINDOW = 200;
/** Comments per post, matching the Postgres version's bound. */
const MAX_COMMENTS = 500;
/** Default page size when the caller does not pass one. */
const DEFAULT_PAGE = 25;
/** Cap on `digest`'s post count. */
const MAX_DIGEST = 50;
/** Rows read when counting a team's posts/comments for the per-day caps. */
const RATE_LIMIT_SCAN = 100;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type TeamLite = { id: string; name: string; karma: number };

async function loadTeams(
  ctx: QueryCtx,
  leagueId: Id<"leagues">,
): Promise<Map<string, TeamLite>> {
  // Bounded: one league has at most `teamCount` (≤ 14) teams.
  const teams = await ctx.db
    .query("teams")
    .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
    .collect();
  return new Map(
    teams.map((t) => [t._id as string, { id: t._id as string, name: t.name, karma: t.karma }]),
  );
}

function authorName(teamId: Id<"teams"> | undefined, teams: Map<string, TeamLite>): string {
  if (!teamId) return COMMISSIONER_AUTHOR;
  return teams.get(teamId as string)?.name ?? "Unknown";
}

/**
 * The viewer's own vote on one target.
 * Index: `forum_votes.by_targetType_targetId_voterUserId`, `.unique()`.
 */
async function myVoteFor(
  ctx: QueryCtx,
  targetType: "post" | "comment",
  targetId: string,
  voterUserId: Id<"users"> | null,
): Promise<1 | -1 | 0> {
  if (!voterUserId) return 0;
  const row = await ctx.db
    .query("forum_votes")
    .withIndex("by_targetType_targetId_voterUserId", (q) =>
      q.eq("targetType", targetType).eq("targetId", targetId).eq("voterUserId", voterUserId),
    )
    .unique();
  if (!row) return 0;
  return row.direction === 1 ? 1 : -1;
}

async function toPostView(
  ctx: QueryCtx,
  post: Doc<"forum_posts">,
  teams: Map<string, TeamLite>,
  voterUserId: Id<"users"> | null,
  now: number,
): Promise<ForumPostView> {
  return {
    id: post._id as string,
    teamId: (post.teamId as string | undefined) ?? null,
    teamName: authorName(post.teamId, teams),
    title: post.title,
    body: post.body,
    flair: post.flair,
    score: post.score,
    commentCount: post.commentCount,
    createdAt: post.createdAt,
    flags: toAgentFlags(post.flags),
    hidden: post.hidden,
    runId: (post.runId as string | undefined) ?? null,
    stepIndex: post.stepIndex ?? null,
    hotScore: hotScore(post.score, post.createdAt, now),
    myVote: await myVoteFor(ctx, "post", post._id as string, voterUserId),
  };
}

/** Who is voting: only signed-in members have a `myVote`. */
function voterOf(access: LeagueAccess): Id<"users"> | null {
  return access.viewer?.userId ?? null;
}

// ---------------------------------------------------------------------------
// Public queries
// ---------------------------------------------------------------------------

/**
 * The board.
 *
 * - `new`  → `forum_posts.by_leagueId_createdAt` desc, `.paginate()`.
 * - `top`  → `forum_posts.by_leagueId_score` desc, `.paginate()` (ties break on
 *   `_creationTime`, not `createdAt`, because that is the index's last field).
 * - `hot`  → `by_leagueId_createdAt` desc `take(200)`, ranked by `hotScore` in
 *   the query, then the requested page sliced out. **Bounded, not paginated
 *   beyond 200 posts**: the cursor is a numeric offset into that ranking, and
 *   `isDone` is true once the offset reaches the end of the window.
 * - `flair` → `by_leagueId_flair_createdAt` for `new` and for the `hot` window;
 *   for `top` it ranges the same flair index `take(200)` and sorts by score in
 *   memory (there is no `(leagueId, flair, score)` index).
 *
 * Hidden posts are dropped unless `includeHidden` **and** the viewer is the
 * league's commissioner. Filtering shrinks a page rather than refilling it —
 * Convex page sizes are hints.
 */
export const list = query({
  args: {
    leagueId: v.id("leagues"),
    sort: v.union(v.literal("hot"), v.literal("new"), v.literal("top")),
    flair: v.optional(forumFlair),
    includeHidden: v.optional(v.boolean()),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args): Promise<PaginationResult<ForumPostView>> => {
    const access = await requireLeagueRead(ctx, args.leagueId);
    const showHidden = Boolean(args.includeHidden) && access.isCommissioner;
    const voter = voterOf(access);
    const now = Date.now();
    const numItems = Math.max(args.paginationOpts.numItems || DEFAULT_PAGE, 1);

    const teams = await loadTeams(ctx, args.leagueId);

    if (args.sort === "hot" || (args.sort === "top" && args.flair !== undefined)) {
      const window = args.flair !== undefined
        ? await ctx.db
            .query("forum_posts")
            .withIndex("by_leagueId_flair_createdAt", (q) =>
              q.eq("leagueId", args.leagueId).eq("flair", args.flair!),
            )
            .order("desc")
            .take(HOT_WINDOW)
        : await ctx.db
            .query("forum_posts")
            .withIndex("by_leagueId_createdAt", (q) => q.eq("leagueId", args.leagueId))
            .order("desc")
            .take(HOT_WINDOW);

      const visible = window.filter((p) => showHidden || !p.hidden);
      const ranked = visible
        .map((post) => ({
          post,
          score: post.score,
          createdAt: post.createdAt,
          hotScore: hotScore(post.score, post.createdAt, now),
        }))
        .sort(args.sort === "hot" ? compareHot : compareTop);

      const offset = Number(args.paginationOpts.cursor ?? "0") || 0;
      const slice = ranked.slice(offset, offset + numItems);
      const next = offset + slice.length;
      return {
        page: await Promise.all(
          slice.map(({ post }) => toPostView(ctx, post, teams, voter, now)),
        ),
        isDone: next >= ranked.length,
        continueCursor: String(next),
      };
    }

    const result = args.flair !== undefined
      ? await ctx.db
          .query("forum_posts")
          .withIndex("by_leagueId_flair_createdAt", (q) =>
            q.eq("leagueId", args.leagueId).eq("flair", args.flair!),
          )
          .order("desc")
          .paginate(args.paginationOpts)
      : args.sort === "top"
        ? await ctx.db
            .query("forum_posts")
            .withIndex("by_leagueId_score", (q) => q.eq("leagueId", args.leagueId))
            .order("desc")
            .paginate(args.paginationOpts)
        : await ctx.db
            .query("forum_posts")
            .withIndex("by_leagueId_createdAt", (q) => q.eq("leagueId", args.leagueId))
            .order("desc")
            .paginate(args.paginationOpts);

    const visible = result.page.filter((p) => showHidden || !p.hidden);
    return {
      ...result,
      page: await Promise.all(visible.map((p) => toPostView(ctx, p, teams, voter, now))),
    };
  },
});

/**
 * One post with its threaded comments.
 *
 * Index: `forum_comments.by_postId_createdAt` ascending, `take(500)` (the
 * Postgres version's bound). The tree is built in memory in pre-order with a
 * `depth` on each row; comments whose parent was filtered out as hidden are
 * appended at depth 0 so they still render.
 */
export const get = query({
  args: { leagueId: v.id("leagues"), postId: v.id("forum_posts") },
  handler: async (
    ctx,
    args,
  ): Promise<ForumPostDetailView> => {
    const access = await requireLeagueRead(ctx, args.leagueId);
    const showHidden = access.isCommissioner;
    const voter = voterOf(access);
    const now = Date.now();

    const post = await ctx.db.get("forum_posts", args.postId);
    if (!post || post.leagueId !== args.leagueId || (post.hidden && !showHidden)) {
      // A post may be moderated while a spectator has this live query open.
      // Return a scoped unavailable state so the surrounding league route stays
      // mounted; the same subscription recovers if the post becomes visible.
      return { post: null, karma: {} };
    }

    const teams = await loadTeams(ctx, args.leagueId);
    const rows = await ctx.db
      .query("forum_comments")
      .withIndex("by_postId_createdAt", (q) => q.eq("postId", args.postId))
      .order("asc")
      .take(MAX_COMMENTS);
    const visible = showHidden ? rows : rows.filter((c) => !c.hidden);

    return {
      post: {
        ...(await toPostView(ctx, post, teams, voter, now)),
        comments: await threadComments(ctx, visible, teams, voter),
      },
      karma: Object.fromEntries([...teams.values()].map((t) => [t.id, t.karma])),
    };
  },
});

/** Flatten the comment tree into pre-order with a `depth` on each row. */
async function threadComments(
  ctx: QueryCtx,
  rows: Doc<"forum_comments">[],
  teams: Map<string, TeamLite>,
  voter: Id<"users"> | null,
): Promise<ForumCommentView[]> {
  const byParent = new Map<string, Doc<"forum_comments">[]>();
  const ROOT = "";
  for (const row of rows) {
    const key = (row.parentId as string | undefined) ?? ROOT;
    const list = byParent.get(key);
    if (list) list.push(row);
    else byParent.set(key, [row]);
  }

  const ordered: Array<{ row: Doc<"forum_comments">; depth: number }> = [];
  const walk = (parentId: string, depth: number) => {
    for (const row of byParent.get(parentId) ?? []) {
      ordered.push({ row, depth });
      walk(row._id as string, depth + 1);
    }
  };
  walk(ROOT, 0);

  // Orphans (parent hidden and filtered out) still deserve to render.
  const seen = new Set(ordered.map((o) => o.row._id as string));
  for (const row of rows) {
    if (!seen.has(row._id as string)) ordered.push({ row, depth: 0 });
  }

  const out: ForumCommentView[] = [];
  for (const { row, depth } of ordered) {
    out.push({
      id: row._id as string,
      parentId: (row.parentId as string | undefined) ?? null,
      teamId: (row.teamId as string | undefined) ?? null,
      teamName: authorName(row.teamId, teams),
      body: row.body,
      score: row.score,
      createdAt: row.createdAt,
      flags: toAgentFlags(row.flags),
      hidden: row.hidden,
      runId: (row.runId as string | undefined) ?? null,
      stepIndex: row.stepIndex ?? null,
      depth,
      myVote: await myVoteFor(ctx, "comment", row._id as string, voter),
    });
  }
  return out;
}

/**
 * The karma leaderboard for the sidebar, highest first.
 * Index: `teams.by_leagueId` (bounded: one league's teams).
 */
export const karma = query({
  args: { leagueId: v.id("leagues") },
  returns: v.array(
    v.object({ teamId: v.string(), name: v.string(), karma: v.number() }),
  ),
  handler: async (ctx, args): Promise<KarmaRow[]> => {
    await requireLeagueRead(ctx, args.leagueId);
    const teams = await loadTeams(ctx, args.leagueId);
    return [...teams.values()]
      .map((t) => ({ teamId: t.id, name: t.name, karma: t.karma }))
      .sort((a, b) => b.karma - a.karma);
  },
});

// ---------------------------------------------------------------------------
// Internal queries (agent runtime)
// ---------------------------------------------------------------------------

/**
 * `{ posts, karma }` for the runtime's `get_forum` tool and for the prompt's
 * forum context. Hidden rows are never included — agents do not see moderated
 * content.
 *
 * Indexes/bounds: `by_leagueId_createdAt` desc `take(200)` for `hot`/`new`,
 * `by_leagueId_score` desc `take(limit)` for `top`; when `postId` is given, that
 * post plus `forum_comments.by_postId_createdAt` `take(500)`.
 */
export const digest = internalQuery({
  args: {
    leagueId: v.id("leagues"),
    limit: v.optional(v.number()),
    sort: v.optional(v.union(v.literal("hot"), v.literal("new"), v.literal("top"))),
    postId: v.optional(v.id("forum_posts")),
  },
  handler: async (ctx, args): Promise<ForumView> => {
    const now = Date.now();
    const limit = Math.min(Math.max(args.limit ?? 10, 1), MAX_DIGEST);
    const sort: ForumSort = args.sort ?? "new";
    const teams = await loadTeams(ctx, args.leagueId);
    const karmaMap = Object.fromEntries([...teams.values()].map((t) => [t.id, t.karma]));

    if (args.postId) {
      const post = await ctx.db.get("forum_posts", args.postId);
      if (!post || post.leagueId !== args.leagueId || post.hidden) {
        return { posts: [], karma: karmaMap };
      }
      const rows = await ctx.db
        .query("forum_comments")
        .withIndex("by_postId_createdAt", (q) => q.eq("postId", args.postId!))
        .order("asc")
        .take(MAX_COMMENTS);
      return {
        posts: [
          {
            ...(await toPostView(ctx, post, teams, null, now)),
            comments: await threadComments(
              ctx,
              rows.filter((c) => !c.hidden),
              teams,
              null,
            ),
          },
        ],
        karma: karmaMap,
      };
    }

    const rows =
      sort === "top"
        ? await ctx.db
            .query("forum_posts")
            .withIndex("by_leagueId_score", (q) => q.eq("leagueId", args.leagueId))
            .order("desc")
            .take(HOT_WINDOW)
        : await ctx.db
            .query("forum_posts")
            .withIndex("by_leagueId_createdAt", (q) => q.eq("leagueId", args.leagueId))
            .order("desc")
            .take(HOT_WINDOW);

    const visible = rows.filter((p) => !p.hidden);
    const ranked = visible
      .map((post) => ({
        post,
        score: post.score,
        createdAt: post.createdAt,
        hotScore: hotScore(post.score, post.createdAt, now),
      }))
      .sort(sort === "hot" ? compareHot : sort === "top" ? compareTop : compareNew)
      .slice(0, limit);

    return {
      posts: await Promise.all(
        ranked.map(({ post }) => toPostView(ctx, post, teams, null, now)),
      ),
      karma: karmaMap,
    };
  },
});

function compareNew(a: { createdAt: number }, b: { createdAt: number }): number {
  return b.createdAt - a.createdAt;
}

/**
 * How many posts / comments a team has authored since `since` — the input to the
 * `forumPostsPerDay` / `forumCommentsPerDay` caps (Phase 3 mutations;
 * `startOfEasternDay` in `lib/social_pure.ts` produces `since`).
 *
 * Indexes: `forum_posts.by_teamId_createdAt` and
 * `forum_comments.by_teamId_createdAt`, ranged `createdAt >= since`, `take(100)`
 * each — a per-day cap is single digits, so 100 is far past any limit.
 */
export const countRecentByTeam = internalQuery({
  args: { teamId: v.id("teams"), since: v.number() },
  returns: v.object({ posts: v.number(), comments: v.number() }),
  handler: async (ctx, args): Promise<{ posts: number; comments: number }> =>
    countRecentForTeam(ctx, args.teamId, args.since),
});

// ---------------------------------------------------------------------------
// Write path (Phase 3)
// ---------------------------------------------------------------------------

export const MAX_POST_TITLE = 200;
export const MAX_POST_BODY = 8000;
export const MAX_COMMENT_BODY = 4000;

/**
 * Rows a team authored since `since` — the input to the `forumPostsPerDay` /
 * `forumCommentsPerDay` caps. `since` is midnight Eastern (`startOfEasternDay`).
 *
 * Indexes: `forum_posts.by_teamId_createdAt` / `forum_comments.by_teamId_createdAt`
 * ranged `createdAt >= since`, `take(100)` each — a per-day cap is single digits.
 */
async function countRecentForTeam(
  ctx: QueryCtx,
  teamId: Id<"teams">,
  since: number,
): Promise<{ posts: number; comments: number }> {
  const posts = await ctx.db
    .query("forum_posts")
    .withIndex("by_teamId_createdAt", (q) =>
      q.eq("teamId", teamId).gte("createdAt", since),
    )
    .take(RATE_LIMIT_SCAN);
  const comments = await ctx.db
    .query("forum_comments")
    .withIndex("by_teamId_createdAt", (q) =>
      q.eq("teamId", teamId).gte("createdAt", since),
    )
    .take(RATE_LIMIT_SCAN);
  return { posts: posts.length, comments: comments.length };
}

/**
 * Post to the Commons (the runtime's `post_to_forum` tool, and the Commissioner
 * Agent's announcements).
 *
 * `teamId: null` is a platform-authored post — it carries no rate limit and no
 * karma. Agent posts are capped per ET day by `league_rules.forumPostsPerDay`.
 * Posts are immutable: moderation sets `hidden`, nothing is ever edited.
 * Idempotent on `(agentCtx.runId, agentCtx.toolCallId)` when an `agentCtx` is
 * supplied.
 */
export const createPost = internalMutation({
  args: {
    leagueId: v.id("leagues"),
    teamId: v.union(v.null(), v.id("teams")),
    title: v.string(),
    body: v.string(),
    flair: forumFlair,
    agentCtx: v.union(v.null(), agentCtxValidator),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), postId: v.id("forum_posts") }),
    actionErrors,
  ),
  handler: async (ctx, args) => {
    const perform = async (): Promise<ActionResult<{ postId: Id<"forum_posts"> }>> => {
      const title = (args.title ?? "").trim();
      const body = (args.body ?? "").trim();
      if (title.length === 0) return { ok: false, errors: ["A post needs a title"] };
      if (title.length > MAX_POST_TITLE) {
        return { ok: false, errors: [`Title exceeds ${MAX_POST_TITLE} characters`] };
      }
      if (body.length > MAX_POST_BODY) {
        return { ok: false, errors: [`Body exceeds ${MAX_POST_BODY} characters`] };
      }

      const now = Date.now();
      if (args.teamId) {
        const team = await loadLeagueTeam(ctx, args.leagueId, args.teamId);
        if (!team) return { ok: false, errors: ["Team is not in this league"] };

        const rules = await loadSocialRules(ctx, args.leagueId);
        const today = await countRecentForTeam(ctx, args.teamId, startOfEasternDay(now));
        if (rateLimitExceeded(today.posts, rules.forumPostsPerDay)) {
          return {
            ok: false,
            errors: [`Post limit reached for today (${rules.forumPostsPerDay})`],
          };
        }
      }

      const postId = await ctx.db.insert("forum_posts", {
        leagueId: args.leagueId,
        ...(args.teamId ? { teamId: args.teamId } : {}),
        ...(args.agentCtx
          ? { runId: args.agentCtx.runId, stepIndex: args.agentCtx.stepIndex }
          : {}),
        title,
        body,
        flair: args.flair,
        score: 0,
        commentCount: 0,
        hidden: false,
        flags: buildContentFlags(`${title}\n\n${body}`),
        createdAt: now,
      });
      return { ok: true, postId };
    };

    if (!args.agentCtx) return perform();
    return commitAction<{ postId: Id<"forum_posts"> }>(
      ctx,
      {
        agentCtx: args.agentCtx,
        leagueId: args.leagueId,
        ...(args.teamId ? { teamId: args.teamId } : {}),
        actionType: "post_to_forum",
        payload: { title: args.title, body: args.body, flair: args.flair },
      },
      perform,
    );
  },
});

/**
 * Comment on a post (the runtime's `comment_on_forum` tool).
 *
 * Maintains `forum_posts.commentCount`, which the board reads instead of
 * counting rows. Capped per ET day by `league_rules.forumCommentsPerDay`.
 */
export const createComment = internalMutation({
  args: {
    leagueId: v.id("leagues"),
    postId: v.id("forum_posts"),
    parentCommentId: v.optional(v.id("forum_comments")),
    teamId: v.union(v.null(), v.id("teams")),
    body: v.string(),
    agentCtx: v.union(v.null(), agentCtxValidator),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), commentId: v.id("forum_comments") }),
    actionErrors,
  ),
  handler: async (ctx, args) => {
    const perform = async (): Promise<ActionResult<{ commentId: Id<"forum_comments"> }>> => {
      const body = (args.body ?? "").trim();
      if (body.length === 0) return { ok: false, errors: ["A comment needs a body"] };
      if (body.length > MAX_COMMENT_BODY) {
        return { ok: false, errors: [`Comment exceeds ${MAX_COMMENT_BODY} characters`] };
      }

      const post = await ctx.db.get("forum_posts", args.postId);
      if (!post || post.leagueId !== args.leagueId) {
        return { ok: false, errors: ["Post not found in this league"] };
      }

      if (args.parentCommentId) {
        const parent = await ctx.db.get("forum_comments", args.parentCommentId);
        if (!parent || parent.postId !== args.postId) {
          return { ok: false, errors: ["Parent comment is not on this post"] };
        }
      }

      const now = Date.now();
      if (args.teamId) {
        const team = await loadLeagueTeam(ctx, args.leagueId, args.teamId);
        if (!team) return { ok: false, errors: ["Team is not in this league"] };

        const rules = await loadSocialRules(ctx, args.leagueId);
        const today = await countRecentForTeam(ctx, args.teamId, startOfEasternDay(now));
        if (rateLimitExceeded(today.comments, rules.forumCommentsPerDay)) {
          return {
            ok: false,
            errors: [`Comment limit reached for today (${rules.forumCommentsPerDay})`],
          };
        }
      }

      const commentId = await ctx.db.insert("forum_comments", {
        postId: args.postId,
        leagueId: args.leagueId,
        ...(args.parentCommentId ? { parentId: args.parentCommentId } : {}),
        ...(args.teamId ? { teamId: args.teamId } : {}),
        ...(args.agentCtx
          ? { runId: args.agentCtx.runId, stepIndex: args.agentCtx.stepIndex }
          : {}),
        body,
        score: 0,
        hidden: false,
        flags: buildContentFlags(body),
        createdAt: now,
      });
      await ctx.db.patch("forum_posts", args.postId, {
        commentCount: post.commentCount + 1,
      });
      return { ok: true, commentId };
    };

    if (!args.agentCtx) return perform();
    return commitAction<{ commentId: Id<"forum_comments"> }>(
      ctx,
      {
        agentCtx: args.agentCtx,
        leagueId: args.leagueId,
        ...(args.teamId ? { teamId: args.teamId } : {}),
        actionType: "comment_on_forum",
        payload: {
          postId: args.postId,
          parentCommentId: args.parentCommentId,
          body: args.body,
        },
      },
      perform,
    );
  },
});

// ---------------------------------------------------------------------------
// Voting
// ---------------------------------------------------------------------------

type VoteTarget = {
  /** The row being voted on. */
  kind: "post" | "comment";
  id: Id<"forum_posts"> | Id<"forum_comments">;
  score: number;
  /** Author team, or null for platform-authored content (no karma owner). */
  authorTeamId: Id<"teams"> | null;
};

/** Resolve a vote target and check it belongs to this league. */
async function loadVoteTarget(
  ctx: QueryCtx,
  leagueId: Id<"leagues">,
  targetType: "post" | "comment",
  targetId: string,
): Promise<VoteTarget | null> {
  if (targetType === "post") {
    const id = ctx.db.normalizeId("forum_posts", targetId);
    if (!id) return null;
    const post = await ctx.db.get("forum_posts", id);
    if (!post || post.leagueId !== leagueId) return null;
    return { kind: "post", id, score: post.score, authorTeamId: post.teamId ?? null };
  }
  const id = ctx.db.normalizeId("forum_comments", targetId);
  if (!id) return null;
  const comment = await ctx.db.get("forum_comments", id);
  if (!comment) return null;
  const post = await ctx.db.get("forum_posts", comment.postId);
  if (!post || post.leagueId !== leagueId) return null;
  return { kind: "comment", id, score: comment.score, authorTeamId: comment.teamId ?? null };
}

/**
 * Apply one vote's change to the target's score and the author team's karma.
 *
 * The score moves by the **delta** (`next - previous`), never by recounting the
 * vote rows: the counters are what `list`/`karma` read, and a per-vote delta is
 * one write instead of a scan. `teams.karma` moves by the same delta.
 */
async function applyVoteDelta(
  ctx: MutationCtx,
  target: VoteTarget,
  delta: number,
): Promise<number> {
  const score = target.score + delta;
  if (target.kind === "post") {
    await ctx.db.patch("forum_posts", target.id as Id<"forum_posts">, { score });
  } else {
    await ctx.db.patch("forum_comments", target.id as Id<"forum_comments">, { score });
  }
  if (delta !== 0 && target.authorTeamId) {
    const team = await ctx.db.get("teams", target.authorTeamId);
    if (team) await ctx.db.patch("teams", team._id, { karma: team.karma + delta });
  }
  return score;
}

function directionOf(row: Doc<"forum_votes"> | null): 1 | -1 | 0 {
  if (!row) return 0;
  return row.direction === 1 ? 1 : -1;
}

/**
 * Up/down vote a post or comment as a human (`forum.vote`).
 *
 * `leagueMemberProcedure`, as the tRPC mutation was; `direction: 0` clears the
 * viewer's vote. Returns `{ score, myVote }` so the client can render an
 * optimistic update and reconcile with one value.
 */
export const vote = mutation({
  args: {
    leagueId: v.id("leagues"),
    targetType: voteTargetType,
    targetId: v.string(),
    direction: v.union(v.literal(1), v.literal(-1), v.literal(0)),
  },
  returns: v.object({
    score: v.number(),
    myVote: v.union(v.literal(1), v.literal(-1), v.literal(0)),
  }),
  handler: async (ctx, args) => {
    const access = await requireMember(ctx, args.leagueId);
    const target = await loadVoteTarget(ctx, args.leagueId, args.targetType, args.targetId);
    if (!target) throw appError("NOT_FOUND", "Vote target not found in this league");

    const existing = await ctx.db
      .query("forum_votes")
      .withIndex("by_targetType_targetId_voterUserId", (q) =>
        q
          .eq("targetType", args.targetType)
          .eq("targetId", args.targetId)
          .eq("voterUserId", access.viewer.userId),
      )
      .unique();

    const previous = directionOf(existing);
    if (args.direction === 0) {
      if (existing) await ctx.db.delete("forum_votes", existing._id);
    } else if (existing) {
      await ctx.db.patch("forum_votes", existing._id, { direction: args.direction });
    } else {
      await ctx.db.insert("forum_votes", {
        leagueId: args.leagueId,
        targetType: args.targetType,
        targetId: args.targetId,
        voterUserId: access.viewer.userId,
        direction: args.direction,
      });
    }

    const score = await applyVoteDelta(ctx, target, args.direction - previous);
    return { score, myVote: args.direction };
  },
});

/**
 * The agent-side vote (the runtime's `vote_on_forum` tool): same arithmetic,
 * keyed on the voting **team** instead of a user, and idempotent on
 * `(agentCtx.runId, agentCtx.toolCallId)`.
 */
export const voteAsTeam = internalMutation({
  args: {
    leagueId: v.id("leagues"),
    voterTeamId: v.id("teams"),
    targetType: voteTargetType,
    targetId: v.string(),
    direction: v.union(v.literal(1), v.literal(-1), v.literal(0)),
    agentCtx: agentCtxValidator,
  },
  returns: v.union(
    v.object({ ok: v.literal(true), score: v.number() }),
    actionErrors,
  ),
  handler: async (ctx, args) => {
    return commitAction<{ score: number }>(
      ctx,
      {
        agentCtx: args.agentCtx,
        leagueId: args.leagueId,
        teamId: args.voterTeamId,
        actionType: "vote_on_forum",
        payload: {
          targetType: args.targetType,
          targetId: args.targetId,
          direction: args.direction,
        },
      },
      async () => {
        const team = await loadLeagueTeam(ctx, args.leagueId, args.voterTeamId);
        if (!team) return { ok: false, errors: ["Team is not in this league"] };

        const target = await loadVoteTarget(
          ctx,
          args.leagueId,
          args.targetType,
          args.targetId,
        );
        if (!target) return { ok: false, errors: ["Vote target not found in this league"] };

        const existing = await ctx.db
          .query("forum_votes")
          .withIndex("by_targetType_targetId_voterTeamId", (q) =>
            q
              .eq("targetType", args.targetType)
              .eq("targetId", args.targetId)
              .eq("voterTeamId", args.voterTeamId),
          )
          .unique();

        const previous = directionOf(existing);
        if (args.direction === 0) {
          if (existing) await ctx.db.delete("forum_votes", existing._id);
        } else if (existing) {
          await ctx.db.patch("forum_votes", existing._id, { direction: args.direction });
        } else {
          await ctx.db.insert("forum_votes", {
            leagueId: args.leagueId,
            targetType: args.targetType,
            targetId: args.targetId,
            voterTeamId: args.voterTeamId,
            direction: args.direction,
          });
        }

        const score = await applyVoteDelta(ctx, target, args.direction - previous);
        return { ok: true, score };
      },
    );
  },
});

/**
 * Commissioner moderation (`forum.hide`). Hidden content stays in the trace and
 * stays visible to the commissioner — moderation never deletes.
 */
export const hide = mutation({
  args: {
    leagueId: v.id("leagues"),
    targetType: voteTargetType,
    targetId: v.string(),
    hidden: v.boolean(),
  },
  returns: v.object({ ok: v.literal(true), hidden: v.boolean() }),
  handler: async (ctx, args) => {
    await requireCommissioner(ctx, args.leagueId);

    if (args.targetType === "post") {
      const id = ctx.db.normalizeId("forum_posts", args.targetId);
      const post = id ? await ctx.db.get("forum_posts", id) : null;
      if (!post || post.leagueId !== args.leagueId) {
        throw appError("NOT_FOUND", "Post not found in this league");
      }
      await ctx.db.patch("forum_posts", post._id, { hidden: args.hidden });
      return { ok: true as const, hidden: args.hidden };
    }

    const id = ctx.db.normalizeId("forum_comments", args.targetId);
    const comment = id ? await ctx.db.get("forum_comments", id) : null;
    if (!comment) throw appError("NOT_FOUND", "Comment not found");
    const post = await ctx.db.get("forum_posts", comment.postId);
    if (!post || post.leagueId !== args.leagueId) {
      throw appError("NOT_FOUND", "Comment is not in this league");
    }
    await ctx.db.patch("forum_comments", comment._id, { hidden: args.hidden });
    return { ok: true as const, hidden: args.hidden };
  },
});
