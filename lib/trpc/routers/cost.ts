/**
 * Cost dashboards. Every read is public within the league — spend is part of
 * the transparency contract (PRD 1.2, 5.9).
 */
import { z } from "zod";

import {
  benchmarkByModel,
  budgetStatus,
  costPerPoint,
  costPerWin,
  costTrendByWeek,
  leagueSpendByModel,
  leagueSpendByTeam,
  leagueSpendTotals,
  mostExpensiveRuns,
  teamSeasonSpend,
  teamWeekSpend,
} from "@/lib/services/cost";
import { leagueReadProcedure, router } from "@/lib/trpc/init";

export const costRouter = router({
  /** One team's panel: this week vs cap, season total, cost per point / win. */
  team: leagueReadProcedure
    .input(z.object({ teamId: z.uuid(), weekNo: z.number().int().min(1).max(30) }))
    .query(async ({ ctx, input }) => {
      const [week, season, perPoint, perWin, budget] = await Promise.all([
        teamWeekSpend(input.teamId, input.weekNo, ctx.db),
        teamSeasonSpend(input.teamId, ctx.db),
        costPerPoint(input.teamId, ctx.db),
        costPerWin(input.teamId, ctx.db),
        budgetStatus(input.teamId, input.weekNo, ctx.db),
      ]);
      return { week, season, costPerPoint: perPoint, costPerWin: perWin, budget };
    }),

  /** The league dashboard payload. */
  league: leagueReadProcedure
    .input(z.object({ limit: z.number().int().min(1).max(50).default(10) }))
    .query(async ({ ctx, input }) => {
      const [totals, byTeam, byModel, expensive, trend] = await Promise.all([
        leagueSpendTotals(ctx.league.id, ctx.db),
        leagueSpendByTeam(ctx.league.id, ctx.db),
        leagueSpendByModel(ctx.league.id, ctx.db),
        mostExpensiveRuns(ctx.league.id, input.limit, ctx.db),
        costTrendByWeek(ctx.league.id, ctx.db),
      ]);
      return { totals, byTeam, byModel, expensive, trend };
    }),

  /** Cost-adjusted performance by model across the league's teams. */
  benchmark: leagueReadProcedure.query(async ({ ctx }) => {
    return benchmarkByModel(ctx.league.id, ctx.db);
  }),
});
