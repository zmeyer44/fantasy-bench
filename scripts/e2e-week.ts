/**
 * Phase 5 §11 "End-to-end": drive a simulated week 1 through the Convex runtime
 * and leave it in a state `scripts/golden-diff.ts` can compare with
 * `tests/golden/postgres-week1/*.json`.
 *
 *   npm run seed:convex                                   # once, golden data present
 *   npx tsx --env-file=.env.local scripts/e2e-week.ts     # import + drive
 *   npx tsx --env-file=.env.local scripts/golden-diff.ts  # compare
 *
 * ## Why a second league rather than a reset
 *
 * The golden dump already contains the old system's runs, so re-driving the demo
 * league would diff new behaviour against a league that has already acted. The
 * brief's first option is `seed.reset` + `npm run seed:convex` with a
 * "skip the run/social/waiver tables" flag — `scripts/seed-convex.ts` has no such
 * flag, and `seed.reset` wipes every app table on a deployment several people
 * share. So this takes the brief's fallback: it re-imports the golden league's
 * **pre-run** tables under a new slug (`e2e-league`) and drives that.
 *
 * Imported: leagues, league_rules, league_members, teams, weeks, matchups,
 * agent_configs, config_versions (pinned to `mock/scripted`), roster_slots,
 * draft_picks, the 180 draft transactions, the week-1 `draft_default` lineups and
 * every week-1 window. Deliberately not imported: runs, run_steps, run_actions,
 * usage_events, waiver_claims, trades, threads, messages, forum posts,
 * transactions of type add/drop/trade, snapshots — the system produces those.
 * `players`, `player_projections`, `player_projection_latest`, `nfl_games`,
 * `model_prices` and `skills` are league-independent and already on the
 * deployment; this script reuses them through the seed's id map
 * (`.cache/seed-map.<deployment>.json`, written by `npm run seed:convex`).
 *
 * ## What it drives
 *
 * The same three windows `scripts/smoke-e2e.ts` drove against Postgres, in the
 * same order — `lineup_weekly#1`, `waiver#1`, `trade_a#1` — each
 * `windows:openNow` -> wait for every run terminal -> `windows:closeNow`, then
 * `commissioner_agent:runWeekly` for week 1. Those internal mutations/actions are
 * reached through `npx convex run` because `ConvexHttpClient` cannot call
 * `internal.*` and nothing may be added to `convex/`.
 *
 * Re-runnable: pass `--slug=e2e-league-2` for a fresh league. Re-running with the
 * same slug re-uses the league it finds (its own rows are remembered in
 * `.cache/seed-map.<deployment>.<slug>.json`) and would drive windows that already
 * ran, which is why `drive` refuses when the target window already has runs unless
 * `--force` is given.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { ConvexHttpClient } from "convex/browser";

import { api } from "../convex/_generated/api";
import { readIdMap, seedMapFile, setTable, tableMap, writeIdMap, type IdMap } from "./seed-map";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GOLDEN = path.join(ROOT, "tests", "golden", "postgres-week1");

// ------------------------------------------------------------------- options

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

const COMMAND = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "all";
const SLUG = arg("slug") ?? "e2e-league";
const WEEK_NO = Number(arg("week") ?? 1);
const FORCE = process.argv.includes("--force");
const POLL_MS = Number(arg("poll") ?? 5_000);
const TIMEOUT_MS = Number(arg("timeout") ?? 15 * 60_000);
const STATE_FILE = arg("state") ?? path.join(ROOT, ".cache", "e2e-week.json");
/** The windows the old harness drove, in the old harness's order. */
const DRIVE: Array<{ label: string; roundNo: number }> = [
  { label: "lineup_weekly", roundNo: 1 },
  { label: "waiver", roundNo: 1 },
  { label: "trade_a", roundNo: 1 },
];

const url = process.env.NEXT_PUBLIC_CONVEX_URL;
const deployment = process.env.CONVEX_DEPLOYMENT;
const secret = process.env.SEED_SECRET;
if (!url) throw new Error("NEXT_PUBLIC_CONVEX_URL is not set (see .env.local).");
if (!secret) throw new Error("SEED_SECRET is not set (see .env.local).");
if (url.includes("content-ant")) {
  throw new Error("Refusing to run against the load-test deployment; this belongs on dev.");
}

const client = new ConvexHttpClient(url);

const startedAt = Date.now();
const elapsed = () => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
function log(line: string): void {
  process.stdout.write(`[${elapsed()}] ${line}\n`);
}

// --------------------------------------------------------------- golden input

type Row = Record<string, unknown>;

function readGolden(table: string): Row[] {
  const file = path.join(GOLDEN, `${table}.json`);
  if (!fs.existsSync(file)) return [];
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  const rows = Array.isArray(parsed) ? (parsed as Row[]) : [parsed as Row];
  if (!rows.length || rows[0].created_at === undefined) return rows;
  return rows
    .map((row, index) => ({ row, index, at: ms(row.created_at) ?? 0 }))
    .sort((a, b) => a.at - b.at || a.index - b.index)
    .map((entry) => entry.row);
}

function ms(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "number") return value;
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? undefined : parsed;
}

function msRequired(value: unknown, fallback: number): number {
  return ms(value) ?? fallback;
}

function num(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function numOr(value: unknown, fallback: number): number {
  return num(value) ?? fallback;
}

function str(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

/** Convex has no `undefined` on the wire; drop the keys rather than send nulls. */
function clean(row: Row): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) if (value !== undefined) out[key] = value;
  return out;
}

// ------------------------------------------------------------------ id maps

/**
 * Two id maps, both on disk (`scripts/seed-map.ts`): the seed's, for the
 * league-independent rows this script reuses, and this slug's own, so a re-run
 * recognises the rows it created last time.
 */
const BASE_MAP: IdMap = readIdMap(seedMapFile(ROOT));
const OWN_MAP_FILE = seedMapFile(ROOT, SLUG);
const ownMap: IdMap = readIdMap(OWN_MAP_FILE);

const maps = new Map<string, Map<string, string>>();
function mapOf(table: string): Map<string, string> {
  let found = maps.get(table);
  if (!found) {
    found = tableMap(ownMap, table);
    maps.set(table, found);
  }
  return found;
}

/** Persist this run's own map, so a re-run under the same slug resumes. */
function saveOwnMap(): void {
  for (const [table, m] of maps) setTable(ownMap, table, m);
  writeIdMap(OWN_MAP_FILE, ownMap);
}

function ref(table: string, goldenId: unknown): string {
  const id = mapOf(table).get(String(goldenId));
  if (!id) throw new Error(`No imported ${table} for golden id ${String(goldenId)}`);
  return id;
}

function refOpt(table: string, goldenId: unknown): string | undefined {
  if (goldenId === null || goldenId === undefined) return undefined;
  return mapOf(table).get(String(goldenId));
}

// ----------------------------------------------------------- convex plumbing

/** Pull one league-independent table out of the seed's map. */
function loadFromSeedMap(table: string): void {
  const target = mapOf(table);
  for (const [goldenId, id] of Object.entries(BASE_MAP[table] ?? {})) {
    if (!target.has(goldenId)) target.set(goldenId, id);
  }
}

/** Insert rows this run owns; anything already in this slug's map is skipped. */
async function importRows(table: string, rows: Row[], batchSize = 400): Promise<void> {
  const known = mapOf(table);
  const pending = rows.filter((row) => !known.has(String(row.__golden)));
  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    const { ids } = await client.mutation(api.seed.importBatch, {
      secret: secret!,
      table,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- __golden is the local dedupe key, never a column
      rows: batch.map(({ __golden, ...rest }) => rest),
    });
    batch.forEach((row, index) => known.set(String(row.__golden), ids[index]));
  }
  saveOwnMap();
  process.stdout.write(
    `  ${table.padEnd(20)} ${String(rows.length).padStart(4)} rows` +
      (pending.length === rows.length ? "\n" : ` (${rows.length - pending.length} already present)\n`),
  );
}

async function patchRows(table: string, rows: Array<{ id: string; patch: Row }>): Promise<void> {
  for (let i = 0; i < rows.length; i += 200) {
    await client.mutation(api.seed.patchBatch, {
      secret: secret!,
      table: table as never,
      rows: rows.slice(i, i + 200),
    });
  }
}

async function convexRun(fn: string, args: unknown): Promise<unknown> {
  const { stdout } = await execFileAsync("npx", ["convex", "run", fn, JSON.stringify(args)], {
    cwd: ROOT,
    env: { ...process.env, ...(deployment ? { CONVEX_DEPLOYMENT: deployment } : {}) },
    maxBuffer: 16 * 1024 * 1024,
  });
  const text = stdout.trim();
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  try {
    return JSON.parse(text.slice(start)) as unknown;
  } catch {
    return { raw: text };
  }
}

// -------------------------------------------------------------------- import

async function importLeague(): Promise<string> {
  log(`importing the golden league as "${SLUG}"`);

  const existing = await client.query(api.leagues.bySlug, { slug: SLUG });
  if (existing) {
    if (!Object.keys(ownMap).length) {
      throw new Error(
        `League "${SLUG}" exists on the deployment but ${OWN_MAP_FILE} is missing, so this run ` +
          `cannot tell which rows it already created and would import them a second time. ` +
          `Use --slug=<new-slug> for a fresh league.`,
      );
    }
    log(`league ${SLUG} already exists (${existing.league._id}) — reusing it`);
  }

  // League-independent rows already on the deployment, from the seed's id map.
  loadFromSeedMap("players");
  loadFromSeedMap("skills");
  log(`resolved ${mapOf("players").size} players, ${mapOf("skills").size} skills`);

  const demo = await client.query(api.users.byEmailPublic, {
    secret: secret!,
    email: "demo@fantasybench.dev",
  });
  if (!demo) throw new Error("Demo user is missing — run `npm run seed:convex` first.");
  const userId = demo.userId;
  const goldenUserId = String(readGolden("users")[0].id);
  mapOf("users").set(goldenUserId, userId);

  const now = Date.now();

  // -- league core ---------------------------------------------------------
  await importRows(
    "leagues",
    readGolden("leagues").map((row) =>
      clean({
        __golden: row.id,
        name: `E2E ${String(row.name)}`,
        slug: SLUG,
        commissionerUserId: ref("users", row.commissioner_user_id),
        season: numOr(row.season, 2026),
        teamCount: numOr(row.team_count, 12),
        isPublic: true,
        status: String(row.status),
        draftType: String(row.draft_type),
        draftScheduledAt: ms(row.draft_scheduled_at),
        // `leagues.by_joinCode` is a `.unique()` lookup; a duplicate code would
        // break `leagues.byJoinCode` for reasons unrelated to this test.
        joinCode: undefined,
        createdAt: msRequired(row.created_at, now),
        updatedAt: now,
      }),
    ),
  );

  await importRows(
    "league_rules",
    readGolden("league_rules").map((row) =>
      clean({
        __golden: row.id,
        leagueId: ref("leagues", row.league_id),
        scoringPreset: String(row.scoring_preset),
        superflex: row.superflex === true,
        tePremium: row.te_premium === true,
        rosterSlots: row.roster_slots,
        faabBudget: numOr(row.faab_budget, 100),
        playoffTeams: numOr(row.playoff_teams, 6),
        playoffStartWeek: numOr(row.playoff_start_week, 15),
        regularSeasonWeeks: numOr(row.regular_season_weeks, 14),
        seasonWeeks: numOr(row.season_weeks, 17),
        transparencyMode: String(row.transparency_mode),
        injectionPolicy: String(row.injection_policy),
        modelAllowlist: row.model_allowlist ?? [],
        fallbackModelId: str(row.fallback_model_id),
        weeklyTokenCapPerTeam: num(row.weekly_token_cap_per_team),
        leagueUsdHardCap: num(row.league_usd_hard_cap),
        contextCharLimit: numOr(row.context_char_limit, 8_000),
        maxStepsCap: numOr(row.max_steps_cap, 30),
        editLock: row.edit_lock,
        windowOverrides: row.window_overrides ?? undefined,
        tradeReviewHours: numOr(row.trade_review_hours, 24),
        fairnessFloor: num(row.fairness_floor),
        antiChurnWeeks: numOr(row.anti_churn_weeks, 3),
        maxOpenProposals: numOr(row.max_open_proposals, 3),
        maxMessagesPerRun: numOr(row.max_messages_per_run, 6),
        maxThreadsPerWindow: numOr(row.max_threads_per_window, 4),
        forumPostsPerDay: numOr(row.forum_posts_per_day, 2),
        forumCommentsPerDay: numOr(row.forum_comments_per_day, 6),
        safetyAutopilot: row.safety_autopilot === true,
        rulesLockedAt: ms(row.rules_locked_at),
        runWallclockSeconds: numOr(row.run_wallclock_seconds, 300),
        draftPickSeconds: numOr(row.draft_pick_seconds, 240),
        reuseSnapshotWithinMs: numOr(row.reuse_snapshot_within_ms, 600_000),
        draftBudget: numOr(row.draft_budget, 200),
      }),
    ),
  );

  await importRows(
    "league_members",
    readGolden("league_members").map((row) =>
      clean({
        __golden: row.id,
        leagueId: ref("leagues", row.league_id),
        userId: ref("users", row.user_id),
        role: String(row.role),
        createdAt: ms(row.created_at),
      }),
    ),
  );

  await importRows(
    "teams",
    readGolden("teams").map((row) =>
      clean({
        __golden: row.id,
        leagueId: ref("leagues", row.league_id),
        ownerUserId: refOpt("users", row.owner_user_id),
        name: String(row.name),
        abbreviation: String(row.abbreviation),
        faabRemaining: numOr(row.faab_remaining, 0),
        waiverPriority: numOr(row.waiver_priority, 0),
        karma: numOr(row.karma, 0),
        draftBudgetRemaining: numOr(row.draft_budget_remaining, 0),
        createdAt: ms(row.created_at),
      }),
    ),
  );

  await importRows(
    "weeks",
    readGolden("weeks").map((row) =>
      clean({
        __golden: row.id,
        leagueId: ref("leagues", row.league_id),
        weekNo: numOr(row.week_no, 0),
        startsAt: msRequired(row.starts_at, 0),
        endsAt: msRequired(row.ends_at, 0),
        isPlayoff: row.is_playoff === true,
        status: String(row.status),
      }),
    ),
  );

  await importRows(
    "matchups",
    readGolden("matchups").map((row) =>
      clean({
        __golden: row.id,
        leagueId: ref("leagues", row.league_id),
        weekNo: numOr(row.week_no, 0),
        homeTeamId: ref("teams", row.home_team_id),
        awayTeamId: ref("teams", row.away_team_id),
        homeScore: num(row.home_score),
        awayScore: num(row.away_score),
        isFinal: row.is_final === true,
      }),
    ),
  );

  // -- agent configs (pinned to the mock model) -----------------------------
  const configs = readGolden("agent_configs");
  const versions = readGolden("config_versions");
  const versionSkills = readGolden("config_version_skills");
  const teamByConfig = new Map(configs.map((row) => [String(row.id), String(row.team_id)]));

  await importRows(
    "agent_configs",
    configs.map((row) =>
      clean({
        __golden: row.id,
        teamId: ref("teams", row.team_id),
        leagueId: ref("leagues", readGolden("teams").find((t) => t.id === row.team_id)!.league_id),
        noteToAgent: str(row.note_to_agent),
        createdAt: ms(row.created_at),
        updatedAt: ms(row.updated_at),
      }),
    ),
  );

  const skillIdsByVersion = new Map<string, string[]>();
  for (const row of [...versionSkills].sort((a, b) => numOr(a.position, 0) - numOr(b.position, 0))) {
    const skillId = refOpt("skills", row.skill_id);
    if (!skillId) continue;
    const key = String(row.config_version_id);
    skillIdsByVersion.set(key, [...(skillIdsByVersion.get(key) ?? []), skillId]);
  }

  await importRows(
    "config_versions",
    versions.map((row) => {
      const goldenTeamId = teamByConfig.get(String(row.config_id))!;
      return clean({
        __golden: row.id,
        configId: ref("agent_configs", row.config_id),
        teamId: ref("teams", goldenTeamId),
        leagueId: ref("leagues", readGolden("teams").find((t) => t.id === goldenTeamId)!.league_id),
        versionNo: numOr(row.version_no, 1),
        contextMd: String(row.context_md),
        // The whole point of the e2e run: every team on the deterministic mock.
        modelId: "mock/scripted",
        harness: row.harness,
        skillIds: skillIdsByVersion.get(String(row.id)) ?? [],
        createdByUserId: refOpt("users", row.created_by_user_id),
        appliedAt: ms(row.applied_at),
        changeSummary: str(row.change_summary),
        createdAt: ms(row.created_at),
      });
    }),
  );

  await patchRows(
    "agent_configs",
    configs.map((row) => ({
      id: ref("agent_configs", row.id),
      patch: clean({ currentVersionId: refOpt("config_versions", row.current_version_id) }),
    })),
  );

  // -- roster, draft, the pre-run lineups -----------------------------------
  const goldenTeams = readGolden("teams");
  const leagueOfTeam = (teamId: unknown) =>
    ref("leagues", goldenTeams.find((t) => String(t.id) === String(teamId))!.league_id);

  await importRows(
    "roster_slots",
    readGolden("roster_slots").map((row) =>
      clean({
        __golden: row.id,
        leagueId: leagueOfTeam(row.team_id),
        teamId: ref("teams", row.team_id),
        playerId: ref("players", row.player_id),
        acquiredAt: msRequired(row.acquired_at, 0),
        acquiredVia: String(row.acquired_via),
      }),
    ),
  );

  await importRows(
    "draft_picks",
    readGolden("draft_picks").map((row) =>
      clean({
        __golden: row.id,
        leagueId: ref("leagues", row.league_id),
        round: numOr(row.round, 0),
        pickNo: numOr(row.pick_no, 0),
        overallNo: numOr(row.overall_no, 0),
        teamId: ref("teams", row.team_id),
        playerId: refOpt("players", row.player_id),
        price: num(row.price),
        auto: row.auto === true,
        rationale: str(row.rationale),
        madeAt: ms(row.made_at),
      }),
    ),
  );

  // Only the draft transactions: `add`/`drop`/`trade` rows are what the run writes.
  await importRows(
    "transactions",
    readGolden("transactions")
      .filter((row) => String(row.type) === "draft")
      .map((row) =>
        clean({
          __golden: row.id,
          leagueId: ref("leagues", row.league_id),
          teamId: ref("teams", row.team_id),
          type: String(row.type),
          weekNo: num(row.week_no),
          playerId: refOpt("players", row.player_id),
          details: { source: "draft" },
        }),
      ),
  );

  // Only the `draft_default` v1 lineups; the agent writes v2.
  await importRows(
    "lineups",
    readGolden("lineups")
      .filter((row) => String(row.source) === "draft_default")
      .map((row) =>
        clean({
          __golden: row.id,
          teamId: ref("teams", row.team_id),
          leagueId: leagueOfTeam(row.team_id),
          weekNo: numOr(row.week_no, 0),
          version: numOr(row.version, 1),
          slots: (Array.isArray(row.slots) ? (row.slots as Row[]) : []).map((slot) => ({
            slot: String(slot.slot),
            playerId: slot.playerId ? ref("players", slot.playerId) : null,
          })),
          source: String(row.source),
        }),
      ),
  );

  // -- windows: week 1 only, all reset to `scheduled` with no snapshot -------
  await importRows(
    "windows",
    readGolden("windows")
      .filter((row) => num(row.week_no) === WEEK_NO)
      .map((row) =>
        clean({
          __golden: row.id,
          leagueId: ref("leagues", row.league_id),
          type: String(row.type),
          label: String(row.label),
          weekNo: num(row.week_no) ?? 0,
          roundNo: numOr(row.round_no, 1),
          opensAt: msRequired(row.opens_at, 0),
          submissionDeadlineAt: msRequired(row.submission_deadline_at, 0),
          closesAt: msRequired(row.closes_at, 0),
          status: "scheduled",
          scope: windowScope(row.scope),
          runCount: 0,
          terminalRunCount: 0,
        }),
      ),
  );

  const leagueId = ref("leagues", readGolden("leagues")[0].id);
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify({ slug: SLUG, leagueId, url, weekNo: WEEK_NO, importedAt: Date.now() }, null, 2),
  );
  log(`league ${SLUG} = ${leagueId} (state written to ${STATE_FILE})`);
  return leagueId;
}

/** The subset of the old `windows.scope` blob the Convex validator carries. */
function windowScope(scope: unknown): Row {
  const raw = (scope ?? {}) as Row;
  const out: Row = {};
  if (Array.isArray(raw.gameDays)) out.gameDays = raw.gameDays;
  if (Array.isArray(raw.slots)) out.slots = raw.slots;
  if (num(raw.pickNo) !== undefined) out.pickNo = num(raw.pickNo);
  if (num(raw.rounds) !== undefined) out.rounds = num(raw.rounds);
  if (num(raw.roundNo) !== undefined) out.round = num(raw.roundNo);
  if (num(raw.round) !== undefined) out.round = num(raw.round);
  if (num(raw.lotNo) !== undefined) out.lotNo = num(raw.lotNo);
  if (typeof raw.phase === "string") out.phase = raw.phase;
  if (typeof raw.draftType === "string") out.draftType = raw.draftType;
  return out;
}

// --------------------------------------------------------------------- drive

type WindowView = {
  id: string;
  label: string;
  roundNo: number;
  status: string;
  runCount: number;
  terminalRunCount: number;
  submissionDeadlineAt: number;
  closesAt: number;
};

type RunItem = {
  id: string;
  windowId: string;
  windowLabel: string;
  status: string;
  outcome: string | null;
  stepCount: number;
  teamId: string | null;
};

const TERMINAL = new Set(["succeeded", "partial", "failed", "timed_out", "fallback", "skipped"]);

async function windowsForWeek(leagueId: string): Promise<WindowView[]> {
  return (await client.query(api.windows.forWeek, {
    leagueId: leagueId as never,
    weekNo: WEEK_NO,
  })) as unknown as WindowView[];
}

async function runsOfWindow(leagueId: string, windowId: string): Promise<RunItem[]> {
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

async function driveWindow(leagueId: string, label: string, roundNo: number): Promise<void> {
  const before = (await windowsForWeek(leagueId)).find(
    (w) => w.label === label && w.roundNo === roundNo,
  );
  if (!before) throw new Error(`No window ${label}#${roundNo} in week ${WEEK_NO}`);
  if (before.runCount > 0 && !FORCE) {
    throw new Error(
      `${label}#${roundNo} already has ${before.runCount} runs — use --slug= for a fresh league, or --force.`,
    );
  }

  const t0 = Date.now();
  const opened = (await convexRun("windows:openNow", {
    leagueId,
    label,
    weekNo: WEEK_NO,
    roundNo,
  })) as { windowId: string; opened: boolean; snapshotId: string | null };
  log(`opened ${label}#${roundNo} -> window ${opened.windowId} (snapshot ${opened.snapshotId})`);

  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    const runs = await runsOfWindow(leagueId, opened.windowId);
    const terminal = runs.filter((r) => TERMINAL.has(r.status)).length;
    log(`  ${label}: ${runs.length} runs, ${terminal} terminal`);
    if (runs.length > 0 && terminal === runs.length) break;
    if (Date.now() - t0 > TIMEOUT_MS) throw new Error(`${label}: runs did not finish in time`);
  }

  const closed = await convexRun("windows:closeNow", { windowId: opened.windowId });
  log(`closed ${label}#${roundNo}: ${JSON.stringify(closed)}`);
  // `close` schedules waiver processing / trade expiry / metrics as separate
  // transactions; give them a moment to land before the next window opens.
  await new Promise((resolve) => setTimeout(resolve, 15_000));
}

async function drive(leagueId: string): Promise<void> {
  for (const { label, roundNo } of DRIVE) await driveWindow(leagueId, label, roundNo);

  log("running the weekly commissioner tasks");
  const results = await convexRun("commissioner_agent:runWeekly", { leagueId, weekNo: WEEK_NO });
  log(`commissioner: ${JSON.stringify(results)}`);
  // The recap posts through scheduled mutations too.
  await new Promise((resolve) => setTimeout(resolve, 10_000));

  const windows = await windowsForWeek(leagueId);
  process.stdout.write("\nwindows after the run:\n");
  for (const w of windows.filter((x) => x.runCount > 0)) {
    process.stdout.write(
      `  ${`${w.label}#${w.roundNo}`.padEnd(24)} ${w.status.padEnd(10)} runs ${w.runCount} terminal ${w.terminalRunCount}\n`,
    );
  }
}

// ---------------------------------------------------------------------- main

async function resolveLeagueId(): Promise<string> {
  const found = await client.query(api.leagues.bySlug, { slug: SLUG });
  if (!found) throw new Error(`League ${SLUG} not found — run the import first.`);
  return found.league._id as unknown as string;
}

async function main(): Promise<void> {
  log(`${COMMAND} on ${url} (slug ${SLUG})`);
  if (COMMAND === "import") {
    await importLeague();
    return;
  }
  if (COMMAND === "drive") {
    await drive(await resolveLeagueId());
    return;
  }
  if (COMMAND === "all") {
    await drive(await importLeague());
    return;
  }
  throw new Error(`Unknown command "${COMMAND}". Use: import | drive | all`);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
