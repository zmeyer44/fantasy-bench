import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { etInstant, templateByLabel, weekdayIndex } from "./templates";

/**
 * The weekly lineup lock is the close of the `lineup_weekly` template (Wednesday
 * 19:00 Eastern by default), computed on the ET calendar so DST does not move
 * it. Reading the template keeps this and `resolveWindowsForWeek` in step.
 *
 * The anchor's calendar date is used, not its instant: existing seasons may
 * have stored a 05:00 Tuesday anchor after a UTC-based DST rollover.
 */
export function weeklyLineupDeadline(weekStartsAt: number): number {
  const template = templateByLabel("lineup_weekly");
  if (!template) throw new Error("lineup_weekly window template is missing");
  const daysFromTuesday = (weekdayIndex(template.closesDay) - weekdayIndex("tue") + 7) % 7;
  return etInstant(weekStartsAt, daysFromTuesday, template.closesTime);
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
