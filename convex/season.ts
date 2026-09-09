/**
 * The season tick: live scoring, week finalization and the Commissioner Agent's
 * weekly duties (migration plan §2.4, "Scoring, standings, commissioner").
 *
 * This is all that survives of the old five-minute `/api/cron/tick`. Everything
 * else it did is now event-driven (window jobs, the week-rollover chain, the
 * draft chain, Workpool retries), but scoring genuinely is a poll: NFL stats
 * arrive from a provider on their own schedule, so somebody has to look.
 *
 * `crons.ts` calls `tickAll` every 15 minutes; the game-day guard lives here, in
 * a mutation, rather than in the cron schedule, because the source of truth is
 * the indexed NFL schedule rather than a fixed set of weekdays.
 */
import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { gameActivityBounds } from "./lib/game_calendar";
import { currentWeekNoFor } from "./weeks";

/** One page of in-season leagues per tick. */
const MAX_LEAGUES_PER_TICK = 200;

/**
 * Fan out one scoring mutation per in-season league.
 *
 * Deliberately tiny: it reads one index range and schedules; all the work
 * happens in `scoreOne`, one transaction per league, so no single mutation is
 * anywhere near the 1 s / 32k-document budget.
 */
export const tickAll = internalMutation({
  args: { now: v.optional(v.number()), force: v.optional(v.boolean()) },
  returns: v.object({ leagues: v.number(), skipped: v.boolean() }),
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    if (!args.force) {
      const { from, through } = gameActivityBounds(now);
      const scheduledGame = await ctx.db
        .query("nfl_games")
        .withIndex("by_kickoffAt", (q) =>
          q.gte("kickoffAt", from).lte("kickoffAt", through),
        )
        .first();
      if (!scheduledGame) return { leagues: 0, skipped: true };
    }

    const leagues = await ctx.db
      .query("leagues")
      .withIndex("by_status", (q) => q.eq("status", "in_season"))
      .take(MAX_LEAGUES_PER_TICK);

    for (const league of leagues) {
      await ctx.scheduler.runAfter(0, internal.season.scoreOne, {
        leagueId: league._id,
        now,
      });
    }
    return { leagues: leagues.length, skipped: false };
  },
});

/**
 * Score one league's active week, finalize it when every NFL game is done, and
 * hand the week to the Commissioner Agent exactly once.
 *
 * `scoring.finalizeWeek` is idempotent and keeps returning `finalized: true`
 * once the games are final, so the "did we already do this?" question is
 * answered by the week's own status *before* the call — otherwise a recap would
 * be posted every fifteen minutes for the rest of the week.
 */
export const scoreOne = internalMutation({
  args: { leagueId: v.id("leagues"), now: v.optional(v.number()) },
  returns: v.object({
    weekNo: v.number(),
    scored: v.boolean(),
    finalized: v.boolean(),
    commissionerScheduled: v.boolean(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    weekNo: number;
    scored: boolean;
    finalized: boolean;
    commissionerScheduled: boolean;
  }> => {
    const now = args.now ?? Date.now();
    const league = await ctx.db.get("leagues", args.leagueId);
    if (!league || league.status !== "in_season") {
      return { weekNo: 0, scored: false, finalized: false, commissionerScheduled: false };
    }
    const weekNo = await currentWeekNoFor(ctx, args.leagueId, now);

    const week = await ctx.db
      .query("weeks")
      .withIndex("by_leagueId_weekNo", (q) =>
        q.eq("leagueId", args.leagueId).eq("weekNo", weekNo),
      )
      .first();
    const alreadyComplete = week?.status === "complete";

    await ctx.runMutation(internal.scoring.scoreLeague, { leagueId: args.leagueId, weekNo });
    const result = await ctx.runMutation(internal.scoring.finalizeWeek, {
      leagueId: args.leagueId,
      weekNo,
    });

    let commissionerScheduled = false;
    if (result.finalized && !alreadyComplete) {
      // Recap + power rankings + flagged-trade digest (PRD 5.10). An action, so
      // a model outage can never roll back the scoring it followed.
      await ctx.scheduler.runAfter(0, internal.commissioner_agent.runWeekly, {
        leagueId: args.leagueId,
        weekNo,
      });
      commissionerScheduled = true;

      const rules = await ctx.db
        .query("league_rules")
        .withIndex("by_leagueId", (q) => q.eq("leagueId", args.leagueId))
        .unique();
      if (rules && weekNo >= rules.seasonWeeks) {
        await ctx.scheduler.runAfter(0, internal.commissioner_agent.seasonAwards, {
          leagueId: args.leagueId,
        });
      }
    }

    return { weekNo, scored: true, finalized: result.finalized, commissionerScheduled };
  },
});
