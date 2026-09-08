/**
 * The five-minute tick (PRD §6.2).
 *
 * Cron is a trigger, not a worker. Everything here is idempotent and safe to
 * run on any schedule: windows open once, runs are created once per team per
 * window, closes are guarded by status, and dispatch only ever asks the
 * executor to look at a row it will claim for itself.
 *
 * Order matters. Closes run before opens so a window that opens and closes
 * inside one tick interval still gets its fallbacks, and dispatch runs last so
 * it sees runs created earlier in the same tick.
 */
import { and, asc, eq, gt, inArray, lte, ne, sql } from "drizzle-orm";

import { db, type DbOrTx } from "@/lib/db";
import {
  leagueRules,
  leagues,
  snapshots,
  teams,
  weeks,
  windows,
} from "@/lib/db/schema";
import type { League, LeagueRules, Window } from "@/lib/db/types";
import { publicEnv } from "@/lib/env";
import { runWeeklyCommissionerTasks } from "@/lib/services/commissioner-agent";
import { finalizeWeek, isWeekComplete, scoreWeek } from "@/lib/services/scoring";
import { loadSnapshot, takeSnapshot } from "@/lib/services/snapshot";
import { advanceBracket, seedPlayoffs } from "@/lib/services/standings";
import { processWaivers } from "@/lib/services/waivers";
import { isWithinEditWindow, type EditLock } from "@/lib/time";

import { progressDraft, type DraftProgressReport } from "./draft-progression";
import { safeApplySafetyAutopilot } from "./lineup-fallback";
import { materializeWindows } from "./materialize";
import {
  createRunsForWindow,
  pendingRunsToDispatch,
  reapExpiredRuns,
  teamIdsForLeague,
  terminateOpenRuns,
} from "./runs";

export type TickOptions = {
  now?: Date;
  /** Set false in tests: skip the outbound fan-out entirely. */
  dispatch?: boolean;
  /** Injected so the route can hand us Next's `after`-wrapped fetch. */
  fetchImpl?: typeof fetch;
  /** Injected so a scheduled callback can run after the response is sent. */
  schedule?: (task: () => Promise<void>) => void;
  executor?: DbOrTx;
  /** Restrict the tick to one league (tests, admin tools). */
  leagueId?: string;
};

export type LeagueTickReport = {
  leagueId: string;
  name: string;
  weekNo: number | null;
  materialized: number;
  opened: string[];
  closed: string[];
  runsCreated: number;
  runsTerminated: number;
  waiversProcessed: number;
  fallbacksApplied: number;
  scored: boolean;
  finalized: boolean;
  /** Commissioner Agent weekly tasks ran after finalization. */
  commissionerRan?: boolean;
  draft?: DraftProgressReport;
  configVersionsApplied?: number;
  error?: string;
};

export type TickReport = {
  now: string;
  leagues: LeagueTickReport[];
  reaped: number;
  dispatched: number;
  durationMs: number;
};

export const DEFAULT_RUN_CONCURRENCY = 20;

function runConcurrency(): number {
  const raw = Number(process.env.RUN_CONCURRENCY);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_RUN_CONCURRENCY;
}

function internalSecret(): string {
  return process.env.INTERNAL_SECRET ?? "dev-internal-secret";
}

function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? publicEnv.appUrl;
}

/** The league week that "now" belongs to, from the `weeks` grid. */
export async function currentWeekNo(
  leagueId: string,
  now: Date,
  executor: DbOrTx = db,
): Promise<number | null> {
  const rows = await executor
    .select({ weekNo: weeks.weekNo, startsAt: weeks.startsAt, endsAt: weeks.endsAt })
    .from(weeks)
    .where(eq(weeks.leagueId, leagueId))
    .orderBy(asc(weeks.weekNo));
  if (rows.length === 0) return null;
  for (const row of rows) {
    if (now >= row.startsAt && now < row.endsAt) return row.weekNo;
  }
  // Before the season: week 1. After it: the last week.
  return now < rows[0].startsAt ? rows[0].weekNo : rows[rows.length - 1].weekNo;
}

// -------------------------------------------------------------- the tick

export async function runTick(options: TickOptions = {}): Promise<TickReport> {
  const started = Date.now();
  const now = options.now ?? new Date();
  const executor = options.executor ?? db;

  const activeLeagues = await executor
    .select()
    .from(leagues)
    .where(
      options.leagueId
        ? eq(leagues.id, options.leagueId)
        : sql`${leagues.status} in ('drafting', 'in_season')`,
    );

  const reports: LeagueTickReport[] = [];
  for (const league of activeLeagues) {
    try {
      reports.push(await tickLeague(league, now, executor));
    } catch (err) {
      reports.push({
        leagueId: league.id,
        name: league.name,
        weekNo: null,
        materialized: 0,
        opened: [],
        closed: [],
        runsCreated: 0,
        runsTerminated: 0,
        waiversProcessed: 0,
        fallbacksApplied: 0,
        scored: false,
        finalized: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // (5) Reap runs whose lease expired while running, and apply their fallback.
  const reaped = await reapExpiredRuns(now, executor);
  for (const run of reaped) {
    if (run.windowType !== "lineup" || !run.teamId || !run.snapshotId) continue;
    try {
      const snapshot = await loadSnapshot(run.snapshotId, executor);
      await safeApplySafetyAutopilot(
        {
          snapshot: snapshot.payload,
          teamId: run.teamId,
          weekNo: run.weekNo ?? snapshot.payload.weekNo,
          runId: run.id,
          now,
        },
        executor,
      );
    } catch (err) {
      console.warn(`[tick] autopilot after reap failed for run ${run.id}`, err);
    }
  }

  // (6) Dispatch. This is the ONLY way a run executes.
  const dispatched =
    options.dispatch === false ? 0 : await dispatchPendingRuns(now, options, executor);

  return {
    now: now.toISOString(),
    leagues: reports,
    reaped: reaped.length,
    dispatched,
    durationMs: Date.now() - started,
  };
}

async function tickLeague(
  league: League,
  now: Date,
  executor: DbOrTx,
): Promise<LeagueTickReport> {
  const report: LeagueTickReport = {
    leagueId: league.id,
    name: league.name,
    weekNo: null,
    materialized: 0,
    opened: [],
    closed: [],
    runsCreated: 0,
    runsTerminated: 0,
    waiversProcessed: 0,
    fallbacksApplied: 0,
    scored: false,
    finalized: false,
  };

  const rules = await executor.query.leagueRules.findFirst({
    where: eq(leagueRules.leagueId, league.id),
  });
  if (!rules) return report;

  // (8) Draft first: a drafting league has no weekly windows yet.
  if (league.status === "drafting") {
    report.draft = await progressDraft(league.id, now, executor);
    if (!report.draft.finalized) return report;
  }

  const weekNo = await currentWeekNo(league.id, now, executor);
  report.weekNo = weekNo;
  if (weekNo === null) return report;

  // (1) Ensure this week's and next week's windows exist, and mark week status.
  for (const week of [weekNo, weekNo + 1]) {
    const result = await materializeWindows(league.id, week, executor);
    report.materialized += result.created;
  }
  await markWeekStatuses(league.id, weekNo, now, executor);

  // (3) Close before open, so a short window still gets its fallbacks.
  await closeDueWindows(league, rules, now, executor, report);

  // (2) Open.
  await openDueWindows(league, now, executor, report);

  // (4) Config edit-lock unlock boundary.
  report.configVersionsApplied = await applyConfigsAtUnlock(league.id, rules, now);

  // (7) Score the active week; finalize when every NFL game is done.
  const teamCount = await executor
    .select({ id: teams.id })
    .from(teams)
    .where(eq(teams.leagueId, league.id));
  if (teamCount.length > 0) {
    await scoreWeek(league.id, weekNo, executor);
    report.scored = true;
    if (await isWeekComplete(league.season, weekNo, executor)) {
      const { finalized } = await finalizeWeek(league.id, weekNo, executor);
      report.finalized = finalized;
      if (finalized) {
        if (weekNo + 1 === rules.playoffStartWeek) await seedPlayoffs(league.id, executor);
        if (weekNo >= rules.playoffStartWeek) await advanceBracket(league.id, weekNo, executor);
        // Commissioner Agent duties (PRD 5.10): recap, power rankings, flagged trades.
        // Best-effort — a model outage must never block scoring or the next tick.
        try {
          await runWeeklyCommissionerTasks(league.id, weekNo);
          report.commissionerRan = true;
        } catch (error) {
          console.error(`[tick] commissioner tasks failed for league ${league.id}:`, error);
        }
      }
    }
  }

  return report;
}

async function markWeekStatuses(
  leagueId: string,
  weekNo: number,
  now: Date,
  executor: DbOrTx,
): Promise<void> {
  await executor
    .update(weeks)
    .set({ status: "active" })
    .where(
      and(eq(weeks.leagueId, leagueId), eq(weeks.weekNo, weekNo), ne(weeks.status, "complete")),
    );
  await executor
    .update(weeks)
    .set({ status: "complete" })
    .where(
      and(
        eq(weeks.leagueId, leagueId),
        lte(weeks.endsAt, now),
        ne(weeks.status, "complete"),
      ),
    );
}

async function openDueWindows(
  league: League,
  now: Date,
  executor: DbOrTx,
  report: LeagueTickReport,
): Promise<void> {
  const due = await executor
    .select()
    .from(windows)
    .where(
      and(
        eq(windows.leagueId, league.id),
        eq(windows.status, "scheduled"),
        lte(windows.opensAt, now),
        gt(windows.closesAt, now),
        // Draft windows are opened by `progressDraft`, one pick at a time.
        ne(windows.type, "draft"),
      ),
    )
    .orderBy(asc(windows.opensAt));

  const teamIds = await teamIdsForLeague(league.id, executor);
  for (const window of due) {
    const { snapshotId } = await takeSnapshot(
      { leagueId: league.id, weekNo: window.weekNo ?? 1, windowId: window.id, now },
      executor,
    );
    await executor
      .update(windows)
      .set({ status: "open", snapshotId })
      .where(and(eq(windows.id, window.id), eq(windows.status, "scheduled")));
    // Bind the snapshot back to the window for the trace viewer.
    await executor
      .update(snapshots)
      .set({ windowId: window.id })
      .where(eq(snapshots.id, snapshotId));

    const created = await createRunsForWindow(window, teamIds, executor);
    report.runsCreated += created.length;
    report.opened.push(`${window.label}#${window.roundNo}`);
  }
}

async function closeDueWindows(
  league: League,
  rules: LeagueRules,
  now: Date,
  executor: DbOrTx,
  report: LeagueTickReport,
): Promise<void> {
  const due = await executor
    .select()
    .from(windows)
    .where(
      and(
        eq(windows.leagueId, league.id),
        inArray(windows.status, ["scheduled", "open", "closing"]),
        lte(windows.closesAt, now),
        ne(windows.type, "draft"),
      ),
    )
    .orderBy(asc(windows.closesAt));

  for (const window of due) {
    await executor.update(windows).set({ status: "closing" }).where(eq(windows.id, window.id));

    // Trade proposals expire at the *window's* close (PRD 5.4 fallbacks), not at
    // the end of each negotiation round — an offer made in round 1 must still be
    // answerable in rounds 2 and 3 (PRD 5.6). Non-trade windows never hold
    // proposals, so only the last round of a trade window sweeps them, across
    // every round sub-window of the same label/week.
    if (window.type === "trade") {
      try {
        const siblings = await executor
          .select({ id: windows.id, roundNo: windows.roundNo })
          .from(windows)
          .where(
            and(
              eq(windows.leagueId, window.leagueId),
              eq(windows.label, window.label),
              eq(windows.weekNo, window.weekNo ?? 0),
            ),
          );
        const lastRound = Math.max(window.roundNo, ...siblings.map((w) => w.roundNo));
        if (window.roundNo >= lastRound) {
          const { expireOpenProposals } = await import("@/lib/services/trades");
          for (const sibling of siblings) await expireOpenProposals(sibling.id);
        }
      } catch (err) {
        logStubMiss("expireOpenProposals", err);
      }
    }

    const terminated = await terminateOpenRuns(window.id, now, executor);
    report.runsTerminated += terminated.timedOut + terminated.skipped;

    if (window.type === "lineup" && rules.safetyAutopilot) {
      report.fallbacksApplied += await applyLineupFallbacks(league.id, window, now, executor);
    }

    if (window.type === "waiver") {
      const result = await processWaivers(window.id, now, executor);
      report.waiversProcessed += result.processed;
    }

    if (window.type === "trade") {
      try {
        const { processTradeReviews } = await import("@/lib/services/trades");
        await processTradeReviews(league.id, now);
      } catch (err) {
        logStubMiss("processTradeReviews", err);
      }
    }

    await executor.update(windows).set({ status: "closed" }).where(eq(windows.id, window.id));
    report.closed.push(`${window.label}#${window.roundNo}`);
  }
}

/**
 * Safety autopilot for every team in a closing lineup window.
 *
 * It runs regardless of whether the team's run ever started — a provider outage
 * that stops every run must not blank twelve lineups (PRD §12).
 */
async function applyLineupFallbacks(
  leagueId: string,
  window: Window,
  now: Date,
  executor: DbOrTx,
): Promise<number> {
  if (!window.snapshotId) return 0;
  let snapshot;
  try {
    snapshot = await loadSnapshot(window.snapshotId, executor);
  } catch {
    return 0;
  }
  let applied = 0;
  for (const team of snapshot.payload.teams) {
    try {
      const result = await safeApplySafetyAutopilot(
        {
          snapshot: snapshot.payload,
          teamId: team.id,
          weekNo: window.weekNo ?? snapshot.payload.weekNo,
          now,
        },
        executor,
      );
      if (result.changed) applied++;
    } catch (err) {
      console.warn(`[tick] autopilot failed for team ${team.id} in league ${leagueId}`, err);
    }
  }
  return applied;
}

/**
 * Apply queued config edits at the unlock boundary. We detect the boundary by
 * asking whether the edit window was closed one tick ago and is open now, which
 * makes the check independent of the tick's exact cadence.
 */
async function applyConfigsAtUnlock(
  leagueId: string,
  rules: LeagueRules,
  now: Date,
): Promise<number> {
  const editLock = rules.editLock as EditLock;
  const oneTickAgo = new Date(now.getTime() - 5 * 60_000);
  const justUnlocked =
    isWithinEditWindow(now, editLock) && !isWithinEditWindow(oneTickAgo, editLock);
  if (!justUnlocked) return 0;
  try {
    const { applyPendingConfigVersions } = await import("@/lib/services/config");
    return await applyPendingConfigVersions(leagueId);
  } catch (err) {
    logStubMiss("applyPendingConfigVersions", err);
    return 0;
  }
}

function logStubMiss(name: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("not implemented")) return; // contract stub during parallel build
  console.warn(`[tick] ${name} failed: ${message}`);
}

// ------------------------------------------------------------- dispatching

/**
 * Fan out one fire-and-forget POST per pending run.
 *
 * `after()` (next/server) is the right primitive here: per
 * `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/after.md`,
 * "Using `after` in a serverless context requires waiting for asynchronous tasks
 * to finish after the response has been sent. In Next.js and Vercel, this is
 * achieved using a primitive called `waitUntil(promise)`" — so `after` IS the
 * documented `waitUntil` wrapper, and the cron route passes it in as `schedule`.
 */
export async function dispatchPendingRuns(
  now: Date,
  options: TickOptions,
  executor: DbOrTx = db,
): Promise<number> {
  const limit = runConcurrency();
  const pending = await pendingRunsToDispatch(now, limit, executor);
  if (pending.length === 0) return 0;

  const doFetch = options.fetchImpl ?? fetch;
  const base = appUrl().replace(/\/$/, "");
  const secret = internalSecret();

  const task = async () => {
    await Promise.allSettled(
      pending.map((run) =>
        doFetch(`${base}/api/runs/${run.id}/execute`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${secret}`,
            "content-type": "application/json",
          },
          // The executor claims the row itself; a duplicate POST is a no-op.
          body: JSON.stringify({ dispatchedAt: now.toISOString() }),
        }).catch((err) => {
          console.warn(`[tick] dispatch failed for run ${run.id}`, err);
        }),
      ),
    );
  };

  if (options.schedule) options.schedule(task);
  else void task();

  return pending.length;
}

// ----------------------------------------------------- admin / test helpers

/** Open a window immediately (snapshot + runs), regardless of its clock. */
export async function openWindowNow(
  leagueId: string,
  label: string,
  opts: { weekNo?: number; roundNo?: number; now?: Date; executor?: DbOrTx } = {},
): Promise<{ windowId: string; snapshotId: string; runsCreated: number }> {
  const executor = opts.executor ?? db;
  const now = opts.now ?? new Date();
  const weekNo = opts.weekNo ?? (await currentWeekNo(leagueId, now, executor)) ?? 1;

  let window = await executor.query.windows.findFirst({
    where: and(
      eq(windows.leagueId, leagueId),
      eq(windows.label, label),
      eq(windows.weekNo, weekNo),
      eq(windows.roundNo, opts.roundNo ?? 1),
    ),
  });
  if (!window) {
    await materializeWindows(leagueId, weekNo, executor);
    window = await executor.query.windows.findFirst({
      where: and(
        eq(windows.leagueId, leagueId),
        eq(windows.label, label),
        eq(windows.weekNo, weekNo),
        eq(windows.roundNo, opts.roundNo ?? 1),
      ),
    });
  }
  if (!window) throw new Error(`No window ${label} for league ${leagueId} week ${weekNo}`);

  const { snapshotId } = await takeSnapshot(
    { leagueId, weekNo, windowId: window.id, now },
    executor,
  );
  await executor
    .update(windows)
    .set({ status: "open", snapshotId })
    .where(eq(windows.id, window.id));
  const teamIds = await teamIdsForLeague(leagueId, executor);
  const created = await createRunsForWindow(window, teamIds, executor);
  return { windowId: window.id, snapshotId, runsCreated: created.length };
}

/** Close a window immediately, running the same fallbacks the tick would. */
export async function closeWindowNow(
  windowId: string,
  opts: { now?: Date; executor?: DbOrTx } = {},
): Promise<LeagueTickReport> {
  const executor = opts.executor ?? db;
  const now = opts.now ?? new Date();
  const window = await executor.query.windows.findFirst({ where: eq(windows.id, windowId) });
  if (!window) throw new Error(`Window ${windowId} not found`);
  const league = await executor.query.leagues.findFirst({ where: eq(leagues.id, window.leagueId) });
  const rules = await executor.query.leagueRules.findFirst({
    where: eq(leagueRules.leagueId, window.leagueId),
  });
  if (!league || !rules) throw new Error(`League ${window.leagueId} not found`);

  const report: LeagueTickReport = {
    leagueId: league.id,
    name: league.name,
    weekNo: window.weekNo,
    materialized: 0,
    opened: [],
    closed: [],
    runsCreated: 0,
    runsTerminated: 0,
    waiversProcessed: 0,
    fallbacksApplied: 0,
    scored: false,
    finalized: false,
  };
  // Force the close path by pretending we are at (or past) the close instant.
  await executor
    .update(windows)
    .set({ closesAt: new Date(Math.min(window.closesAt.getTime(), now.getTime())) })
    .where(eq(windows.id, windowId));
  await closeDueWindows(league, rules, now, executor, report);
  return report;
}
