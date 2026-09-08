/**
 * League weeks.
 *
 * `currentWeekNo`:
 * the latest week whose `startsAt` has passed, defaulting to week 1 before the
 * season opens. The old version read every week row and folded; here the same
 * answer comes from one bounded range on `weeks.by_leagueId_startsAt`.
 */
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, query, type QueryCtx } from "./_generated/server";
import { requireLeagueRead } from "./lib/auth";
import type { EditLockConfig } from "./lib/defaults";
import { nextWeekdayAtET, parseHhMm, type Weekday } from "./lib/templates";
import { weekStatus } from "./schema";

/**
 * Bound for the one bounded read below: a season is 18 regular-season weeks
 * plus playoffs, and the seed materialises one row per week, so 22 covers every
 * league the rules allow (`seasonWeeks` is capped at 18 + 4 playoff rounds).
 */
const MAX_WEEKS = 22;

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

/**
 * Every week row of a league, ascending — the source of truth for the week
 * pickers (matchups) and week filters (traces), which used to derive
 * `1..rules.seasonWeeks` because no query listed the rows.
 */
export const list = query({
  args: { leagueId: v.id("leagues") },
  returns: v.array(
    v.object({
      weekNo: v.number(),
      startsAt: v.number(),
      endsAt: v.number(),
      status: weekStatus,
      isPlayoff: v.boolean(),
    }),
  ),
  handler: async (ctx, { leagueId }) => {
    await requireLeagueRead(ctx, leagueId);
    // Bounded by construction: one row per week of one season (<= MAX_WEEKS).
    const rows = await ctx.db
      .query("weeks")
      .withIndex("by_leagueId_weekNo", (q) => q.eq("leagueId", leagueId))
      .take(MAX_WEEKS);
    return rows.map((week) => ({
      weekNo: week.weekNo,
      startsAt: week.startsAt,
      endsAt: week.endsAt,
      status: week.status,
      isPlayoff: week.isPlayoff,
    }));
  },
});

// =====================================================================
// Phase 5b — week rollover
// =====================================================================

/**
 * The instant the config edit window next opens, at or after `from`.
 *
 * `league_rules.editLock` is a recurring Eastern wall-clock window
 * (`lib/time#EditLock`); the unlock boundary is what promotes every team's
 * pending config version (PRD 5.7), so it gets its own scheduled job per week
 * rather than being polled by a cron.
 */
export function nextUnlockInstant(from: number, editLock: EditLockConfig): number {
  const { hh, mm } = parseHhMm(editLock.unlockTime);
  return nextWeekdayAtET(from, editLock.unlockDay as Weekday, hh, mm);
}

/**
 * Roll the league into `weekNo`.
 *
 * Scheduled at every week's `startsAt` (Tuesday 06:00 ET, the waiver-open
 * instant) and chained: each rollover schedules the next one. It replaces four
 * jobs the old five-minute tick did every five minutes for every league —
 * materialising this week's and next week's windows, marking week statuses,
 * applying queued config edits at the unlock boundary, and keeping the chain
 * alive.
 */
export const rollover = internalMutation({
  args: { leagueId: v.id("leagues"), weekNo: v.number(), now: v.optional(v.number()) },
  returns: v.object({
    weekNo: v.number(),
    materialized: v.number(),
    nextRolloverAt: v.union(v.null(), v.number()),
    unlockAt: v.union(v.null(), v.number()),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    weekNo: number;
    materialized: number;
    nextRolloverAt: number | null;
    unlockAt: number | null;
  }> => {
    const now = args.now ?? Date.now();
    const league = await ctx.db.get("leagues", args.leagueId);
    if (!league) {
      return { weekNo: args.weekNo, materialized: 0, nextRolloverAt: null, unlockAt: null };
    }

    // (1) This week's and next week's windows, with their open/close jobs.
    let materialized = 0;
    for (const weekNo of [args.weekNo, args.weekNo + 1]) {
      const result = await ctx.runMutation(internal.windows.materializeWindows, {
        leagueId: args.leagueId,
        weekNo,
      });
      materialized += result.created;
    }

    // (2) Week statuses. Bounded: one row per week of one season.
    const weeks = await ctx.db
      .query("weeks")
      .withIndex("by_leagueId_weekNo", (q) => q.eq("leagueId", args.leagueId))
      .take(MAX_WEEKS);
    const current = weeks.find((week) => week.weekNo === args.weekNo);
    for (const week of weeks) {
      if (week.endsAt <= now && week.status !== "complete") {
        await ctx.db.patch("weeks", week._id, { status: "complete" });
      } else if (week.weekNo === args.weekNo && week.status === "upcoming") {
        await ctx.db.patch("weeks", week._id, { status: "active" });
      }
    }

    const rules = await ctx.db
      .query("league_rules")
      .withIndex("by_leagueId", (q) => q.eq("leagueId", args.leagueId))
      .unique();

    // (3) The config edit-lock unlock boundary for this week.
    let unlockAt: number | null = null;
    if (current && rules) {
      if (current.unlockJobId) await ctx.scheduler.cancel(current.unlockJobId);
      unlockAt = nextUnlockInstant(current.startsAt, rules.editLock as EditLockConfig);
      const unlockJobId = await ctx.scheduler.runAt(
        Math.max(unlockAt, now),
        internal.configs.applyPending,
        { leagueId: args.leagueId },
      );
      await ctx.db.patch("weeks", current._id, { unlockJobId, rolloverJobId: undefined });
    }

    // (4) Chain: the next week's rollover, stored on the week it rolls into.
    let nextRolloverAt: number | null = null;
    const next = weeks.find((week) => week.weekNo === args.weekNo + 1);
    if (next) {
      if (next.rolloverJobId) await ctx.scheduler.cancel(next.rolloverJobId);
      nextRolloverAt = next.startsAt;
      const rolloverJobId = await ctx.scheduler.runAt(
        Math.max(next.startsAt, now),
        internal.weeks.rollover,
        { leagueId: args.leagueId, weekNo: next.weekNo },
      );
      await ctx.db.patch("weeks", next._id, { rolloverJobId });
    }

    return { weekNo: args.weekNo, materialized, nextRolloverAt, unlockAt };
  },
});

/**
 * Start the rollover chain for a league entering `in_season`.
 *
 * Called by `internal.draft_progression.onPickWindowClosed` right after
 * `internal.draft.finalize` (which is what writes the `weeks` rows). A league
 * that skips the draft entirely must call this from `leagues.create` /
 * `commissioner.startDraft` — see the Phase 5b report.
 *
 * Idempotent: it cancels whatever chain is already armed before arming a new one.
 */
export const scheduleSeason = internalMutation({
  args: { leagueId: v.id("leagues"), now: v.optional(v.number()) },
  returns: v.object({ weekNo: v.union(v.null(), v.number()), startsAt: v.union(v.null(), v.number()) }),
  handler: async (ctx, args): Promise<{ weekNo: number | null; startsAt: number | null }> => {
    const now = args.now ?? Date.now();
    // Bounded: one row per week of one season.
    const weeks = await ctx.db
      .query("weeks")
      .withIndex("by_leagueId_weekNo", (q) => q.eq("leagueId", args.leagueId))
      .take(MAX_WEEKS);
    if (weeks.length === 0) return { weekNo: null, startsAt: null };

    // Cancel any chain a previous call armed, so this stays idempotent.
    for (const week of weeks) {
      if (week.rolloverJobId) {
        await ctx.scheduler.cancel(week.rolloverJobId);
        await ctx.db.patch("weeks", week._id, { rolloverJobId: undefined });
      }
    }

    const started = weeks.filter((week) => week.startsAt <= now);
    const target = started.length > 0 ? started[started.length - 1] : weeks[0];
    const rolloverJobId = await ctx.scheduler.runAt(
      Math.max(target.startsAt, now),
      internal.weeks.rollover,
      { leagueId: args.leagueId, weekNo: target.weekNo },
    );
    await ctx.db.patch("weeks", target._id, { rolloverJobId });
    return { weekNo: target.weekNo, startsAt: target.startsAt };
  },
});
