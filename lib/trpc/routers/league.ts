import { TRPCError } from "@trpc/server";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";

import { teams } from "@/lib/db/schema";
import {
  createLeague,
  joinLeague,
  listLeaguesForUser,
  MAX_TEAMS,
  MIN_TEAMS,
} from "@/lib/services/league";
import {
  leagueReadProcedure,
  protectedProcedure,
  router,
} from "@/lib/trpc/init";

export const createLeagueSchema = z.object({
  name: z.string().min(3).max(60),
  teamCount: z.number().int().min(MIN_TEAMS).max(MAX_TEAMS).default(12),
  scoringPreset: z.enum(["ppr", "half_ppr", "standard"]).default("ppr"),
  draftType: z.enum(["snake", "auction"]).default("snake"),
  isPublic: z.boolean().default(true),
  superflex: z.boolean().default(false),
  tePremium: z.boolean().default(false),
  faabBudget: z.number().int().min(0).max(1000).default(100),
});

export const leagueRouter = router({
  /** Create a league skeleton and return it (the caller redirects to it). */
  create: protectedProcedure
    .input(createLeagueSchema)
    .mutation(async ({ ctx, input }) => {
      const { league } = await createLeague({
        ...input,
        commissionerUserId: ctx.user.id,
      });
      return league;
    }),

  /** League header data. Public leagues are readable without membership. */
  get: leagueReadProcedure.query(async ({ ctx }) => {
    const leagueTeams = await ctx.db
      .select()
      .from(teams)
      .where(eq(teams.leagueId, ctx.league.id))
      .orderBy(asc(teams.waiverPriority));

    return {
      league: ctx.league,
      teams: leagueTeams,
      membership: ctx.membership,
    };
  }),

  /** Every league the signed-in user belongs to. */
  listMine: protectedProcedure.query(async ({ ctx }) => {
    return listLeaguesForUser(ctx.user.id, ctx.db);
  }),

  /** Join a public league and claim the first unowned team. */
  join: protectedProcedure
    .input(z.object({ leagueId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const league = await ctx.db.query.leagues.findFirst({
        where: (l, { eq: equals }) => equals(l.id, input.leagueId),
      });
      if (!league) throw new TRPCError({ code: "NOT_FOUND", message: "League not found" });
      if (!league.isPublic) {
        throw new TRPCError({ code: "FORBIDDEN", message: "This league is invite-only" });
      }
      return joinLeague(input.leagueId, ctx.user.id, ctx.db);
    }),
});
