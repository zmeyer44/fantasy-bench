/**
 * Decision windows (PRD §5.3): what is open now, what opens next, the grid for a
 * week, and the idempotent materializer that turns templates into rows.
 *
 * Window reads plus materialisation. The
 * old view counted runs with a correlated sub-query per row; here the counts are
 * denormalised onto the window (`runCount`, `terminalRunCount`), maintained by
 * the dispatch/persist/close mutations in Phase 5.
 *
 * Phase 5 adds `openJobId` / `closeJobId` scheduling to `materializeWindows`;
 * this phase only writes the rows.
 */
import { v } from "convex/values";

import { leagueDefaultModelId } from "../lib/models";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { requireLeagueRead } from "./lib/auth";
import { appError } from "./lib/errors";
import { resolveWindowsForWeek, type WindowOverrides } from "./lib/templates";
import { countdown, windowLabelText } from "./lib/views_shared";
import { enqueueRun } from "./runs";
import { cancelWindowJobs, rescheduleWindow, scheduleWindowJobs } from "./scheduling";
import { weeklyLineupDeadline } from "./lib/lineup_deadline";

/** One decision window as the UI reads it (dates are epoch ms). */
export type WindowView = {
  id: Id<"windows">;
  type: Doc<"windows">["type"];
  label: string;
  labelText: string;
  weekNo: number | null;
  roundNo: number;
  opensAt: number;
  submissionDeadlineAt: number;
  closesAt: number;
  status: Doc<"windows">["status"];
  snapshotId: Id<"snapshots"> | null;
  runCount: number;
  terminalRunCount: number;
  /** Human countdown to the next state change, relative to `now`. */
  countdown: string;
  phase: "past" | "open" | "upcoming";
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
    const now = Date.now();
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
      const windowId = await ctx.db.insert("windows", {
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
      // Phase 5: the row and its two scheduled jobs commit together.
      await scheduleWindowJobs(ctx, windowId, now);
      created++;
    }
    return { weekNo, created, existing };
  },
});

// =====================================================================
// Phase 5b — the window lifecycle
// =====================================================================

/** `dispatch` polls the snapshot this often, this many times (5 min of headroom). */
const DISPATCH_POLL_MS = 5_000;
const MAX_DISPATCH_ATTEMPTS = 60;

/** Bounded by construction: one run per team per window, ≤ 14 teams. */
const MAX_RUNS_PER_WINDOW = 64;

/** Trade windows split into at most `rounds` siblings; 8 covers every override. */
const MAX_TRADE_SIBLINGS = 16;

/**
 * Tests (and the `convex-test` harness, which has no Workpool component
 * registered) set `RUN_DISPATCH=skip` so `dispatch` creates the run documents
 * without enqueueing them. Production never sets it.
 */
function dispatchDisabled(): boolean {
  return process.env.RUN_DISPATCH === "skip";
}

async function rulesOf(ctx: QueryCtx, leagueId: Id<"leagues">): Promise<Doc<"league_rules"> | null> {
  return ctx.db
    .query("league_rules")
    .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
    .unique();
}

/** Bounded by construction: 8–14 teams per league (`convex/lib/season.ts`). */
async function teamsOf(ctx: QueryCtx, leagueId: Id<"leagues">): Promise<Doc<"teams">[]> {
  return ctx.db
    .query("teams")
    .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
    .collect();
}

/**
 * Which teams get a run in this window.
 *
 * Commissioner windows are the league's own business and create none. A snake
 * pick window belongs to the team on the clock; an auction nomination window to
 * the nominating team; an auction bidding window to everybody (sealed bids).
 */
async function teamIdsForWindow(
  ctx: QueryCtx,
  window: Doc<"windows">,
): Promise<Id<"teams">[]> {
  if (window.type === "commissioner") return [];
  if (window.type === "draft") {
    const single = window.scope.onTheClockTeamId ?? window.scope.nominationTeamId;
    if (single) return [single];
  }
  return (await teamsOf(ctx, window.leagueId)).map((team) => team._id);
}

/**
 * `modelId` + `configVersionId` per team.
 *
 * `assignmentsForTeams`: the team's applied config
 * version decides, and a team with no config at all falls back to the league's
 * first allowlisted model so it still gets a run.
 */
async function assignmentsFor(
  ctx: MutationCtx,
  leagueId: Id<"leagues">,
  teamIds: Id<"teams">[],
): Promise<Array<{ teamId: Id<"teams">; modelId: string; configVersionId?: Id<"config_versions"> }>> {
  const rules = await rulesOf(ctx, leagueId);
  const leagueDefault = leagueDefaultModelId(rules?.modelAllowlist);
  const out: Array<{
    teamId: Id<"teams">;
    modelId: string;
    configVersionId?: Id<"config_versions">;
  }> = [];
  for (const teamId of teamIds) {
    const version = await ctx.runQuery(internal.configs.currentForTeam, { teamId });
    out.push({
      teamId,
      modelId: version?.modelId || leagueDefault,
      configVersionId: version?._id,
    });
  }
  return out;
}

// ------------------------------------------------------------------- open

/**
 * Open a window: freeze a snapshot and hand the runs to `dispatch`.
 *
 * Idempotent on `status`: a duplicate job (a reschedule race, a manual
 * `openNow`) finds the window already `open` and does nothing. The snapshot is
 * inserted here, `building`, so the window is bound to it immediately even if
 * the build action dies — `dispatch` then still creates the runs and lets
 * `onComplete` fail them, which is what makes the close fallbacks apply
 * (migration plan §4, "fail safe").
 */
export const open = internalMutation({
  args: { windowId: v.id("windows"), now: v.optional(v.number()) },
  returns: v.object({
    opened: v.boolean(),
    snapshotId: v.union(v.null(), v.id("snapshots")),
    reusedSnapshot: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const window = await ctx.db.get("windows", args.windowId);
    if (!window || window.status !== "scheduled") {
      return { opened: false, snapshotId: null, reusedSnapshot: false };
    }
    const league = await ctx.db.get("leagues", window.leagueId);
    if (!league) return { opened: false, snapshotId: null, reusedSnapshot: false };
    const rules = await rulesOf(ctx, window.leagueId);
    const weekNo = window.weekNo > 0 ? window.weekNo : 1;

    // A snake draft opens a window every few minutes; rebuilding a 400-player
    // payload each time is pure waste, so `reuseSnapshotWithinMs` lets a pick
    // window ride the previous one (PRD 5.2).
    let snapshotId: Id<"snapshots"> | null = null;
    let reused = false;
    if (window.type === "draft" && (rules?.reuseSnapshotWithinMs ?? 0) > 0) {
      // Bounded: the five newest snapshots of one league.
      const recent = await ctx.db
        .query("snapshots")
        .withIndex("by_leagueId_takenAt", (q) => q.eq("leagueId", window.leagueId))
        .order("desc")
        .take(5);
      const fresh = recent.find(
        (row) =>
          row.status === "ready" && now - row.takenAt <= (rules?.reuseSnapshotWithinMs ?? 0),
      );
      if (fresh) {
        snapshotId = fresh._id;
        reused = true;
      }
    }

    if (!snapshotId) {
      snapshotId = await ctx.db.insert("snapshots", {
        leagueId: window.leagueId,
        windowId: window._id,
        season: league.season,
        weekNo,
        takenAt: now,
        status: "building",
        chunkCount: 0,
        playerCount: 0,
      });
      // `snapshot.build` is an action (it does the CPU work across several
      // mutations) and is at-most-once; a failure marks the snapshot `failed`
      // and `dispatch` proceeds anyway.
      await ctx.scheduler.runAfter(0, internal.snapshot.build, {
        leagueId: window.leagueId,
        weekNo,
        windowId: window._id,
        snapshotId,
        now,
      });
    }

    await ctx.db.patch("windows", args.windowId, {
      status: "open",
      snapshotId,
      openJobId: undefined,
    });

    await ctx.scheduler.runAfter(0, internal.windows.dispatch, {
      windowId: args.windowId,
      attempt: 0,
    });

    return { opened: true, snapshotId, reusedSnapshot: reused };
  },
});

// --------------------------------------------------------------- dispatch

/**
 * Create one `runs` document per team and enqueue each on the Workpool.
 *
 * `snapshot.build` cannot call us (it is another package's file), so `open`
 * schedules this immediately and we wait for the snapshot ourselves: while it
 * is still `building` we re-schedule in 5 s, up to `MAX_DISPATCH_ATTEMPTS`
 * (5 minutes). A `failed` snapshot does *not* stop us — the runs are created
 * and fail fast, which is what makes the safety autopilot at close fire.
 *
 * Idempotent: teams that already have a run in this window are skipped, read
 * off `runs.by_windowId_status` (bounded by one run per team).
 */
export const dispatch = internalMutation({
  args: { windowId: v.id("windows"), attempt: v.optional(v.number()) },
  returns: v.object({ created: v.number(), waiting: v.boolean() }),
  handler: async (ctx, args): Promise<{ created: number; waiting: boolean }> => {
    const attempt = args.attempt ?? 0;
    const window = await ctx.db.get("windows", args.windowId);
    if (!window || window.status !== "open") return { created: 0, waiting: false };

    if (window.snapshotId) {
      const snapshot = await ctx.db.get("snapshots", window.snapshotId);
      if (snapshot?.status === "building" && attempt < MAX_DISPATCH_ATTEMPTS) {
        await ctx.scheduler.runAfter(DISPATCH_POLL_MS, internal.windows.dispatch, {
          windowId: args.windowId,
          attempt: attempt + 1,
        });
        return { created: 0, waiting: true };
      }
    }

    const teamIds = await teamIdsForWindow(ctx, window);
    if (teamIds.length === 0) return { created: 0, waiting: false };

    // Bounded: one run per team per window.
    const existing = await ctx.db
      .query("runs")
      .withIndex("by_windowId_status", (q) => q.eq("windowId", args.windowId))
      .take(MAX_RUNS_PER_WINDOW);
    const already = new Set(existing.map((run) => run.teamId as string));
    const missing = teamIds.filter((id) => !already.has(id));
    if (missing.length === 0) return { created: 0, waiting: false };

    const assignments = await assignmentsFor(ctx, window.leagueId, missing);
    const runIds: Id<"runs">[] = [];
    for (const assignment of assignments) {
      runIds.push(
        await ctx.db.insert("runs", {
          windowId: window._id,
          leagueId: window.leagueId,
          teamId: assignment.teamId,
          configVersionId: assignment.configVersionId,
          modelId: assignment.modelId,
          kind: "team",
          status: "pending",
          windowType: window.type,
          windowLabel: window.label,
          weekNo: window.weekNo,
          attempt: 1,
          lastPersistedStep: -1,
          totalCostUsd: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          stepCount: 0,
          committedActionCount: 0,
          rejectedActionCount: 0,
        }),
      );
    }

    await ctx.db.patch("windows", args.windowId, {
      runCount: window.runCount + runIds.length,
    });

    if (!dispatchDisabled()) {
      for (const runId of runIds) await enqueueRun(ctx, runId);
    }

    return { created: runIds.length, waiting: false };
  },
});

// ------------------------------------------------------------------ close

/**
 * Close a window and apply its fallbacks.
 *
 * The mutation itself stays small (the 1 s / 32k-document budget): every step
 * that could be heavy is scheduled with `runAfter(0, …)` rather than run
 * inline. Twelve safety autopilots each reassemble a snapshot, so each gets its
 * own transaction (`internal.windows.autopilotForTeam`); waiver processing,
 * trade expiry, trade reviews, draft progression and the team-week metrics are
 * likewise their own transactions. They all commit-or-not with this close.
 */
export const close = internalMutation({
  args: { windowId: v.id("windows"), now: v.optional(v.number()) },
  returns: v.object({
    closed: v.boolean(),
    autopilots: v.number(),
    tradeSiblingsExpired: v.number(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{ closed: boolean; autopilots: number; tradeSiblingsExpired: number }> => {
    const now = args.now ?? Date.now();
    const window = await ctx.db.get("windows", args.windowId);
    if (!window || window.status === "closed") {
      return { closed: false, autopilots: 0, tradeSiblingsExpired: 0 };
    }
    const rules = await rulesOf(ctx, window.leagueId);

    await ctx.db.patch("windows", args.windowId, { status: "closing", closeJobId: undefined });

    // Runs that never reached a terminal state: `timed_out` / `skipped`, and
    // their Workpool jobs cancelled (5a's contract).
    await ctx.runMutation(internal.runs.cancelForWindow, { windowId: args.windowId });

    let autopilots = 0;
    if (window.type === "lineup" && rules?.safetyAutopilot && window.snapshotId) {
      // Runs regardless of whether any run started: a provider outage that
      // stops every run must not blank twelve lineups (PRD §12).
      for (const team of await teamsOf(ctx, window.leagueId)) {
        await ctx.scheduler.runAfter(0, internal.windows.autopilotForTeam, {
          windowId: args.windowId,
          teamId: team._id,
          now,
        });
        autopilots++;
      }
    }

    if (window.type === "waiver") {
      await ctx.scheduler.runAfter(0, internal.waivers.process, {
        windowId: args.windowId,
        now,
      });
    }

    let tradeSiblingsExpired = 0;
    if (window.type === "trade") {
      // A proposal made in round 1 must still be answerable in rounds 2 and 3
      // (PRD 5.6), so only the *last* round of a label sweeps every sibling.
      const siblings = await ctx.db
        .query("windows")
        .withIndex("by_leagueId_label_weekNo_roundNo", (q) =>
          q
            .eq("leagueId", window.leagueId)
            .eq("label", window.label)
            .eq("weekNo", window.weekNo),
        )
        .take(MAX_TRADE_SIBLINGS);
      const lastRound = siblings.reduce((max, row) => Math.max(max, row.roundNo), window.roundNo);
      if (window.roundNo >= lastRound) {
        for (const sibling of siblings) {
          await ctx.scheduler.runAfter(0, internal.trades.expireForWindow, {
            windowId: sibling._id,
          });
          tradeSiblingsExpired++;
        }
      }
      await ctx.scheduler.runAfter(0, internal.trades.processReviews, {
        leagueId: window.leagueId,
        now,
      });
    }

    if (window.type === "draft") {
      await ctx.scheduler.runAfter(0, internal.draft_progression.onPickWindowClosed, {
        windowId: args.windowId,
        now,
      });
    }

    if (window.type === "lineup") {
      await ctx.scheduler.runAfter(0, internal.metrics.computeForWindowClose, {
        windowId: args.windowId,
      });
    }

    await ctx.db.patch("windows", args.windowId, { status: "closed" });
    return { closed: true, autopilots, tradeSiblingsExpired };
  },
});

/**
 * One team's safety autopilot, in its own transaction.
 *
 * Scheduled per team by `close` so a twelve-team league never puts twelve
 * snapshot reassemblies into a single mutation.
 */
export const autopilotForTeam = internalMutation({
  args: { windowId: v.id("windows"), teamId: v.id("teams"), now: v.optional(v.number()) },
  returns: v.object({ changed: v.boolean() }),
  handler: async (ctx, args): Promise<{ changed: boolean }> => {
    const window = await ctx.db.get("windows", args.windowId);
    if (!window?.snapshotId) return { changed: false };
    const result = await ctx.runMutation(internal.lineups.applySafetyAutopilot, {
      snapshotId: window.snapshotId,
      teamId: args.teamId,
      weekNo: window.weekNo > 0 ? window.weekNo : 1,
      now: args.now,
    });
    return { changed: result.changed };
  },
});

// ----------------------------------------------------------- rescheduling

/**
 * Re-derive a league week's windows from the current templates + overrides and
 * re-arm the jobs of every window that has not opened yet.
 *
 * This is what `commissioner.setWindowOverrides` must call after it writes
 * `league_rules.windowOverrides` (that file belongs to package E; see the
 * Phase 5b report). Windows that already opened are left exactly as they are —
 * a commissioner must not move the clock out from under a running agent.
 *
 * A window that the new overrides disable is deleted when it is still
 * `scheduled` and has no runs; otherwise it is left alone.
 */
export const rescheduleForLeague = internalMutation({
  args: { leagueId: v.id("leagues"), weekNo: v.number(), now: v.optional(v.number()) },
  returns: v.object({ rescheduled: v.number(), created: v.number(), removed: v.number() }),
  handler: async (
    ctx,
    args,
  ): Promise<{ rescheduled: number; created: number; removed: number }> => {
    const now = args.now ?? Date.now();
    const week = await ctx.db
      .query("weeks")
      .withIndex("by_leagueId_weekNo", (q) =>
        q.eq("leagueId", args.leagueId).eq("weekNo", args.weekNo),
      )
      .first();
    if (!week) return { rescheduled: 0, created: 0, removed: 0 };

    const rules = await rulesOf(ctx, args.leagueId);
    const resolved = resolveWindowsForWeek(
      week.startsAt,
      (rules?.windowOverrides ?? null) as WindowOverrides | null,
    );
    const wanted = new Map(resolved.map((w) => [`${w.label}#${w.roundNo}`, w]));

    // Bounded: one league week materialises ~18 windows.
    const rows = await ctx.db
      .query("windows")
      .withIndex("by_leagueId_weekNo_type", (q) =>
        q.eq("leagueId", args.leagueId).eq("weekNo", args.weekNo),
      )
      .collect();

    let rescheduled = 0;
    let removed = 0;
    for (const row of rows) {
      const key = `${row.label}#${row.roundNo}`;
      const target = wanted.get(key);
      wanted.delete(key);
      if (row.status !== "scheduled") continue; // never move an open window
      if (!target) {
        if (row.runCount === 0) {
          if (row.openJobId) await ctx.scheduler.cancel(row.openJobId);
          if (row.closeJobId) await ctx.scheduler.cancel(row.closeJobId);
          await ctx.db.delete("windows", row._id);
          removed++;
        }
        continue;
      }
      await ctx.db.patch("windows", row._id, {
        opensAt: target.opensAt,
        closesAt: target.closesAt,
        submissionDeadlineAt: target.submissionDeadlineAt,
        scope: target.scope,
      });
      await scheduleWindowJobs(ctx, row._id, now);
      rescheduled++;
    }

    // Anything the overrides newly enabled.
    let created = 0;
    for (const target of wanted.values()) {
      const windowId = await ctx.db.insert("windows", {
        leagueId: args.leagueId,
        type: target.type,
        label: target.label,
        weekNo: args.weekNo,
        roundNo: target.roundNo,
        opensAt: target.opensAt,
        submissionDeadlineAt: target.submissionDeadlineAt,
        closesAt: target.closesAt,
        status: "scheduled",
        scope: target.scope,
        runCount: 0,
        terminalRunCount: 0,
      });
      await scheduleWindowJobs(ctx, windowId, now);
      created++;
    }

    return { rescheduled, created, removed };
  },
});

/** Read-only, paginated targets for the one-time weekly deadline migration. */
export const weeklyDeadlineMigrationTargets = internalQuery({
  args: { cursor: v.union(v.string(), v.null()), now: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const page = await ctx.db.query("leagues").withIndex("by_status", (q) => q.eq("status", "in_season"))
      .paginate({ cursor: args.cursor, numItems: 10 });
    const targets: { leagueId: Id<"leagues">; weekNo: number }[] = [];
    for (const league of page.page) {
      const weeks = await ctx.db.query("weeks")
        .withIndex("by_leagueId_weekNo", (q) => q.eq("leagueId", league._id)).take(22);
      for (const week of weeks) {
        if (week.endsAt <= now || week.status === "complete") continue;
        // Only replace materialized schedules. Week rollover uses the new defaults.
        const window = await ctx.db.query("windows")
          .withIndex("by_leagueId_weekNo_type", (q) => q.eq("leagueId", league._id).eq("weekNo", week.weekNo)).first();
        if (window) targets.push({ leagueId: league._id, weekNo: week.weekNo });
      }
    }
    return { targets, cursor: page.continueCursor, done: page.isDone };
  },
});

/** Preserve completed history, cancel superseded lineup jobs, and install the weekly window. */
export const migrateWeeklyDeadline = internalMutation({
  args: { leagueId: v.id("leagues"), weekNo: v.number(), now: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const week = await ctx.db.query("weeks")
      .withIndex("by_leagueId_weekNo", (q) => q.eq("leagueId", args.leagueId).eq("weekNo", args.weekNo)).first();
    if (!week || week.endsAt <= now || week.status === "complete") return { retired: 0, created: false };
    const rows = await ctx.db.query("windows")
      .withIndex("by_leagueId_weekNo_type", (q) => q.eq("leagueId", args.leagueId).eq("weekNo", args.weekNo).eq("type", "lineup"))
      .collect();
    let retired = 0;
    for (const row of rows) {
      if (row.label === "lineup_weekly" || row.status === "closed") continue;
      await cancelWindowJobs(ctx, row);
      await ctx.runMutation(internal.runs.cancelForWindow, { windowId: row._id });
      if (row.runCount === 0) await ctx.db.delete("windows", row._id);
      else await ctx.db.patch("windows", row._id, { status: "closed", openJobId: undefined, closeJobId: undefined });
      retired++;
    }
    if (rows.some((row) => row.label === "lineup_weekly")) return { retired, created: false };
    const target = resolveWindowsForWeek(week.startsAt).find((window) => window.label === "lineup_weekly")!;
    // Do not retroactively run agents or change an already locked week's lineup.
    const expired = now >= weeklyLineupDeadline(week.startsAt);
    const windowId = await ctx.db.insert("windows", {
      leagueId: args.leagueId, weekNo: args.weekNo, type: "lineup", label: target.label,
      roundNo: 1, opensAt: target.opensAt, closesAt: target.closesAt,
      submissionDeadlineAt: target.submissionDeadlineAt, scope: {},
      status: expired ? "closed" : "scheduled", runCount: 0, terminalRunCount: 0,
    });
    if (!expired) await scheduleWindowJobs(ctx, windowId, now);
    return { retired, created: true };
  },
});

// -------------------------------------------------------- admin / e2e helpers

/**
 * Open a window immediately, whatever its clock says.
 *
 * `npx convex run windows:openNow '{"leagueId":"…","label":"lineup_weekly","weekNo":1}'`
 * is the smoke-test entry point that replaced `scripts/smoke-e2e.ts`'s tick.
 */
export const openNow = internalMutation({
  args: {
    leagueId: v.id("leagues"),
    label: v.string(),
    weekNo: v.optional(v.number()),
    roundNo: v.optional(v.number()),
  },
  returns: v.object({
    windowId: v.id("windows"),
    snapshotId: v.union(v.null(), v.id("snapshots")),
    opened: v.boolean(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    windowId: Id<"windows">;
    snapshotId: Id<"snapshots"> | null;
    opened: boolean;
  }> => {
    const now = Date.now();
    const weekNo = args.weekNo ?? 1;
    const roundNo = args.roundNo ?? 1;

    const find = async () =>
      ctx.db
        .query("windows")
        .withIndex("by_leagueId_label_weekNo_roundNo", (q) =>
          q
            .eq("leagueId", args.leagueId)
            .eq("label", args.label)
            .eq("weekNo", weekNo)
            .eq("roundNo", roundNo),
        )
        .first();

    let window = await find();
    if (!window) {
      await ctx.runMutation(internal.windows.materializeWindows, {
        leagueId: args.leagueId,
        weekNo,
      });
      window = await find();
    }
    if (!window) {
      throw appError("NOT_FOUND", `No window ${args.label}#${roundNo} in week ${weekNo}`);
    }

    // Force it back to `scheduled` with an open clock so `open` will act.
    if (window.openJobId) await ctx.scheduler.cancel(window.openJobId);
    await ctx.db.patch("windows", window._id, {
      status: "scheduled",
      opensAt: Math.min(window.opensAt, now),
      openJobId: undefined,
    });
    const result = await ctx.runMutation(internal.windows.open, {
      windowId: window._id,
      now,
    });
    return { windowId: window._id, snapshotId: result.snapshotId, opened: result.opened };
  },
});

/**
 * Re-arm a window's jobs, optionally moving its clock — the mutation wrapper
 * around `convex/scheduling.ts#rescheduleWindow`, so a commissioner tool (or a
 * test) can reach it through `npx convex run`.
 */
export const rescheduleNow = internalMutation({
  args: {
    windowId: v.id("windows"),
    opensAt: v.optional(v.number()),
    closesAt: v.optional(v.number()),
    now: v.optional(v.number()),
  },
  returns: v.object({
    openJobId: v.union(v.null(), v.id("_scheduled_functions")),
    closeJobId: v.union(v.null(), v.id("_scheduled_functions")),
  }),
  handler: async (ctx, args) => {
    const jobs = await rescheduleWindow(ctx, args.windowId, {
      opensAt: args.opensAt,
      closesAt: args.closesAt,
      now: args.now,
    });
    return {
      openJobId: jobs.openJobId ?? null,
      closeJobId: jobs.closeJobId ?? null,
    };
  },
});

/** Close a window immediately, running the fallbacks the clock would have run. */
export const closeNow = internalMutation({
  args: { windowId: v.id("windows") },
  returns: v.object({ closed: v.boolean(), autopilots: v.number() }),
  handler: async (ctx, { windowId }): Promise<{ closed: boolean; autopilots: number }> => {
    const now = Date.now();
    const window = await ctx.db.get("windows", windowId);
    if (!window) throw appError("NOT_FOUND", `Window ${windowId} not found`);
    if (window.closesAt > now) await ctx.db.patch("windows", windowId, { closesAt: now });
    const result = await ctx.runMutation(internal.windows.close, { windowId, now });
    return { closed: result.closed, autopilots: result.autopilots };
  },
});
