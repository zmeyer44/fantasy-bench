/**
 * Season / week arithmetic, ported verbatim from `lib/services/league/create.ts`
 * (`seasonWeek1Start`, `weekBoundaries`) with epoch-millisecond returns.
 *
 * `lib/time.ts` is a pure module (ET helpers over `@date-fns/tz`) and is imported
 * directly — nothing here touches Drizzle.
 */
import { fromET, nextWeekdayAtET } from "@/lib/time";

/** A league always gets 17 weeks (PRD 5.1). */
export const SEASON_WEEKS = 17;
export const MIN_TEAMS = 8;
export const MAX_TEAMS = 14;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Tuesday 06:00 ET after Labor Day (the first Monday of September) for a season.
 * 2024 -> Tue Sep 3 · 2025 -> Tue Sep 2 · 2026 -> Tue Sep 8.
 */
export function seasonWeek1Start(season: number): number {
  // `nextWeekdayAtET` is on-or-after, so a September 1 Monday counts as Labor Day.
  const septemberFirst = fromET({ year: season, month: 9, day: 1, hour: 0, minute: 0 });
  const laborDay = nextWeekdayAtET(septemberFirst, "mon", 0, 0);
  return nextWeekdayAtET(laborDay, "tue", 6, 0).getTime();
}

/**
 * Week `weekNo`'s [startsAt, endsAt) in epoch ms. Weeks are 7 days long and the
 * Tuesday 06:00 ET boundary is the waiver-open instant (ARCHITECTURE.md).
 * Pass `week1StartMs` to anchor to a known kickoff instead.
 */
export function weekBoundaries(
  season: number,
  weekNo: number,
  week1StartMs?: number,
): { startsAt: number; endsAt: number } {
  const anchor = week1StartMs ?? seasonWeek1Start(season);
  const startsAt = anchor + (weekNo - 1) * WEEK_MS;
  return { startsAt, endsAt: startsAt + WEEK_MS };
}

/** Default season = current year (NFL seasons are named for their September). */
export function currentSeason(nowMs: number = Date.now()): number {
  return new Date(nowMs).getUTCFullYear();
}

/** `My Cool League` -> `my-cool-league`. */
export function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/[\s_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "league"
  );
}

/** `Injury-aware lineups` -> `injury-aware-lineups` (skills allow a longer slug). */
export function slugifySkill(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/[\s_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "skill"
  );
}

/** Team names for an unowned league skeleton: "Team 1" … "Team N". */
export function defaultTeamName(index: number): string {
  return `Team ${index + 1}`;
}

/** `Team 1` -> `T1`, `Team 12` -> `T12`. Unique within a league by construction. */
export function defaultTeamAbbreviation(index: number): string {
  return `T${index + 1}`;
}
