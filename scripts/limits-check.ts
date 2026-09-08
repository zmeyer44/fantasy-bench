/**
 * Call every **public query** in `convex/*.ts` against the load-test deployment and
 * check that none of them hits a Convex transaction limit.
 *
 *   npx tsx --env-file=.env.loadtest scripts/limits-check.ts
 *
 * Flags: `--leagues=N` (how many random leagues to sample, default 5),
 * `--seed=N` (sampling seed), `--json=path` (write the raw results).
 *
 * The function list is not hard-coded: it comes from `npx convex function-spec`
 * against `CONVEX_DEPLOYMENT`, so a query added after this was written shows up as
 * a failure ("no argument recipe") rather than silently going unchecked.
 *
 * For each sampled league the script finds the *largest* team, run, thread and post
 * it can see and calls every query with those, twice for paginated queries so the
 * cursor path is exercised too. What it is looking for is the four limits in
 * `docs/CONVEX_NOTES.md` §4 — "Too many documents read" (32 000), "Too many bytes
 * read" (16 MiB), the 1 s query time limit, and index-range exhaustion — plus any
 * other error. Latency is wall-clock at the client, so it includes the round trip;
 * treat the numbers as an upper bound on server time.
 *
 * Exit code 0 when every query succeeded, 1 when any failed.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";

import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { anyApi } from "convex/server";

const execFileAsync = promisify(execFile);

const LEAGUE_SAMPLE = Number(arg("leagues") ?? 5);
const SAMPLE_SEED = Number(arg("seed") ?? 7);
const JSON_OUT = arg("json");
/** Latency above this is reported as a concern (the query time limit is 1 s). */
const SLOW_MS = 1_000;
const PAGE = { numItems: 25, cursor: null };

const USER = { email: "loadtest@fantasybench.dev", password: "password1234" };

function arg(name: string): string | undefined {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

const url = process.env.NEXT_PUBLIC_CONVEX_URL;
const secret = process.env.SEED_SECRET;
if (!url) throw new Error("NEXT_PUBLIC_CONVEX_URL is not set (use --env-file=.env.loadtest).");
if (url.includes("tidy-peacock-243")) {
  throw new Error(
    "Refusing to run against the shared dev deployment. Point NEXT_PUBLIC_CONVEX_URL at the loadtest deployment.",
  );
}

const client = new ConvexHttpClient(url);

type Row = Record<string, unknown>;
type Args = Row;

type Result = {
  identifier: string;
  calls: number;
  /** Worst warm latency (the number the 1 s threshold is judged on). */
  maxMs: number;
  /** Worst first-call latency, which carries the deployment's cold start. */
  maxColdMs: number;
  errors: Array<{ args: string; message: string }>;
  skipped?: string;
};

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Untyped references, because the function list comes from the deployment at run
 * time rather than from `convex/_generated/api`.
 */
type AnyQuery = FunctionReference<"query", "public", Record<string, unknown>, unknown>;
type AnyAction = FunctionReference<"action", "public", Record<string, unknown>, unknown>;

function walk(path: string[]): unknown {
  let node: Record<string, unknown> = anyApi as unknown as Record<string, unknown>;
  for (const part of path.slice(0, -1)) node = node[part] as Record<string, unknown>;
  return node[path[path.length - 1]];
}

/** `"views.js:home"` or `"views.home"` -> the `api.views.home` reference. */
function q(identifier: string): AnyQuery {
  const [file, name] = identifier.includes(":") ? identifier.split(":") : ["", identifier];
  const path = file
    ? [...file.replace(/\.js$/, "").split("/"), name]
    : identifier.split(".");
  return walk(path) as AnyQuery;
}

function action(path: string): AnyAction {
  return walk(path.split(".")) as AnyAction;
}

async function publicQueries(): Promise<string[]> {
  const { stdout } = await execFileAsync("npx", ["convex", "function-spec"], {
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  const spec = JSON.parse(stdout) as {
    functions: Array<{
      identifier: string;
      functionType: string;
      visibility: { kind: string };
    }>;
  };
  return spec.functions
    .filter((fn) => fn.functionType === "Query" && fn.visibility.kind === "public")
    .map((fn) => fn.identifier)
    .sort();
}

// ------------------------------------------------------------------- sampling

type Sample = {
  slug: string;
  leagueId: string;
  joinCode: string | null;
  weekNo: number;
  teamId: string;
  teamIds: string[];
  versionIds: [string, string] | null;
  matchupId: string | null;
  runId: string | null;
  threadId: string | null;
  postId: string | null;
  tradeId: string | null;
  snapshotId: string | null;
  payloadId: string | null;
};


/** Sign in through the real password flow so member-only reads are exercised. */
async function authenticate(): Promise<void> {
  const result = (await client.action(action("auth.signIn"), {
    provider: "password",
    params: { email: USER.email, password: USER.password, flow: "signIn" },
  })) as { tokens?: { token: string } | null };
  if (!result?.tokens?.token) throw new Error("Password sign-in returned no token.");
  client.setAuth(result.tokens.token);
}

async function buildSamples(): Promise<Sample[]> {
  const rand = mulberry32(SAMPLE_SEED);
  const slugs: string[] = [];
  for (let i = 0; i < 50; i += 1) slugs.push(`loadtest-${String(i).padStart(3, "0")}`);
  const picked = slugs.sort(() => rand() - 0.5).slice(0, LEAGUE_SAMPLE);

  const samples: Sample[] = [];
  for (const slug of picked) {
    const found = (await client.query(q("leagues.bySlug"), { slug })) as {
      league: { _id: string; joinCode?: string | null };
    } | null;
    if (!found) continue;
    const leagueId = found.league._id;

    const weeks = (await client.query(q("weeks.list"), { leagueId })) as Array<{
      weekNo: number;
    }>;
    const weekNo = weeks.at(-1)?.weekNo ?? 1;

    const teams = (await client.query(q("views.teams"), { leagueId })) as Array<{
      id: string;
    }>;
    const teamIds = teams.map((team) => team.id);

    // Largest run: the one with the most steps (ties broken by cost).
    const runs = (await client.query(q("runs.list"), {
      leagueId,
      paginationOpts: { numItems: 100, cursor: null },
    })) as { page: Array<{ id: string; teamId: string | null; stepCount: number }> };
    const biggestRun = [...runs.page].sort(
      (a, b) => b.stepCount - a.stepCount || a.id.localeCompare(b.id),
    )[0];

    // Largest team: the one with the most runs in that first page.
    const runsPerTeam = new Map<string, number>();
    for (const run of runs.page) {
      if (!run.teamId) continue;
      runsPerTeam.set(run.teamId, (runsPerTeam.get(run.teamId) ?? 0) + 1);
    }
    const busiestTeam =
      [...runsPerTeam.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? teamIds[0];

    const threads = (await client.query(q("messaging.listThreads"), {
      leagueId,
      limit: 200,
    })) as Array<{ id: string; messageCount: number }>;
    const biggestThread = [...threads].sort((a, b) => b.messageCount - a.messageCount)[0];

    const posts = (await client.query(q("forum.list"), {
      leagueId,
      sort: "top",
      paginationOpts: { numItems: 50, cursor: null },
    })) as { page: Array<{ id: string; commentCount: number }> };
    const biggestPost = [...posts.page].sort((a, b) => b.commentCount - a.commentCount)[0];

    const trades = (await client.query(q("trades.list"), {
      leagueId,
      limit: 50,
    })) as Array<{ id: string }>;

    const matchups = (await client.query(q("views.matchups"), {
      leagueId,
      weekNo,
    })) as Array<{ id: string }>;

    const windows = (await client.query(q("windows.forWeek"), {
      leagueId,
      weekNo,
    })) as Array<{ snapshotId: string | null }>;
    const snapshotId = windows.find((w) => w.snapshotId)?.snapshotId ?? null;

    // `configs.versions` returns raw `config_versions` documents, so the id is
    // `_id`; the view models above (`views.teams`, `runs.list`, `forum.list`, …)
    // project a plain `id`. Accept either.
    // `runs.stepPayload` is reachable only through a step's `payloadRef`, and the
    // load-test seed writes exactly one oversized tool result per league, on that
    // league's very first run. `runs.list` is newest-first, so the first run is the
    // last entry of the week-1 page.
    let payloadId: string | null = null;
    const weekOne = (await client.query(q("runs.list"), {
      leagueId,
      weekNo: 1,
      paginationOpts: { numItems: 100, cursor: null },
    })) as { page: Array<{ id: string }> };
    for (const run of [weekOne.page.at(-1), biggestRun]) {
      if (!run || payloadId) continue;
      const steps = (await client.query(q("runs.steps"), {
        runId: run.id,
        paginationOpts: { numItems: 50, cursor: null },
      })) as { page: Array<{ toolResults?: unknown[] }> };
      for (const step of steps.page) {
        for (const result of step.toolResults ?? []) {
          const ref = (result as { payloadRef?: string }).payloadRef;
          if (ref) payloadId = ref;
        }
      }
    }

    const config = (await client.query(q("configs.versions"), {
      leagueId,
      teamId: busiestTeam,
    })) as { versions: Array<{ _id?: string; id?: string }> };
    const idOf = (row: { _id?: string; id?: string } | undefined) => row?._id ?? row?.id ?? null;
    const versionId = idOf(config.versions[0]);

    samples.push({
      slug,
      leagueId,
      joinCode: found.league.joinCode ?? null,
      weekNo,
      teamId: busiestTeam,
      teamIds,
      versionIds: versionId ? [versionId, idOf(config.versions[1]) ?? versionId] : null,
      matchupId: matchups[0]?.id ?? null,
      runId: biggestRun?.id ?? null,
      threadId: biggestThread?.id ?? null,
      postId: biggestPost?.id ?? null,
      tradeId: trades[0]?.id ?? null,
      snapshotId,
      payloadId,
    });
  }
  return samples;
}

// -------------------------------------------------------------- arg recipes

type Call = {
  /** What is being exercised, for the failure report. */
  label: string;
  args: Args;
  /** `paginationOpts`-style paging: the second page uses `continueCursor`. */
  paginated?: boolean;
  /** `seed.*`-style paging: a bare `cursor` argument. */
  cursorArg?: boolean;
};

const LONG_CONTEXT = "You manage a fantasy football team. ".repeat(200);

/**
 * One entry per public query. A query missing from here is reported as a failure,
 * so a function added later cannot slip through unchecked.
 */
function recipes(samples: Sample[]): Map<string, Call[]> {
  const map = new Map<string, Call[]>();
  const put = (identifier: string, calls: Call[]) => map.set(identifier, calls);
  const per = (make: (sample: Sample) => Call | null): Call[] =>
    samples.map(make).filter((call): call is Call => call !== null);

  // --- global reads -------------------------------------------------------
  put("auth.js:isAuthenticated", [{ label: "global", args: {} }]);
  put("users.js:me", [{ label: "global", args: {} }]);
  put("leagues.js:listMine", [{ label: "global (50 memberships)", args: {} }]);
  put("ledger.js:modelPrices", [{ label: "global", args: {} }]);
  put("skills.js:list", [
    { label: "all", args: {} },
    { label: "text search", args: { query: "draft" } },
    { label: "mine", args: { mine: true } },
  ]);
  put("skills.js:get", [{ label: "builtin", args: { slug: "value-based-drafting" } }]);
  put("users.js:byEmailPublic", [
    { label: "seed lookup", args: { secret: secret ?? "", email: USER.email } },
  ]);
  put("seed.js:tableCount", [
    { label: "run_steps", args: { secret: secret ?? "", table: "run_steps" }, cursorArg: true },
  ]);

  // --- league reads -------------------------------------------------------
  put("leagues.js:bySlug", per((s) => ({ label: s.slug, args: { slug: s.slug } })));
  put(
    "leagues.js:byJoinCode",
    per((s) => (s.joinCode ? { label: s.slug, args: { code: s.joinCode } } : null)),
  );
  put("leagues.js:get", per((s) => ({ label: s.slug, args: { leagueId: s.leagueId } })));
  put("views.js:home", per((s) => ({ label: s.slug, args: { leagueId: s.leagueId } })));
  put("views.js:standings", per((s) => ({ label: s.slug, args: { leagueId: s.leagueId } })));
  put("views.js:teams", per((s) => ({ label: s.slug, args: { leagueId: s.leagueId } })));
  put("views.js:team", per((s) => ({ label: `${s.slug} busiest team`, args: { teamId: s.teamId } })));
  put(
    "views.js:matchups",
    per((s) => ({ label: s.slug, args: { leagueId: s.leagueId, weekNo: s.weekNo } })),
  );
  put(
    "views.js:matchup",
    per((s) =>
      s.matchupId
        ? {
            label: s.slug,
            args: { leagueId: s.leagueId, weekNo: s.weekNo, matchupId: s.matchupId },
          }
        : null,
    ),
  );
  put(
    "waivers.js:results",
    per((s) => ({ label: s.slug, args: { leagueId: s.leagueId, weekNo: s.weekNo } })),
  );
  put(
    "windows.js:forWeek",
    per((s) => ({ label: s.slug, args: { leagueId: s.leagueId, weekNo: s.weekNo } })),
  );
  put("windows.js:schedule", [
    ...per((s) => ({ label: s.slug, args: { leagueId: s.leagueId } })),
    ...per((s) => ({ label: `${s.slug} limit 40`, args: { leagueId: s.leagueId, limit: 40 } })),
  ]);
  put("weeks.js:list", per((s) => ({ label: s.slug, args: { leagueId: s.leagueId } })));
  put("weeks.js:currentWeekNo", per((s) => ({ label: s.slug, args: { leagueId: s.leagueId } })));
  put("draft.js:board", per((s) => ({ label: s.slug, args: { leagueId: s.leagueId } })));

  // --- ledger -------------------------------------------------------------
  put(
    "ledger.js:teamDashboard",
    per((s) => ({
      label: s.slug,
      args: { leagueId: s.leagueId, teamId: s.teamId, weekNo: s.weekNo },
    })),
  );
  put("ledger.js:leagueDashboard", [
    ...per((s) => ({ label: s.slug, args: { leagueId: s.leagueId } })),
    ...per((s) => ({ label: `${s.slug} limit 50`, args: { leagueId: s.leagueId, limit: 50 } })),
  ]);
  put("ledger.js:benchmark", per((s) => ({ label: s.slug, args: { leagueId: s.leagueId } })));

  // --- config -------------------------------------------------------------
  put(
    "configs.js:get",
    per((s) => ({ label: s.slug, args: { leagueId: s.leagueId, teamId: s.teamId } })),
  );
  put(
    "configs.js:versions",
    per((s) => ({ label: s.slug, args: { leagueId: s.leagueId, teamId: s.teamId } })),
  );
  put(
    "configs.js:version",
    per((s) =>
      s.versionIds
        ? { label: s.slug, args: { leagueId: s.leagueId, versionId: s.versionIds[0] } }
        : null,
    ),
  );
  put(
    "configs.js:diff",
    per((s) =>
      s.versionIds
        ? {
            label: s.slug,
            args: { leagueId: s.leagueId, a: s.versionIds[0], b: s.versionIds[1] },
          }
        : null,
    ),
  );
  put("configs.js:lockStatus", per((s) => ({ label: s.slug, args: { leagueId: s.leagueId } })));
  put(
    "configs.js:estimate",
    per((s) => ({
      label: `${s.slug} 7k context`,
      args: {
        leagueId: s.leagueId,
        contextMd: LONG_CONTEXT,
        skillIds: [],
        modelId: "mock/scripted",
      },
    })),
  );

  // --- commissioner -------------------------------------------------------
  put("commissioner.js:settings", per((s) => ({ label: s.slug, args: { leagueId: s.leagueId } })));
  put("commissioner.js:inviteLink", per((s) => ({ label: s.slug, args: { leagueId: s.leagueId } })));
  put(
    "commissioner.js:changeLog",
    per((s) => ({
      label: s.slug,
      args: { leagueId: s.leagueId, paginationOpts: PAGE },
      paginated: true,
    })),
  );

  // --- runs / traces ------------------------------------------------------
  put("runs.js:list", [
    ...per((s) => ({
      label: `${s.slug} unfiltered (612 runs)`,
      args: { leagueId: s.leagueId, paginationOpts: PAGE },
      paginated: true,
    })),
    ...per((s) => ({
      label: `${s.slug} by team`,
      args: { leagueId: s.leagueId, teamId: s.teamId, paginationOpts: PAGE },
      paginated: true,
    })),
    ...per((s) => ({
      label: `${s.slug} by windowType+status`,
      args: {
        leagueId: s.leagueId,
        windowType: "waiver",
        status: "succeeded",
        paginationOpts: PAGE,
      },
      paginated: true,
    })),
    ...per((s) => ({
      label: `${s.slug} by modelId`,
      args: { leagueId: s.leagueId, modelId: "mock/scripted", paginationOpts: PAGE },
      paginated: true,
    })),
  ]);
  put("runs.js:search", [
    ...per((s) => ({
      label: `${s.slug} "FAAB"`,
      args: { leagueId: s.leagueId, q: "FAAB", paginationOpts: PAGE },
      paginated: true,
    })),
    ...per((s) => ({
      label: `${s.slug} "lineup" + filters`,
      args: {
        leagueId: s.leagueId,
        q: "lineup",
        windowType: "lineup",
        paginationOpts: PAGE,
      },
      paginated: true,
    })),
  ]);
  put("runs.js:get", per((s) => (s.runId ? { label: s.slug, args: { runId: s.runId } } : null)));
  put(
    "runs.js:steps",
    per((s) =>
      s.runId
        ? { label: s.slug, args: { runId: s.runId, paginationOpts: PAGE }, paginated: true }
        : null,
    ),
  );
  put(
    "runs.js:usageEvents",
    per((s) =>
      s.runId
        ? { label: s.slug, args: { runId: s.runId, paginationOpts: PAGE }, paginated: true }
        : null,
    ),
  );
  put("runs.js:export", per((s) => (s.runId ? { label: s.slug, args: { runId: s.runId } } : null)));
  put(
    "runs.js:exportTeamPage",
    per((s) => ({
      label: `${s.slug} busiest team`,
      args: { teamId: s.teamId, paginationOpts: { numItems: 10, cursor: null } },
      paginated: true,
    })),
  );
  put("runs.js:modelOptions", per((s) => ({ label: s.slug, args: { leagueId: s.leagueId } })));
  put(
    "runs.js:searchPlayers",
    per((s) => ({ label: `${s.slug} "ja"`, args: { leagueId: s.leagueId, q: "ja" } })),
  );
  put(
    "runs.js:stepPayload",
    per((s) => (s.payloadId ? { label: s.slug, args: { payloadId: s.payloadId } } : null)),
  );

  // --- social -------------------------------------------------------------
  put("trades.js:list", [
    ...per((s) => ({ label: s.slug, args: { leagueId: s.leagueId } })),
    ...per((s) => ({ label: `${s.slug} limit 200`, args: { leagueId: s.leagueId, limit: 200 } })),
    ...per((s) => ({
      label: `${s.slug} by team`,
      args: { leagueId: s.leagueId, teamId: s.teamId, limit: 200 },
    })),
  ]);
  put(
    "trades.js:get",
    per((s) =>
      s.tradeId ? { label: s.slug, args: { leagueId: s.leagueId, tradeId: s.tradeId } } : null,
    ),
  );
  put("messaging.js:listThreads", [
    ...per((s) => ({ label: s.slug, args: { leagueId: s.leagueId } })),
    ...per((s) => ({ label: `${s.slug} limit 200`, args: { leagueId: s.leagueId, limit: 200 } })),
  ]);
  put(
    "messaging.js:getThread",
    per((s) =>
      s.threadId
        ? {
            label: `${s.slug} biggest thread`,
            args: { leagueId: s.leagueId, threadId: s.threadId, paginationOpts: PAGE },
            paginated: true,
          }
        : null,
    ),
  );
  put(
    "forum.js:list",
    (["hot", "new", "top"] as const).flatMap((sort) =>
      per((s) => ({
        label: `${s.slug} ${sort}`,
        args: { leagueId: s.leagueId, sort, paginationOpts: PAGE },
        paginated: true,
      })),
    ),
  );
  put(
    "forum.js:get",
    per((s) =>
      s.postId ? { label: s.slug, args: { leagueId: s.leagueId, postId: s.postId } } : null,
    ),
  );
  put("forum.js:karma", per((s) => ({ label: s.slug, args: { leagueId: s.leagueId } })));

  // --- misc ---------------------------------------------------------------
  put("metrics.js:filmRoom", [
    ...per((s) => ({ label: s.slug, args: { teamId: s.teamId } })),
    ...per((s) => ({ label: `${s.slug} week`, args: { teamId: s.teamId, weekNo: s.weekNo } })),
  ]);
  put(
    "snapshot.js:meta",
    per((s) => (s.snapshotId ? { label: s.slug, args: { snapshotId: s.snapshotId } } : null)),
  );
  put(
    "transactions.js:list",
    per((s) => ({
      label: s.slug,
      args: { leagueId: s.leagueId, paginationOpts: PAGE },
      paginated: true,
    })),
  );
  put(
    "transactions.js:forTeam",
    per((s) => ({
      label: s.slug,
      args: { teamId: s.teamId, paginationOpts: PAGE },
      paginated: true,
    })),
  );

  return map;
}

// ------------------------------------------------------------------ the run

/** Convex reports limit breaches as ordinary errors; these are the ones §11 cares about. */
const LIMIT_PATTERNS = [
  /Too many documents read/i,
  /Too many bytes read/i,
  /Too many reads/i,
  /index ranges/i,
  /took too long/i,
  /exceeded.*time limit/i,
  /Function execution timed out/i,
];

function isLimitError(message: string): boolean {
  return LIMIT_PATTERNS.some((pattern) => pattern.test(message));
}

function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, " ").trim();
}

/**
 * One call, timed twice.
 *
 * The first call to a function on a freshly pushed deployment pays for module
 * loading, so it is reported separately: `ms` is the warm number and `coldMs` the
 * first one. Paginated queries fetch a second page and the slower of the two pages
 * is kept.
 */
async function runCall(identifier: string, call: Call): Promise<{ ms: number; coldMs: number }> {
  const reference = q(identifier);
  const coldStart = Date.now();
  await client.query(reference, call.args);
  const coldMs = Date.now() - coldStart;

  const started = Date.now();
  const first: unknown = await client.query(reference, call.args);
  let ms = Date.now() - started;

  if (call.paginated && first && typeof first === "object") {
    const page = first as { continueCursor?: string; isDone?: boolean };
    if (page.continueCursor && !page.isDone) {
      const opts = call.args.paginationOpts as { numItems: number };
      const secondStart = Date.now();
      await client.query(reference, {
        ...call.args,
        paginationOpts: { numItems: opts.numItems, cursor: page.continueCursor },
      });
      ms = Math.max(ms, Date.now() - secondStart);
    }
  }

  if (call.cursorArg && first && typeof first === "object") {
    const page = first as { continueCursor?: string; isDone?: boolean };
    if (page.continueCursor && !page.isDone) {
      const secondStart = Date.now();
      await client.query(reference, { ...call.args, cursor: page.continueCursor });
      ms = Math.max(ms, Date.now() - secondStart);
    }
  }

  return { ms, coldMs };
}

async function main(): Promise<void> {
  process.stdout.write(`Limits check -> ${url}\n`);
  await authenticate();

  const identifiers = await publicQueries();
  process.stdout.write(`  ${identifiers.length} public queries in the deployment\n`);

  const samples = await buildSamples();
  if (samples.length === 0) throw new Error("No load-test leagues found; run scripts/loadtest-seed.ts first.");
  process.stdout.write(
    `  sampling ${samples.length} leagues: ${samples.map((s) => s.slug).join(", ")}\n\n`,
  );

  const plan = recipes(samples);
  const results: Result[] = [];

  for (const identifier of identifiers) {
    const calls = plan.get(identifier);
    if (calls === undefined) {
      results.push({
        identifier,
        calls: 0,
        maxMs: 0,
        maxColdMs: 0,
        errors: [
          {
            args: "-",
            message: "no argument recipe in scripts/limits-check.ts — this query was NOT checked",
          },
        ],
      });
      continue;
    }
    if (calls.length === 0) {
      const reason =
        "the recipe produced no calls — a required id could not be resolved from the sampled leagues";
      results.push({ identifier, calls: 0, maxMs: 0, maxColdMs: 0, errors: [], skipped: reason });
      process.stdout.write(`  ${identifier.padEnd(34)} SKIPPED — ${reason}\n`);
      continue;
    }

    const result: Result = { identifier, calls: 0, maxMs: 0, maxColdMs: 0, errors: [] };
    for (const call of calls) {
      try {
        const { ms, coldMs } = await runCall(identifier, call);
        result.calls += 1;
        result.maxMs = Math.max(result.maxMs, ms);
        result.maxColdMs = Math.max(result.maxColdMs, coldMs);
      } catch (error) {
        result.errors.push({ args: call.label, message: errorMessage(error) });
      }
    }
    results.push(result);
    const flag = result.errors.length ? "FAIL" : result.maxMs > SLOW_MS ? "slow" : "ok";
    process.stdout.write(
      `  ${identifier.padEnd(34)} ${String(result.calls).padStart(3)} calls  ${String(result.maxMs).padStart(5)} ms warm  ${String(result.maxColdMs).padStart(5)} ms cold  ${flag}\n`,
    );
  }

  // --- report -------------------------------------------------------------
  const failed = results.filter((row) => row.errors.length > 0);
  const slow = results.filter((row) => row.errors.length === 0 && row.maxMs > SLOW_MS);

  process.stdout.write("\nSlowest queries (warm / cold, wall clock incl. RTT):\n");
  for (const row of [...results].sort((a, b) => b.maxMs - a.maxMs).slice(0, 15)) {
    process.stdout.write(
      `  ${String(row.maxMs).padStart(5)} / ${String(row.maxColdMs).padStart(5)} ms  ${row.identifier}\n`,
    );
  }

  if (slow.length) {
    process.stdout.write(`\n${slow.length} queries over ${SLOW_MS} ms (wall clock, incl. RTT):\n`);
    for (const row of slow) process.stdout.write(`  ${row.identifier}: ${row.maxMs} ms\n`);
  }

  if (failed.length) {
    process.stdout.write(`\n${failed.length} queries FAILED:\n`);
    for (const row of failed) {
      for (const error of row.errors) {
        const kind = isLimitError(error.message) ? "LIMIT" : "ERROR";
        process.stdout.write(`  [${kind}] ${row.identifier} (${error.args})\n    ${error.message}\n`);
      }
    }
  } else {
    process.stdout.write("\nNo query hit a read/time limit.\n");
  }

  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, `${JSON.stringify({ url, samples, results }, null, 2)}\n`);
    process.stdout.write(`\nWrote ${JSON_OUT}\n`);
  }

  process.exit(failed.length ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error("Limits check failed to run:", error);
  process.exit(1);
});
