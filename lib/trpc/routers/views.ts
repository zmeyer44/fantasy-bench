/**
 * Public read models over `lib/services/views`.
 *
 * Everything is `leagueReadProcedure`: members always pass, and non-members
 * pass for public leagues (spectator mode, PRD 5.11).
 */
import { z } from "zod";

import {
  draftBoard,
  leagueHome,
  matchupPage,
  matchupsForWeek,
  standings,
  teamCards,
  teamPage,
  waiverResults,
  windowSchedule,
  windowsForWeek,
} from "@/lib/services/views";
import { leagueReadProcedure, router } from "@/lib/trpc/init";

export const viewsRouter = router({
  home: leagueReadProcedure.query(async ({ ctx }) =>
    leagueHome(ctx.league.id, {
      userId: ctx.user?.id ?? null,
      isMember: Boolean(ctx.membership),
      isCommissioner: ctx.membership?.role === "commissioner",
    }),
  ),

  standings: leagueReadProcedure.query(async ({ ctx }) => standings(ctx.league.id)),

  teams: leagueReadProcedure.query(async ({ ctx }) => teamCards(ctx.league.id)),

  team: leagueReadProcedure
    .input(z.object({ teamId: z.uuid() }))
    .query(async ({ input }) => teamPage(input.teamId)),

  matchups: leagueReadProcedure
    .input(z.object({ weekNo: z.number().int().min(1).max(18) }))
    .query(async ({ ctx, input }) => matchupsForWeek(ctx.league.id, input.weekNo)),

  matchup: leagueReadProcedure
    .input(z.object({ weekNo: z.number().int().min(1).max(18), matchupId: z.uuid() }))
    .query(async ({ ctx, input }) =>
      matchupPage(ctx.league.id, input.weekNo, input.matchupId),
    ),

  /** Polled every 15s by the draft page while the league is `drafting`. */
  draftBoard: leagueReadProcedure.query(async ({ ctx }) => draftBoard(ctx.league.id)),

  waivers: leagueReadProcedure
    .input(z.object({ weekNo: z.number().int().min(1).max(18) }))
    .query(async ({ ctx, input }) => waiverResults(ctx.league.id, input.weekNo)),

  windowsForWeek: leagueReadProcedure
    .input(z.object({ weekNo: z.number().int().min(1).max(18) }))
    .query(async ({ ctx, input }) => windowsForWeek(ctx.league.id, input.weekNo)),

  windowSchedule: leagueReadProcedure.query(async ({ ctx }) => windowSchedule(ctx.league.id)),
});
