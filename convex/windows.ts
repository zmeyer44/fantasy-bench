/**
 * Decision windows (PRD §5.3): what is open now, what opens next, the grid for a
 * week, and the idempotent materializer that turns templates into rows.
 *
 * Port of `lib/services/views/windows.ts` + `lib/scheduler/materialize.ts`. The
 * old view counted runs with a correlated sub-query per row; here the counts are
 * denormalised onto the window (`runCount`, `terminalRunCount`), maintained by
 * the dispatch/persist/close mutations in Phase 5.
 *
 * Phase 5 adds `openJobId` / `closeJobId` scheduling to `materializeWindows`;
 * this phase only writes the rows.
 */
import { v } from "convex/values";

import type { WindowView as LegacyWindowView } from "../lib/services/views/windows";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, query, type QueryCtx } from "./_generated/server";
import { requireLeagueRead } from "./lib/auth";
import { resolveWindowsForWeek, type WindowOverrides } from "./lib/templates";
import { countdown, windowLabelText } from "./lib/views_shared";

/** The old `WindowView` with epoch-ms dates, plus the denormalised terminal count. */
export type WindowView = Omit<
  LegacyWindowView,
  "id" | "opensAt" | "submissionDeadlineAt" | "closesAt" | "snapshotId"
> & {
  id: Id<"windows">;
  opensAt: number;
  submissionDeadlineAt: number;
  closesAt: number;
  snapshotId: Id<"snapshots"> | null;
  terminalRunCount: number;
};

export type WindowSchedule = {
  /** Windows whose open/close bracket `now`. */
  open: WindowView[];
  /** The next few windows that have not opened yet. */
  upcoming: WindowView[];
  /** The single headline window for the league header countdown. */
  next: WindowView | null;
};

export function decorate(row: Doc<"windows">, now: number): WindowView {
  const phase = now < row.opensAt ? "upcoming" : now >= row.closesAt ? "past" : ("open" as const);
  return {
    id: row._id,
    type: row.type,
    label: row.label,
    labelText: windowLabelText(row.label),
    weekNo: row.weekNo,
    roundNo: row.roundNo,
    opensAt: row.opensAt,
    submissionDeadlineAt: row.submissionDeadlineAt,
    closesAt: row.closesAt,
    status: row.status,
    snapshotId: row.snapshotId ?? null,
    runCount: row.runCount,
    terminalRunCount: row.terminalRunCount,
    phase,
    countdown:
      phase === "upcoming"
        ? countdown(now, row.opensAt)
        : phase === "open"
          ? countdown(now, row.closesAt)
          : "closed",
  };
}

/** Every window for a week, in schedule order. */
export async function windowsForWeek(
  ctx: QueryCtx,
  leagueId: Id<"leagues">,
  weekNo: number,
  now: number,
): Promise<WindowView[]> {
  // Bounded: one league week materialises ~18 windows.
  const rows = await ctx.db
    .query("windows")
    .withIndex("by_leagueId_weekNo_type", (q) => q.eq("leagueId", leagueId).eq("weekNo", weekNo))
    .collect();
  return rows
    .sort((a, b) => a.opensAt - b.opensAt || a.roundNo - b.roundNo)
    .map((row) => decorate(row, now));
}

export const forWeek = query({
  args: { leagueId: v.id("leagues"), weekNo: v.number() },
  handler: async (ctx, { leagueId, weekNo }): Promise<WindowView[]> => {
    await requireLeagueRead(ctx, leagueId);
    return windowsForWeek(ctx, leagueId, weekNo, Date.now());
  },
});

/**
 * Currently-open + next-opening windows (the league header countdown).
 *
 * The old query was `closesAt >= now`, which no index can serve. Two bounded
 * reads over `by_leagueId_opensAt` give the same answer: the 20 most recently
 * opened windows (a window never spans more than a day, so 20 covers every one
 * that can still be open) and the next `limit * 3` that have not opened.
 */
export async function windowSchedule(
  ctx: QueryCtx,
  leagueId: Id<"leagues">,
  now: number,
  limit = 4,
): Promise<WindowSchedule> {
  const recent = await ctx.db
    .query("windows")
    .withIndex("by_leagueId_opensAt", (q) => q.eq("leagueId", leagueId).lte("opensAt", now))
    .order("desc")
    .take(20);
  const ahead = await ctx.db
    .query("windows")
    .withIndex("by_leagueId_opensAt", (q) => q.eq("leagueId", leagueId).gt("opensAt", now))
    .take(limit * 3);

  const open = recent
    .filter((row) => row.closesAt > now)
    .sort((a, b) => a.opensAt - b.opensAt || a.roundNo - b.roundNo)
    .map((row) => decorate(row, now));
  const upcoming = ahead
    .sort((a, b) => a.opensAt - b.opensAt || a.roundNo - b.roundNo)
    .slice(0, limit)
    .map((row) => decorate(row, now));
  return { open, upcoming, next: open[0] ?? upcoming[0] ?? null };
}

export const schedule = query({
  args: { leagueId: v.id("leagues"), limit: v.optional(v.number()) },
  handler: async (ctx, { leagueId, limit }): Promise<WindowSchedule> => {
    await requireLeagueRead(ctx, leagueId);
    return windowSchedule(ctx, leagueId, Date.now(), limit ?? 4);
  },
});

/**
 * Create every `windows` row for one league week.
 *
 * Idempotent by construction: `by_leagueId_label_weekNo_roundNo` is the dedupe
 * key, so calling this repeatedly is free and a window that has already opened
 * is never rewritten underneath a running agent.
 */
export const materializeWindows = internalMutation({
  args: { leagueId: v.id("leagues"), weekNo: v.number() },
  returns: v.object({ weekNo: v.number(), created: v.number(), existing: v.number() }),
  handler: async (ctx, { leagueId, weekNo }) => {
    const week = await ctx.db
      .query("weeks")
      .withIndex("by_leagueId_weekNo", (q) => q.eq("leagueId", leagueId).eq("weekNo", weekNo))
      .first();
    if (!week) return { weekNo, created: 0, existing: 0 };

    const rules = await ctx.db
      .query("league_rules")
      .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
      .unique();

    const resolved = resolveWindowsForWeek(
      week.startsAt,
      (rules?.windowOverrides ?? null) as WindowOverrides | null,
    );

    let created = 0;
    let existing = 0;
    for (const window of resolved) {
      const already = await ctx.db
        .query("windows")
        .withIndex("by_leagueId_label_weekNo_roundNo", (q) =>
          q
            .eq("leagueId", leagueId)
            .eq("label", window.label)
            .eq("weekNo", weekNo)
            .eq("roundNo", window.roundNo),
        )
        .first();
      if (already) {
        existing++;
        continue;
      }
      await ctx.db.insert("windows", {
        leagueId,
        type: window.type,
        label: window.label,
        weekNo,
        roundNo: window.roundNo,
        opensAt: window.opensAt,
        submissionDeadlineAt: window.submissionDeadlineAt,
        closesAt: window.closesAt,
        status: "scheduled",
        scope: window.scope,
        runCount: 0,
        terminalRunCount: 0,
      });
      created++;
    }
    return { weekNo, created, existing };
  },
});
