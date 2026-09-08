/**
 * League weeks.
 *
 * `currentWeekNo` is the port of `lib/services/views/league-home#currentWeekNo`:
 * the latest week whose `startsAt` has passed, defaulting to week 1 before the
 * season opens. The old version read every week row and folded; here the same
 * answer comes from one bounded range on `weeks.by_leagueId_startsAt`.
 */
import { v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import { internalQuery, query, type QueryCtx } from "./_generated/server";
import { requireLeagueRead } from "./lib/auth";

/** Latest week whose `startsAt` <= `now`, else the earliest week, else 1. */
export async function currentWeekNoFor(
  ctx: QueryCtx,
  leagueId: Id<"leagues">,
  now: number,
): Promise<number> {
  const started = await ctx.db
    .query("weeks")
    .withIndex("by_leagueId_startsAt", (q) => q.eq("leagueId", leagueId).lte("startsAt", now))
    .order("desc")
    .first();
  if (started) return started.weekNo;
  // Before the first week starts the old code clamped to 1.
  return 1;
}

export const currentWeekNo = query({
  args: { leagueId: v.id("leagues") },
  returns: v.number(),
  handler: async (ctx, { leagueId }) => {
    await requireLeagueRead(ctx, leagueId);
    return currentWeekNoFor(ctx, leagueId, Date.now());
  },
});

export const currentWeekNoInternal = internalQuery({
  args: { leagueId: v.id("leagues"), now: v.optional(v.number()) },
  returns: v.number(),
  handler: async (ctx, { leagueId, now }) => currentWeekNoFor(ctx, leagueId, now ?? Date.now()),
});

/** One week row by number, for the window materializer and the schedule pages. */
export const byNumber = internalQuery({
  args: { leagueId: v.id("leagues"), weekNo: v.number() },
  handler: async (ctx, { leagueId, weekNo }) =>
    ctx.db
      .query("weeks")
      .withIndex("by_leagueId_weekNo", (q) => q.eq("leagueId", leagueId).eq("weekNo", weekNo))
      .first(),
});
