/**
 * The only polls left in the system (migration plan §2.4).
 *
 * `vercel.json`'s two cron entries are gone. Window opens and closes, week
 * rollover, config unlock and draft progression are all `ctx.scheduler` jobs
 * hung off the rows they belong to; what remains here is the genuinely
 * clock-driven work — asking providers whether the world changed, and scoring
 * the games they report.
 *
 * Every target is an **internal mutation**, never an action: scheduled mutations
 * execute exactly once, scheduled actions are at-most-once
 * (docs/CONVEX_NOTES.md §5). Each of these mutations evaluates its Eastern-time
 * guard and then schedules the action or the per-league fan-out that does the
 * work, so a skipped tick costs one index read.
 *
 * Cron times are UTC and "at most one run of a given cron executes at a time;
 * overlapping runs are skipped rather than queued" (§6), which is exactly the
 * behaviour a poll wants.
 */
import { cronJobs } from "convex/server";

import { internal } from "./_generated/api";

const crons = cronJobs();

/**
 * Live scoring + week finalization. `season.tickAll` checks the indexed NFL
 * schedule; outside the bounded kickoff/finalization window it returns without
 * paging a single league.
 */
crons.interval("score in-season leagues", { minutes: 15 }, internal.season.tickAll, {});

/**
 * Projections and news. Sleeper's projections CDN caches for ten minutes
 * (docs/DATA_PROVIDERS.md), so fifteen is the tightest useful poll, and the
 * `player_projection_latest` vintage gate makes an unchanged feed free.
 */
crons.interval("ingest projections and news", { minutes: 15 }, internal.ingest.tick, {
  mode: "regular",
});

/** Live stats and game status while games are being played (guarded inside). */
crons.interval("ingest game-day stats", { minutes: 5 }, internal.ingest.tick, {
  mode: "gameday",
});

/**
 * The full universe once a day, including the 14.6 MB Sleeper player feed —
 * 09:00 UTC is the small hours in every US timezone. `minuteUTC` is omitted so
 * Convex spreads the load (§6).
 */
crons.daily("ingest full universe", { hourUTC: 9, minuteUTC: 17 }, internal.ingest.tick, {
  mode: "full",
});

export default crons;
