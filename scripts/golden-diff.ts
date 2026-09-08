/**
 * Phase 5 §11 "End-to-end": diff the league `scripts/e2e-week.ts` drove against
 * the golden state recorded from the Postgres system before Phase 2
 * (`tests/golden/postgres-week1/*.json`).
 *
 *   npx tsx --env-file=.env.local scripts/golden-diff.ts [--slug=e2e-league]
 *
 * Ids and timestamps differ by construction (a fresh Convex import, a snapshot
 * rebuilt live rather than the frozen golden one), so nothing is compared by id.
 * Every invariant is **behavioural**:
 *
 *  - per team, the final week-1 lineup by player **sleeper id** and slot;
 *  - runs per window and their status / outcome / stepCount distributions;
 *  - committed vs rejected actions per window;
 *  - waiver claims: how many, how many won, and which team won which player
 *    (again by sleeper id);
 *  - trades proposed and their statuses;
 *  - threads, messages;
 *  - forum posts by flair;
 *  - transactions by type;
 *  - usage events, and that every team-week rollup equals the sum of its events
 *    (`ledger.verify`, which is the reconciliation action itself).
 *
 * Player identity crosses the two systems through `players.legacyId`: the golden
 * uuid maps to a Convex id through `seed.lookupLegacy`, and to a sleeper id
 * through `players.json`.
 *
 * A mismatch fails the script (exit 1) **unless** it matches an entry in
 * `EXPECTED` — the list of differences the Phase 2/3/5 reports predict — in which
 * case it is printed with its reason and does not fail the run. An `EXPECTED`
 * entry that turns out to *match* is also reported, because a deviation that
 * silently disappeared is news too.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ConvexHttpClient } from "convex/browser";

import { api } from "../convex/_generated/api";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GOLDEN = path.join(ROOT, "tests", "golden", "postgres-week1");

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

const STATE_FILE = arg("state") ?? path.join(ROOT, ".cache", "e2e-week.json");
const SLUG =
  arg("slug") ??
  (fs.existsSync(STATE_FILE)
    ? (JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as { slug: string }).slug
    : "e2e-league");
const WEEK_NO = Number(arg("week") ?? 1);
const OUT = arg("out") ?? path.join(ROOT, ".cache", "golden-diff.json");

const url = process.env.NEXT_PUBLIC_CONVEX_URL;
const secret = process.env.SEED_SECRET;
if (!url) throw new Error("NEXT_PUBLIC_CONVEX_URL is not set (see .env.local).");
if (!secret) throw new Error("SEED_SECRET is not set (see .env.local).");
const client = new ConvexHttpClient(url);

/**
 * Sign in as the seeded demo user.
 *
 * `ledger.verify` is commissioner-only, and the DM/forum reads apply transparency
 * rules to an anonymous viewer — the old smoke harness ran with full database
 * access, so the comparison has to be made as a member. The demo account is the
 * one `scripts/seed-convex.ts` creates through the real password flow, and it is
 * the commissioner and owner of team 1 in the imported league.
 */
async function signIn(): Promise<void> {
  const result = (await client.action(api.auth.signIn, {
    provider: "password",
    params: { email: "demo@fantasybench.dev", password: "password1234", flow: "signIn" },
  })) as unknown as { tokens?: { token?: string } | null };
  const token = result?.tokens?.token;
  if (!token) throw new Error(`auth.signIn returned no token: ${JSON.stringify(result)}`);
  client.setAuth(token);
}

// -------------------------------------------------------- expected deviations

/**
 * The trade window is the one place where both systems are genuinely
 * non-deterministic: the twelve trade runs execute concurrently, so whether a
 * team sees a proposal in `get_inbox` before it writes its own depends on
 * scheduling. Two consequences, both observed:
 *
 *  - Golden lost one `propose_trade` to a **Postgres race**: two runs inserted
 *    the same canonical `threads` pair at once and one hit the unique index
 *    (`validation_result` in `run_actions.json` is the raw insert error). The
 *    Convex `trades.propose` does the thread upsert inside its own transaction,
 *    so all twelve proposals commit — the difference is a fix, not a regression.
 *  - In the Convex run two teams found a proposal already in their inbox and
 *    answered it in the same window (`respond_to_trade` -> `rejected`), which
 *    adds two actions, two messages, one step to each of those runs and moves
 *    two trades out of `proposed`. Golden happened to interleave the other way.
 *
 * The invariant that must hold either way — and does — is twelve
 * `propose_trade`, twelve `send_message` and twelve `set_rationale` calls, one
 * per team.
 */
const TRADE_INTERLEAVING =
  "the twelve trade runs are concurrent in both systems, so whether a team answers a proposal it " +
  "finds in its inbox is scheduling-dependent. Golden: one proposal lost to a Postgres `threads` " +
  "unique-index race, none answered. Convex: all twelve proposals committed (the upsert is " +
  "transactional) and two were answered inside the window. Twelve propose_trade / send_message / " +
  "set_rationale calls in both.";

/**
 * Differences the migration already accounts for. `key` is matched as a prefix,
 * first match wins. Anything not listed here that differs is a real failure.
 */
const EXPECTED: Array<{ key: string; reason: string }> = [
  // NOTE: there is deliberately no `lineup.` entry. Comparing the committed
  // `set_lineup` payload by sleeper id, all twelve week-1 lineups are identical to
  // the golden ones, so any lineup difference is a real failure — including
  // `lineup.*.viewDuplicateStarters`, which is a `views.team` rendering defect
  // (see docs/verification/phase5.md), not a behavioural deviation.
  {
    key: "waivers.wonBy.",
    reason:
      "all twelve teams submit the same $10 bid at priority 1 on the single top-ranked free agent, " +
      "so the winner is an arbitrary tie-break in both systems (golden: Stop Sequence; Convex: " +
      "Gradient Ascent), and WHICH free agent is top-ranked comes from the snapshot's free-agent " +
      "list, rebuilt live here rather than frozen. Claim count (24), win count (2) and the " +
      "won/lost split all match.",
  },
  {
    key: "trades.status.expired",
    reason:
      "`windows.close` expires proposals only on the LAST round of a trade label " +
      "(convex/windows.ts, PRD 5.6). Only `trade_a#1` of three rounds was driven, so its " +
      "proposals stay `proposed` — as they also do in the golden dump, where round 1 closed alone.",
  },
  {
    key: "waivers.count",
    reason:
      "`waivers.submit` replaces ALL of a team's pending claims for the window rather than " +
      "appending (convex/waivers.ts), so a run that called the tool twice would keep only the " +
      "last call's claims. The mock calls it once, so the counts match.",
  },
  {
    key: "actions.window.commissioner_",
    reason:
      "the old commissioner-agent service wrote no `run_actions` rows at all (the golden dump has " +
      "none for its two commissioner runs); `convex/commissioner_agent.ts` records every " +
      "`post_to_forum` as a run action, so the trace shows what the recap posted. Additive.",
  },
  {
    key: "actions.window.trade_a#1.type.respond_to_trade",
    reason: TRADE_INTERLEAVING,
  },
  { key: "actions.window.trade_a#1.committed", reason: TRADE_INTERLEAVING },
  { key: "actions.window.trade_a#1.rejected", reason: TRADE_INTERLEAVING },
  { key: "runs.window.trade_a#1.outcome.", reason: TRADE_INTERLEAVING },
  { key: "runs.window.trade_a#1.steps.", reason: TRADE_INTERLEAVING },
  { key: "trades.count", reason: TRADE_INTERLEAVING },
  { key: "trades.status.", reason: TRADE_INTERLEAVING },
  { key: "messages.count", reason: TRADE_INTERLEAVING },
];

function expectationFor(key: string): string | null {
  return EXPECTED.find((e) => key.startsWith(e.key))?.reason ?? null;
}

// ---------------------------------------------------------------- golden side

type Row = Record<string, unknown>;

function readGolden(table: string): Row[] {
  const file = path.join(GOLDEN, `${table}.json`);
  if (!fs.existsSync(file)) return [];
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  return Array.isArray(parsed) ? (parsed as Row[]) : [parsed as Row];
}

function bump(into: Map<string, number>, key: string, by = 1): void {
  into.set(key, (into.get(key) ?? 0) + by);
}

function goldenMetrics(): Map<string, string> {
  const out = new Map<string, string>();
  const counts = new Map<string, number>();

  const players = readGolden("players");
  const sleeperOf = new Map(players.map((p) => [String(p.id), String(p.sleeper_id ?? p.id)]));
  const teams = readGolden("teams");
  const teamName = new Map(teams.map((t) => [String(t.id), String(t.name)]));
  const windows = readGolden("windows");
  const windowKey = new Map(
    windows.map((w) => [String(w.id), `${String(w.label)}#${Number(w.round_no ?? 1)}`]),
  );

  // -- runs ----------------------------------------------------------------
  const runs = readGolden("runs");
  const runWindow = new Map(runs.map((r) => [String(r.id), windowKey.get(String(r.window_id))!]));
  out.set("runs.total", String(runs.length));
  for (const run of runs) {
    const w = runWindow.get(String(run.id))!;
    bump(counts, `runs.window.${w}.count`);
    bump(counts, `runs.window.${w}.status.${String(run.status)}`);
    bump(counts, `runs.window.${w}.outcome.${String(run.outcome ?? "(none)")}`);
    bump(counts, `runs.window.${w}.steps.${String(run.step_count)}`);
  }

  // -- actions -------------------------------------------------------------
  for (const action of readGolden("run_actions")) {
    const w = runWindow.get(String(action.run_id));
    if (!w) continue;
    bump(counts, `actions.window.${w}.${action.committed_at ? "committed" : "rejected"}`);
    bump(counts, `actions.window.${w}.type.${String(action.action_type)}`);
  }

  // -- lineups (final week-1 version per team) ------------------------------
  const byTeam = new Map<string, Row>();
  for (const lineup of readGolden("lineups")) {
    if (Number(lineup.week_no) !== WEEK_NO) continue;
    const key = String(lineup.team_id);
    const best = byTeam.get(key);
    if (!best || Number(lineup.version) > Number(best.version)) byTeam.set(key, lineup);
  }
  for (const [teamId, lineup] of byTeam) {
    const name = teamName.get(teamId) ?? teamId;
    const slots = (Array.isArray(lineup.slots) ? (lineup.slots as Row[]) : []).map(
      (s) => `${String(s.slot)}:${s.playerId ? (sleeperOf.get(String(s.playerId)) ?? "?") : "-"}`,
    );
    out.set(`lineup.${name}.slots`, slots.join(" "));
    out.set(`lineup.${name}.slotCount`, String(slots.length));
    out.set(`lineup.${name}.source`, String(lineup.source));
    // The old team page rendered the stored slots positionally, so no starter
    // could appear twice. See the `views.team` note in docs/verification/phase5.md.
    out.set(`lineup.${name}.viewDuplicateStarters`, "0");
  }

  // -- waivers -------------------------------------------------------------
  const claims = readGolden("waiver_claims").filter((c) => Number(c.week_no) === WEEK_NO);
  out.set("waivers.count", String(claims.length));
  out.set("waivers.won", String(claims.filter((c) => String(c.status) === "won").length));
  for (const claim of claims) bump(counts, `waivers.status.${String(claim.status)}`);
  for (const claim of claims.filter((c) => String(c.status) === "won")) {
    out.set(
      `waivers.wonBy.${sleeperOf.get(String(claim.add_player_id)) ?? "?"}`,
      teamName.get(String(claim.team_id)) ?? "?",
    );
  }

  // -- trades, threads, messages, forum ------------------------------------
  const trades = readGolden("trades");
  out.set("trades.count", String(trades.length));
  for (const trade of trades) bump(counts, `trades.status.${String(trade.status)}`);

  out.set("threads.count", String(readGolden("threads").length));
  out.set("messages.count", String(readGolden("messages").length));

  const posts = readGolden("forum_posts");
  out.set("forum.posts.count", String(posts.length));
  for (const post of posts) bump(counts, `forum.posts.flair.${String(post.flair)}`);

  // -- transactions --------------------------------------------------------
  for (const tx of readGolden("transactions")) bump(counts, `transactions.type.${String(tx.type)}`);

  // -- usage ---------------------------------------------------------------
  out.set("usage.events", String(readGolden("usage_events").length));

  zeroFillActionCounts(counts);
  for (const [key, value] of counts) out.set(key, String(value));
  return out;
}

/**
 * A window with runs but no rejected action has no `rejected` key at all, which
 * would read as "missing on one side" rather than "zero on both". Give every
 * window that produced runs an explicit committed/rejected pair.
 */
function zeroFillActionCounts(counts: Map<string, number>): void {
  for (const key of [...counts.keys()]) {
    const match = /^runs\.window\.(.+)\.count$/.exec(key);
    if (!match) continue;
    for (const field of ["committed", "rejected"]) {
      const actionKey = `actions.window.${match[1]}.${field}`;
      if (!counts.has(actionKey)) counts.set(actionKey, 0);
    }
  }
}

// ---------------------------------------------------------------- convex side

type Paged<T> = { page: T[]; isDone: boolean; continueCursor: string };

async function paginate<T>(
  fetchPage: (cursor: string | null) => Promise<Paged<T>>,
  cap = 40,
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < cap; i += 1) {
    const page = await fetchPage(cursor);
    out.push(...page.page);
    if (page.isDone) break;
    cursor = page.continueCursor;
  }
  return out;
}

/** Convex player id -> sleeper id, via `players.legacyId` and the golden dump. */
async function sleeperMap(): Promise<Map<string, string>> {
  const goldenSleeper = new Map(
    readGolden("players").map((p) => [String(p.id), String(p.sleeper_id ?? p.id)]),
  );
  const out = new Map<string, string>();
  let cursor: string | null = null;
  for (;;) {
    const page: { map: Record<string, string>; continueCursor: string; isDone: boolean } =
      await client.query(api.seed.lookupLegacy, {
        secret: secret!,
        table: "players",
        cursor,
        numItems: 1_000,
      });
    for (const [legacyId, id] of Object.entries(page.map)) {
      const sleeper = goldenSleeper.get(legacyId);
      if (sleeper) out.set(id, sleeper);
    }
    if (page.isDone) return out;
    cursor = page.continueCursor;
  }
}

type RunItem = {
  id: string;
  windowId: string;
  windowLabel: string;
  weekNo: number;
  status: string;
  outcome: string | null;
  stepCount: number;
};

async function convexMetrics(): Promise<{ metrics: Map<string, string>; extra: Row }> {
  const out = new Map<string, string>();
  const counts = new Map<string, number>();
  const extra: Row = {};

  await signIn();
  const found = await client.query(api.leagues.bySlug, { slug: SLUG });
  if (!found) throw new Error(`League ${SLUG} not found — run scripts/e2e-week.ts first.`);
  const leagueId = found.league._id as unknown as string;
  extra.leagueId = leagueId;

  const sleeperOf = await sleeperMap();

  // -- runs (week 1 plus the week-less commissioner digest) -----------------
  const runs: RunItem[] = [];
  for (const weekNo of [WEEK_NO, 0]) {
    runs.push(
      ...(await paginate<RunItem>(async (cursor) =>
        (await client.query(api.runs.list, {
          leagueId: leagueId as never,
          weekNo,
          paginationOpts: { numItems: 100, cursor },
        })) as unknown as Paged<RunItem>,
      )),
    );
  }
  const windowsOfRun = new Map<string, string>();
  for (const run of runs) {
    // The window round is on the trace detail; the label plus round is the key
    // the golden side uses, and every driven window is round 1.
    windowsOfRun.set(run.id, `${run.windowLabel}#1`);
  }
  out.set("runs.total", String(runs.length));
  for (const run of runs) {
    const w = windowsOfRun.get(run.id)!;
    bump(counts, `runs.window.${w}.count`);
    bump(counts, `runs.window.${w}.status.${run.status}`);
    bump(counts, `runs.window.${w}.outcome.${run.outcome ?? "(none)"}`);
    bump(counts, `runs.window.${w}.steps.${String(run.stepCount)}`);
  }

  // -- actions + usage events, from the trace detail ------------------------
  //
  // The `set_lineup` payload is also read here: it is what the agent actually
  // committed, so it is a better source for the lineup invariant than reading the
  // lineup back through `views.team` (which mis-renders repeated slot labels —
  // see `lineup.*.viewDuplicateStarters` below).
  const committedLineup = new Map<string, string>();
  let usageEvents = 0;
  for (const run of runs) {
    const detail = (await client.query(api.runs.get, { runId: run.id as never })) as unknown as {
      actions: Array<{ actionType: string; committedAt: number | null; payload: Row }>;
      usage: { committedActionCount: number; rejectedActionCount: number };
      team: { name: string } | null;
    };
    for (const action of detail.actions) {
      if (action.actionType !== "set_lineup" || !action.committedAt || !detail.team) continue;
      const slots = (Array.isArray(action.payload.slots) ? (action.payload.slots as Row[]) : []).map(
        (slot) =>
          `${String(slot.slot)}:${slot.playerId ? (sleeperOf.get(String(slot.playerId)) ?? "?") : "-"}`,
      );
      committedLineup.set(detail.team.name, slots.join(" "));
    }
    const w = windowsOfRun.get(run.id)!;
    bump(counts, `actions.window.${w}.committed`, detail.usage.committedActionCount);
    bump(counts, `actions.window.${w}.rejected`, detail.usage.rejectedActionCount);
    for (const action of detail.actions) bump(counts, `actions.window.${w}.type.${action.actionType}`);
    const events = await paginate(async (cursor) =>
      (await client.query(api.runs.usageEvents, {
        runId: run.id as never,
        paginationOpts: { numItems: 100, cursor },
      })) as unknown as Paged<unknown>,
    );
    usageEvents += events.length;
  }
  out.set("usage.events", String(usageEvents));

  // -- lineups --------------------------------------------------------------
  const standings = (await client.query(api.views.standings, {
    leagueId: leagueId as never,
  })) as unknown as Array<{ teamId: string; teamName: string }>;
  for (const team of standings) {
    const page = (await client.query(api.views.team, {
      teamId: team.teamId as never,
    })) as unknown as {
      lineup: Array<{ slot: string; entry: { playerId: string } | null; starting: boolean }>;
      lineupSource: string | null;
      weekNo: number;
    } | null;
    if (!page) continue;
    // `views.team` appends a BENCH row per unassigned roster player; the stored
    // lineup is the starting grid, which is what the golden agent lineup holds.
    const starters = page.lineup.filter((row) => row.starting);
    const slots = starters.map(
      (row) => `${row.slot}:${row.entry ? (sleeperOf.get(row.entry.playerId) ?? "?") : "-"}`,
    );
    const filled = starters.map((row) => row.entry?.playerId).filter(Boolean) as string[];
    out.set(`lineup.${team.teamName}.slots`, committedLineup.get(team.teamName) ?? slots.join(" "));
    out.set(`lineup.${team.teamName}.slotCount`, String(slots.length));
    out.set(
      `lineup.${team.teamName}.viewDuplicateStarters`,
      String(filled.length - new Set(filled).size),
    );
    out.set(`lineup.${team.teamName}.source`, String(page.lineupSource ?? "(none)"));
    extra[`lineupWeek.${team.teamName}`] = page.weekNo;
  }

  // -- waivers --------------------------------------------------------------
  const waivers = (await client.query(api.waivers.results, {
    leagueId: leagueId as never,
    weekNo: WEEK_NO,
  })) as unknown as {
    results: Array<{ teamName: string; addPlayerId: string; status: string; bid: number }>;
  };
  out.set("waivers.count", String(waivers.results.length));
  out.set("waivers.won", String(waivers.results.filter((r) => r.status === "won").length));
  for (const claim of waivers.results) bump(counts, `waivers.status.${claim.status}`);
  for (const claim of waivers.results.filter((r) => r.status === "won")) {
    out.set(`waivers.wonBy.${sleeperOf.get(claim.addPlayerId) ?? "?"}`, claim.teamName);
  }

  // -- trades ---------------------------------------------------------------
  const trades = (await client.query(api.trades.list, {
    leagueId: leagueId as never,
    limit: 100,
  })) as unknown as Array<{ id: string; status: string }>;
  out.set("trades.count", String(trades.length));
  for (const trade of trades) bump(counts, `trades.status.${trade.status}`);

  // -- threads and messages -------------------------------------------------
  const threads = (await client.query(api.messaging.listThreads, {
    leagueId: leagueId as never,
    limit: 100,
  })) as unknown as Array<{ id: string }>;
  out.set("threads.count", String(threads.length));
  let messages = 0;
  for (const thread of threads) {
    const view = (await client.query(api.messaging.getThread, {
      leagueId: leagueId as never,
      threadId: thread.id as never,
      paginationOpts: { numItems: 100, cursor: null },
    })) as unknown as { messages: Paged<unknown> };
    messages += view.messages.page.length;
  }
  out.set("messages.count", String(messages));

  // -- forum ----------------------------------------------------------------
  const posts = await paginate(async (cursor) =>
    (await client.query(api.forum.list, {
      leagueId: leagueId as never,
      sort: "new",
      paginationOpts: { numItems: 50, cursor },
    })) as unknown as Paged<{ flair: string }>,
  );
  out.set("forum.posts.count", String(posts.length));
  for (const post of posts) bump(counts, `forum.posts.flair.${post.flair}`);

  // -- transactions ---------------------------------------------------------
  const txs = await paginate(async (cursor) =>
    (await client.query(api.transactions.list, {
      leagueId: leagueId as never,
      paginationOpts: { numItems: 200, cursor },
    })) as unknown as Paged<{ type: string }>,
  );
  for (const tx of txs) bump(counts, `transactions.type.${tx.type}`);

  // -- ledger reconciliation ------------------------------------------------
  const verify = (await client.action(api.ledger.verify, {
    leagueId: leagueId as never,
    weekNo: WEEK_NO,
  })) as unknown as {
    ok: boolean;
    league: { ok: boolean; diffs: unknown[] };
    teams: Array<{ teamName: string; ok: boolean; diffs: unknown[] }>;
  };
  extra.ledgerVerify = verify;
  out.set("ledger.rollupsMatchEvents", verify.ok ? "true" : "false");

  zeroFillActionCounts(counts);
  for (const [key, value] of counts) out.set(key, String(value));
  return { metrics: out, extra };
}

// --------------------------------------------------------------------- diff

async function main(): Promise<void> {
  process.stdout.write(`golden: tests/golden/postgres-week1  new: ${SLUG} @ ${url}\n\n`);
  const golden = goldenMetrics();
  // The reconciliation invariant has no golden counterpart (the old system had no
  // rollup tables); it is asserted directly.
  golden.set("ledger.rollupsMatchEvents", "true");

  const { metrics: actual, extra } = await convexMetrics();

  const keys = [...new Set([...golden.keys(), ...actual.keys()])].sort();
  const rows: Array<{ key: string; golden: string; actual: string; verdict: string; reason?: string }> =
    [];
  let unexplained = 0;
  let explained = 0;

  for (const key of keys) {
    const g = golden.get(key) ?? "—";
    const a = actual.get(key) ?? "—";
    if (g === a) {
      rows.push({ key, golden: g, actual: a, verdict: "match" });
      continue;
    }
    const reason = expectationFor(key);
    if (reason) {
      explained += 1;
      rows.push({ key, golden: g, actual: a, verdict: "EXPECTED", reason });
    } else {
      unexplained += 1;
      rows.push({ key, golden: g, actual: a, verdict: "MISMATCH" });
    }
  }

  const width = Math.max(...rows.map((r) => r.key.length));
  const trunc = (value: string) => (value.length > 70 ? `${value.slice(0, 67)}...` : value);
  process.stdout.write(
    `${"invariant".padEnd(width)}  ${"golden".padEnd(24)}  ${"new".padEnd(24)}  verdict\n`,
  );
  process.stdout.write(`${"-".repeat(width)}  ${"-".repeat(24)}  ${"-".repeat(24)}  -------\n`);
  for (const row of rows) {
    process.stdout.write(
      `${row.key.padEnd(width)}  ${trunc(row.golden).padEnd(24)}  ${trunc(row.actual).padEnd(24)}  ${row.verdict}\n`,
    );
  }

  const reasons = [...new Set(rows.filter((r) => r.reason).map((r) => r.reason!))];
  if (reasons.length > 0) {
    process.stdout.write("\nexpected differences:\n");
    for (const reason of reasons) process.stdout.write(`  - ${reason}\n`);
  }

  const unusedExpectations = EXPECTED.filter(
    (e) => !rows.some((r) => r.verdict === "EXPECTED" && r.key.startsWith(e.key)),
  );
  if (unusedExpectations.length > 0) {
    process.stdout.write("\nexpected differences that did NOT occur (the systems agree here):\n");
    for (const e of unusedExpectations) process.stdout.write(`  - ${e.key}: ${e.reason}\n`);
  }

  process.stdout.write(
    `\n${rows.filter((r) => r.verdict === "match").length} match, ${explained} expected, ${unexplained} unexplained\n`,
  );

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ slug: SLUG, rows, extra }, null, 2));
  process.stdout.write(`report written to ${OUT}\n`);

  if (unexplained > 0) process.exit(1);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
