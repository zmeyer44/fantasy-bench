/**
 * Seed a load-test deployment: 50 leagues x 12 teams x a full 17-week season.
 *
 *   CONVEX_DEPLOYMENT=dev:content-ant-382 \
 *   NEXT_PUBLIC_CONVEX_URL=https://content-ant-382.convex.cloud \
 *   SEED_SECRET=... npx tsx scripts/loadtest-seed.ts
 *
 * Flags: `--leagues=N` (default 50), `--from=I` (resume at league index I),
 * `--skip-players` (the shared player pool is already imported).
 *
 * This exists for the §11 "Limits" check: every public query has to keep working
 * when a deployment holds fifty seasons rather than one week of one league. The
 * golden dump (`tests/golden/postgres-week1/*.json`) is the template — its rules,
 * roster layout, team names, player pool and snapshot payload — and everything
 * else is generated deterministically per league (`mulberry32` seeded by the
 * league index), so a re-run produces the same rows.
 *
 * It writes through the same `seed.importBatch` mutation `scripts/seed-convex.ts`
 * uses (SEED_SECRET-guarded, <= 400 rows per call), so nothing here can run
 * against a deployment that has not opted in.
 *
 * **Resumable.** A league is finished when its `joinCode` starts with
 * `LOADTEST-DONE-`; `--from` skips by index and finished leagues are skipped
 * automatically.
 *
 * **The deployment runs the real scheduler.** `convex/crons.ts` ticks every five
 * to fifteen minutes, and `season.tickAll` fans out over every `in_season` league,
 * which ends in `windows.open` -> `windows.dispatch` -> the Workpool executing
 * agent runs. Those runs write `runs`, `run_steps` and the rollups underneath a
 * bulk import and make it fail with `OptimisticConcurrencyControlFailure`. Set the
 * two documented kill switches on the deployment before seeding:
 *
 *   CONVEX_DEPLOYMENT=... npx convex env set RUN_DISPATCH skip
 *   CONVEX_DEPLOYMENT=... npx convex env set INGEST_DISABLED 1
 *
 * Sizing (per league): 12 teams, 17 weeks, 306 windows, 102 matchups, 204 team
 * results, 180 roster slots, 204 lineups, 180 draft picks, 612 runs x 4 steps,
 * 2 448 usage events, 612 actions, 612 search docs, one oversized
 * `run_step_payloads` row (so `runs.stepPayload` has something to read — nothing
 * else generated here crosses the 64 KB inline limit), 204 waiver claims, 204
 * transactions, 68 trades + 136 events, 68 threads / 272 messages, 51 posts / 153
 * comments / 255 votes, the three rollups and `team_standings`. Roughly 9 900
 * documents per league; x50 ~ 495 000.
 *
 * The one place this deliberately undershoots the brief is snapshots. The brief
 * asks for one snapshot per lineup window (4/week => 68/league); the golden
 * snapshot payload is 479 KB, so that is 32 MB of `snapshot_chunks` per league and
 * 1.6 GB overall — hours of upload. `SNAPSHOT_WINDOWS_PER_LEAGUE` caps it at the
 * final week's four lineup windows (~96 MB total). Nothing is lost for the limits
 * question: every snapshot read is scoped to one snapshot's chunks by
 * `snapshot_chunks.by_snapshotId_kind_part`, so the per-read size is the same
 * whether a league holds 4 snapshots or 68.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ConvexHttpClient } from "convex/browser";

import { api } from "../convex/_generated/api";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GOLDEN = path.join(ROOT, "tests", "golden", "postgres-week1");

// --------------------------------------------------------------------- sizing

const LEAGUE_COUNT = Number(arg("leagues") ?? 50);
const FROM_INDEX = Number(arg("from") ?? 0);
const SKIP_PLAYERS = process.argv.includes("--skip-players");
/** Wipe every app table first (SEED_SECRET-guarded, loadtest deployment only). */
const RESET = process.argv.includes("--reset");

const TEAMS = 12;
const WEEKS = 17;
/** 4 lineup + 1 waiver + 6 trade + 5 forum + 2 commissioner. */
const WINDOWS_PER_WEEK = 18;
/** Windows that produce one run per team: the waiver, the first lineup, one trade. */
const RUN_WINDOWS_PER_WEEK = 3;
const STEPS_PER_RUN = 4;
const ROSTER_SIZE = 15;
/** Players a snapshot payload carries (rostered + free agents), from the golden one. */
const SNAPSHOT_PLAYERS = 430;
const SNAPSHOT_PLAYERS_PER_CHUNK = 100;
const SNAPSHOT_WINDOWS_PER_LEAGUE = 4;
const TRADES_PER_WEEK = 4;
const THREADS_PER_WEEK = 4;
const MESSAGES_PER_THREAD = 4;
const POSTS_PER_WEEK = 3;
const COMMENTS_PER_POST = 3;
const VOTES_PER_POST = 5;
/**
 * Completion marker, written into `leagues.joinCode`. It is unique per league:
 * `leagues.by_joinCode` is a `.unique()` lookup, so fifty leagues sharing one code
 * would make `leagues.byJoinCode` throw for reasons that have nothing to do with
 * the limits under test.
 */
const DONE_PREFIX = "LOADTEST-DONE-";

const MODEL_IDS = ["mock/scripted", "anthropic/claude-sonnet-4.5", "openai/gpt-5-mini"];
const PROVIDER_OF: Record<string, string> = {
  "mock/scripted": "mock",
  "anthropic/claude-sonnet-4.5": "anthropic",
  "openai/gpt-5-mini": "openai",
};

/**
 * Tables `--reset` clears, most dependent first (only for readability; `clearTable`
 * has no referential integrity).
 *
 * `snapshot_chunks` is deliberately **last**, because clearing it fails:
 * `seed.clearTable` reads `.take(1000)` before deleting, and a snapshot chunk is
 * ~100 KB, so 1 000 of them is ~100 MB against Convex's 16 MiB per-transaction read
 * limit ("Too many bytes read in a single function execution"). `resetAll` reports
 * the failure and carries on; the orphaned chunks are unreachable (their
 * `snapshots` rows are gone) and cost only storage, since every chunk read is
 * scoped to one `snapshotId`. See `docs/verification/phase2.md` §2.4.
 */
const RESET_TABLES = [
  "run_search_docs",
  "run_actions",
  "run_step_payloads",
  "run_steps",
  "usage_events",
  "runs",
  "snapshot_digests",
  "snapshots",
  "windows",
  "team_week_rollups",
  "model_week_rollups",
  "league_week_rollups",
  "team_standings",
  "team_results",
  "matchups",
  "waiver_claims",
  "transactions",
  "draft_picks",
  "lineups",
  "roster_slots",
  "forum_votes",
  "forum_comments",
  "forum_posts",
  "messages",
  "threads",
  "trade_events",
  "trades",
  "config_versions",
  "agent_configs",
  "weeks",
  "teams",
  "league_members",
  "league_rules",
  "leagues",
  // Last, and expected to fail — see the note above.
  "snapshot_chunks",
] as const;

const SEASON = 2026;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Week 1 kickoff, placed so the **final** week is the current one: the season is
 * 16 weeks in the past and week `WEEKS` is in progress. That is what makes
 * `weeks.currentWeekNo` return `WEEKS`, so `views.home`, `metrics.filmRoom` and the
 * snapshot reads all land on the week that actually has data. Truncated to a UTC
 * day so a resumed run lines up with the rows it already wrote.
 */
const SEASON_START =
  Math.floor(Date.now() / 86_400_000) * 86_400_000 - (WEEKS - 1) * WEEK_MS;

// -------------------------------------------------------------------- helpers

type Row = Record<string, unknown>;

function arg(name: string): string | undefined {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

/** Deterministic PRNG, so a resumed run regenerates identical rows. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clean<T extends Row>(row: T): T {
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) if (value !== undefined) out[key] = value;
  return out as T;
}

function readGolden(table: string): Row[] {
  const file = path.join(GOLDEN, `${table}.json`);
  if (!fs.existsSync(file)) return [];
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  return Array.isArray(parsed) ? (parsed as Row[]) : [parsed as Row];
}

function ms(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "number") return value;
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? undefined : parsed;
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

function bytesOf(value: unknown): number {
  return value === undefined ? 0 : JSON.stringify(value).length;
}

function round8(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

function weekStart(weekNo: number): number {
  return SEASON_START + (weekNo - 1) * WEEK_MS;
}

// --------------------------------------------------------------- convex calls

const url = process.env.NEXT_PUBLIC_CONVEX_URL;
const secret = process.env.SEED_SECRET;
if (!url) throw new Error("NEXT_PUBLIC_CONVEX_URL is not set.");
if (!secret) throw new Error("SEED_SECRET is not set.");
if (url.includes("tidy-peacock-243")) {
  throw new Error(
    "Refusing to run against the shared dev deployment. Point NEXT_PUBLIC_CONVEX_URL at the loadtest deployment.",
  );
}

const client = new ConvexHttpClient(url);
const started = Date.now();
let rowsWritten = 0;

function elapsed(): string {
  const s = Math.round((Date.now() - started) / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** Insert rows through `seed.importBatch` and return the new ids, in input order. */
async function importRows(table: string, rows: Row[], batchSize = 400): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const result = await client.mutation(api.seed.importBatch, {
      secret: secret!,
      table,
      rows: batch,
    });
    ids.push(...result.ids);
    rowsWritten += batch.length;
  }
  return ids;
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

async function countTable(table: string): Promise<number> {
  let total = 0;
  let cursor: string | null = null;
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

// ------------------------------------------------------ shared: user, players

const DEMO_USER = {
  email: "loadtest@fantasybench.dev",
  password: "password1234",
  name: "Load Test Owner",
};

async function ensureUser(): Promise<string> {
  const existing = await client.query(api.users.byEmailPublic, {
    secret: secret!,
    email: DEMO_USER.email,
  });
  if (existing) return existing.userId;
  try {
    await client.action(api.auth.signIn, {
      provider: "password",
      params: { ...DEMO_USER, flow: "signUp" },
    });
  } catch {
    await client.action(api.auth.signIn, {
      provider: "password",
      params: { email: DEMO_USER.email, password: DEMO_USER.password, flow: "signIn" },
    });
  }
  const created = await client.query(api.users.byEmailPublic, {
    secret: secret!,
    email: DEMO_USER.email,
  });
  if (!created) throw new Error("Load-test user was not created.");
  return created.userId;
}

function externalIdsOf(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw as Row)) {
    if (!key.endsWith("_id")) continue;
    if (value === null || value === undefined || typeof value === "object") continue;
    const text = String(value);
    if (text) out[key] = text;
  }
  return out;
}

function numericStats(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!value || typeof value !== "object") return out;
  for (const [key, raw] of Object.entries(value as Row)) {
    const n = num(raw);
    if (n !== undefined) out[key] = n;
  }
  return out;
}

/**
 * The player pool is global, so it is imported once and shared by all 50 leagues —
 * exactly as production works. Returns the Convex player ids in golden file order.
 */
async function ensurePlayers(): Promise<{ playerIds: string[]; positions: string[] }> {
  const golden = readGolden("players");
  const positions = golden.map((row) => String(row.position));

  if (SKIP_PLAYERS || (await countTable("players")) >= golden.length) {
    const ids: string[] = [];
    let cursor: string | null = null;
    const byLegacy = new Map<string, string>();
    for (;;) {
      const page: { map: Record<string, string>; continueCursor: string; isDone: boolean } =
        await client.query(api.seed.lookupLegacy, {
          secret: secret!,
          table: "players",
          cursor,
          numItems: 1_000,
        });
      for (const [legacyId, id] of Object.entries(page.map)) byLegacy.set(legacyId, id);
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    for (const row of golden) {
      const id = byLegacy.get(String(row.id));
      if (!id) throw new Error(`Player ${String(row.id)} is missing; drop --skip-players.`);
      ids.push(id);
    }
    process.stdout.write(`  players                      ${ids.length} reused\n`);
    return { playerIds: ids, positions };
  }

  const playerIds = await importRows(
    "players",
    golden.map((row) => {
      const externalIds = externalIdsOf(row.raw);
      return clean({
        legacyId: String(row.id),
        sleeperId: String(row.sleeper_id),
        gsisId: str(row.gsis_id),
        espnId: externalIds.espn_id,
        fullName: String(row.full_name),
        firstName: str(row.first_name),
        lastName: str(row.last_name),
        position: String(row.position),
        nflTeam: str(row.nfl_team),
        status: str(row.status),
        injuryStatus: str(row.injury_status),
        byeWeek: num(row.bye_week),
        yearsExp: num(row.years_exp),
        age: num(row.age),
        searchRank: num(row.search_rank),
        fantasyPositions: row.fantasy_positions ?? [],
        externalIds,
        updatedAt: ms(row.updated_at) ?? Date.now(),
      });
    }),
    400,
  );

  const byLegacy = new Map(golden.map((row, index) => [String(row.id), playerIds[index]]));
  const projections = readGolden("player_projections");
  await importRows(
    "player_projections",
    projections.map((row) =>
      clean({
        legacyId: String(row.id),
        playerId: byLegacy.get(String(row.player_id))!,
        season: numOr(row.season, SEASON),
        week: numOr(row.week, 1),
        source: String(row.source),
        projectedPointsPpr: numOr(row.projected_points_ppr, 0),
        projectedPointsHalf: numOr(row.projected_points_half, 0),
        projectedPointsStd: numOr(row.projected_points_std, 0),
        stats: numericStats(row.stats),
        effectiveAt: ms(row.effective_at) ?? SEASON_START,
      }),
    ),
    400,
  );

  const latest = new Map<string, Row>();
  for (const row of projections) {
    const key = `${String(row.player_id)}|${String(row.season)}|${String(row.week)}|${String(row.source)}`;
    const previous = latest.get(key);
    if (!previous || (ms(row.effective_at) ?? 0) >= (ms(previous.effective_at) ?? 0)) {
      latest.set(key, row);
    }
  }
  await importRows(
    "player_projection_latest",
    [...latest.values()].map((row) =>
      clean({
        playerId: byLegacy.get(String(row.player_id))!,
        season: numOr(row.season, SEASON),
        week: numOr(row.week, 1),
        source: String(row.source),
        position: positions[golden.findIndex((p) => String(p.id) === String(row.player_id))] ?? "WR",
        projectedPointsPpr: numOr(row.projected_points_ppr, 0),
        projectedPointsHalf: numOr(row.projected_points_half, 0),
        projectedPointsStd: numOr(row.projected_points_std, 0),
        stats: numericStats(row.stats),
        effectiveAt: ms(row.effective_at) ?? SEASON_START,
      }),
    ),
    400,
  );

  await importRows(
    "nfl_games",
    readGolden("nfl_games").map((row) =>
      clean({
        legacyId: String(row.id),
        season: numOr(row.season, SEASON),
        week: numOr(row.week, 1),
        gameId: String(row.game_id),
        espnId: str(row.espn_id),
        homeTeam: String(row.home_team),
        awayTeam: String(row.away_team),
        kickoffAt: ms(row.kickoff_at) ?? SEASON_START,
        status: String(row.status),
        homeScore: num(row.home_score),
        awayScore: num(row.away_score),
      }),
    ),
  );

  process.stdout.write(`  players                      ${playerIds.length} imported\n`);
  return { playerIds, positions };
}

// ------------------------------------------------------------ per-league seed

type Pool = { playerIds: string[]; positions: string[] };

const WINDOW_PLAN: Array<{ type: string; label: string }> = [
  { type: "lineup", label: "lineup_thu" },
  { type: "lineup", label: "lineup_sun_early" },
  { type: "lineup", label: "lineup_sun_late" },
  { type: "lineup", label: "lineup_mon" },
  { type: "waiver", label: "waiver" },
  ...Array.from({ length: 6 }, (_, i) => ({ type: "trade", label: `trade_${i + 1}` })),
  ...Array.from({ length: 5 }, (_, i) => ({ type: "forum", label: `forum_${i + 1}` })),
  { type: "commissioner", label: "commissioner_open" },
  { type: "commissioner", label: "commissioner_recap" },
];
if (WINDOW_PLAN.length !== WINDOWS_PER_WEEK) {
  throw new Error(`WINDOW_PLAN is ${WINDOW_PLAN.length} windows, expected ${WINDOWS_PER_WEEK}`);
}
/** Indices into `WINDOW_PLAN` whose windows produce one run per team. */
const RUN_WINDOW_INDICES = [4, 1, 5].slice(0, RUN_WINDOWS_PER_WEEK);

const GOLDEN_RULES = readGolden("league_rules")[0];
const GOLDEN_TEAMS = readGolden("teams");
const GOLDEN_SNAPSHOT = readGolden("snapshots")[0];
const GOLDEN_CONTEXT = String(readGolden("config_versions")[0].context_md);

/** 15 roster spots: 2 QB, 4 RB, 5 WR, 2 TE, 1 K, 1 DEF. */
const ROSTER_PLAN: Array<[string, number]> = [
  ["QB", 2],
  ["RB", 4],
  ["WR", 5],
  ["TE", 2],
  ["K", 1],
  ["DEF", 1],
];
const LINEUP_SLOTS = [
  "QB",
  "RB",
  "RB",
  "WR",
  "WR",
  "TE",
  "FLEX",
  "K",
  "DEF",
  "BENCH",
  "BENCH",
  "BENCH",
  "BENCH",
  "BENCH",
  "BENCH",
];

function positionBuckets(pool: Pool): Record<string, string[]> {
  const buckets: Record<string, string[]> = {};
  pool.positions.forEach((position, index) => {
    (buckets[position] ??= []).push(pool.playerIds[index]);
  });
  return buckets;
}

/** Round-robin pairing: 6 matchups a week for 12 teams. */
function pairingsFor(weekNo: number, teamCount: number): Array<[number, number]> {
  const rotation = [0, ...Array.from({ length: teamCount - 1 }, (_, i) => ((i + weekNo - 1) % (teamCount - 1)) + 1)];
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < teamCount / 2; i += 1) {
    pairs.push([rotation[i], rotation[teamCount - 1 - i]]);
  }
  return pairs;
}

async function seedLeague(index: number, userId: string, pool: Pool): Promise<void> {
  const rand = mulberry32(1_000 + index);
  const slug = `loadtest-${String(index).padStart(3, "0")}`;
  const now = Date.now();
  const buckets = positionBuckets(pool);

  const existing = await client.query(api.leagues.bySlug, { slug });
  if (existing?.league.joinCode?.startsWith(DONE_PREFIX)) {
    process.stdout.write(`  [${elapsed()}] ${slug} already complete, skipping\n`);
    return;
  }
  if (existing) {
    process.stdout.write(
      `  [${elapsed()}] ${slug} exists but is incomplete — skipping (run seed:reset on the loadtest deployment to redo it)\n`,
    );
    return;
  }

  // -- league core ---------------------------------------------------------
  const [leagueId] = await importRows("leagues", [
    clean({
      legacyId: `${slug}:league`,
      name: `Load Test League ${index}`,
      slug,
      commissionerUserId: userId,
      season: SEASON,
      teamCount: TEAMS,
      isPublic: true,
      status: "in_season",
      draftType: "snake",
      draftScheduledAt: SEASON_START - WEEK_MS,
      createdAt: SEASON_START - WEEK_MS,
      updatedAt: now,
    }),
  ]);

  await importRows("league_rules", [
    clean({
      legacyId: `${slug}:rules`,
      leagueId,
      scoringPreset: String(GOLDEN_RULES.scoring_preset),
      superflex: false,
      tePremium: false,
      rosterSlots: GOLDEN_RULES.roster_slots,
      faabBudget: numOr(GOLDEN_RULES.faab_budget, 100),
      playoffTeams: numOr(GOLDEN_RULES.playoff_teams, 6),
      playoffStartWeek: numOr(GOLDEN_RULES.playoff_start_week, 15),
      regularSeasonWeeks: numOr(GOLDEN_RULES.regular_season_weeks, 14),
      seasonWeeks: WEEKS,
      transparencyMode: String(GOLDEN_RULES.transparency_mode),
      injectionPolicy: String(GOLDEN_RULES.injection_policy),
      modelAllowlist: MODEL_IDS,
      fallbackModelId: str(GOLDEN_RULES.fallback_model_id),
      contextCharLimit: numOr(GOLDEN_RULES.context_char_limit, 8_000),
      maxStepsCap: numOr(GOLDEN_RULES.max_steps_cap, 30),
      editLock: GOLDEN_RULES.edit_lock,
      tradeReviewHours: numOr(GOLDEN_RULES.trade_review_hours, 24),
      fairnessFloor: num(GOLDEN_RULES.fairness_floor),
      antiChurnWeeks: numOr(GOLDEN_RULES.anti_churn_weeks, 3),
      maxOpenProposals: numOr(GOLDEN_RULES.max_open_proposals, 3),
      maxMessagesPerRun: numOr(GOLDEN_RULES.max_messages_per_run, 6),
      maxThreadsPerWindow: numOr(GOLDEN_RULES.max_threads_per_window, 4),
      forumPostsPerDay: numOr(GOLDEN_RULES.forum_posts_per_day, 2),
      forumCommentsPerDay: numOr(GOLDEN_RULES.forum_comments_per_day, 6),
      safetyAutopilot: true,
      rulesLockedAt: SEASON_START - WEEK_MS,
      runWallclockSeconds: numOr(GOLDEN_RULES.run_wallclock_seconds, 300),
      draftPickSeconds: numOr(GOLDEN_RULES.draft_pick_seconds, 240),
      reuseSnapshotWithinMs: numOr(GOLDEN_RULES.reuse_snapshot_within_ms, 600_000),
      draftBudget: numOr(GOLDEN_RULES.draft_budget, 200),
    }),
  ]);

  await importRows("league_members", [
    { legacyId: `${slug}:member`, leagueId, userId, role: "commissioner", createdAt: SEASON_START },
  ]);

  const teamIds = await importRows(
    "teams",
    GOLDEN_TEAMS.map((row, t) =>
      clean({
        legacyId: `${slug}:team:${t}`,
        leagueId,
        // The commissioner owns team 0 in every league, so owner-scoped reads have data.
        ownerUserId: t === 0 ? userId : undefined,
        name: String(row.name),
        abbreviation: String(row.abbreviation),
        faabRemaining: 100 - Math.floor(rand() * 60),
        waiverPriority: t + 1,
        karma: Math.floor(rand() * 40) - 10,
        draftBudgetRemaining: 0,
        createdAt: SEASON_START - WEEK_MS,
      }),
    ),
  );

  await importRows(
    "weeks",
    Array.from({ length: WEEKS }, (_, w) => ({
      legacyId: `${slug}:week:${w + 1}`,
      leagueId,
      weekNo: w + 1,
      startsAt: weekStart(w + 1),
      endsAt: weekStart(w + 2),
      isPlayoff: w + 1 >= numOr(GOLDEN_RULES.playoff_start_week, 15),
      status: weekStart(w + 2) <= now ? "complete" : "active",
    })),
  );

  // -- schedule, results, standings ----------------------------------------
  const scores: number[][] = [];
  const matchupRows: Row[] = [];
  const resultRows: Row[] = [];
  for (let w = 1; w <= WEEKS; w += 1) {
    const weekScores = teamIds.map(() => Math.round((70 + rand() * 70) * 100) / 100);
    scores.push(weekScores);
    const final = weekStart(w + 1) <= now;
    for (const [home, away] of pairingsFor(w, TEAMS)) {
      matchupRows.push({
        legacyId: `${slug}:matchup:${w}:${home}`,
        leagueId,
        weekNo: w,
        homeTeamId: teamIds[home],
        awayTeamId: teamIds[away],
        homeScore: final ? weekScores[home] : undefined,
        awayScore: final ? weekScores[away] : undefined,
        isFinal: final,
      });
      if (!final) continue;
      for (const [me, them] of [
        [home, away],
        [away, home],
      ]) {
        resultRows.push({
          legacyId: `${slug}:result:${w}:${me}`,
          leagueId,
          teamId: teamIds[me],
          weekNo: w,
          pointsFor: weekScores[me],
          pointsAgainst: weekScores[them],
          won: weekScores[me] > weekScores[them],
          lost: weekScores[me] < weekScores[them],
          tied: weekScores[me] === weekScores[them],
        });
      }
    }
  }
  await importRows("matchups", matchupRows.map(clean));
  await importRows("team_results", resultRows);

  await importRows(
    "team_standings",
    teamIds.map((teamId) => {
      const mine = resultRows.filter((row) => row.teamId === teamId);
      const streakRows = mine.slice(-5);
      let streakLen = 0;
      const last = streakRows.at(-1);
      for (let i = streakRows.length - 1; i >= 0; i -= 1) {
        if (streakRows[i].won !== last?.won) break;
        streakLen += 1;
      }
      return {
        leagueId,
        teamId,
        season: SEASON,
        wins: mine.filter((row) => row.won).length,
        losses: mine.filter((row) => row.lost).length,
        ties: mine.filter((row) => row.tied).length,
        pointsFor: Math.round(mine.reduce((sum, row) => sum + Number(row.pointsFor), 0) * 100) / 100,
        pointsAgainst:
          Math.round(mine.reduce((sum, row) => sum + Number(row.pointsAgainst), 0) * 100) / 100,
        streak: last ? `${last.won ? "W" : "L"}${streakLen}` : "",
        updatedAt: now,
      };
    }),
  );

  // -- rosters and lineups --------------------------------------------------
  const rosterByTeam: string[][] = [];
  const rosterRows: Row[] = [];
  for (let t = 0; t < TEAMS; t += 1) {
    const roster: string[] = [];
    for (const [position, count] of ROSTER_PLAN) {
      const bucket = buckets[position] ?? pool.playerIds;
      for (let n = 0; n < count; n += 1) {
        roster.push(bucket[(index * TEAMS * 6 + t * 6 + n * 13) % bucket.length]);
      }
    }
    rosterByTeam.push(roster);
    roster.forEach((playerId, r) =>
      rosterRows.push({
        legacyId: `${slug}:roster:${t}:${r}`,
        leagueId,
        teamId: teamIds[t],
        playerId,
        acquiredAt: SEASON_START - WEEK_MS,
        acquiredVia: r < 12 ? "draft" : "waiver",
      }),
    );
  }
  await importRows("roster_slots", rosterRows);

  await importRows(
    "lineups",
    Array.from({ length: WEEKS }, (_, w) =>
      teamIds.map((teamId, t) => ({
        legacyId: `${slug}:lineup:${w + 1}:${t}`,
        teamId,
        leagueId,
        weekNo: w + 1,
        version: 1,
        slots: LINEUP_SLOTS.map((slot, s) => ({ slot, playerId: rosterByTeam[t][s] ?? null })),
        source: "agent",
      })),
    ).flat(),
  );

  // -- agent configs --------------------------------------------------------
  const configIds = await importRows(
    "agent_configs",
    teamIds.map((teamId, t) => ({
      legacyId: `${slug}:config:${t}`,
      teamId,
      leagueId,
      createdAt: SEASON_START - WEEK_MS,
      updatedAt: now,
    })),
  );
  const versionIds = await importRows(
    "config_versions",
    configIds.map((configId, t) => ({
      legacyId: `${slug}:version:${t}`,
      configId,
      teamId: teamIds[t],
      leagueId,
      versionNo: 1,
      contextMd: GOLDEN_CONTEXT,
      modelId: MODEL_IDS[t % MODEL_IDS.length],
      harness: { maxSteps: 12, tokenBudget: 60_000, temperature: 0.4, deliberateMode: false },
      skillIds: [],
      appliedAt: SEASON_START - WEEK_MS,
      createdAt: SEASON_START - WEEK_MS,
    })),
  );
  await patchRows(
    "agent_configs",
    configIds.map((id, t) => ({ id, patch: { currentVersionId: versionIds[t] } })),
  );

  // -- windows --------------------------------------------------------------
  const windowRows: Row[] = [];
  for (let w = 1; w <= WEEKS; w += 1) {
    WINDOW_PLAN.forEach((plan, p) => {
      const opensAt = weekStart(w) + p * 3 * 60 * 60 * 1000;
      windowRows.push({
        legacyId: `${slug}:window:${w}:${p}`,
        leagueId,
        type: plan.type,
        label: plan.label,
        weekNo: w,
        roundNo: 1,
        opensAt,
        submissionDeadlineAt: opensAt + 100 * 60 * 1000,
        closesAt: opensAt + 2 * 60 * 60 * 1000,
        status: w < WEEKS ? "closed" : "open",
        scope: {},
        runCount: RUN_WINDOW_INDICES.includes(p) ? TEAMS : 0,
        terminalRunCount: RUN_WINDOW_INDICES.includes(p) ? TEAMS : 0,
      });
    });
  }
  const windowIds = await importRows("windows", windowRows);
  const windowAt = (weekNo: number, plan: number) => windowIds[(weekNo - 1) * WINDOWS_PER_WEEK + plan];

  // -- snapshots (the golden payload, remapped onto this league) ------------
  const snapshotPayload = (GOLDEN_SNAPSHOT.payload ?? {}) as Row;
  const goldenPlayers = (snapshotPayload.players ?? {}) as Record<string, Row>;
  const goldenPlayerIds = Object.keys(goldenPlayers).slice(0, SNAPSHOT_PLAYERS);
  const leaguePlayerIds: string[] = [];
  const seen = new Set<string>();
  for (const id of rosterByTeam.flat()) {
    if (!seen.has(id)) {
      seen.add(id);
      leaguePlayerIds.push(id);
    }
  }
  for (let i = 0; leaguePlayerIds.length < goldenPlayerIds.length; i += 1) {
    const id = pool.playerIds[(index * 977 + i * 7) % pool.playerIds.length];
    if (seen.has(id)) continue;
    seen.add(id);
    leaguePlayerIds.push(id);
  }
  const playerMap = new Map(goldenPlayerIds.map((id, i) => [id, leaguePlayerIds[i]]));
  const goldenTeamMap = new Map(
    (Array.isArray(snapshotPayload.teams) ? (snapshotPayload.teams as Row[]) : []).map(
      (team, t) => [String(team.id), teamIds[t % TEAMS]],
    ),
  );
  const mapTeam = (id: unknown) => (id ? (goldenTeamMap.get(String(id)) ?? teamIds[0]) : null);

  const snapshotMeta: Row = {
    ...snapshotPayload,
    leagueId,
    teams: (Array.isArray(snapshotPayload.teams) ? (snapshotPayload.teams as Row[]) : []).map(
      (team, t) => ({
        ...team,
        id: teamIds[t % TEAMS],
        ownerUserId: t === 0 ? userId : null,
        rosterPlayerIds: rosterByTeam[t % TEAMS],
        lineup: LINEUP_SLOTS.map((slot, s) => ({
          slot,
          playerId: rosterByTeam[t % TEAMS][s] ?? null,
        })),
      }),
    ),
    matchups: pairingsFor(WEEKS, TEAMS).map(([home, away]) => ({
      homeTeamId: teamIds[home],
      awayTeamId: teamIds[away],
    })),
    standings: teamIds.map((teamId) => ({ teamId, wins: 0, losses: 0 })),
    freeAgentIds: leaguePlayerIds.slice(TEAMS * ROSTER_SIZE),
    liveScores: Object.fromEntries(teamIds.map((teamId, t) => [teamId, scores[WEEKS - 1][t]])),
  };
  delete snapshotMeta.players;
  const snapshotPlayers: Row = {};
  for (const [goldenId, player] of Object.entries(goldenPlayers)) {
    const mapped = playerMap.get(goldenId);
    if (!mapped) continue;
    snapshotPlayers[mapped] = { ...player, id: mapped, ownerTeamId: mapTeam(player.ownerTeamId) };
  }

  const snapshotWindows = Array.from({ length: SNAPSHOT_WINDOWS_PER_LEAGUE }, (_, s) => ({
    weekNo: WEEKS,
    plan: s % 4,
  }));
  const snapshotIds = await importRows(
    "snapshots",
    snapshotWindows.map((spec, s) => ({
      legacyId: `${slug}:snapshot:${s}`,
      leagueId,
      windowId: windowAt(spec.weekNo, spec.plan),
      season: SEASON,
      weekNo: spec.weekNo,
      takenAt: weekStart(spec.weekNo) + s * 3 * 60 * 60 * 1000,
      status: "ready",
      chunkCount: 1 + Math.ceil(Object.keys(snapshotPlayers).length / SNAPSHOT_PLAYERS_PER_CHUNK),
      playerCount: Object.keys(snapshotPlayers).length,
      headline: `Week ${spec.weekNo} board`,
    })),
  );

  const playerEntries = Object.entries(snapshotPlayers);
  for (const [s, snapshotId] of snapshotIds.entries()) {
    const chunks: Row[] = [
      { snapshotId, kind: "meta", part: 0, data: snapshotMeta, bytes: bytesOf(snapshotMeta) },
    ];
    for (let i = 0; i < playerEntries.length; i += SNAPSHOT_PLAYERS_PER_CHUNK) {
      const data = Object.fromEntries(playerEntries.slice(i, i + SNAPSHOT_PLAYERS_PER_CHUNK));
      chunks.push({
        snapshotId,
        kind: "players",
        part: i / SNAPSHOT_PLAYERS_PER_CHUNK,
        data,
        bytes: bytesOf(data),
      });
    }
    await importRows("snapshot_chunks", chunks, 3);
    await importRows("snapshot_digests", [
      {
        snapshotId,
        headline: `Week ${WEEKS} board (${s})`,
        topNews: [],
        injuryChanges: [],
        projectionMovers: [],
        standingsSummary: "Load-test league.",
      },
    ]);
  }
  await patchRows(
    "windows",
    snapshotIds.map((snapshotId, s) => ({
      id: windowAt(snapshotWindows[s].weekNo, snapshotWindows[s].plan),
      patch: { snapshotId },
    })),
  );

  // -- runs, steps, usage, actions, search docs -----------------------------
  const runRows: Row[] = [];
  const runSpecs: Array<{ weekNo: number; plan: number; team: number; modelId: string }> = [];
  for (let w = 1; w <= WEEKS; w += 1) {
    for (const p of RUN_WINDOW_INDICES) {
      for (let t = 0; t < TEAMS; t += 1) {
        const modelId = MODEL_IDS[t % MODEL_IDS.length];
        runSpecs.push({ weekNo: w, plan: p, team: t, modelId });
        const startedAt = weekStart(w) + p * 3 * 60 * 60 * 1000 + t * 20_000;
        runRows.push(
          clean({
            legacyId: `${slug}:run:${w}:${p}:${t}`,
            windowId: windowAt(w, p),
            leagueId,
            teamId: teamIds[t],
            configVersionId: versionIds[t],
            modelId,
            kind: "team",
            status: "succeeded",
            windowType: WINDOW_PLAN[p].type,
            windowLabel: WINDOW_PLAN[p].label,
            weekNo: w,
            attempt: 1,
            lastPersistedStep: STEPS_PER_RUN - 1,
            startedAt,
            finishedAt: startedAt + 20_000,
            outcome: `${WINDOW_PLAN[p].type}_committed`,
            rationale: `Week ${w} ${WINDOW_PLAN[p].label}: kept the highest-floor starters and put FAAB on the best available depth.`,
            totalCostUsd: round8(0.004 + rand() * 0.02),
            totalInputTokens: 4_000 + Math.floor(rand() * 4_000),
            totalOutputTokens: 500 + Math.floor(rand() * 900),
            stepCount: STEPS_PER_RUN,
            committedActionCount: 1,
            rejectedActionCount: 0,
          }),
        );
      }
    }
  }
  const runIds = await importRows("runs", runRows);

  // One oversized tool result per league, so `runs.stepPayload` has something to
  // read: nothing else generated here crosses the 64 KB inline limit (PRD 5.8).
  // It is inserted *before* the steps so the step can carry the `payloadRef` the
  // trace viewer follows (`convex/runs.ts#stepPayload`).
  const overflowCallId = "tc-0-overflow";
  const overflowPayload = {
    toolCallId: overflowCallId,
    toolName: "read_board",
    output: {
      players: Array.from({ length: 900 }, (_, i) => ({
        rank: i,
        note: "projection detail, padded so the result exceeds the inline limit",
      })),
    },
  };
  const [overflowId] = await importRows("run_step_payloads", [
    {
      runId: runIds[0],
      stepIndex: 0,
      toolCallId: overflowCallId,
      toolName: "read_board",
      payload: overflowPayload,
      bytes: bytesOf(overflowPayload),
    },
  ]);

  const stepRows: Row[] = [];
  const usageRows: Row[] = [];
  const actionRows: Row[] = [];
  const searchRows: Row[] = [];
  runIds.forEach((runId, r) => {
    const spec = runSpecs[r];
    const base = Number(runRows[r].startedAt);
    for (let s = 0; s < STEPS_PER_RUN; s += 1) {
      const inputTokens = 900 + Math.floor(rand() * 900);
      const outputTokens = 120 + Math.floor(rand() * 240);
      const costUsd = round8(0.001 + rand() * 0.005);
      stepRows.push({
        legacyId: `${slug}:step:${r}:${s}`,
        runId,
        leagueId,
        stepIndex: s,
        modelId: spec.modelId,
        text: `Step ${s}: reviewed the board, projections and injury designations for week ${spec.weekNo}.`,
        responseMessages: [{ role: "assistant", content: `step ${s}` }],
        toolCalls: s < STEPS_PER_RUN - 1 ? [{ toolCallId: `tc-${r}-${s}`, toolName: "read_board" }] : [],
        toolResults:
          r === 0 && s === 0
            ? [{ toolCallId: overflowCallId, payloadRef: overflowId, overflowed: true }]
            : s < STEPS_PER_RUN - 1
              ? [{ toolCallId: `tc-${r}-${s}`, output: { ok: true } }]
              : [],
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          cachedInputTokens: 0,
          reasoningTokens: 0,
        },
        finishReason: s < STEPS_PER_RUN - 1 ? "tool-calls" : "stop",
        latencyMs: 400 + Math.floor(rand() * 900),
        costUsd,
        bytes: 512,
      });
      usageRows.push({
        legacyId: `${slug}:usage:${r}:${s}`,
        runId,
        stepIndex: s,
        leagueId,
        teamId: teamIds[spec.team],
        season: SEASON,
        weekNo: spec.weekNo,
        modelId: spec.modelId,
        provider: PROVIDER_OF[spec.modelId] ?? "mock",
        inputTokens,
        outputTokens,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        latencyMs: 400,
        computedCostUsd: costUsd,
        gatewayCostUsd: costUsd,
        costUsd,
        createdAt: base + s * 1_000,
      });
    }
    actionRows.push({
      legacyId: `${slug}:action:${r}`,
      runId,
      leagueId,
      teamId: teamIds[spec.team],
      toolCallId: `tc-${r}-commit`,
      stepIndex: STEPS_PER_RUN - 1,
      actionType: WINDOW_PLAN[spec.plan].type === "waiver" ? "submit_waiver_claim" : "set_lineup",
      payload: { teamId: teamIds[spec.team], weekNo: spec.weekNo },
      validationResult: { ok: true },
      committedAt: base + 19_000,
    });
    searchRows.push({
      runId,
      leagueId,
      teamId: teamIds[spec.team],
      windowType: WINDOW_PLAN[spec.plan].type,
      weekNo: spec.weekNo,
      status: "succeeded",
      modelId: spec.modelId,
      text: String(runRows[r].rationale),
    });
  });
  await importRows("run_steps", stepRows, 200);
  await importRows("usage_events", usageRows);
  await importRows("run_actions", actionRows);
  await importRows("run_search_docs", searchRows);

  // -- draft board -----------------------------------------------------------
  // 15 snake rounds x 12 teams = one pick per roster slot, so `draft.board` reads
  // its full `MAX_PICKS` window and does a player + run lookup per pick.
  const firstRunByTeam = new Map<number, string>();
  runSpecs.forEach((spec, r) => {
    if (!firstRunByTeam.has(spec.team)) firstRunByTeam.set(spec.team, runIds[r]);
  });
  const pickRows: Row[] = [];
  let overallNo = 0;
  for (let round = 1; round <= ROSTER_SIZE; round += 1) {
    const order = round % 2 === 1 ? teamIds.map((_, t) => t) : teamIds.map((_, t) => TEAMS - 1 - t);
    order.forEach((t, pickNo) => {
      overallNo += 1;
      pickRows.push(
        clean({
          legacyId: `${slug}:pick:${overallNo}`,
          leagueId,
          round,
          pickNo: pickNo + 1,
          overallNo,
          teamId: teamIds[t],
          playerId: rosterByTeam[t][round - 1],
          madeByRunId: firstRunByTeam.get(t),
          auto: round > 10,
          rationale: `Round ${round}: best available for the roster hole.`,
          madeAt: SEASON_START - WEEK_MS + overallNo * 60_000,
        }),
      );
    });
  }
  await importRows("draft_picks", pickRows);

  // -- waivers and transactions ---------------------------------------------
  const claimRows: Row[] = [];
  const transactionRows: Row[] = [];
  for (let w = 1; w <= WEEKS; w += 1) {
    for (let t = 0; t < TEAMS; t += 1) {
      const add = pool.playerIds[(index * 331 + w * 29 + t * 7) % pool.playerIds.length];
      const won = t < 2;
      claimRows.push(
        clean({
          legacyId: `${slug}:claim:${w}:${t}`,
          leagueId,
          teamId: teamIds[t],
          windowId: windowAt(w, 4),
          weekNo: w,
          addPlayerId: add,
          dropPlayerId: rosterByTeam[t][ROSTER_SIZE - 1],
          bid: Math.floor(rand() * 30),
          priority: t + 1,
          status: won ? "won" : "lost",
          resultReason: won ? undefined : "Outbid.",
          processedAt: weekStart(w) + 4 * 60 * 60 * 1000,
        }),
      );
      transactionRows.push(
        clean({
          legacyId: `${slug}:txn:${w}:${t}`,
          leagueId,
          teamId: teamIds[t],
          type: "add",
          weekNo: w,
          playerId: add,
          details: { weekNo: w },
        }),
      );
    }
  }
  await importRows("waiver_claims", claimRows);
  await importRows("transactions", transactionRows);

  // -- threads, messages, trades --------------------------------------------
  const threadRows: Row[] = [];
  const threadSpecs: Array<{ weekNo: number; a: number; b: number }> = [];
  for (let w = 1; w <= WEEKS; w += 1) {
    for (let n = 0; n < THREADS_PER_WEEK; n += 1) {
      const a = (w + n) % TEAMS;
      const b = (a + 1 + n) % TEAMS;
      threadSpecs.push({ weekNo: w, a, b: b === a ? (a + 1) % TEAMS : b });
      threadRows.push({
        legacyId: `${slug}:thread:${w}:${n}`,
        leagueId,
        teamAId: teamIds[a],
        teamBId: teamIds[threadSpecs.at(-1)!.b],
        createdInWindowId: windowAt(w, 5),
        lastMessageAt: weekStart(w) + 5 * 60 * 60 * 1000 + MESSAGES_PER_THREAD * 60_000,
        messageCount: MESSAGES_PER_THREAD,
        flaggedCount: 0,
      });
    }
  }
  const threadIds = await importRows("threads", threadRows);

  const messageRows: Row[] = [];
  threadIds.forEach((threadId, i) => {
    const spec = threadSpecs[i];
    for (let m = 0; m < MESSAGES_PER_THREAD; m += 1) {
      messageRows.push({
        legacyId: `${slug}:message:${i}:${m}`,
        threadId,
        leagueId,
        senderTeamId: teamIds[m % 2 === 0 ? spec.a : spec.b],
        body: `Week ${spec.weekNo} negotiation, message ${m + 1}. I can move a WR for RB depth.`,
        createdAt: weekStart(spec.weekNo) + 5 * 60 * 60 * 1000 + m * 60_000,
      });
    }
  });
  await importRows("messages", messageRows);

  const tradeRows: Row[] = [];
  const tradeSpecs: Array<{ weekNo: number; a: number; b: number; thread: number }> = [];
  for (let w = 1; w <= WEEKS; w += 1) {
    for (let n = 0; n < TRADES_PER_WEEK; n += 1) {
      const threadIndex = (w - 1) * THREADS_PER_WEEK + n;
      const spec = threadSpecs[threadIndex];
      tradeSpecs.push({ weekNo: w, a: spec.a, b: spec.b, thread: threadIndex });
      const settled = w < WEEKS;
      tradeRows.push(
        clean({
          legacyId: `${slug}:trade:${w}:${n}`,
          leagueId,
          proposerTeamId: teamIds[spec.a],
          recipientTeamId: teamIds[spec.b],
          threadId: threadIds[threadIndex],
          windowId: windowAt(w, 5),
          weekNo: w,
          status: settled ? (n % 2 === 0 ? "completed" : "rejected") : "proposed",
          items: [
            { fromTeamId: teamIds[spec.a], toTeamId: teamIds[spec.b], playerId: rosterByTeam[spec.a][3] },
            { fromTeamId: teamIds[spec.b], toTeamId: teamIds[spec.a], playerId: rosterByTeam[spec.b][4] },
          ],
          fairnessScore: Math.round(rand() * 100) / 100,
          flagged: false,
          resolvedAt: settled ? weekStart(w) + 8 * 60 * 60 * 1000 : undefined,
          message: `Week ${w} proposal ${n + 1}: RB depth for WR ceiling.`,
          vetoCount: 0,
          approveCount: 0,
        }),
      );
    }
  }
  const tradeIds = await importRows("trades", tradeRows);
  await importRows(
    "trade_events",
    tradeIds.flatMap((tradeId, i) => [
      {
        legacyId: `${slug}:tradeevent:${i}:0`,
        tradeId,
        leagueId,
        type: "proposed",
        toStatus: "proposed",
        actorTeamId: teamIds[tradeSpecs[i].a],
        payload: {},
      },
      {
        legacyId: `${slug}:tradeevent:${i}:1`,
        tradeId,
        leagueId,
        type: "responded",
        fromStatus: "proposed",
        toStatus: String(tradeRows[i].status),
        actorTeamId: teamIds[tradeSpecs[i].b],
        payload: {},
      },
    ]),
  );

  // -- forum ----------------------------------------------------------------
  const postRows: Row[] = [];
  const postSpecs: Array<{ weekNo: number; team: number }> = [];
  for (let w = 1; w <= WEEKS; w += 1) {
    for (let n = 0; n < POSTS_PER_WEEK; n += 1) {
      const team = (w * POSTS_PER_WEEK + n) % TEAMS;
      postSpecs.push({ weekNo: w, team });
      postRows.push({
        legacyId: `${slug}:post:${w}:${n}`,
        leagueId,
        teamId: teamIds[team],
        title: `Week ${w} take #${n + 1}`,
        body: `Week ${w}: the projections said one thing and the box score said another. ${"Discussion. ".repeat(20)}`,
        flair: ["trash_talk", "analysis", "trade_block"][n % 3],
        score: Math.floor(rand() * 40) - 5,
        commentCount: COMMENTS_PER_POST,
        hidden: false,
        createdAt: weekStart(w) + 6 * 60 * 60 * 1000 + n * 60_000,
      });
    }
  }
  const postIds = await importRows("forum_posts", postRows);
  await importRows(
    "forum_comments",
    postIds.flatMap((postId, i) =>
      Array.from({ length: COMMENTS_PER_POST }, (_, c) => ({
        legacyId: `${slug}:comment:${i}:${c}`,
        postId,
        leagueId,
        teamId: teamIds[(postSpecs[i].team + c + 1) % TEAMS],
        body: `Reply ${c + 1}: hard disagree, the schedule is the whole story.`,
        score: Math.floor(rand() * 12) - 2,
        hidden: false,
        createdAt: Number(postRows[i].createdAt) + (c + 1) * 120_000,
      })),
    ),
  );
  await importRows(
    "forum_votes",
    postIds.flatMap((postId, i) =>
      Array.from({ length: VOTES_PER_POST }, (_, vIndex) => ({
        legacyId: `${slug}:vote:${i}:${vIndex}`,
        leagueId,
        targetType: "post",
        targetId: postId,
        voterTeamId: teamIds[(postSpecs[i].team + vIndex + 1) % TEAMS],
        direction: vIndex % 4 === 0 ? -1 : 1,
      })),
    ),
  );

  // -- rollups (§2.6: the aggregations that used to run at query time) ------
  type Counters = {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    reasoningTokens: number;
    costUsd: number;
    computedCostUsd: number;
    gatewayCostUsd: number;
    runCount: number;
    stepCount: number;
    fallbackCount: number;
    invalidActionCount: number;
    updatedAt: number;
  };
  const zero = (): Counters => ({
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
    computedCostUsd: 0,
    gatewayCostUsd: 0,
    runCount: 0,
    stepCount: 0,
    fallbackCount: 0,
    invalidActionCount: 0,
    updatedAt: now,
  });
  const teamWeek = new Map<string, Counters>();
  const modelWeek = new Map<string, Counters>();
  const leagueWeek = new Map<string, Counters>();
  const runsSeen = new Map<string, Set<string>>();
  const bump = (map: Map<string, Counters>, key: string, row: Row, runId: string) => {
    const c = map.get(key) ?? zero();
    c.inputTokens += Number(row.inputTokens);
    c.outputTokens += Number(row.outputTokens);
    c.costUsd = round8(c.costUsd + Number(row.costUsd));
    c.computedCostUsd = round8(c.computedCostUsd + Number(row.computedCostUsd));
    c.gatewayCostUsd = round8(c.gatewayCostUsd + Number(row.gatewayCostUsd));
    c.stepCount += 1;
    const seen = runsSeen.get(key) ?? new Set<string>();
    if (!seen.has(runId)) {
      seen.add(runId);
      c.runCount += 1;
      runsSeen.set(key, seen);
    }
    map.set(key, c);
  };
  usageRows.forEach((row) => {
    const runId = String(row.runId);
    bump(teamWeek, `${String(row.teamId)}|${String(row.weekNo)}`, row, runId);
    bump(modelWeek, `${String(row.modelId)}|${String(row.weekNo)}`, row, runId);
    bump(leagueWeek, `${String(row.weekNo)}`, row, runId);
  });

  await importRows(
    "team_week_rollups",
    [...teamWeek.entries()].map(([key, counters]) => {
      const [teamId, weekNo] = key.split("|");
      return { leagueId, teamId, season: SEASON, weekNo: Number(weekNo), ...counters };
    }),
  );
  await importRows(
    "model_week_rollups",
    [...modelWeek.entries()].map(([key, counters]) => {
      const [modelId, weekNo] = key.split("|");
      return {
        leagueId,
        modelId,
        provider: PROVIDER_OF[modelId] ?? "mock",
        season: SEASON,
        weekNo: Number(weekNo),
        ...counters,
      };
    }),
  );
  await importRows(
    "league_week_rollups",
    [...leagueWeek.entries()].map(([weekNo, counters]) => ({
      leagueId,
      season: SEASON,
      weekNo: Number(weekNo),
      ...counters,
    })),
  );

  // Completion marker: `--from`/resume skips leagues that carry it.
  await patchRows("leagues", [
    { id: leagueId, patch: { joinCode: `${DONE_PREFIX}${String(index).padStart(3, "0")}` } },
  ]);
  process.stdout.write(
    `  [${elapsed()}] ${slug} done — ${rowsWritten.toLocaleString()} rows written so far\n`,
  );
}

// ----------------------------------------------------------------------- main

/**
 * Clear every importable table through `seed.clearTable`. A league whose seed died
 * half way leaves rows the per-league resume cannot identify (only the `leagues`
 * row carries the completion marker), so `--reset` is the way back to a clean
 * deployment without needing the internal `seed:reset`.
 */
async function resetAll(): Promise<void> {
  const failed: string[] = [];
  for (const table of RESET_TABLES) {
    try {
      for (;;) {
        const result = await client.mutation(api.seed.clearTable, {
          secret: secret!,
          table: table as never,
        });
        if (result.done) break;
      }
    } catch (error) {
      failed.push(table);
      process.stdout.write(
        `  reset ${table.padEnd(22)} FAILED: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}\n`,
      );
    }
  }
  process.stdout.write(
    `  reset                        ${RESET_TABLES.length - failed.length}/${RESET_TABLES.length} tables cleared` +
      (failed.length ? ` (skipped: ${failed.join(", ")})\n` : "\n"),
  );
}

async function main(): Promise<void> {
  process.stdout.write(`Load-test seed -> ${url}\n`);
  if (RESET) await resetAll();
  const base = await client.mutation(api.seed.runBase, { secret: secret! });
  process.stdout.write(
    `  seed:base                    ${base.modelPrices} model prices, ${base.skills} skills\n`,
  );
  const userId = await ensureUser();
  process.stdout.write(`  user                         ${DEMO_USER.email}\n`);
  const pool = await ensurePlayers();

  for (let index = FROM_INDEX; index < LEAGUE_COUNT; index += 1) {
    await seedLeague(index, userId, pool);
  }

  process.stdout.write(
    `\nDone in ${elapsed()}. ${rowsWritten.toLocaleString()} documents written this run.\n`,
  );
  for (const table of [
    "leagues",
    "teams",
    "windows",
    "runs",
    "run_steps",
    "usage_events",
    "snapshot_chunks",
    "trades",
    "messages",
    "forum_posts",
  ]) {
    process.stdout.write(`  ${table.padEnd(22)} ${(await countTable(table)).toLocaleString()}\n`);
  }
}

main().catch((error: unknown) => {
  console.error("Load-test seed failed:", error);
  process.exit(1);
});
