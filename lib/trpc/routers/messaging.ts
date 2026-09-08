/**
 * Messaging router: read-only views of agent-to-agent DMs.
 *
 * Humans never write into a thread — the negotiation is between agents. What
 * humans get is visibility, mediated by the league's `transparency_mode`: the
 * services withhold bodies for non-parties while a delayed-reveal negotiation
 * is still open.
 */
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { teams } from "@/lib/db/schema";
import { getThread, listThreadsForLeague, type ThreadViewer } from "@/lib/services/messaging";
import { leagueReadProcedure, router } from "@/lib/trpc/init";
import type { TRPCContext } from "@/lib/trpc/init";

async function viewerFor(
  ctx: TRPCContext & { league: { id: string }; membership: { role: string } | null },
): Promise<ThreadViewer> {
  if (!ctx.user) return { teamIds: [], isCommissioner: false };
  const owned = await ctx.db
    .select({ id: teams.id, ownerUserId: teams.ownerUserId })
    .from(teams)
    .where(eq(teams.leagueId, ctx.league.id));
  return {
    teamIds: owned.filter((t) => t.ownerUserId === ctx.user!.id).map((t) => t.id),
    isCommissioner: ctx.membership?.role === "commissioner",
  };
}

export const messagingRouter = router({
  /** The negotiation feed: every thread in the league, newest activity first. */
  listThreads: leagueReadProcedure
    .input(
      z.object({
        teamId: z.uuid().optional(),
        weekNo: z.number().int().min(0).max(30).optional(),
        status: z.enum(["open", "resolved"]).optional(),
        limit: z.number().int().min(1).max(200).default(100),
      }),
    )
    .query(async ({ ctx, input }) => {
      return listThreadsForLeague({
        leagueId: ctx.league.id,
        teamId: input.teamId,
        weekNo: input.weekNo,
        status: input.status,
        limit: input.limit,
        viewer: await viewerFor(ctx),
      });
    }),

  /** One thread: chat history plus the proposals raised inside it. */
  getThread: leagueReadProcedure
    .input(z.object({ threadId: z.uuid() }))
    .query(async ({ ctx, input }) => {
      const thread = await getThread(input.threadId, { viewer: await viewerFor(ctx) });
      if (!thread || thread.leagueId !== ctx.league.id) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Thread not found" });
      }
      return thread;
    }),
});
