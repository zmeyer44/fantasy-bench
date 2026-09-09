/**
 * Phase 5 §11 "Load": 600 agent runs at Workpool parallelism 24.
 *
 *   npx tsx --env-file=.env.loadtest scripts/loadtest-run.ts patch-models
 *   npx tsx --env-file=.env.loadtest scripts/loadtest-run.ts check
 *   npx tsx --env-file=.env.loadtest scripts/loadtest-run.ts run
 *
 * The 50-league deployment `scripts/loadtest-seed.ts` builds (`dev:content-ant-382`)
 * is the fixture. This script opens one week-1 lineup window in every one of those
 * leagues *at the same moment*, waits for all 50 x 12 = 600 runs to reach a
 * terminal state, and reports throughput, the status/outcome mix, the step
 * distribution and whether every run beat its window's `submissionDeadlineAt`.
 *
 * Three things about how it talks to the deployment:
 *
 *  1. **`windows.openNow` / `closeNow` / `rescheduleNow` are `internalMutation`s.**
 *     `ConvexHttpClient` cannot reach `internal.*`, and nothing may be added to
 *     `convex/` for a verification run, so they are called through
 *     `npx convex run` child processes carrying `CONVEX_DEPLOYMENT` explicitly
 *     (<= `PROC_BATCH` at a time). Every read is a public query over
 *     `ConvexHttpClient` (`leagues.bySlug`, `windows.forWeek`, `runs.list`,
 *     `seed.*`), which is why the load-test leagues being public matters.
 *  2. **It never selects a deployment.** `CONVEX_DEPLOYMENT` is inherited from
 *     `--env-file=.env.loadtest` and passed down to the children; the script
 *     refuses outright if the URL is the shared dev deployment. Note that
 *     `npx convex dev --once` (the push) *does* rewrite `.env.local`; this script
 *     does not push.
 *  3. **The window it drives is `lineup_sun_late`, not `lineup_sun_early`.**
 *     `scripts/loadtest-seed.ts` pre-seeds 12 finished runs into every league's
 *     `waiver`, `lineup_sun_early` and `trade_1` window of every week
 *     (`RUN_WINDOW_INDICES = [4, 1, 5]`), and `windows.dispatch` skips a team that
 *     already has a run in the window — so opening `lineup_sun_early` would create
 *     zero runs. `lineup_sun_late` is the same window type over the same 12 teams
 *     with no pre-seeded runs.
 *
 *     A window can only be measured once: after a run its 12 runs per league are
 *     there for good and `dispatch` will skip them. `lineup_thu` and
 *     `lineup_sun_late` have both been used; the next clean label on this fixture
 *     is `lineup_mon` (`--label=lineup_mon`), or re-seed the deployment.
 *
 * Also note: `RUN_DISPATCH` must NOT be set on the deployment. Phase 2 leaves it
 * at `skip`, which makes `windows.dispatch` create the run documents without
 * enqueueing them — `check` reports it as "runs created, 0 terminal" forever.
 * Remove it before a run and restore it afterwards.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { ConvexHttpClient } from "convex/browser";

import { api } from "../convex/_generated/api";
import { readIdMap, seedMapFile } from "./seed-map";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ------------------------------------------------------------------- options

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

const COMMAND = process.argv[2] ?? "run";
const LEAGUE_COUNT = Number(arg("leagues") ?? 50);
const LABEL = arg("label") ?? "lineup_sun_late";
const WEEK_NO = Number(arg("week") ?? 1);
const ROUND_NO = Number(arg("round") ?? 1);
/** Child `npx convex run` processes in flight at once. */
const PROC_BATCH = Number(arg("batch") ?? 10);
const POLL_MS = Number(arg("poll") ?? 10_000);
const TIMEOUT_MS = Number(arg("timeout") ?? 45 * 60_000);
/** Window length applied by `rescheduleNow` so `submissionDeadlineAt` is in the future. */
const WINDOW_MS = Number(arg("window") ?? 2 * 60 * 60_000);
const OUT = arg("out") ?? path.join(ROOT, ".cache", "loadtest-run.json");
const SKIP_CLOSE = process.argv.includes("--skip-close");
const SKIP_RESCHEDULE = process.argv.includes("--skip-reschedule");

const url = process.env.NEXT_PUBLIC_CONVEX_URL;
const deployment = process.env.CONVEX_DEPLOYMENT;
const secret = process.env.SEED_SECRET;
if (!url) throw new Error("NEXT_PUBLIC_CONVEX_URL is not set — use --env-file=.env.loadtest.");
if (!deployment) throw new Error("CONVEX_DEPLOYMENT is not set — use --env-file=.env.loadtest.");
if (!secret) throw new Error("SEED_SECRET is not set — use --env-file=.env.loadtest.");
if (url.includes("tidy-peacock") || deployment.includes("tidy-peacock")) {
  throw new Error(
    "Refusing to run against the shared dev deployment. This script only targets the load-test deployment.",
  );
}

const client = new ConvexHttpClient(url);

// --------------------------------------------------------------- small utils

const started = Date.now();
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
function log(line: string): void {
  process.stdout.write(`[${elapsed()}] ${line}\n`);
}

async function inBatches<T, R>(
  items: T[],
  size: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map((item, j) => fn(item, i + j)))));
  }
  return out;
}

/**
 * `npx convex run <fn> '<json>'` against the load-test deployment.
 *
 * `CONVEX_DEPLOYMENT` is passed in the child env rather than through
 * `convex deployment select`, which would redirect everyone's pushes.
 */
async function convexRun(fn: string, args: unknown): Promise<unknown> {
  const { stdout } = await execFileAsync(
    "npx",
    ["convex", "run", fn, JSON.stringify(args)],
    {
      cwd: ROOT,
      env: { ...process.env, CONVEX_DEPLOYMENT: deployment },
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  const text = stdout.trim();
  const brace = text.indexOf("{");
  if (brace < 0) return null;
  try {
    return JSON.parse(text.slice(brace)) as unknown;
  } catch {
    return { raw: text };
  }
}

// ------------------------------------------------------------------- reading

type WindowView = {
  id: string;
  label: string;
  type: string;
  weekNo: number;
  roundNo: number;
  status: string;
  opensAt: number;
  submissionDeadlineAt: number;
  closesAt: number;
  snapshotId: string | null;
  runCount: number;
  terminalRunCount: number;
};

type RunItem = {
  id: string;
  teamId: string | null;
  windowId: string;
  windowLabel: string;
  modelId: string;
  status: string;
  outcome: string | null;
  stepCount: number;
  costUsd: number;
  actionCount: number;
  startedAt: number | null;
  finishedAt: number | null;
  fallbackKind: string | null;
};

type League = { index: number; slug: string; leagueId: string; window: WindowView };

const TERMINAL = new Set(["succeeded", "partial", "failed", "timed_out", "fallback", "skipped"]);

function slugOf(index: number): string {
  return `loadtest-${String(index).padStart(3, "0")}`;
}

async function windowFor(leagueId: string): Promise<WindowView | null> {
  const windows = (await client.query(api.windows.forWeek, {
    leagueId: leagueId as never,
    weekNo: WEEK_NO,
  })) as unknown as WindowView[];
  return windows.find((w) => w.label === LABEL && w.roundNo === ROUND_NO) ?? null;
}

async function loadLeagues(): Promise<League[]> {
  const out: League[] = [];
  await inBatches(
    Array.from({ length: LEAGUE_COUNT }, (_, i) => i),
    10,
    async (index) => {
      const slug = slugOf(index);
      const found = await client.query(api.leagues.bySlug, { slug });
      if (!found) throw new Error(`League ${slug} is missing — run scripts/loadtest-seed.ts first.`);
      const leagueId = found.league._id as unknown as string;
      const window = await windowFor(leagueId);
      if (!window) throw new Error(`League ${slug} has no ${LABEL}#${ROUND_NO} in week ${WEEK_NO}.`);
      out.push({ index, slug, leagueId, window });
    },
  );
  return out.sort((a, b) => a.index - b.index);
}

/** Every run of `windowId`, read through the public paginated `runs.list`. */
async function runsForWindow(leagueId: string, windowId: string): Promise<RunItem[]> {
  const out: RunItem[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = (await client.query(api.runs.list, {
      leagueId: leagueId as never,
      weekNo: WEEK_NO,
      paginationOpts: { numItems: 100, cursor },
    })) as unknown as { page: RunItem[]; isDone: boolean; continueCursor: string };
    out.push(...page.page.filter((run) => run.windowId === windowId));
    if (page.isDone) return out;
    cursor = page.continueCursor;
  }
}

/** Whole-table row count through the paginated `seed.tableCount`. */
async function tableCount(table: string): Promise<number> {
  let cursor: string | null = null;
  let total = 0;
  for (;;) {
    const page: { count: number; continueCursor: string; isDone: boolean } = await client.query(
      api.seed.tableCount,
      { secret: secret!, table: table as never, cursor },
    );
    total += page.count;
    if (page.isDone) return total;
    cursor = page.continueCursor;
  }
}

// ------------------------------------------------------------- patch-models

/**
 * Force every current config version onto `mock/scripted`.
 *
 * `scripts/loadtest-seed.ts` spreads teams across `mock/scripted`,
 * `openai/gpt-5.6-terra` and `openai/gpt-5.6-sol`, and the load-test
 * deployment has no `AI_GATEWAY_API_KEY` — 400 of the 600 runs would fail in
 * `resolveModel` and the test would measure the failure path instead of
 * throughput. `seed.patchBatch` is the SEED_SECRET-guarded way to fix that
 * without touching `convex/`.
 *
 * (`docs/CONVEX_CONVENTIONS.md` says config versions are never patched after
 * insert. That rule is about the product's write paths; this is the seed fixing
 * its own fixture on a scratch deployment.)
 */
async function patchModels(): Promise<void> {
  const file = seedMapFile(ROOT, "loadtest");
  const ids = Object.values(readIdMap(file).config_versions ?? {});
  if (!ids.length) {
    throw new Error(`${file} lists no config_versions; re-run scripts/loadtest-seed.ts first.`);
  }
  log(`patching ${ids.length} config_versions to mock/scripted`);
  for (let i = 0; i < ids.length; i += 200) {
    await client.mutation(api.seed.patchBatch, {
      secret: secret!,
      table: "config_versions",
      rows: ids.slice(i, i + 200).map((id) => ({ id, patch: { modelId: "mock/scripted" } })),
    });
  }
  log(`done — ${ids.length} config versions now pin mock/scripted`);
}

// -------------------------------------------------------------------- check

async function check(): Promise<void> {
  const leagues = await loadLeagues();
  log(`${leagues.length} leagues, target window ${LABEL}#${ROUND_NO} week ${WEEK_NO}`);
  const withRuns = leagues.filter((l) => l.window.runCount > 0);
  log(`windows already carrying runs: ${withRuns.length} (${withRuns.map((l) => l.slug).join(", ")})`);
  const statuses = new Map<string, number>();
  for (const league of leagues) {
    statuses.set(league.window.status, (statuses.get(league.window.status) ?? 0) + 1);
  }
  log(`window statuses: ${[...statuses].map(([k, v]) => `${k}=${v}`).join(", ")}`);
  log(`config_versions: ${await tableCount("config_versions")}, lineups: ${await tableCount("lineups")}`);
}

// --------------------------------------------------------------------- close

/**
 * Close the target window in every league without running anything.
 *
 * Cleanup: an interrupted `run` (or one made while the deployment still had
 * `RUN_DISPATCH=skip`) leaves 50 windows `open` with pending runs that will never
 * be enqueued. Closing them times those runs out and lets the fallbacks apply, so
 * `terminalRunCount == runCount` holds again.
 */
async function close(): Promise<void> {
  const leagues = await loadLeagues();
  const open = leagues.filter((l) => l.window.status !== "closed");
  log(`closing ${open.length} ${LABEL}#${ROUND_NO} windows`);
  await inBatches(open, PROC_BATCH, async (league) =>
    convexRun("windows:closeNow", { windowId: league.window.id }),
  );
  await new Promise((resolve) => setTimeout(resolve, 20_000));
  const after = await inBatches(leagues, 10, async (league) => windowFor(league.leagueId));
  log(
    `statuses: ${JSON.stringify(tally(after.map((w) => w?.status ?? "(missing)")))}, ` +
      `count mismatches: ${after.filter((w) => w && w.runCount !== w.terminalRunCount).length}`,
  );
}

// -------------------------------------------------------------------- counts

/** Row counts for `--tables=a,b,c`, through the paginated `seed.tableCount`. */
async function counts(): Promise<void> {
  const tables = (arg("tables") ?? "runs,run_steps,run_actions,usage_events,lineups,windows,snapshots").split(",");
  for (const table of tables) {
    process.stdout.write(`  ${table.padEnd(20)} ${await tableCount(table)}\n`);
  }
}

// ------------------------------------------------------------------ resample

/**
 * Re-read the target windows after the fact and print the same distributions the
 * `run` report prints. Used to tell a genuine result from a read that raced the
 * last `persistStep` commit.
 */
async function resample(): Promise<void> {
  const leagues = await loadLeagues();
  const runs = (
    await inBatches(leagues, 10, async (league) => runsForWindow(league.leagueId, league.window.id))
  ).flat();
  process.stdout.write(`runs: ${runs.length}\n`);
  process.stdout.write(`byStatus        ${JSON.stringify(tally(runs.map((r) => r.status)))}\n`);
  process.stdout.write(`byOutcome       ${JSON.stringify(tally(runs.map((r) => r.outcome ?? "(none)")))}\n`);
  process.stdout.write(`byStepCount     ${JSON.stringify(tally(runs.map((r) => String(r.stepCount))))}\n`);
  process.stdout.write(`byActionCount   ${JSON.stringify(tally(runs.map((r) => String(r.actionCount))))}\n`);
  const finished = runs
    .map((r) => r.finishedAt)
    .filter((at): at is number => typeof at === "number")
    .sort((a, b) => a - b);
  process.stdout.write(
    `finish span     ${finished.length ? ((finished[finished.length - 1] - finished[0]) / 1000).toFixed(1) : "-"}s\n`,
  );
  const lowest = runs
    .filter((r) => r.stepCount < 4)
    .slice(0, 5)
    .map((r) => ({ id: r.id, steps: r.stepCount, status: r.status, outcome: r.outcome, actions: r.actionCount }));
  process.stdout.write(`sample <4 steps ${JSON.stringify(lowest)}\n`);
}

// ---------------------------------------------------------------------- run

type Report = Record<string, unknown>;

async function run(): Promise<void> {
  const leagues = await loadLeagues();
  const expectedRuns = leagues.length * 12;
  log(`${leagues.length} leagues x 12 teams = ${expectedRuns} expected runs on ${LABEL}#${ROUND_NO}`);

  const pre = leagues.filter((l) => l.window.runCount > 0);
  if (pre.length > 0) {
    log(
      `WARNING: ${pre.length} target windows already carry runs (${pre[0].slug} has ${pre[0].window.runCount}); ` +
        `dispatch will skip those teams.`,
    );
  }

  const lineupsBefore = await tableCount("lineups");
  log(`lineups before: ${lineupsBefore}`);

  // 1 -- move every window's clock so `submissionDeadlineAt` is a real deadline.
  // The seeded week-1 windows opened (and closed) months ago; `rescheduleWindow`
  // keeps the template's submission lead when only `closesAt` moves.
  const clockAt = Date.now();
  if (!SKIP_RESCHEDULE) {
    await inBatches(leagues, PROC_BATCH, async (league) =>
      convexRun("windows:rescheduleNow", {
        windowId: league.window.id,
        opensAt: clockAt,
        closesAt: clockAt + WINDOW_MS,
        now: clockAt,
      }),
    );
    log(`rescheduled ${leagues.length} windows to [now, now+${Math.round(WINDOW_MS / 60000)}m]`);
  }

  // 2 -- open all of them as close to simultaneously as 50 CLI processes allow.
  const t0 = Date.now();
  const opened = await inBatches(leagues, PROC_BATCH, async (league) => {
    const at = Date.now();
    const result = (await convexRun("windows:openNow", {
      leagueId: league.leagueId,
      label: LABEL,
      weekNo: WEEK_NO,
      roundNo: ROUND_NO,
    })) as { windowId?: string; opened?: boolean } | null;
    return { slug: league.slug, at, opened: result?.opened === true, windowId: result?.windowId };
  });
  const openSpreadMs = Math.max(...opened.map((o) => o.at)) - Math.min(...opened.map((o) => o.at));
  log(
    `opened ${opened.filter((o) => o.opened).length}/${leagues.length} windows; ` +
      `open calls spread over ${(openSpreadMs / 1000).toFixed(1)}s`,
  );

  // 3 -- poll until every run is terminal.
  const samples: Array<{ atMs: number; terminal: number; total: number }> = [];
  let runs: RunItem[] = [];
  let timedOut = false;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    runs = (
      await inBatches(leagues, 10, async (league) => runsForWindow(league.leagueId, league.window.id))
    ).flat();
    const terminal = runs.filter((r) => TERMINAL.has(r.status)).length;
    samples.push({ atMs: Date.now() - t0, terminal, total: runs.length });
    log(`poll: ${runs.length}/${expectedRuns} runs created, ${terminal} terminal`);
    if (runs.length >= expectedRuns && terminal === runs.length) break;
    if (Date.now() - t0 > TIMEOUT_MS) {
      timedOut = true;
      log(`TIMEOUT after ${Math.round((Date.now() - t0) / 1000)}s`);
      break;
    }
  }
  const t1 = Date.now();

  // 4 -- close the windows and let the scheduled fallbacks land.
  let closed: unknown[] = [];
  if (!SKIP_CLOSE) {
    closed = await inBatches(leagues, PROC_BATCH, async (league) =>
      convexRun("windows:closeNow", { windowId: league.window.id }),
    );
    log(`closed ${leagues.length} windows; waiting 30s for the scheduled autopilot/metrics jobs`);
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }

  const after = await inBatches(leagues, 10, async (league) => {
    const window = await windowFor(league.leagueId);
    return { slug: league.slug, window };
  });
  const lineupsAfter = await tableCount("lineups");

  // 5 -- the report.
  const finished = runs
    .map((r) => r.finishedAt)
    .filter((at): at is number => typeof at === "number")
    .sort((a, b) => a - b);
  const ordinal = (n: number) => (finished.length >= n ? finished[n - 1] - t0 : null);

  const byStatus = tally(runs.map((r) => r.status));
  const byOutcome = tally(runs.map((r) => r.outcome ?? "(none)"));
  const byModel = tally(runs.map((r) => r.modelId));
  const bySteps = tally(runs.map((r) => String(r.stepCount)));
  const fallbacks = runs.filter((r) => r.fallbackKind).length;

  const deadlineMisses = leagues.flatMap((league) => {
    const window = after.find((a) => a.slug === league.slug)?.window;
    const deadline = window?.submissionDeadlineAt ?? league.window.submissionDeadlineAt;
    return runs
      .filter((r) => r.windowId === league.window.id)
      .filter((r) => (r.finishedAt ?? Infinity) > deadline)
      .map((r) => ({ slug: league.slug, runId: r.id, finishedAt: r.finishedAt, deadline }));
  });

  const durations = runs
    .filter((r) => r.startedAt && r.finishedAt)
    .map((r) => (r.finishedAt as number) - (r.startedAt as number))
    .sort((a, b) => a - b);

  const countMismatch = after.filter(
    (a) => a.window && a.window.terminalRunCount !== a.window.runCount,
  );

  const wallMs = t1 - t0;
  const report: Report = {
    deployment,
    url,
    label: LABEL,
    weekNo: WEEK_NO,
    roundNo: ROUND_NO,
    leagues: leagues.length,
    expectedRuns,
    observedRuns: runs.length,
    timedOut,
    t0,
    t1,
    wallClockMs: wallMs,
    openCallSpreadMs: openSpreadMs,
    throughputRunsPerMin: runs.length / (wallMs / 60_000),
    stepsTotal: runs.reduce((sum, r) => sum + r.stepCount, 0),
    throughputStepsPerSec: runs.reduce((sum, r) => sum + r.stepCount, 0) / (wallMs / 1000),
    finishedAtMs: { n24: ordinal(24), n100: ordinal(100), n300: ordinal(300), n600: ordinal(600) },
    firstFinishedMs: finished.length ? finished[0] - t0 : null,
    lastFinishedMs: finished.length ? finished[finished.length - 1] - t0 : null,
    byStatus,
    byOutcome,
    byModel,
    byStepCount: bySteps,
    maxStepCount: runs.reduce((max, r) => Math.max(max, r.stepCount), 0),
    minStepCount: runs.reduce((min, r) => Math.min(min, r.stepCount), Infinity),
    fallbacksApplied: fallbacks,
    totalCostUsd: runs.reduce((sum, r) => sum + (r.costUsd ?? 0), 0),
    runDurationMs: {
      min: durations[0] ?? null,
      p50: durations[Math.floor(durations.length * 0.5)] ?? null,
      p95: durations[Math.floor(durations.length * 0.95)] ?? null,
      max: durations[durations.length - 1] ?? null,
    },
    deadlineMisses: deadlineMisses.length,
    deadlineMissSample: deadlineMisses.slice(0, 5),
    windowCountMismatches: countMismatch.map((a) => ({
      slug: a.slug,
      runCount: a.window?.runCount,
      terminalRunCount: a.window?.terminalRunCount,
    })),
    windowStatusesAfterClose: tally(after.map((a) => a.window?.status ?? "(missing)")),
    lineupsBefore,
    lineupsAfter,
    lineupsWritten: lineupsAfter - lineupsBefore,
    autopilotWrites: lineupsAfter - lineupsBefore - runs.filter((r) => r.status === "succeeded").length,
    samples,
    closedResults: closed.length,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  printReport(report);
  log(`report written to ${OUT}`);
  if (timedOut || deadlineMisses.length > 0 || countMismatch.length > 0) process.exitCode = 1;
}

function tally(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}

function printReport(report: Report): void {
  const row = (k: string, v: unknown) =>
    process.stdout.write(`  ${k.padEnd(30)} ${typeof v === "object" ? JSON.stringify(v) : String(v)}\n`);
  process.stdout.write("\n=== load test ===\n");
  for (const key of [
    "deployment",
    "label",
    "leagues",
    "expectedRuns",
    "observedRuns",
    "wallClockMs",
    "openCallSpreadMs",
    "throughputRunsPerMin",
    "stepsTotal",
    "throughputStepsPerSec",
    "firstFinishedMs",
    "finishedAtMs",
    "lastFinishedMs",
    "byStatus",
    "byOutcome",
    "byModel",
    "byStepCount",
    "maxStepCount",
    "fallbacksApplied",
    "totalCostUsd",
    "runDurationMs",
    "deadlineMisses",
    "windowCountMismatches",
    "windowStatusesAfterClose",
    "lineupsWritten",
    "autopilotWrites",
  ]) {
    row(key, report[key]);
  }
}

// --------------------------------------------------------------------- main

const COMMANDS: Record<string, () => Promise<void>> = {
  "patch-models": patchModels,
  check,
  close,
  counts,
  resample,
  run,
};

const command = COMMANDS[COMMAND];
if (!command) {
  process.stderr.write(`Unknown command "${COMMAND}". Use: ${Object.keys(COMMANDS).join(" | ")}\n`);
  process.exit(1);
}

command().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
