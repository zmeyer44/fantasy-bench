import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { fromETParts, toETParts } from "./templates";

/** Wednesday 19:00 Eastern in the league week, including DST transitions. */
export function weeklyLineupDeadline(weekStartsAt: number): number {
  const anchor = toETParts(weekStartsAt);
  // Existing seasons may have stored a 05:00 Tuesday anchor after a UTC-based
  // DST rollover. Use the week row's calendar date, not a previous 06:00 instant.
  const daysUntilWednesday = (3 - anchor.weekday + 7) % 7;
  return fromETParts({ year: anchor.year, month: anchor.month, day: anchor.day + daysUntilWednesday, hour: 19 });
}

export async function lineupDeadlineFor(
  ctx: QueryCtx, leagueId: Id<"leagues">, weekNo: number,
): Promise<number | null> {
  const week = await ctx.db.query("weeks")
    .withIndex("by_leagueId_weekNo", (q) => q.eq("leagueId", leagueId).eq("weekNo", weekNo)).first();
  return week ? weeklyLineupDeadline(week.startsAt) : null;
}

export async function isWeeklyLineupLocked(
  ctx: QueryCtx, leagueId: Id<"leagues">, weekNo: number, now: number,
): Promise<boolean> {
  const deadline = await lineupDeadlineFor(ctx, leagueId, weekNo);
  return deadline !== null && now >= deadline;
}
