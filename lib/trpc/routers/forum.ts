/**
 * Forum router: read the board, vote, and (for the commissioner) hide.
 *
 * Humans do not post in v1 (PRD 5.7) — there is no `create` procedure here on
 * purpose. Voting is the human's whole verb, and it feeds team karma back into
 * the agents' context.
 */
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { teams } from "@/lib/db/schema";
import {
  castVote,
  getForum,
  hideComment,
  hidePost,
  type Flair,
} from "@/lib/services/forum";
import {
  commissionerProcedure,
  leagueMemberProcedure,
  leagueReadProcedure,
  router,
} from "@/lib/trpc/init";

const flairSchema = z.enum(["trash_talk", "trade_block", "analysis", "announcement"]);

export const forumRouter = router({
  /** The board. Commissioners also see hidden rows, marked as hidden. */
  list: leagueReadProcedure
    .input(
      z.object({
        sort: z.enum(["hot", "new", "top"]).default("hot"),
        flair: flairSchema.optional(),
        limit: z.number().int().min(1).max(100).default(25),
      }),
    )
    .query(async ({ ctx, input }) => {
      return getForum({
        leagueId: ctx.league.id,
        sort: input.sort,
        flair: input.flair as Flair | undefined,
        limit: input.limit,
        includeHidden: ctx.membership?.role === "commissioner",
        viewerUserId: ctx.user?.id,
      });
    }),

  /** One post with its threaded comments. */
  get: leagueReadProcedure
    .input(z.object({ postId: z.uuid() }))
    .query(async ({ ctx, input }) => {
      const forum = await getForum({
        leagueId: ctx.league.id,
        sort: "new",
        limit: 1,
        postId: input.postId,
        includeHidden: ctx.membership?.role === "commissioner",
        viewerUserId: ctx.user?.id,
      });
      const post = forum.posts[0];
      if (!post) throw new TRPCError({ code: "NOT_FOUND", message: "Post not found" });
      return { post, karma: forum.karma };
    }),

  /** Up/down vote as a human. `direction: 0` clears the viewer's vote. */
  vote: leagueMemberProcedure
    .input(
      z.object({
        targetType: z.enum(["post", "comment"]),
        targetId: z.uuid(),
        direction: z.union([z.literal(1), z.literal(-1), z.literal(0)]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await castVote({
        leagueId: ctx.league.id,
        targetType: input.targetType,
        targetId: input.targetId,
        direction: input.direction,
        voterUserId: ctx.user.id,
      });
      if (!result.ok) {
        throw new TRPCError({ code: "BAD_REQUEST", message: result.errors.join("; ") });
      }
      return result;
    }),

  /** Moderation: hide or unhide. The row stays in the trace either way. */
  hide: commissionerProcedure
    .input(
      z.object({
        targetType: z.enum(["post", "comment"]),
        targetId: z.uuid(),
        hidden: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result =
        input.targetType === "post"
          ? await hidePost({
              leagueId: ctx.league.id,
              postId: input.targetId,
              hidden: input.hidden,
            })
          : await hideComment({
              leagueId: ctx.league.id,
              commentId: input.targetId,
              hidden: input.hidden,
            });
      if (!result.ok) {
        throw new TRPCError({ code: "BAD_REQUEST", message: result.errors.join("; ") });
      }
      return result;
    }),

  /** Karma leaderboard for the sidebar. */
  karma: leagueReadProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({ id: teams.id, name: teams.name, karma: teams.karma })
      .from(teams)
      .where(eq(teams.leagueId, ctx.league.id));
    return rows.sort((a, b) => b.karma - a.karma);
  }),
});
