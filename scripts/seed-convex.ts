/**
 * Import the golden Postgres dataset into Convex.
 *
 *   npm run seed:convex        (tsx --env-file-if-exists=.env.local)
 *
 * Needs `NEXT_PUBLIC_CONVEX_URL` and `SEED_SECRET`; the same `SEED_SECRET` must be
 * set on the deployment (`npx convex env set SEED_SECRET …`) or every seed
 * function refuses.
 *
 * What it does, in order:
 *
 *  1. `seed.runBase` — model prices + the three built-in skills (idempotent).
 *  2. Signs `demo@fantasybench.dev` up through the real Convex Auth password flow
 *     (`api.auth.signIn`, `flow: "signUp"`, falling back to `"signIn"`), so the
 *     credential hash is genuine and package D can sign in with the same password.
 *  3. Imports `tests/golden/postgres-week1/*.json` in dependency order through
 *     `seed.importBatch`, keeping the golden-uuid -> Convex-id map it builds as
 *     it goes.
 *
 * Derived data the old schema did not have is computed here rather than at read
 * time (§2.3/§2.6): snapshot chunks + digests, the three rollup tables,
 * `team_standings`, `run_search_docs` and `player_projection_latest`.
 *
 * Idempotent: the id map is written to `.cache/seed-map.<deployment>.json` after
 * every table and read back on the next run, so rows already imported are skipped
 * and a partial run resumes where it stopped. Delete that file only if you have
 * also wiped the deployment (`npx convex run seed:reset '{}'`).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ConvexHttpClient } from "convex/browser";

import { api } from "../convex/_generated/api";
import { readIdMap, seedMapFile, setTable, tableMap, writeIdMap, type IdMap } from "./seed-map";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GOLDEN = path.join(ROOT, "tests", "golden", "postgres-week1");

const DEMO_USER = {
  email: "demo@fantasybench.dev",
  password: "password1234",
  name: "Demo Owner",
};

/** 64 KB: a tool result above this goes to `run_step_payloads` (PRD 5.8). */
const PAYLOAD_INLINE_LIMIT = 64 * 1024;
/** Players per `snapshot_chunks` row (`kind: "players"`). */
const SNAPSHOT_PLAYERS_PER_CHUNK = 100;
/** `run_search_docs.text` cap. */
const SEARCH_TEXT_LIMIT = 64 * 1024;

// --------------------------------------------------------------- small helpers

type Row = Record<string, unknown>;

/**
 * Golden rows, oldest first.
 *
 * Convex orders by `_creationTime` wherever the Postgres code ordered by
 * `created_at`, and `_creationTime` is the insert instant — so rows have to go in
 * in chronological order for `trades`, `trade_events`, `forum_*`, `messages` and
 * `run_steps` to read back in the order the old queries produced. The sort is
 * stable, so rows sharing a timestamp keep their file order.
 */
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

/** Postgres timestamps arrive as ISO strings; the database stores epoch ms. */
function ms(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "number") return value;
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? undefined : parsed;
}

function msRequired(value: unknown, fallback: number): number {
  return ms(value) ?? fallback;
}

/** `numeric` columns come back as strings from some drivers. */
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

/**
 * `contentFlags` (the injection classifier's output, PRD 6.7). Postgres stored a
 * looser blob: `{}` for "not classified" and an extra `categories` array the
 * Convex validator does not carry.
 */
function contentFlags(value: unknown): Row | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Row;
  if (typeof raw.injectionSuspected !== "boolean") return undefined;
  return clean({
    injectionSuspected: raw.injectionSuspected,
    score: numOr(raw.score, 0),
    reasons: Array.isArray(raw.reasons) ? (raw.reasons as string[]).map(String) : undefined,
  });
}

/** Drop `undefined` values: Convex has no `undefined`, an absent field is the null. */
function clean<T extends Row>(row: T): T {
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}

// ------------------------------------------------------------------ id mapping

/**
 * `table -> golden id -> Convex _id`, loaded from and written back to
 * `.cache/seed-map.<deployment>.json` (`scripts/seed-map.ts`). Convex rows carry
 * no id of their own, so this file *is* the idempotency key.
 */
const MAP_FILE = seedMapFile(ROOT);
const persisted: IdMap = readIdMap(MAP_FILE);
const ids = new Map<string, Map<string, string>>();

function mapOf(table: string): Map<string, string> {
  let m = ids.get(table);
  if (!m) {
    m = tableMap(persisted, table);
    ids.set(table, m);
  }
  return m;
}

/** Fold the live maps back into the file. Called after every table. */
function saveMap(): void {
  for (const [table, m] of ids) setTable(persisted, table, m);
  writeIdMap(MAP_FILE, persisted);
}

function ref(table: string, goldenId: unknown): string | undefined {
  if (goldenId === null || goldenId === undefined) return undefined;
  const found = mapOf(table).get(String(goldenId));
  if (!found) throw new Error(`No imported ${table} row for golden id ${String(goldenId)}`);
  return found;
}

function refOpt(table: string, goldenId: unknown): string | undefined {
  if (goldenId === null || goldenId === undefined) return undefined;
  return mapOf(table).get(String(goldenId));
}

// -------------------------------------------------------------------- remapping

/**
 * Postgres uuids embedded in JSON blobs.
 *
 * The old schema stored denormalized ids inside jsonb columns, and the runtime
 * and views join them against `roster_slots.playerId` / `teams._id` / thread and
 * trade ids. Left as uuids they would break every roster and projection lookup on
 * the golden data, so every blob that is *read as data* is remapped through the
 * same golden-id -> `_id` maps the columns use.
 *
 * `run_steps.responseMessages/toolCalls/toolResults` are deliberately NOT remapped:
 * they are the verbatim model transcript (trace text, replayed on resume), nothing
 * joins them, and rewriting ids inside them would falsify the trace.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Field name -> the table its uuid(s) point at. Arrays of uuids use the same key. */
const BLOB_FIELD_TABLES: Record<string, string> = {
  playerId: "players",
  addPlayerId: "players",
  dropPlayerId: "players",
  give: "players",
  receive: "players",
  rosterPlayerIds: "players",
  freeAgentIds: "players",
  teamId: "teams",
  toTeamId: "teams",
  fromTeamId: "teams",
  ownerTeamId: "teams",
  homeTeamId: "teams",
  awayTeamId: "teams",
  actorTeamId: "teams",
  senderTeamId: "teams",
  ownerUserId: "users",
  leagueId: "leagues",
  windowId: "windows",
  runId: "runs",
  threadId: "threads",
  messageId: "messages",
  tradeId: "trades",
  parentTradeId: "trades",
  postId: "forum_posts",
  commentId: "forum_comments",
  lineupId: "lineups",
  claimId: "waiver_claims",
  claimIds: "waiver_claims",
  configVersionId: "config_versions",
  snapshotId: "snapshots",
};

/** uuids that had no imported row, counted per importer table for the report. */
const unmapped = new Map<string, number>();

function noteUnmapped(table: string): void {
  unmapped.set(table, (unmapped.get(table) ?? 0) + 1);
}

/** One uuid -> Convex id. Unknown uuids are left alone and counted. */
function remapId(table: string, value: unknown, into: string): unknown {
  if (typeof value !== "string" || !UUID_RE.test(value)) return value;
  const found = mapOf(table).get(value);
  if (found) return found;
  noteUnmapped(into);
  return value;
}

function remapMaybeList(table: string, value: unknown, into: string): unknown {
  if (Array.isArray(value)) return value.map((item) => remapId(table, item, into));
  return remapId(table, value, into);
}

/**
 * Deep copy of a loose blob with every recognised id field remapped.
 * Used for `run_actions.payload`/`result`, `trade_events.payload` and
 * `transactions.details`, whose shapes vary by action type.
 */
function remapBlob(value: unknown, into: string): unknown {
  if (Array.isArray(value)) return value.map((item) => remapBlob(item, into));
  if (!value || typeof value !== "object") return value;
  const out: Row = {};
  for (const [key, child] of Object.entries(value as Row)) {
    const table = BLOB_FIELD_TABLES[key];
    out[key] = table ? remapMaybeList(table, child, into) : remapBlob(child, into);
  }
  return out;
}

/** The `meta` half of a snapshot payload (everything except `players`). */
function remapSnapshotMeta(payload: Row, into: string): Row {
  const out: Row = { ...payload };
  out.leagueId = remapId("leagues", payload.leagueId, into);

  if (Array.isArray(payload.teams)) {
    out.teams = (payload.teams as Row[]).map((team) => ({
      ...team,
      id: remapId("teams", team.id, into),
      ownerUserId: team.ownerUserId ? remapId("users", team.ownerUserId, into) : team.ownerUserId,
      rosterPlayerIds: remapMaybeList("players", team.rosterPlayerIds, into),
      lineup: Array.isArray(team.lineup)
        ? (team.lineup as Row[]).map((slot) => ({
            ...slot,
            playerId: slot.playerId ? remapId("players", slot.playerId, into) : null,
          }))
        : team.lineup,
    }));
  }

  if (Array.isArray(payload.matchups)) {
    out.matchups = (payload.matchups as Row[]).map((matchup) => ({
      ...matchup,
      homeTeamId: remapId("teams", matchup.homeTeamId, into),
      awayTeamId: remapId("teams", matchup.awayTeamId, into),
    }));
  }

  if (Array.isArray(payload.standings)) {
    out.standings = (payload.standings as Row[]).map((standing) => ({
      ...standing,
      teamId: remapId("teams", standing.teamId, into),
    }));
  }

  if (Array.isArray(payload.news)) {
    out.news = (payload.news as Row[]).map((item) => ({
      ...item,
      playerId: item.playerId ? remapId("players", item.playerId, into) : item.playerId,
    }));
  }

  if (Array.isArray(payload.injuries)) {
    out.injuries = (payload.injuries as Row[]).map((item) => ({
      ...item,
      playerId: item.playerId ? remapId("players", item.playerId, into) : item.playerId,
    }));
  }

  out.freeAgentIds = remapMaybeList("players", payload.freeAgentIds, into);

  // `liveScores` is keyed by team id.
  if (payload.liveScores && typeof payload.liveScores === "object") {
    out.liveScores = Object.fromEntries(
      Object.entries(payload.liveScores as Row).map(([teamId, score]) => [
        String(remapId("teams", teamId, into)),
        score,
      ]),
    );
  }

  return out;
}

/** The `players` half: a record keyed by player id, each entry carrying ids too. */
function remapSnapshotPlayers(players: Record<string, unknown>, into: string): Row {
  const out: Row = {};
  for (const [playerId, player] of Object.entries(players)) {
    const mapped = String(remapId("players", playerId, into));
    const row = player as Row;
    out[mapped] = {
      ...row,
      id: remapId("players", row.id, into),
      ownerTeamId: row.ownerTeamId ? remapId("teams", row.ownerTeamId, into) : row.ownerTeamId,
    };
  }
  return out;
}

// ---------------------------------------------------------------- convex calls

const url = process.env.NEXT_PUBLIC_CONVEX_URL;
const secret = process.env.SEED_SECRET;
if (!url) throw new Error("NEXT_PUBLIC_CONVEX_URL is not set (see .env.local).");
if (!secret) throw new Error("SEED_SECRET is not set (see .env.local).");

const client = new ConvexHttpClient(url);
const counts: Array<[string, number]> = [];

/**
 * Insert `rows` (already shaped for the schema) and record their ids.
 *
 * Each row carries `__golden`, the golden uuid it came from. That key is the
 * local dedupe key and never a column: it is stripped before the insert and
 * written to the id map afterwards. Rows already in the map are skipped, which is
 * what makes a re-run cheap and a half-finished run resumable.
 */
async function importRows(table: string, rows: Row[], batchSize = 400): Promise<number> {
  const known = mapOf(table);
  const pending = rows.filter((row) => {
    const goldenId = row.__golden as string | undefined;
    return goldenId === undefined || !known.has(goldenId);
  });

  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    const { ids: inserted } = await client.mutation(api.seed.importBatch, {
      secret: secret!,
      table,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- __golden is the local dedupe key, never a column
      rows: batch.map(({ __golden, ...rest }) => rest),
    });
    batch.forEach((row, index) => {
      const goldenId = row.__golden as string | undefined;
      if (goldenId) known.set(goldenId, inserted[index]);
    });
  }
  saveMap();

  counts.push([table, rows.length]);
  process.stdout.write(
    `  ${table.padEnd(26)} ${String(rows.length).padStart(5)} rows` +
      (pending.length === rows.length ? "\n" : ` (${rows.length - pending.length} already present)\n`),
  );
  return pending.length;
}

/**
 * Insert rows for a derived table — one with no golden uuid to de-duplicate on
 * (`snapshot_chunks`, the rollups, `team_standings`, `run_search_docs`,
 * `player_projection_latest`, `run_step_payloads`). The table is cleared first so
 * a re-run replaces rather than doubles.
 */
async function importDerived(table: string, rows: Row[], batchSize = 400): Promise<string[]> {
  for (;;) {
    const { done } = await client.mutation(api.seed.clearTable, {
      secret: secret!,
      table: table as never,
    });
    if (done) break;
  }
  const ids: string[] = [];
  for (let i = 0; i < rows.length; i += batchSize) {
    const inserted = await client.mutation(api.seed.importBatch, {
      secret: secret!,
      table,
      rows: rows.slice(i, i + batchSize),
    });
    ids.push(...inserted.ids);
  }
  counts.push([table, rows.length]);
  process.stdout.write(`  ${table.padEnd(26)} ${String(rows.length).padStart(5)} rows\n`);
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

// -------------------------------------------------------------------- the seed

async function main(): Promise<void> {
  process.stdout.write(`Seeding ${url}\n`);

  // 1 ---------------------------------------------------------- base fixtures
  const base = await client.mutation(api.seed.runBase, { secret: secret! });
  process.stdout.write(
    `  seed:base                    ${base.modelPrices} model prices, ${base.skills} built-in skills\n`,
  );

  // 2 ------------------------------------------------------------- demo user
  const demoUserId = await ensureDemoUser();
  process.stdout.write(`  demo user                    ${DEMO_USER.email} (${demoUserId})\n`);

  const goldenUser = readGolden("users")[0];
  mapOf("users").set(String(goldenUser.id), demoUserId);
  saveMap();

  // 3 -------------------------------------------------------------- the league
  await importLeague();
  await importPlayersAndProjections();
  await importSkills();
  await importConfigs();
  await importWindowsAndSnapshots();
  await importRunsAndLedger();
  await importRosterAndTransactions();
  await importSocial();
  await importRunActions();
  await importDerivedTables();

  await verify();
}

/**
 * Read the deployment back and print golden count vs. Convex count per table.
 * Exits non-zero on any mismatch, so `npm run seed:convex` is also the check.
 */
async function verify(): Promise<void> {
  if (unmapped.size > 0) {
    process.stdout.write("\nuuids left unmapped inside blobs (no imported row):\n");
    for (const [table, count] of [...unmapped.entries()].sort()) {
      process.stdout.write(`  ${table.padEnd(26)} ${count}\n`);
    }
  } else {
    process.stdout.write("\nEvery uuid inside an imported blob resolved to a Convex id.\n");
  }

  process.stdout.write("\nSeed complete. golden -> convex:\n");
  let bad = 0;
  for (const [table, expected] of counts) {
    let actual = 0;
    let cursor: string | null = null;
    for (;;) {
      const page: { count: number; continueCursor: string; isDone: boolean } = await client.query(
        api.seed.tableCount,
        { secret: secret!, table: table as never, cursor },
      );
      actual += page.count;
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    const ok = actual === expected;
    if (!ok) bad += 1;
    process.stdout.write(
      `  ${table.padEnd(26)} ${String(expected).padStart(5)} -> ${String(actual).padStart(5)} ${ok ? "ok" : "MISMATCH"}\n`,
    );
  }
  if (bad > 0) {
    process.stderr.write(`\n${bad} table(s) do not match the golden dataset.\n`);
    process.exit(1);
  }
}

/**
 * Sign the demo user up through the real password flow, or sign in if the account
 * already exists. `signIn` is a public Convex Auth action; `api.users.byEmailPublic`
 * (SEED_SECRET-guarded) turns the email back into the `Id<"users">`.
 */
async function ensureDemoUser(): Promise<string> {
  const existing = await client.query(api.users.byEmailPublic, {
    secret: secret!,
    email: DEMO_USER.email,
  });
  if (existing) return existing.userId;

  try {
    await client.action(api.auth.signIn, {
      provider: "password",
      params: {
        email: DEMO_USER.email,
        password: DEMO_USER.password,
        name: DEMO_USER.name,
        flow: "signUp",
      },
    });
  } catch (error) {
    // Account exists but the lookup raced, or sign-up is rejected: try signing in.
    process.stdout.write(
      `  sign-up failed (${error instanceof Error ? error.message : String(error)}); signing in\n`,
    );
    await client.action(api.auth.signIn, {
      provider: "password",
      params: { email: DEMO_USER.email, password: DEMO_USER.password, flow: "signIn" },
    });
  }

  const created = await client.query(api.users.byEmailPublic, {
    secret: secret!,
    email: DEMO_USER.email,
  });
  if (!created) throw new Error("Demo user was not created by the password flow.");
  return created.userId;
}

// ------------------------------------------------------------- league skeleton

async function importLeague(): Promise<void> {
  const now = Date.now();

  await importRows(
    "leagues",
    readGolden("leagues").map((row) => ({
      __golden: String(row.id),
      name: String(row.name),
      slug: String(row.slug),
      commissionerUserId: ref("users", row.commissioner_user_id)!,
      season: numOr(row.season, 2026),
      teamCount: numOr(row.team_count, 12),
      isPublic: row.is_public === true,
      status: String(row.status),
      draftType: String(row.draft_type),
      draftScheduledAt: ms(row.draft_scheduled_at),
      joinCode: str(row.join_code),
      createdAt: msRequired(row.created_at, now),
      updatedAt: msRequired(row.updated_at, now),
    })).map(clean),
  );

  await importRows(
    "league_rules",
    readGolden("league_rules").map((row) =>
      clean({
        __golden: String(row.id),
        leagueId: ref("leagues", row.league_id)!,
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
        __golden: String(row.id),
        leagueId: ref("leagues", row.league_id)!,
        userId: ref("users", row.user_id)!,
        role: String(row.role),
        createdAt: ms(row.created_at),
      }),
    ),
  );

  await importRows(
    "teams",
    readGolden("teams").map((row) =>
      clean({
        __golden: String(row.id),
        leagueId: ref("leagues", row.league_id)!,
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
        __golden: String(row.id),
        leagueId: ref("leagues", row.league_id)!,
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
        __golden: String(row.id),
        leagueId: ref("leagues", row.league_id)!,
        weekNo: numOr(row.week_no, 0),
        homeTeamId: ref("teams", row.home_team_id)!,
        awayTeamId: ref("teams", row.away_team_id)!,
        homeScore: num(row.home_score),
        awayScore: num(row.away_score),
        isFinal: row.is_final === true,
      }),
    ),
  );

  await importRows(
    "team_results",
    readGolden("team_results").map((row) =>
      clean({
        __golden: String(row.id),
        leagueId: ref("leagues", row.league_id)!,
        teamId: ref("teams", row.team_id)!,
        weekNo: numOr(row.week_no, 0),
        pointsFor: numOr(row.points_for, 0),
        pointsAgainst: numOr(row.points_against, 0),
        won: row.won === true,
        lost: row.lost === true,
        tied: row.tied === true,
      }),
    ),
  );
}

// ------------------------------------------------------------ players & stats

/** `raw` was the whole Sleeper blob; the Convex schema keeps only cross-provider ids. */
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

async function importPlayersAndProjections(): Promise<void> {
  const players = readGolden("players");
  const positionByPlayer = new Map<string, string>();
  for (const row of players) positionByPlayer.set(String(row.id), String(row.position));

  await importRows(
    "players",
    players.map((row) => {
      const externalIds = externalIdsOf(row.raw);
      return clean({
        __golden: String(row.id),
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
        injuryBodyPart: str(row.injury_body_part),
        injuryNotes: str(row.injury_notes),
        byeWeek: num(row.bye_week),
        yearsExp: num(row.years_exp),
        age: num(row.age),
        searchRank: num(row.search_rank),
        fantasyPositions: row.fantasy_positions ?? [],
        externalIds,
        updatedAt: msRequired(row.updated_at, Date.now()),
      });
    }),
    400,
  );

  await importRows(
    "nfl_games",
    readGolden("nfl_games").map((row) =>
      clean({
        __golden: String(row.id),
        season: numOr(row.season, 0),
        week: numOr(row.week, 0),
        gameId: String(row.game_id),
        espnId: str(row.espn_id),
        homeTeam: String(row.home_team),
        awayTeam: String(row.away_team),
        kickoffAt: msRequired(row.kickoff_at, 0),
        status: String(row.status),
        homeScore: num(row.home_score),
        awayScore: num(row.away_score),
      }),
    ),
  );

  const projections = readGolden("player_projections");
  await importRows(
    "player_projections",
    projections.map((row) =>
      clean({
        __golden: String(row.id),
        playerId: ref("players", row.player_id)!,
        season: numOr(row.season, 0),
        week: numOr(row.week, 0),
        source: String(row.source),
        projectedPointsPpr: numOr(row.projected_points_ppr, 0),
        projectedPointsHalf: numOr(row.projected_points_half, 0),
        projectedPointsStd: numOr(row.projected_points_std, 0),
        stats: numericStats(row.stats),
        effectiveAt: msRequired(row.effective_at, 0),
      }),
    ),
    400,
  );

  // The newest vintage per (player, season, week, source) — the builder's index.
  const latest = new Map<string, Row>();
  for (const row of projections) {
    const key = `${String(row.player_id)}|${String(row.season)}|${String(row.week)}|${String(row.source)}`;
    const previous = latest.get(key);
    if (!previous || msRequired(row.effective_at, 0) >= msRequired(previous.effective_at, 0)) {
      latest.set(key, row);
    }
  }
  await importDerived(
    "player_projection_latest",
    [...latest.values()].map((row) =>
      clean({
        playerId: ref("players", row.player_id)!,
        season: numOr(row.season, 0),
        week: numOr(row.week, 0),
        source: String(row.source),
        position: positionByPlayer.get(String(row.player_id)) ?? "WR",
        projectedPointsPpr: numOr(row.projected_points_ppr, 0),
        projectedPointsHalf: numOr(row.projected_points_half, 0),
        projectedPointsStd: numOr(row.projected_points_std, 0),
        stats: numericStats(row.stats),
        effectiveAt: msRequired(row.effective_at, 0),
      }),
    ),
    400,
  );

  await importRows(
    "player_stats_weekly",
    readGolden("player_stats_weekly").map((row) =>
      clean({
        __golden: String(row.id),
        playerId: ref("players", row.player_id)!,
        season: numOr(row.season, 0),
        week: numOr(row.week, 0),
        source: String(row.source),
        stats: numericStats(row.stats),
        fantasyPointsPpr: numOr(row.fantasy_points_ppr, 0),
        fantasyPointsHalf: numOr(row.fantasy_points_half, 0),
        fantasyPointsStd: numOr(row.fantasy_points_std, 0),
        effectiveAt: msRequired(row.effective_at, 0),
      }),
    ),
  );
}

/** `stats` is `v.record(v.string(), v.number())`; Sleeper mixes in a few strings. */
function numericStats(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!value || typeof value !== "object") return out;
  for (const [key, raw] of Object.entries(value as Row)) {
    const n = num(raw);
    if (n !== undefined) out[key] = n;
  }
  return out;
}

// ------------------------------------------------------------------- skills

/**
 * `seed:base` already created the three built-in skills, so the golden rows are
 * merged onto them by slug rather than inserted a second time.
 */
async function importSkills(): Promise<void> {
  const rows = readGolden("skills");
  const stamps: Array<{ id: string; patch: Row }> = [];
  const fresh: Row[] = [];

  for (const row of rows) {
    const slug = String(row.slug);
    const existing = await client.query(api.skills.get, { slug });
    if (existing) {
      mapOf("skills").set(String(row.id), existing._id);
      stamps.push({
        id: existing._id,
        patch: clean({
          authorUserId: refOpt("users", row.author_user_id),
          createdAt: ms(row.created_at),
        }),
      });
    } else {
      fresh.push(
        clean({
          __golden: String(row.id),
          authorUserId: refOpt("users", row.author_user_id),
          name: String(row.name),
          slug,
          description: str(row.description),
          bodyMd: String(row.body_md),
          visibility: String(row.visibility),
          forkedFromSkillId: refOpt("skills", row.forked_from_skill_id),
          usageCount: 0,
          createdAt: ms(row.created_at),
          updatedAt: msRequired(row.updated_at, Date.now()),
        }),
      );
    }
  }

  if (stamps.length) await patchRows("skills", stamps);
  if (fresh.length) await importRows("skills", fresh);
  saveMap();
  counts.push(["skills", rows.length]);
  process.stdout.write(
    `  ${"skills".padEnd(26)} ${String(rows.length).padStart(5)} rows (${stamps.length} merged with seed:base)\n`,
  );
}

// ------------------------------------------------------------- agent configs

async function importConfigs(): Promise<void> {
  const configs = readGolden("agent_configs");
  const versions = readGolden("config_versions");
  const versionSkills = readGolden("config_version_skills");

  const teamByConfig = new Map<string, string>();
  for (const row of configs) teamByConfig.set(String(row.id), String(row.team_id));

  // agent_configs first, without the version pointers (they do not exist yet).
  await importRows(
    "agent_configs",
    configs.map((row) =>
      clean({
        __golden: String(row.id),
        teamId: ref("teams", row.team_id)!,
        leagueId: ref("leagues", leagueOfTeam(String(row.team_id)))!,
        noteToAgent: str(row.note_to_agent),
        createdAt: ms(row.created_at),
        updatedAt: ms(row.updated_at),
      }),
    ),
  );

  // config_version_skills folded into `config_versions.skillIds`, in position order.
  const skillIdsByVersion = new Map<string, string[]>();
  const ordered = [...versionSkills].sort(
    (a, b) => numOr(a.position, 0) - numOr(b.position, 0),
  );
  for (const row of ordered) {
    const key = String(row.config_version_id);
    const skillId = refOpt("skills", row.skill_id);
    if (!skillId) continue;
    skillIdsByVersion.set(key, [...(skillIdsByVersion.get(key) ?? []), skillId]);
  }

  await importRows(
    "config_versions",
    versions.map((row) => {
      const legacyTeamId = teamByConfig.get(String(row.config_id));
      if (!legacyTeamId) throw new Error(`config_versions row ${String(row.id)} has no config`);
      return clean({
        __golden: String(row.id),
        configId: ref("agent_configs", row.config_id)!,
        teamId: ref("teams", legacyTeamId)!,
        leagueId: ref("leagues", leagueOfTeam(legacyTeamId))!,
        versionNo: numOr(row.version_no, 1),
        contextMd: String(row.context_md),
        modelId: String(row.model_id),
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
      id: ref("agent_configs", row.id)!,
      patch: clean({
        currentVersionId: refOpt("config_versions", row.current_version_id),
        pendingVersionId: refOpt("config_versions", row.pending_version_id),
      }),
    })),
  );

  // `skills.usageCount` is denormalized: how many *current* versions attach it.
  const usage = new Map<string, number>();
  for (const config of configs) {
    const currentId = String(config.current_version_id ?? "");
    if (!currentId) continue;
    for (const skillId of skillIdsByVersion.get(currentId) ?? []) {
      usage.set(skillId, (usage.get(skillId) ?? 0) + 1);
    }
  }
  if (usage.size) {
    await patchRows(
      "skills",
      [...usage.entries()].map(([id, usageCount]) => ({ id, patch: { usageCount } })),
    );
  }
}

let teamLeagues: Map<string, string> | null = null;

/** Golden team id -> golden league id, from `teams.json`. */
function leagueOfTeam(goldenTeamId: string): string {
  if (!teamLeagues) {
    teamLeagues = new Map(readGolden("teams").map((row) => [String(row.id), String(row.league_id)]));
  }
  const leagueId = teamLeagues.get(goldenTeamId);
  if (!leagueId) throw new Error(`No golden team ${goldenTeamId}`);
  return leagueId;
}

// -------------------------------------------------------- windows & snapshots

/** Postgres `windows.scope` keys the Convex `scope` validator does not carry. */
function windowScope(scope: unknown): Row {
  const raw = (scope ?? {}) as Row;
  const out: Row = {};
  if (Array.isArray(raw.gameDays)) out.gameDays = raw.gameDays;
  if (Array.isArray(raw.slots)) out.slots = raw.slots;
  if (num(raw.pickNo) !== undefined) out.pickNo = num(raw.pickNo);
  if (num(raw.rounds) !== undefined) out.rounds = num(raw.rounds);
  // `roundNo` in the old scope blob is the schema's `round`; `dayIndex` is dropped
  // because it always equalled the window's own `roundNo` column.
  if (num(raw.roundNo) !== undefined) out.round = num(raw.roundNo);
  if (num(raw.round) !== undefined) out.round = num(raw.round);
  if (num(raw.lotNo) !== undefined) out.lotNo = num(raw.lotNo);
  if (typeof raw.phase === "string") out.phase = raw.phase;
  if (typeof raw.draftType === "string") out.draftType = raw.draftType;
  if (raw.onTheClockTeamId) out.onTheClockTeamId = refOpt("teams", raw.onTheClockTeamId);
  if (raw.nominationTeamId) out.nominationTeamId = refOpt("teams", raw.nominationTeamId);
  return out;
}

const TERMINAL_RUN_STATUSES = new Set([
  "succeeded",
  "partial",
  "failed",
  "timed_out",
  "fallback",
  "skipped",
]);

async function importWindowsAndSnapshots(): Promise<void> {
  const windows = readGolden("windows");
  const runs = readGolden("runs");

  const runCount = new Map<string, number>();
  const terminalCount = new Map<string, number>();
  for (const run of runs) {
    const key = String(run.window_id);
    runCount.set(key, (runCount.get(key) ?? 0) + 1);
    if (TERMINAL_RUN_STATUSES.has(String(run.status))) {
      terminalCount.set(key, (terminalCount.get(key) ?? 0) + 1);
    }
  }

  await importRows(
    "windows",
    windows.map((row) =>
      clean({
        __golden: String(row.id),
        leagueId: ref("leagues", row.league_id)!,
        type: String(row.type),
        label: String(row.label),
        // `weekNo` is non-null in Convex; week-less (draft//digest) windows use 0.
        weekNo: num(row.week_no) ?? 0,
        roundNo: numOr(row.round_no, 1),
        opensAt: msRequired(row.opens_at, 0),
        submissionDeadlineAt: msRequired(row.submission_deadline_at, 0),
        closesAt: msRequired(row.closes_at, 0),
        status: String(row.status),
        scope: windowScope(row.scope),
        runCount: runCount.get(String(row.id)) ?? 0,
        terminalRunCount: terminalCount.get(String(row.id)) ?? 0,
      }),
    ),
  );

  // Snapshots: metadata row + chunked payload + digest (migration plan §1).
  const snapshots = readGolden("snapshots");
  const snapshotRows: Row[] = [];
  for (const row of snapshots) {
    const payload = (row.payload ?? {}) as Row;
    const players = (payload.players ?? {}) as Record<string, unknown>;
    const playerCount = Object.keys(players).length;
    const chunkCount = 1 + Math.ceil(playerCount / SNAPSHOT_PLAYERS_PER_CHUNK);
    snapshotRows.push(
      clean({
        __golden: String(row.id),
        leagueId: ref("leagues", row.league_id)!,
        windowId: refOpt("windows", row.window_id),
        season: numOr(payload.season ?? row.season, 0),
        weekNo: numOr(row.week_no, 0),
        takenAt: msRequired(row.taken_at, 0),
        status: "ready",
        chunkCount,
        playerCount,
        projectionEffectiveAt: projectionVintage(players),
        headline: str(((row.digest ?? {}) as Row).headline),
      }),
    );
  }
  await importRows("snapshots", snapshotRows);

  const chunks: Row[] = [];
  const digests: Row[] = [];
  for (const row of snapshots) {
    const snapshotId = ref("snapshots", row.id)!;
    const payload = { ...((row.payload ?? {}) as Row) };
    const players = (payload.players ?? {}) as Record<string, unknown>;
    delete payload.players;

    // Every id inside the frozen payload is remapped: the runtime joins these
    // against `roster_slots.playerId` and `teams._id`.
    const meta = remapSnapshotMeta(payload, "snapshot_chunks");
    chunks.push({ snapshotId, kind: "meta", part: 0, data: meta, bytes: bytesOf(meta) });

    const entries = Object.entries(remapSnapshotPlayers(players, "snapshot_chunks"));
    for (let i = 0; i < entries.length; i += SNAPSHOT_PLAYERS_PER_CHUNK) {
      const data = Object.fromEntries(entries.slice(i, i + SNAPSHOT_PLAYERS_PER_CHUNK));
      chunks.push({
        snapshotId,
        kind: "players",
        part: i / SNAPSHOT_PLAYERS_PER_CHUNK,
        data,
        bytes: bytesOf(data),
      });
    }

    const digest = (row.digest ?? {}) as Row;
    const mapPlayer = (rows: unknown) =>
      Array.isArray(rows)
        ? (rows as Row[]).map((item) => ({
            ...item,
            playerId: remapId("players", item.playerId, "snapshot_digests"),
          }))
        : [];
    digests.push({
      snapshotId,
      headline: String(digest.headline ?? ""),
      topNews: digest.topNews ?? [],
      injuryChanges: mapPlayer(digest.injuryChanges),
      projectionMovers: mapPlayer(digest.projectionMovers),
      standingsSummary: String(digest.standingsSummary ?? ""),
    });
  }
  await importDerived("snapshot_chunks", chunks, 4);
  await importDerived("snapshot_digests", digests, 50);

  await patchRows(
    "windows",
    snapshots
      .filter((row) => row.window_id)
      .map((row) => ({
        id: ref("windows", row.window_id)!,
        patch: { snapshotId: ref("snapshots", row.id)! },
      })),
  );
}

/** Newest projection vintage pinned by a snapshot's player payload. */
function projectionVintage(players: Record<string, unknown>): number | undefined {
  let newest: number | undefined;
  for (const player of Object.values(players)) {
    const projection = (player as Row).projection as Row | null | undefined;
    const at = ms(projection?.effectiveAt);
    if (at !== undefined && (newest === undefined || at > newest)) newest = at;
  }
  return newest;
}

// ------------------------------------------------------------ runs and ledger

async function importRunsAndLedger(): Promise<void> {
  const runs = readGolden("runs");
  const steps = readGolden("run_steps");
  const actions = readGolden("run_actions");
  const events = readGolden("usage_events");
  const windows = new Map(readGolden("windows").map((row) => [String(row.id), row]));
  const league = readGolden("leagues")[0];
  const season = numOr(league.season, 2026);

  const committed = new Map<string, number>();
  const rejected = new Map<string, number>();
  for (const action of actions) {
    const key = String(action.run_id);
    const ok = ((action.validation_result ?? {}) as Row).ok === true;
    if (ok) committed.set(key, (committed.get(key) ?? 0) + 1);
    else rejected.set(key, (rejected.get(key) ?? 0) + 1);
  }

  await importRows(
    "runs",
    runs.map((row) => {
      const window = windows.get(String(row.window_id));
      if (!window) throw new Error(`run ${String(row.id)} has no window`);
      const stepCount = numOr(row.step_count, 0);
      return clean({
        __golden: String(row.id),
        windowId: ref("windows", row.window_id)!,
        leagueId: ref("leagues", row.league_id)!,
        teamId: refOpt("teams", row.team_id),
        configVersionId: refOpt("config_versions", row.config_version_id),
        modelId: String(row.model_id),
        kind: String(row.kind),
        status: String(row.status),
        // Denormalized from the window for the trace-list filters (§2.3).
        windowType: String(window.type),
        windowLabel: String(window.label),
        weekNo: num(window.week_no) ?? 0,
        attempt: 1,
        // Every step of these runs is persisted, so the resume marker is the last one.
        lastPersistedStep: stepCount - 1,
        startedAt: ms(row.started_at),
        finishedAt: ms(row.finished_at),
        outcome: str(row.outcome),
        rationale: str(row.rationale),
        totalCostUsd: numOr(row.total_cost_usd, 0),
        totalInputTokens: numOr(row.total_input_tokens, 0),
        totalOutputTokens: numOr(row.total_output_tokens, 0),
        stepCount,
        committedActionCount: committed.get(String(row.id)) ?? 0,
        rejectedActionCount: rejected.get(String(row.id)) ?? 0,
        error: str(row.error),
        fallbackApplied: row.fallback_applied ?? undefined,
        promptSections: row.prompt_sections ?? undefined,
      });
    }),
  );

  const runsById = new Map(runs.map((row) => [String(row.id), row]));

  // run_steps, with oversized tool results split into run_step_payloads (§2.3).
  //
  // The payload rows go in *first*, so the stub left in `toolResults` can carry
  // the real `payloadRef` — `convex/runs.ts` follows that ref to `runs.stepPayload`,
  // and a null ref would make the result unreachable from the trace viewer.
  // `run_step_payloads` is keyed by (runId, stepIndex, toolCallId), not by the
  // step's document id, so it can be written before the steps exist.
  const overflow: Row[] = [];
  /** Where each overflow row's ref has to be written back. */
  const overflowSlots: Array<{ step: number; result: number }> = [];
  const inlinedByStep: Row[][] = [];

  const stepRows = steps.map((row, stepRowIndex) => {
    const run = runsById.get(String(row.run_id));
    if (!run) throw new Error(`run_step ${String(row.id)} has no run`);
    const runId = ref("runs", row.run_id)!;
    const stepIndex = numOr(row.step_index, 0);

    const results = Array.isArray(row.tool_results) ? (row.tool_results as Row[]) : [];
    const inlined = results.map((result, resultIndex) => {
      if (bytesOf(result) <= PAYLOAD_INLINE_LIMIT) return result;
      overflow.push({
        runId,
        stepIndex,
        toolCallId: String(result.toolCallId ?? ""),
        toolName: String(result.toolName ?? ""),
        payload: result,
        bytes: bytesOf(result),
      });
      overflowSlots.push({ step: stepRowIndex, result: resultIndex });
      // `payloadRef` is filled in below, once the payload rows have ids.
      return { toolCallId: result.toolCallId, payloadRef: null as string | null, overflowed: true };
    });
    inlinedByStep.push(inlined);

    return clean({
      __golden: String(row.id),
      runId,
      leagueId: ref("leagues", run.league_id)!,
      stepIndex,
      modelId: String(row.model_id),
      text: str(row.text),
      reasoning: str(row.reasoning),
      // `runs.messages` is gone; the conversation is rebuilt from these (§2.3).
      responseMessages: row.messages ?? [],
      toolCalls: row.tool_calls ?? [],
      toolResults: inlined,
      usage: stepUsage(row.usage),
      finishReason: str(row.finish_reason),
      latencyMs: num(row.latency_ms),
      costUsd: numOr(row.cost_usd, 0),
      bytes: 0, // set below, once `toolResults` is final
    });
  });

  if (overflow.length) {
    const payloadIds = await importDerived("run_step_payloads", overflow, 10);
    if (payloadIds.length !== overflowSlots.length) {
      throw new Error(
        `run_step_payloads returned ${payloadIds.length} ids for ${overflowSlots.length} rows`,
      );
    }
    overflowSlots.forEach((slot, index) => {
      const stub = inlinedByStep[slot.step][slot.result] as { payloadRef: string | null };
      stub.payloadRef = payloadIds[index];
    });
  }

  stepRows.forEach((step, index) => {
    step.bytes = bytesOf(steps[index].messages) + bytesOf(inlinedByStep[index]);
  });

  await importRows("run_steps", stepRows, 20);

  // usage_events + the three rollups, in one pass (§2.6).
  type Counters = {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    reasoningTokens: number;
    costUsd: number;
    computedCostUsd: number;
    gatewayCostUsd: number;
    stepCount: number;
    fallbackCount: number;
    invalidActionCount: number;
    runIds: Set<string>;
  };
  const zero = (): Counters => ({
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
    computedCostUsd: 0,
    gatewayCostUsd: 0,
    stepCount: 0,
    fallbackCount: 0,
    invalidActionCount: 0,
    runIds: new Set(),
  });

  const teamWeek = new Map<string, Counters>();
  const modelWeek = new Map<string, Counters>();
  const leagueWeek = new Map<string, Counters>();
  const bump = (map: Map<string, Counters>, key: string, row: Row, runLegacyId: string) => {
    const c = map.get(key) ?? zero();
    c.inputTokens += numOr(row.input_tokens, 0);
    c.outputTokens += numOr(row.output_tokens, 0);
    c.cachedInputTokens += numOr(row.cached_input_tokens, 0);
    c.reasoningTokens += numOr(row.reasoning_tokens, 0);
    c.costUsd += numOr(row.cost_usd, 0);
    c.computedCostUsd += numOr(row.computed_cost_usd ?? row.cost_usd, 0);
    c.gatewayCostUsd += numOr(row.gateway_cost_usd, 0);
    c.stepCount += 1;
    c.runIds.add(runLegacyId);
    map.set(key, c);
  };

  const eventRows: Row[] = [];
  for (const row of events) {
    const run = runsById.get(String(row.run_id));
    if (!run) throw new Error(`usage_event ${String(row.id)} has no run`);
    const window = windows.get(String(run.window_id));
    const weekNo = num(window?.week_no) ?? 0;
    const costUsd = numOr(row.cost_usd, 0);

    eventRows.push(
      clean({
        __golden: String(row.id),
        runId: ref("runs", row.run_id)!,
        stepIndex: numOr(row.step_index, 0),
        leagueId: ref("leagues", row.league_id)!,
        teamId: refOpt("teams", row.team_id),
        season,
        weekNo,
        modelId: String(row.model_id),
        provider: String(row.provider),
        inputTokens: numOr(row.input_tokens, 0),
        outputTokens: numOr(row.output_tokens, 0),
        cachedInputTokens: numOr(row.cached_input_tokens, 0),
        reasoningTokens: numOr(row.reasoning_tokens, 0),
        latencyMs: num(row.latency_ms),
        computedCostUsd: numOr(row.computed_cost_usd ?? row.cost_usd, 0),
        gatewayCostUsd: num(row.gateway_cost_usd),
        costUsd,
        correctsEventId: refOpt("usage_events", row.corrects_event_id),
        createdAt: msRequired(row.created_at, 0),
      }),
    );

    const runLegacyId = String(row.run_id);
    if (row.team_id) bump(teamWeek, `${String(row.team_id)}|${weekNo}`, row, runLegacyId);
    bump(modelWeek, `${String(row.league_id)}|${String(row.model_id)}|${weekNo}`, row, runLegacyId);
    bump(modelWeek, `|${String(row.model_id)}|${weekNo}`, row, runLegacyId);
    bump(leagueWeek, `${String(row.league_id)}|${weekNo}`, row, runLegacyId);
  }
  await importRows("usage_events", eventRows);

  const now = Date.now();
  const providerOf = new Map(events.map((row) => [String(row.model_id), String(row.provider)]));
  const finish = (c: Counters) => ({
    inputTokens: c.inputTokens,
    outputTokens: c.outputTokens,
    cachedInputTokens: c.cachedInputTokens,
    reasoningTokens: c.reasoningTokens,
    costUsd: round8(c.costUsd),
    computedCostUsd: round8(c.computedCostUsd),
    gatewayCostUsd: round8(c.gatewayCostUsd),
    runCount: c.runIds.size,
    stepCount: c.stepCount,
    fallbackCount: [...c.runIds].filter((id) => runsById.get(id)?.fallback_applied).length,
    invalidActionCount: [...c.runIds].reduce((sum, id) => sum + (rejected.get(id) ?? 0), 0),
    updatedAt: now,
  });

  await importDerived(
    "team_week_rollups",
    [...teamWeek.entries()].map(([key, counters]) => {
      const [legacyTeamId, weekNo] = key.split("|");
      return {
        leagueId: ref("leagues", leagueOfTeam(legacyTeamId))!,
        teamId: ref("teams", legacyTeamId)!,
        season,
        weekNo: Number(weekNo),
        ...finish(counters),
      };
    }),
  );

  await importDerived(
    "model_week_rollups",
    [...modelWeek.entries()].map(([key, counters]) => {
      const [legacyLeagueId, modelId, weekNo] = key.split("|");
      return clean({
        leagueId: legacyLeagueId ? ref("leagues", legacyLeagueId) : undefined,
        modelId,
        provider: providerOf.get(modelId) ?? "unknown",
        season,
        weekNo: Number(weekNo),
        ...finish(counters),
      });
    }),
  );

  await importDerived(
    "league_week_rollups",
    [...leagueWeek.entries()].map(([key, counters]) => {
      const [legacyLeagueId, weekNo] = key.split("|");
      return {
        leagueId: ref("leagues", legacyLeagueId)!,
        season,
        weekNo: Number(weekNo),
        ...finish(counters),
      };
    }),
  );
}

/**
 * `run_actions` is imported last: its `result` blobs name the waiver claims,
 * lineups, threads, messages and trades the action created, and those tables have
 * to exist before those ids can be remapped. Nothing references `run_actions`, so
 * deferring it costs nothing.
 */
async function importRunActions(): Promise<void> {
  const runsById = new Map(readGolden("runs").map((row) => [String(row.id), row]));
  await importRows(
    "run_actions",
    readGolden("run_actions").map((row) => {
      const run = runsById.get(String(row.run_id));
      if (!run) throw new Error(`run_action ${String(row.id)} has no run`);
      const validation = (row.validation_result ?? {}) as Row;
      return clean({
        __golden: String(row.id),
        runId: ref("runs", row.run_id)!,
        leagueId: ref("leagues", run.league_id)!,
        teamId: refOpt("teams", run.team_id),
        toolCallId: String(row.tool_call_id),
        stepIndex: numOr(row.step_index, 0),
        actionType: String(row.action_type),
        payload: remapBlob(row.payload ?? {}, "run_actions") as Row,
        validationResult: {
          ok: validation.ok === true,
          errors: validation.errors as string[] | undefined,
        },
        result: row.result ? remapBlob(row.result, "run_actions") : undefined,
        committedAt: ms(row.committed_at),
      });
    }),
  );
}

function round8(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

function stepUsage(value: unknown): Row {
  const raw = (value ?? {}) as Row;
  return {
    inputTokens: numOr(raw.inputTokens, 0),
    outputTokens: numOr(raw.outputTokens, 0),
    totalTokens: numOr(raw.totalTokens, 0),
    cachedInputTokens: numOr(raw.cachedInputTokens, 0),
    reasoningTokens: numOr(raw.reasoningTokens, 0),
  };
}

// -------------------------------------------------- rosters and transactions

async function importRosterAndTransactions(): Promise<void> {
  await importRows(
    "roster_slots",
    readGolden("roster_slots").map((row) =>
      clean({
        __golden: String(row.id),
        leagueId: ref("leagues", leagueOfTeam(String(row.team_id)))!,
        teamId: ref("teams", row.team_id)!,
        playerId: ref("players", row.player_id)!,
        acquiredAt: msRequired(row.acquired_at, 0),
        acquiredVia: String(row.acquired_via),
      }),
    ),
  );

  await importRows(
    "lineups",
    readGolden("lineups").map((row) =>
      clean({
        __golden: String(row.id),
        teamId: ref("teams", row.team_id)!,
        leagueId: ref("leagues", leagueOfTeam(String(row.team_id)))!,
        weekNo: numOr(row.week_no, 0),
        version: numOr(row.version, 1),
        slots: (Array.isArray(row.slots) ? (row.slots as Row[]) : []).map((slot) => ({
          slot: String(slot.slot),
          playerId: slot.playerId ? ref("players", slot.playerId) : null,
        })),
        source: String(row.source),
        setByRunId: refOpt("runs", row.set_by_run_id),
      }),
    ),
  );

  await importRows(
    "draft_picks",
    readGolden("draft_picks").map((row) =>
      clean({
        __golden: String(row.id),
        leagueId: ref("leagues", row.league_id)!,
        round: numOr(row.round, 0),
        pickNo: numOr(row.pick_no, 0),
        overallNo: numOr(row.overall_no, 0),
        teamId: ref("teams", row.team_id)!,
        playerId: refOpt("players", row.player_id),
        price: num(row.price),
        madeByRunId: refOpt("runs", row.made_by_run_id),
        windowId: refOpt("windows", row.window_id),
        auto: row.auto === true,
        rationale: str(row.rationale),
        madeAt: ms(row.made_at),
      }),
    ),
  );

  await importRows(
    "waiver_claims",
    readGolden("waiver_claims").map((row) =>
      clean({
        __golden: String(row.id),
        leagueId: ref("leagues", row.league_id)!,
        teamId: ref("teams", row.team_id)!,
        windowId: ref("windows", row.window_id)!,
        weekNo: numOr(row.week_no, 0),
        addPlayerId: ref("players", row.add_player_id)!,
        dropPlayerId: refOpt("players", row.drop_player_id),
        bid: numOr(row.bid, 0),
        priority: numOr(row.priority, 0),
        runId: refOpt("runs", row.run_id),
        status: String(row.status),
        resultReason: str(row.result_reason),
        processedAt: ms(row.processed_at),
      }),
    ),
  );
}

// ------------------------------------------------------------------- social

async function importSocial(): Promise<void> {
  const threads = readGolden("threads");
  const messages = readGolden("messages");

  const messageCount = new Map<string, number>();
  const flaggedCount = new Map<string, number>();
  for (const message of messages) {
    const key = String(message.thread_id);
    messageCount.set(key, (messageCount.get(key) ?? 0) + 1);
    // Denormalized for `messaging.listThreads`, which cannot read every thread's
    // messages just to badge the card (package C).
    if (((message.flags ?? {}) as Row).injectionSuspected === true) {
      flaggedCount.set(key, (flaggedCount.get(key) ?? 0) + 1);
    }
  }

  await importRows(
    "threads",
    threads.map((row) =>
      clean({
        __golden: String(row.id),
        leagueId: ref("leagues", row.league_id)!,
        teamAId: ref("teams", row.team_a_id)!,
        teamBId: ref("teams", row.team_b_id)!,
        createdInWindowId: refOpt("windows", row.created_in_window_id),
        lastMessageAt: ms(row.last_message_at),
        messageCount: messageCount.get(String(row.id)) ?? 0,
        flaggedCount: flaggedCount.get(String(row.id)) ?? 0,
      }),
    ),
  );

  await importRows(
    "messages",
    messages.map((row) => {
      const threadLeague = threads.find((t) => String(t.id) === String(row.thread_id))?.league_id;
      return clean({
        __golden: String(row.id),
        threadId: ref("threads", row.thread_id)!,
        leagueId: ref("leagues", threadLeague)!,
        senderTeamId: ref("teams", row.sender_team_id)!,
        runId: refOpt("runs", row.run_id),
        stepIndex: num(row.step_index),
        configVersionId: refOpt("config_versions", row.config_version_id),
        body: String(row.body),
        flags: contentFlags(row.flags),
        createdAt: msRequired(row.created_at, 0),
      });
    }),
  );

  const tradeItems = readGolden("trade_items");
  const itemsByTrade = new Map<string, Row[]>();
  for (const item of tradeItems) {
    const key = String(item.trade_id);
    itemsByTrade.set(key, [...(itemsByTrade.get(key) ?? []), item]);
  }

  await importRows(
    "trades",
    readGolden("trades").map((row) =>
      clean({
        __golden: String(row.id),
        leagueId: ref("leagues", row.league_id)!,
        proposerTeamId: ref("teams", row.proposer_team_id)!,
        recipientTeamId: ref("teams", row.recipient_team_id)!,
        threadId: refOpt("threads", row.thread_id),
        windowId: refOpt("windows", row.window_id),
        weekNo: numOr(row.week_no, 0),
        status: String(row.status),
        // trade_items folded into the trade document (PRD 6.4 / §2.3).
        items: (itemsByTrade.get(String(row.id)) ?? []).map((item) =>
          clean({
            fromTeamId: ref("teams", item.from_team_id)!,
            toTeamId: ref("teams", item.to_team_id)!,
            playerId: refOpt("players", item.player_id),
            faab: num(item.faab),
          }),
        ),
        fairnessScore: num(row.fairness_score),
        fairnessDetail: row.fairness_detail ?? undefined,
        flagged: row.flagged === true,
        reviewEndsAt: ms(row.review_ends_at),
        resolvedAt: ms(row.resolved_at),
        parentTradeId: refOpt("trades", row.parent_trade_id),
        message: str(row.message),
        createdByRunId: refOpt("runs", row.created_by_run_id),
        // No votes were cast in the golden week; the tallies start at zero.
        vetoCount: 0,
        approveCount: 0,
      }),
    ),
  );

  await importRows(
    "trade_events",
    readGolden("trade_events").map((row) => {
      const trade = readGolden("trades").find((t) => String(t.id) === String(row.trade_id));
      return clean({
        __golden: String(row.id),
        tradeId: ref("trades", row.trade_id)!,
        leagueId: ref("leagues", trade?.league_id)!,
        type: String(row.type),
        fromStatus: str(row.from_status),
        toStatus: str(row.to_status),
        runId: refOpt("runs", row.run_id),
        stepIndex: num(row.step_index),
        actorTeamId: refOpt("teams", row.actor_team_id),
        payload: row.payload ? (remapBlob(row.payload, "trade_events") as Row) : undefined,
      });
    }),
  );

  await importRows(
    "trade_votes",
    readGolden("trade_votes").map((row) =>
      clean({
        __golden: String(row.id),
        tradeId: ref("trades", row.trade_id)!,
        userId: ref("users", row.user_id)!,
        vote: String(row.vote),
      }),
    ),
  );

  await importRows(
    "transactions",
    readGolden("transactions").map((row) =>
      clean({
        __golden: String(row.id),
        leagueId: ref("leagues", row.league_id)!,
        teamId: ref("teams", row.team_id)!,
        type: String(row.type),
        weekNo: num(row.week_no),
        playerId: refOpt("players", row.player_id),
        relatedTeamId: refOpt("teams", row.related_team_id),
        tradeId: refOpt("trades", row.trade_id),
        runId: refOpt("runs", row.run_id),
        details: row.details ? (remapBlob(row.details, "transactions") as Row) : undefined,
      }),
    ),
  );

  await importRows(
    "forum_posts",
    readGolden("forum_posts").map((row) =>
      clean({
        __golden: String(row.id),
        leagueId: ref("leagues", row.league_id)!,
        teamId: refOpt("teams", row.team_id),
        runId: refOpt("runs", row.run_id),
        stepIndex: num(row.step_index),
        title: String(row.title),
        body: String(row.body),
        flair: String(row.flair),
        score: numOr(row.score, 0),
        commentCount: numOr(row.comment_count, 0),
        hidden: row.hidden === true,
        flags: contentFlags(row.flags),
        createdAt: msRequired(row.created_at, 0),
      }),
    ),
  );

  await importRows(
    "forum_comments",
    readGolden("forum_comments").map((row) =>
      clean({
        __golden: String(row.id),
        postId: ref("forum_posts", row.post_id)!,
        leagueId: ref("leagues", row.league_id)!,
        parentId: refOpt("forum_comments", row.parent_id),
        teamId: refOpt("teams", row.team_id),
        runId: refOpt("runs", row.run_id),
        stepIndex: num(row.step_index),
        body: String(row.body),
        score: numOr(row.score, 0),
        hidden: row.hidden === true,
        flags: contentFlags(row.flags),
        createdAt: msRequired(row.created_at, 0),
      }),
    ),
  );

  await importRows(
    "forum_votes",
    readGolden("forum_votes").map((row) =>
      clean({
        __golden: String(row.id),
        leagueId: ref("leagues", row.league_id)!,
        targetType: String(row.target_type),
        targetId: String(row.target_id),
        voterUserId: refOpt("users", row.voter_user_id),
        voterTeamId: refOpt("teams", row.voter_team_id),
        direction: numOr(row.direction, 0),
      }),
    ),
  );

  await importRows(
    "league_rule_changes",
    readGolden("league_rule_changes").map((row) =>
      clean({
        __golden: String(row.id),
        leagueId: ref("leagues", row.league_id)!,
        userId: refOpt("users", row.user_id),
        field: String(row.field),
        fromValue: row.from_value ?? undefined,
        toValue: row.to_value ?? undefined,
        note: str(row.note),
        createdAt: ms(row.created_at),
      }),
    ),
  );

  await importRows(
    "custom_providers",
    readGolden("custom_providers").map((row) =>
      clean({
        __golden: String(row.id),
        leagueId: refOpt("leagues", row.league_id),
        teamId: refOpt("teams", row.team_id),
        name: String(row.name),
        slug: String(row.slug ?? row.name),
        kind: "http_json",
        config: row.config,
        enabled: row.enabled === true,
        createdByUserId: refOpt("users", row.created_by_user_id),
      }),
    ),
  );
}

// -------------------------------------------------------------- derived-only

async function importDerivedTables(): Promise<void> {
  const league = readGolden("leagues")[0];
  const season = numOr(league.season, 2026);
  const now = Date.now();

  // Standings: no games were scored in the golden week, so every row is zeroed.
  const results = readGolden("team_results");
  await importDerived(
    "team_standings",
    readGolden("teams").map((team) => {
      const mine = results.filter((r) => String(r.team_id) === String(team.id));
      return {
        leagueId: ref("leagues", team.league_id)!,
        teamId: ref("teams", team.id)!,
        season,
        wins: mine.filter((r) => r.won === true).length,
        losses: mine.filter((r) => r.lost === true).length,
        ties: mine.filter((r) => r.tied === true).length,
        pointsFor: mine.reduce((sum, r) => sum + numOr(r.points_for, 0), 0),
        pointsAgainst: mine.reduce((sum, r) => sum + numOr(r.points_against, 0), 0),
        streak: "",
        updatedAt: now,
      };
    }),
  );

  // run_search_docs replaces the Postgres ILIKE trace search (§1).
  const runs = readGolden("runs");
  const actions = readGolden("run_actions");
  const windows = new Map(readGolden("windows").map((row) => [String(row.id), row]));
  const playerNames = new Map(
    readGolden("players").map((row) => [String(row.id), String(row.full_name)]),
  );

  const actionsByRun = new Map<string, Row[]>();
  for (const action of actions) {
    const key = String(action.run_id);
    actionsByRun.set(key, [...(actionsByRun.get(key) ?? []), action]);
  }

  await importDerived(
    "run_search_docs",
    runs.map((row) => {
      const window = windows.get(String(row.window_id))!;
      const mine = actionsByRun.get(String(row.id)) ?? [];
      const names = new Set<string>();
      for (const action of mine) {
        for (const id of collectUuids(action.payload)) {
          const name = playerNames.get(id);
          if (name) names.add(name);
        }
      }
      const text = [
        String(row.rationale ?? ""),
        String(row.outcome ?? ""),
        [...new Set(mine.map((a) => String(a.action_type)))].join(" "),
        [...names].join(" "),
      ]
        .filter(Boolean)
        .join("\n")
        .slice(0, SEARCH_TEXT_LIMIT);

      return clean({
        runId: ref("runs", row.id)!,
        leagueId: ref("leagues", row.league_id)!,
        teamId: refOpt("teams", row.team_id),
        windowType: String(window.type),
        weekNo: num(window.week_no) ?? 0,
        status: String(row.status),
        modelId: String(row.model_id),
        text,
      });
    }),
  );
}

/** Every uuid-looking string anywhere in a payload — the action's player ids. */
function collectUuids(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    if (UUID_RE.test(value)) out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectUuids(item, out);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value as Row)) collectUuids(item, out);
  }
  return out;
}

main().catch((error: unknown) => {
  console.error("Seed failed:", error);
  process.exit(1);
});
