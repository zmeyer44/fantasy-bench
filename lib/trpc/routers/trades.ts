/**
 * Trades router: the negotiation feed, one trade, and the human veto vote.
 *
 * Reads are `leagueReadProcedure` (spectators may watch a public league);
 * voting is `leagueMemberProcedure` and the service re-checks that the voter is
 * an owner rather than a spectator.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { castVetoVote, getTrade, listTradesForLeague } from "@/lib/services/trades";
import { leagueMemberProcedure, leagueReadProcedure, router } from "@/lib/trpc/init";

const tradeStatusSchema = z.enum([
  "proposed",
  "countered",
  "accepted",
  "rejected",
  "expired",
  "in_review",
  "vetoed",
  "completed",
  "cancelled",
]);

export const tradesRouter = router({
  /** League-wide negotiation feed, filterable by team, week and status. */
  list: leagueReadProcedure
    .input(
      z.object({
        teamId: z.uuid().optional(),
        weekNo: z.number().int().min(0).max(30).optional(),
        status: tradeStatusSchema.optional(),
        limit: z.number().int().min(1).max(200).default(100),
      }),
    )
    .query(async ({ ctx, input }) => {
      return listTradesForLeague({
        leagueId: ctx.league.id,
        teamId: input.teamId,
        weekNo: input.weekNo,
        status: input.status,
        limit: input.limit,
      });
    }),

  /** One trade with its event timeline, fairness breakdown and veto tally. */
  get: leagueReadProcedure
    .input(z.object({ tradeId: z.uuid() }))
    .query(async ({ ctx, input }) => {
      const trade = await getTrade(input.tradeId);
      if (!trade || trade.leagueId !== ctx.league.id) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Trade not found" });
      }
      return trade;
    }),

  /** Owners block a flagged trade by majority. `approve` is an explicit no-veto. */
  castVeto: leagueMemberProcedure
    .input(z.object({ tradeId: z.uuid(), vote: z.enum(["veto", "approve"]) }))
    .mutation(async ({ ctx, input }) => {
      const trade = await getTrade(input.tradeId);
      if (!trade || trade.leagueId !== ctx.league.id) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Trade not found" });
      }
      const result = await castVetoVote({
        tradeId: input.tradeId,
        userId: ctx.user.id,
        vote: input.vote,
      });
      if (!result.ok) {
        throw new TRPCError({ code: "BAD_REQUEST", message: result.errors.join("; ") });
      }
      return result;
    }),
});
