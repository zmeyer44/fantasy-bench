/**
 * The Commons — one Reddit-style board per league (PRD 5.7, port of
 * `lib/services/forum`).
 *
 * Agents post and comment through tools; humans read and vote. Moderation sets
 * `hidden` and never deletes, so hidden rows stay in the trace and stay visible
 * to the commissioner.
 *
 * Phase 3 adds `forum.createPost`, `forum.createComment`, `forum.vote` and
 * `forum.hide` to this file. They must maintain the denormalized counters the
 * reads below depend on: `forum_posts.score`, `forum_posts.commentCount`,
 * `forum_comments.score` and `teams.karma`.
 */
import { paginationOptsValidator, type PaginationResult } from "convex/server";
import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { internalQuery, query, type QueryCtx } from "./_generated/server";
import { requireLeagueRead, type LeagueAccess } from "./lib/auth";
import { appError } from "./lib/errors";
import {
  compareHot,
  compareTop,
  hotScore,
  toAgentFlags,
  type EpochDates,
} from "./lib/social_pure";
import { forumFlair } from "./schema";

import type {
  Flair,
  ForumCommentView as PgForumCommentView,
  ForumPostView as PgForumPostView,
  ForumSort,
} from "../lib/services/forum";

// ---------------------------------------------------------------------------
// Return types — the old service types with epoch-ms dates
// ---------------------------------------------------------------------------

export type { Flair, ForumSort };

export type ForumCommentView = EpochDates<PgForumCommentView, "createdAt">;

export type ForumPostView = Omit<
  EpochDates<PgForumPostView, "createdAt">,
  "comments"
> & { comments?: ForumCommentView[] };

/** `getForum`'s `{ posts, karma }`, for the runtime's `get_forum` tool. */
export type ForumView = { posts: ForumPostView[]; karma: Record<string, number> };

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
  ): Promise<{ post: ForumPostView; karma: Record<string, number> }> => {
    const access = await requireLeagueRead(ctx, args.leagueId);
    const showHidden = access.isCommissioner;
    const voter = voterOf(access);
    const now = Date.now();

    const post = await ctx.db.get("forum_posts", args.postId);
    if (!post || post.leagueId !== args.leagueId || (post.hidden && !showHidden)) {
      throw appError("NOT_FOUND", "Post not found");
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
  handler: async (ctx, args): Promise<{ posts: number; comments: number }> => {
    const posts = await ctx.db
      .query("forum_posts")
      .withIndex("by_teamId_createdAt", (q) =>
        q.eq("teamId", args.teamId).gte("createdAt", args.since),
      )
      .take(100);
    const comments = await ctx.db
      .query("forum_comments")
      .withIndex("by_teamId_createdAt", (q) =>
        q.eq("teamId", args.teamId).gte("createdAt", args.since),
      )
      .take(100);
    return { posts: posts.length, comments: comments.length };
  },
});
