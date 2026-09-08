/**
 * Which ingest set the 15-minute cron should run, chosen from the clock.
 *
 * PRD §6.2 asks for "every 15 minutes (every 5 on game days)". Vercel cron
 * granularity is fixed per entry, so instead of two schedules we keep one and
 * vary the *work*: during live games only stats and news are pulled (cheap,
 * high-value), and the full universe is rebuilt once a week on Tuesday morning,
 * right as the new league week opens.
 */
import { toET } from "@/lib/time";

export type IngestPlan = {
  players: boolean;
  schedule: boolean;
  projections: boolean;
  stats: boolean;
  news: boolean;
  ownership: boolean;
  reason: "game_day" | "weekly_rebuild" | "routine" | "manual_all";
};

/**
 * Game-day awareness, in Eastern time:
 *  - Thu 19:00+, Sun 12:00+, Mon 19:00+ (and the overnight tails) -> live games.
 *  - Tue 05:00-09:00 -> the weekly rebuild.
 */
export function planFor(now: Date): IngestPlan {
  const et = toET(now);
  const day = et.getDay();
  const hour = et.getHours();

  const liveGames =
    (day === 4 && hour >= 19) ||
    (day === 0 && hour >= 12) ||
    (day === 1 && hour >= 19) ||
    // Overnight tails of the Sunday and Monday night games.
    (day === 1 && hour < 3) ||
    (day === 2 && hour < 3);

  if (liveGames) {
    return {
      players: false,
      schedule: true,
      projections: false,
      stats: true,
      news: true,
      ownership: false,
      reason: "game_day",
    };
  }
  if (day === 2 && hour >= 5 && hour < 9) {
    return {
      players: true,
      schedule: true,
      projections: true,
      stats: true,
      news: true,
      ownership: true,
      reason: "weekly_rebuild",
    };
  }
  return {
    players: false,
    schedule: false,
    projections: true,
    stats: false,
    news: true,
    ownership: false,
    reason: "routine",
  };
}

export function fullIngestPlan(): IngestPlan {
  return {
    players: true,
    schedule: true,
    projections: true,
    stats: true,
    news: true,
    ownership: true,
    reason: "manual_all",
  };
}
