/**
 * Parity tests: every read procedure of `docs/migration-plan.md` §2.1 that became a
 * Convex query is called against the **golden dataset** (`tests/golden/postgres-week1/*.json`,
 * the Postgres week-1 dump) and checked against the shape the old tRPC procedure
 * returned.
 *
 * Two kinds of assertion per query:
 *
 *  (a) **Shape.** `assertSameKeys(expected, actual, path)` walks the expected
 *      skeleton — including the first element of every array — and requires the
 *      Convex value to have exactly the same key set at every level. The skeletons
 *      are pinned to the old return types at compile time: each one is written as
 *      `satisfies Shape<OldReturnType>`, with the old type imported **type-only**
 *      from `lib/services/*` or inferred from the tRPC routers with
 *      `inferRouterOutputs`, so a skeleton that drifts from the old type fails
 *      `npm run typecheck`. Epoch-ms numbers are accepted where the old shape had
 *      a `Date` (`docs/CONVEX_CONVENTIONS.md`: "Dates are epoch milliseconds").
 *
 *  (b) **Values.** A handful of checks per query read straight off the golden JSON
 *      (counts, names, a known lineup slot, a known trade status, a known post
 *      score), so the query is not merely shaped right but returns the same data.
 *
 * Deviations that Phase 2 accepted on purpose are asserted *as deviations*, each
 * with a `DEVIATION:` comment naming it. Anything else that differs is a failure.
 *
 * The fixture is the whole golden dump — 3,230 players, 38 runs, 194 steps, 4
 * snapshots, 12 teams, one league — mapped to Convex documents by the same rules
 * `scripts/seed-convex.ts` applies (that script is a program, not a module, so the
 * mappers it needs are reproduced here; keep the two in step).
 */
import fs from "node:fs";
import path from "node:path";

import { convexTest } from "convex-test";
import { beforeAll, describe, expect, test } from "vitest";

import { api } from "./_generated/api";
import type { DataModel, Id, TableNames } from "./_generated/dataModel";
import type { GenericMutationCtx } from "convex/server";
import schema from "./schema";
import { BUILTIN_SKILLS } from "./seed/skills";
import type { League, LeagueMember, LeagueRules, Team } from "@/lib/db/types";
import type { ModelCatalogEntry } from "@/lib/models";
import { MODEL_CATALOG } from "@/lib/models";
import type { ConfigDiff } from "@/lib/services/config/diff";
import type { PromptEstimate } from "@/lib/services/config/estimate";
import type {
  ConfigVersionWithSkills,
  EditLockStatus,
  TeamConfigView,
} from "@/lib/services/config/queries";
import type {
  BudgetStatus,
  CostPerPoint,
  CostPerWin,
  ExpensiveRun,
  ModelBenchmarkRow,
  ModelSpendRow,
  SpendTotals,
  TeamSeasonSpend,
  TeamSpendRow,
  WeekSpendRow,
} from "@/lib/services/cost";
import type { ForumPostView, ForumView } from "@/lib/services/forum";
import type { LeagueSummary } from "@/lib/services/league/queries";
import type { InviteLink, LeagueRuleChange } from "@/lib/services/league/rules";
import type { ThreadListItem, ThreadView } from "@/lib/services/messaging";
import type { SkillDetail, SkillWithMeta } from "@/lib/services/skills";
import type { TradeDetail } from "@/lib/services/trades";
import type { TradeSummary } from "@/lib/services/trades/summaries";
import type { DraftBoard } from "@/lib/services/views/draft";
import type { LeagueHome, MatchupCard } from "@/lib/services/views/league-home";
import type { MatchupPage } from "@/lib/services/views/matchup";
import type { StandingsRow } from "@/lib/services/views/standings";
import type { TeamCard, TeamPage } from "@/lib/services/views/team";
import type { TraceDetail, TraceListResult } from "@/lib/services/views/traces";
import type { WaiverWeekView } from "@/lib/services/views/waivers";
import type { WindowSchedule, WindowView } from "@/lib/services/views/windows";

const modules = import.meta.glob("./**/*.ts");

const GOLDEN = path.join(process.cwd(), "tests", "golden", "postgres-week1");

/** Mirrors `scripts/seed-convex.ts`. */
const PAYLOAD_INLINE_LIMIT = 64 * 1024;
const SNAPSHOT_PLAYERS_PER_CHUNK = 100;
const SEARCH_TEXT_LIMIT = 64 * 1024;
const PRICES_EFFECTIVE_FROM = Date.parse("2026-01-01T00:00:00.000Z");

type Row = Record<string, unknown>;
type Ctx = GenericMutationCtx<DataModel>;

// ------------------------------------------------------- golden readers (copy)

const goldenCache = new Map<string, Row[]>();

/** `scripts/seed-convex.ts#readGolden`: rows oldest first so `_creationTime` orders like `created_at`. */
function readGolden(table: string): Row[] {
  const cached = goldenCache.get(table);
  if (cached) return cached;
  const file = path.join(GOLDEN, `${table}.json`);
  const rows: Row[] = fs.existsSync(file)
    ? (() => {
        const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
        return Array.isArray(parsed) ? (parsed as Row[]) : [parsed as Row];
      })()
    : [];
  const sorted =
    rows.length && rows[0].created_at !== undefined
      ? rows
          .map((row, index) => ({ row, index, at: ms(row.created_at) ?? 0 }))
          .sort((a, b) => a.at - b.at || a.index - b.index)
          .map((entry) => entry.row)
      : rows;
  goldenCache.set(table, sorted);
  return sorted;
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

function bytesOf(value: unknown): number {
  return value === undefined ? 0 : JSON.stringify(value).length;
}

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

function clean<T extends Row>(row: T): T {
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
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

// ------------------------------------------------------------------ id mapping

const ids = new Map<string, Map<string, string>>();

function mapOf(table: string): Map<string, string> {
  let m = ids.get(table);
  if (!m) {
    m = new Map();
    ids.set(table, m);
  }
  return m;
}

function ref(table: string, legacyId: unknown): string | undefined {
  if (legacyId === null || legacyId === undefined) return undefined;
  const found = mapOf(table).get(String(legacyId));
  if (!found) throw new Error(`No imported ${table} row for legacy id ${String(legacyId)}`);
  return found;
}

function refOpt(table: string, legacyId: unknown): string | undefined {
  if (legacyId === null || legacyId === undefined) return undefined;
  return mapOf(table).get(String(legacyId));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `scripts/seed-convex.ts#BLOB_FIELD_TABLES`. */
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

function remapId(table: string, value: unknown): unknown {
  if (typeof value !== "string" || !UUID_RE.test(value)) return value;
  return mapOf(table).get(value) ?? value;
}

function remapMaybeList(table: string, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => remapId(table, item));
  return remapId(table, value);
}

function remapBlob(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => remapBlob(item));
  if (!value || typeof value !== "object") return value;
  const out: Row = {};
  for (const [key, child] of Object.entries(value as Row)) {
    const table = BLOB_FIELD_TABLES[key];
    out[key] = table ? remapMaybeList(table, child) : remapBlob(child);
  }
  return out;
}

function remapSnapshotMeta(payload: Row): Row {
  const out: Row = { ...payload };
  out.leagueId = remapId("leagues", payload.leagueId);

  if (Array.isArray(payload.teams)) {
    out.teams = (payload.teams as Row[]).map((team) => ({
      ...team,
      id: remapId("teams", team.id),
      ownerUserId: team.ownerUserId ? remapId("users", team.ownerUserId) : team.ownerUserId,
      rosterPlayerIds: remapMaybeList("players", team.rosterPlayerIds),
      lineup: Array.isArray(team.lineup)
        ? (team.lineup as Row[]).map((slot) => ({
            ...slot,
            playerId: slot.playerId ? remapId("players", slot.playerId) : null,
          }))
        : team.lineup,
    }));
  }

  if (Array.isArray(payload.matchups)) {
    out.matchups = (payload.matchups as Row[]).map((matchup) => ({
      ...matchup,
      homeTeamId: remapId("teams", matchup.homeTeamId),
      awayTeamId: remapId("teams", matchup.awayTeamId),
    }));
  }

  if (Array.isArray(payload.standings)) {
    out.standings = (payload.standings as Row[]).map((standing) => ({
      ...standing,
      teamId: remapId("teams", standing.teamId),
    }));
  }

  if (Array.isArray(payload.news)) {
    out.news = (payload.news as Row[]).map((item) => ({
      ...item,
      playerId: item.playerId ? remapId("players", item.playerId) : item.playerId,
    }));
  }

  if (Array.isArray(payload.injuries)) {
    out.injuries = (payload.injuries as Row[]).map((item) => ({
      ...item,
      playerId: item.playerId ? remapId("players", item.playerId) : item.playerId,
    }));
  }

  out.freeAgentIds = remapMaybeList("players", payload.freeAgentIds);

  if (payload.liveScores && typeof payload.liveScores === "object") {
    out.liveScores = Object.fromEntries(
      Object.entries(payload.liveScores as Row).map(([teamId, score]) => [
        String(remapId("teams", teamId)),
        score,
      ]),
    );
  }

  return out;
}

function remapSnapshotPlayers(players: Record<string, unknown>): Row {
  const out: Row = {};
  for (const [playerId, player] of Object.entries(players)) {
    const mapped = String(remapId("players", playerId));
    const row = player as Row;
    out[mapped] = {
      ...row,
      id: remapId("players", row.id),
      ownerTeamId: row.ownerTeamId ? remapId("teams", row.ownerTeamId) : row.ownerTeamId,
    };
  }
  return out;
}

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

let teamLeagues: Map<string, string> | null = null;

function leagueOfTeam(legacyTeamId: string): string {
  if (!teamLeagues) {
    teamLeagues = new Map(readGolden("teams").map((row) => [String(row.id), String(row.league_id)]));
  }
  const leagueId = teamLeagues.get(legacyTeamId);
  if (!leagueId) throw new Error(`No golden team ${legacyTeamId}`);
  return leagueId;
}

// --------------------------------------------------------------- the importer

/**
 * Insert one table's rows and record `legacyId -> _id`.
 *
 * `ctx.db.insert` is generic over 50 table names, so the row is cast at the
 * boundary exactly as `convex/seed.ts#insertRow` does; the real check is Convex's
 * schema validation on insert, which `convex-test` performs.
 */
async function insertRows(ctx: Ctx, table: TableNames, rows: Row[]): Promise<void> {
  const m = mapOf(table);
  for (const row of rows) {
    const id = await ctx.db.insert(table, row as never);
    const legacyId = row.legacyId;
    if (typeof legacyId === "string") m.set(legacyId, id);
  }
}

/** `scripts/seed-convex.ts#windowScope`. */
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

function projectionVintage(players: Record<string, unknown>): number | undefined {
  let newest: number | undefined;
  for (const player of Object.values(players)) {
    const projection = (player as Row).projection as Row | null | undefined;
    const at = ms(projection?.effectiveAt);
    if (at !== undefined && (newest === undefined || at > newest)) newest = at;
  }
  return newest;
}

/** Everything `seed:base` writes, plus the golden dump, in `scripts/seed-convex.ts` order. */
async function seedGolden(ctx: Ctx): Promise<{ demoUserId: string; sessionId: string }> {
  const now = Date.now();

  // --- seed:base ------------------------------------------------------------
  for (const model of MODEL_CATALOG) {
    await ctx.db.insert("model_prices", {
      modelId: model.modelId,
      provider: model.provider,
      displayName: model.displayName,
      inputPerM: model.inputPerM,
      outputPerM: model.outputPerM,
      cachedInputPerM: model.cachedInputPerM ?? undefined,
      reasoningPerM: model.reasoningPerM ?? undefined,
      supportsReasoning: model.supportsReasoning,
      effectiveFrom: PRICES_EFFECTIVE_FROM,
    });
  }
  const builtinBySlug = new Map<string, Id<"skills">>();
  for (const skill of BUILTIN_SKILLS) {
    builtinBySlug.set(
      skill.slug,
      await ctx.db.insert("skills", {
        slug: skill.slug,
        name: skill.name,
        description: skill.description,
        bodyMd: skill.bodyMd,
        visibility: "public",
        usageCount: 0,
        createdAt: now,
        updatedAt: now,
      }),
    );
  }

  // --- demo user (the password flow is not reachable from `t.run`) -----------
  const goldenUser = readGolden("users")[0];
  const legacyUserId = String(goldenUser.id);
  const demoUserId = await ctx.db.insert("users", {
    email: String(goldenUser.email),
    name: String(goldenUser.name),
    legacyId: legacyUserId,
  });
  mapOf("users").set(legacyUserId, demoUserId);
  const sessionId = await ctx.db.insert("authSessions", {
    userId: demoUserId,
    expirationTime: now + 86_400_000,
  });

  // --- league skeleton ------------------------------------------------------
  await insertRows(
    ctx,
    "leagues",
    readGolden("leagues").map((row) =>
      clean({
        legacyId: String(row.id),
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
      }),
    ),
  );

  await insertRows(
    ctx,
    "league_rules",
    readGolden("league_rules").map((row) =>
      clean({
        legacyId: String(row.id),
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

  await insertRows(
    ctx,
    "league_members",
    readGolden("league_members").map((row) =>
      clean({
        legacyId: String(row.id),
        leagueId: ref("leagues", row.league_id)!,
        userId: ref("users", row.user_id)!,
        role: String(row.role),
        createdAt: ms(row.created_at),
      }),
    ),
  );

  await insertRows(
    ctx,
    "teams",
    readGolden("teams").map((row) =>
      clean({
        legacyId: String(row.id),
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

  await insertRows(
    ctx,
    "weeks",
    readGolden("weeks").map((row) =>
      clean({
        legacyId: String(row.id),
        leagueId: ref("leagues", row.league_id)!,
        weekNo: numOr(row.week_no, 0),
        startsAt: msRequired(row.starts_at, 0),
        endsAt: msRequired(row.ends_at, 0),
        isPlayoff: row.is_playoff === true,
        status: String(row.status),
      }),
    ),
  );

  await insertRows(
    ctx,
    "matchups",
    readGolden("matchups").map((row) =>
      clean({
        legacyId: String(row.id),
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

  await insertRows(
    ctx,
    "team_results",
    readGolden("team_results").map((row) =>
      clean({
        legacyId: String(row.id),
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

  // --- players, games, projections -----------------------------------------
  const players = readGolden("players");
  const positionByPlayer = new Map<string, string>();
  for (const row of players) positionByPlayer.set(String(row.id), String(row.position));

  await insertRows(
    ctx,
    "players",
    players.map((row) => {
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
        injuryBodyPart: str(row.injury_body_part),
        injuryNotes: str(row.injury_notes),
        byeWeek: num(row.bye_week),
        yearsExp: num(row.years_exp),
        age: num(row.age),
        searchRank: num(row.search_rank),
        fantasyPositions: row.fantasy_positions ?? [],
        externalIds,
        updatedAt: msRequired(row.updated_at, now),
      });
    }),
  );

  await insertRows(
    ctx,
    "nfl_games",
    readGolden("nfl_games").map((row) =>
      clean({
        legacyId: String(row.id),
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
  await insertRows(
    ctx,
    "player_projections",
    projections.map((row) =>
      clean({
        legacyId: String(row.id),
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
  );

  const latest = new Map<string, Row>();
  for (const row of projections) {
    const key = `${String(row.player_id)}|${String(row.season)}|${String(row.week)}|${String(row.source)}`;
    const previous = latest.get(key);
    if (!previous || msRequired(row.effective_at, 0) >= msRequired(previous.effective_at, 0)) {
      latest.set(key, row);
    }
  }
  await insertRows(
    ctx,
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
  );

  // --- skills: golden rows merged onto the `seed:base` builtins by slug -----
  const goldenSkills = readGolden("skills");
  const freshSkills: Row[] = [];
  for (const row of goldenSkills) {
    const slug = String(row.slug);
    const existing = builtinBySlug.get(slug);
    if (existing) {
      mapOf("skills").set(String(row.id), existing);
      await ctx.db.patch(
        "skills",
        existing,
        clean({
          legacyId: String(row.id),
          authorUserId: refOpt("users", row.author_user_id),
          createdAt: ms(row.created_at),
        }) as never,
      );
    } else {
      freshSkills.push(
        clean({
          legacyId: String(row.id),
          authorUserId: refOpt("users", row.author_user_id),
          name: String(row.name),
          slug,
          description: str(row.description),
          bodyMd: String(row.body_md),
          visibility: String(row.visibility),
          forkedFromSkillId: refOpt("skills", row.forked_from_skill_id),
          usageCount: 0,
          createdAt: ms(row.created_at),
          updatedAt: msRequired(row.updated_at, now),
        }),
      );
    }
  }
  await insertRows(ctx, "skills", freshSkills);

  // --- agent configs + immutable versions ----------------------------------
  const configs = readGolden("agent_configs");
  const versions = readGolden("config_versions");
  const versionSkills = readGolden("config_version_skills");
  const teamByConfig = new Map<string, string>();
  for (const row of configs) teamByConfig.set(String(row.id), String(row.team_id));

  await insertRows(
    ctx,
    "agent_configs",
    configs.map((row) =>
      clean({
        legacyId: String(row.id),
        teamId: ref("teams", row.team_id)!,
        leagueId: ref("leagues", leagueOfTeam(String(row.team_id)))!,
        noteToAgent: str(row.note_to_agent),
        createdAt: ms(row.created_at),
        updatedAt: ms(row.updated_at),
      }),
    ),
  );

  const skillIdsByVersion = new Map<string, string[]>();
  for (const row of [...versionSkills].sort((a, b) => numOr(a.position, 0) - numOr(b.position, 0))) {
    const key = String(row.config_version_id);
    const skillId = refOpt("skills", row.skill_id);
    if (!skillId) continue;
    skillIdsByVersion.set(key, [...(skillIdsByVersion.get(key) ?? []), skillId]);
  }

  await insertRows(
    ctx,
    "config_versions",
    versions.map((row) => {
      const legacyTeamId = teamByConfig.get(String(row.config_id));
      if (!legacyTeamId) throw new Error(`config_versions row ${String(row.id)} has no config`);
      return clean({
        legacyId: String(row.id),
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

  for (const row of configs) {
    await ctx.db.patch(
      "agent_configs",
      ref("agent_configs", row.id)! as Id<"agent_configs">,
      clean({
        currentVersionId: refOpt("config_versions", row.current_version_id),
        pendingVersionId: refOpt("config_versions", row.pending_version_id),
      }) as never,
    );
  }

  const skillUsage = new Map<string, number>();
  for (const config of configs) {
    const currentId = String(config.current_version_id ?? "");
    if (!currentId) continue;
    for (const skillId of skillIdsByVersion.get(currentId) ?? []) {
      skillUsage.set(skillId, (skillUsage.get(skillId) ?? 0) + 1);
    }
  }
  for (const [id, usageCount] of skillUsage) {
    await ctx.db.patch("skills", id as Id<"skills">, { usageCount });
  }

  // --- windows + snapshots (chunked) ---------------------------------------
  const goldenWindows = readGolden("windows");
  const goldenRuns = readGolden("runs");

  const runCount = new Map<string, number>();
  const terminalCount = new Map<string, number>();
  for (const run of goldenRuns) {
    const key = String(run.window_id);
    runCount.set(key, (runCount.get(key) ?? 0) + 1);
    if (TERMINAL_RUN_STATUSES.has(String(run.status))) {
      terminalCount.set(key, (terminalCount.get(key) ?? 0) + 1);
    }
  }

  await insertRows(
    ctx,
    "windows",
    goldenWindows.map((row) =>
      clean({
        legacyId: String(row.id),
        leagueId: ref("leagues", row.league_id)!,
        type: String(row.type),
        label: String(row.label),
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

  const snapshots = readGolden("snapshots");
  await insertRows(
    ctx,
    "snapshots",
    snapshots.map((row) => {
      const payload = (row.payload ?? {}) as Row;
      const snapPlayers = (payload.players ?? {}) as Record<string, unknown>;
      const playerCount = Object.keys(snapPlayers).length;
      return clean({
        legacyId: String(row.id),
        leagueId: ref("leagues", row.league_id)!,
        windowId: refOpt("windows", row.window_id),
        season: numOr(payload.season ?? row.season, 0),
        weekNo: numOr(row.week_no, 0),
        takenAt: msRequired(row.taken_at, 0),
        status: "ready",
        chunkCount: 1 + Math.ceil(playerCount / SNAPSHOT_PLAYERS_PER_CHUNK),
        playerCount,
        projectionEffectiveAt: projectionVintage(snapPlayers),
        headline: str(((row.digest ?? {}) as Row).headline),
      });
    }),
  );

  const chunks: Row[] = [];
  const digests: Row[] = [];
  for (const row of snapshots) {
    const snapshotId = ref("snapshots", row.id)!;
    const payload = { ...((row.payload ?? {}) as Row) };
    const snapPlayers = (payload.players ?? {}) as Record<string, unknown>;
    delete payload.players;

    const meta = remapSnapshotMeta(payload);
    chunks.push({ snapshotId, kind: "meta", part: 0, data: meta, bytes: bytesOf(meta) });

    const entries = Object.entries(remapSnapshotPlayers(snapPlayers));
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
            playerId: remapId("players", item.playerId),
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
  await insertRows(ctx, "snapshot_chunks", chunks);
  await insertRows(ctx, "snapshot_digests", digests);

  for (const row of snapshots) {
    if (!row.window_id) continue;
    await ctx.db.patch("windows", ref("windows", row.window_id)! as Id<"windows">, {
      snapshotId: ref("snapshots", row.id)! as Id<"snapshots">,
    });
  }

  // --- runs, steps, usage events, the three rollups -------------------------
  const goldenSteps = readGolden("run_steps");
  const goldenActions = readGolden("run_actions");
  const goldenEvents = readGolden("usage_events");
  const windowByLegacy = new Map(goldenWindows.map((row) => [String(row.id), row]));
  const league = readGolden("leagues")[0];
  const season = numOr(league.season, 2026);

  const committed = new Map<string, number>();
  const rejected = new Map<string, number>();
  for (const action of goldenActions) {
    const key = String(action.run_id);
    const ok = ((action.validation_result ?? {}) as Row).ok === true;
    if (ok) committed.set(key, (committed.get(key) ?? 0) + 1);
    else rejected.set(key, (rejected.get(key) ?? 0) + 1);
  }

  await insertRows(
    ctx,
    "runs",
    goldenRuns.map((row) => {
      const window = windowByLegacy.get(String(row.window_id));
      if (!window) throw new Error(`run ${String(row.id)} has no window`);
      const stepCount = numOr(row.step_count, 0);
      return clean({
        legacyId: String(row.id),
        windowId: ref("windows", row.window_id)!,
        leagueId: ref("leagues", row.league_id)!,
        teamId: refOpt("teams", row.team_id),
        configVersionId: refOpt("config_versions", row.config_version_id),
        modelId: String(row.model_id),
        kind: String(row.kind),
        status: String(row.status),
        windowType: String(window.type),
        windowLabel: String(window.label),
        weekNo: num(window.week_no) ?? 0,
        attempt: 1,
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

  const runsById = new Map(goldenRuns.map((row) => [String(row.id), row]));

  const overflow: Row[] = [];
  const stepRows = goldenSteps.map((row) => {
    const run = runsById.get(String(row.run_id));
    if (!run) throw new Error(`run_step ${String(row.id)} has no run`);
    const runId = ref("runs", row.run_id)!;
    const stepIndex = numOr(row.step_index, 0);

    const results = Array.isArray(row.tool_results) ? (row.tool_results as Row[]) : [];
    const inlined = results.map((result) => {
      if (bytesOf(result) <= PAYLOAD_INLINE_LIMIT) return result;
      overflow.push({
        runId,
        stepIndex,
        toolCallId: String(result.toolCallId ?? ""),
        toolName: String(result.toolName ?? ""),
        payload: result,
        bytes: bytesOf(result),
      });
      return { toolCallId: result.toolCallId, payloadRef: null, overflowed: true };
    });

    return clean({
      legacyId: String(row.id),
      runId,
      leagueId: ref("leagues", run.league_id)!,
      stepIndex,
      modelId: String(row.model_id),
      text: str(row.text),
      reasoning: str(row.reasoning),
      responseMessages: row.messages ?? [],
      toolCalls: row.tool_calls ?? [],
      toolResults: inlined,
      usage: stepUsage(row.usage),
      finishReason: str(row.finish_reason),
      latencyMs: num(row.latency_ms),
      costUsd: numOr(row.cost_usd, 0),
      bytes: bytesOf(row.messages) + bytesOf(inlined),
    });
  });
  await insertRows(ctx, "run_steps", stepRows);
  await insertRows(ctx, "run_step_payloads", overflow);

  type Counters = {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    reasoningTokens: number;
    costUsd: number;
    computedCostUsd: number;
    gatewayCostUsd: number;
    stepCount: number;
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
  for (const row of goldenEvents) {
    const run = runsById.get(String(row.run_id));
    if (!run) throw new Error(`usage_event ${String(row.id)} has no run`);
    const window = windowByLegacy.get(String(run.window_id));
    const weekNo = num(window?.week_no) ?? 0;

    eventRows.push(
      clean({
        legacyId: String(row.id),
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
        costUsd: numOr(row.cost_usd, 0),
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
  await insertRows(ctx, "usage_events", eventRows);

  const providerOf = new Map(goldenEvents.map((row) => [String(row.model_id), String(row.provider)]));
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

  await insertRows(
    ctx,
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

  await insertRows(
    ctx,
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

  await insertRows(
    ctx,
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

  // --- rosters, lineups, draft, waivers ------------------------------------
  await insertRows(
    ctx,
    "roster_slots",
    readGolden("roster_slots").map((row) =>
      clean({
        legacyId: String(row.id),
        leagueId: ref("leagues", leagueOfTeam(String(row.team_id)))!,
        teamId: ref("teams", row.team_id)!,
        playerId: ref("players", row.player_id)!,
        acquiredAt: msRequired(row.acquired_at, 0),
        acquiredVia: String(row.acquired_via),
      }),
    ),
  );

  await insertRows(
    ctx,
    "lineups",
    readGolden("lineups").map((row) =>
      clean({
        legacyId: String(row.id),
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

  await insertRows(
    ctx,
    "draft_picks",
    readGolden("draft_picks").map((row) =>
      clean({
        legacyId: String(row.id),
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

  await insertRows(
    ctx,
    "waiver_claims",
    readGolden("waiver_claims").map((row) =>
      clean({
        legacyId: String(row.id),
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

  // --- social ---------------------------------------------------------------
  const goldenThreads = readGolden("threads");
  const goldenMessages = readGolden("messages");
  const messageCount = new Map<string, number>();
  const flaggedCount = new Map<string, number>();
  for (const message of goldenMessages) {
    const key = String(message.thread_id);
    messageCount.set(key, (messageCount.get(key) ?? 0) + 1);
    if (((message.flags ?? {}) as Row).injectionSuspected === true) {
      flaggedCount.set(key, (flaggedCount.get(key) ?? 0) + 1);
    }
  }

  await insertRows(
    ctx,
    "threads",
    goldenThreads.map((row) =>
      clean({
        legacyId: String(row.id),
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

  await insertRows(
    ctx,
    "messages",
    goldenMessages.map((row) => {
      const threadLeague = goldenThreads.find((t) => String(t.id) === String(row.thread_id))
        ?.league_id;
      return clean({
        legacyId: String(row.id),
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
  const goldenTrades = readGolden("trades");

  await insertRows(
    ctx,
    "trades",
    goldenTrades.map((row) =>
      clean({
        legacyId: String(row.id),
        leagueId: ref("leagues", row.league_id)!,
        proposerTeamId: ref("teams", row.proposer_team_id)!,
        recipientTeamId: ref("teams", row.recipient_team_id)!,
        threadId: refOpt("threads", row.thread_id),
        windowId: refOpt("windows", row.window_id),
        weekNo: numOr(row.week_no, 0),
        status: String(row.status),
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
        vetoCount: 0,
        approveCount: 0,
      }),
    ),
  );

  await insertRows(
    ctx,
    "trade_events",
    readGolden("trade_events").map((row) => {
      const trade = goldenTrades.find((t) => String(t.id) === String(row.trade_id));
      return clean({
        legacyId: String(row.id),
        tradeId: ref("trades", row.trade_id)!,
        leagueId: ref("leagues", trade?.league_id)!,
        type: String(row.type),
        fromStatus: str(row.from_status),
        toStatus: str(row.to_status),
        runId: refOpt("runs", row.run_id),
        stepIndex: num(row.step_index),
        actorTeamId: refOpt("teams", row.actor_team_id),
        payload: row.payload ? (remapBlob(row.payload) as Row) : undefined,
      });
    }),
  );

  await insertRows(
    ctx,
    "trade_votes",
    readGolden("trade_votes").map((row) =>
      clean({
        legacyId: String(row.id),
        tradeId: ref("trades", row.trade_id)!,
        userId: ref("users", row.user_id)!,
        vote: String(row.vote),
      }),
    ),
  );

  await insertRows(
    ctx,
    "transactions",
    readGolden("transactions").map((row) =>
      clean({
        legacyId: String(row.id),
        leagueId: ref("leagues", row.league_id)!,
        teamId: ref("teams", row.team_id)!,
        type: String(row.type),
        weekNo: num(row.week_no),
        playerId: refOpt("players", row.player_id),
        relatedTeamId: refOpt("teams", row.related_team_id),
        tradeId: refOpt("trades", row.trade_id),
        runId: refOpt("runs", row.run_id),
        details: row.details ? (remapBlob(row.details) as Row) : undefined,
      }),
    ),
  );

  await insertRows(
    ctx,
    "forum_posts",
    readGolden("forum_posts").map((row) =>
      clean({
        legacyId: String(row.id),
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

  await insertRows(
    ctx,
    "forum_comments",
    readGolden("forum_comments").map((row) =>
      clean({
        legacyId: String(row.id),
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

  await insertRows(
    ctx,
    "forum_votes",
    readGolden("forum_votes").map((row) =>
      clean({
        legacyId: String(row.id),
        leagueId: ref("leagues", row.league_id)!,
        targetType: String(row.target_type),
        targetId: String(row.target_id),
        voterUserId: refOpt("users", row.voter_user_id),
        voterTeamId: refOpt("teams", row.voter_team_id),
        direction: numOr(row.direction, 0),
      }),
    ),
  );

  await insertRows(
    ctx,
    "league_rule_changes",
    readGolden("league_rule_changes").map((row) =>
      clean({
        legacyId: String(row.id),
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

  // --- run_actions last: their blobs name rows created above ----------------
  await insertRows(
    ctx,
    "run_actions",
    goldenActions.map((row) => {
      const run = runsById.get(String(row.run_id));
      if (!run) throw new Error(`run_action ${String(row.id)} has no run`);
      const validation = (row.validation_result ?? {}) as Row;
      return clean({
        legacyId: String(row.id),
        runId: ref("runs", row.run_id)!,
        leagueId: ref("leagues", run.league_id)!,
        teamId: refOpt("teams", run.team_id),
        toolCallId: String(row.tool_call_id),
        stepIndex: numOr(row.step_index, 0),
        actionType: String(row.action_type),
        payload: remapBlob(row.payload ?? {}) as Row,
        validationResult: {
          ok: validation.ok === true,
          errors: validation.errors as string[] | undefined,
        },
        result: row.result ? remapBlob(row.result) : undefined,
        committedAt: ms(row.committed_at),
      });
    }),
  );

  // --- derived-only: standings + the trace search index --------------------
  const results = readGolden("team_results");
  await insertRows(
    ctx,
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

  const playerNames = new Map(
    players.map((row) => [String(row.id), String(row.full_name)]),
  );
  const actionsByRun = new Map<string, Row[]>();
  for (const action of goldenActions) {
    const key = String(action.run_id);
    actionsByRun.set(key, [...(actionsByRun.get(key) ?? []), action]);
  }

  await insertRows(
    ctx,
    "run_search_docs",
    goldenRuns.map((row) => {
      const window = windowByLegacy.get(String(row.window_id))!;
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

  return { demoUserId, sessionId };
}

// ---------------------------------------------------------------- the fixture

type Fixture = {
  t: ReturnType<typeof convexTest>;
  demoUserId: Id<"users">;
  sessionId: Id<"authSessions">;
  leagueId: Id<"leagues">;
};

let fx: Fixture;

beforeAll(async () => {
  const t = convexTest(schema, modules);
  const { demoUserId, sessionId } = await t.run(async (ctx) => seedGolden(ctx as Ctx));
  fx = {
    t,
    demoUserId: demoUserId as Id<"users">,
    sessionId: sessionId as Id<"authSessions">,
    leagueId: ref("leagues", readGolden("leagues")[0].id)! as Id<"leagues">,
  };
}, 600_000);
// ------------------------------------------------------ shape assertion tools

/**
 * A skeleton of an old return type.
 *
 * `0` means "a scalar; do not descend" and `"date"` means "the old shape had a
 * `Date` here, so the Convex value must be epoch ms (or null)". `Shape<T>` ties a
 * skeleton to the old TypeScript type: every key of `T` must appear, no extra key
 * may, and arrays are written as a one-element tuple describing their elements.
 * `0` is accepted at every level as an explicit "not checked further" escape.
 */
const LEAF = 0;
const DATE = "date";
type Leaf = typeof LEAF;
type DateLeaf = typeof DATE;

type Shape<T> = Leaf | ShapeInner<NonNullable<T>>;
type ShapeInner<T> = T extends Date
  ? DateLeaf
  : T extends readonly (infer E)[]
    ? readonly [Shape<E>]
    : T extends object
      ? { [K in keyof Required<T>]: Shape<Required<T>[K]> }
      : Leaf;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keys that carry a value. Convex omits unset optional fields entirely. */
function liveKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort();
}

/**
 * Every way `actual` differs, in key terms, from the old-shape skeleton
 * `expected`. Arrays are compared through their first element. An empty result
 * means the Convex value has exactly the old key set at every level.
 */
function keyDiff(expected: unknown, actual: unknown, path = "$"): string[] {
  if (expected === LEAF) return [];

  if (expected === DATE) {
    if (actual === null || actual === undefined) return [];
    return typeof actual === "number"
      ? []
      : [`${path}: old shape had Date, expected epoch ms number, got ${typeof actual}`];
  }

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [`${path}: expected an array, got ${describe_(actual)}`];
    if (!expected.length || !actual.length) return [];
    return keyDiff(expected[0], actual[0], `${path}[0]`);
  }

  if (isPlainObject(expected)) {
    if (actual === null || actual === undefined) return [];
    if (!isPlainObject(actual)) return [`${path}: expected an object, got ${describe_(actual)}`];
    const want = liveKeys(expected);
    const got = liveKeys(actual);
    const out: string[] = [];
    for (const key of want) if (!got.includes(key)) out.push(`${path}.${key}: missing`);
    for (const key of got) if (!want.includes(key)) out.push(`${path}.${key}: unexpected`);
    for (const key of want) {
      if (got.includes(key)) out.push(...keyDiff(expected[key], actual[key], `${path}.${key}`));
    }
    return out;
  }

  return [];
}

function describe_(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** The old key set is exactly reproduced. */
function assertSameKeys(expected: unknown, actual: unknown, path: string): void {
  expect(keyDiff(expected, actual, path)).toEqual([]);
}

/**
 * The old key set is reproduced except for the listed, deliberate deviations.
 * Every entry must carry a `// DEVIATION:` comment at the call site naming the
 * Phase 2 decision it encodes; anything not listed here fails.
 */
function assertSameKeysExcept(
  expected: unknown,
  actual: unknown,
  path: string,
  deviations: string[],
): void {
  expect(keyDiff(expected, actual, path).sort()).toEqual([...deviations].sort());
}

/**
 * Deviation A — **optional field absent instead of null.** Convex has no
 * `undefined`; an unset optional column is simply not on the document, whereas the
 * Postgres row always carried the key with a `null`. Every path listed here is a
 * field whose golden value is null, so the Convex document omits it.
 * (`docs/CONVEX_CONVENTIONS.md`, "an absent field is the null".)
 */
function optionalUnset(...paths: string[]): string[] {
  return paths.map((path) => `${path}: missing`);
}

/**
 * Deviation B — **additive Convex column.** `docs/migration-plan.md` §2.3
 * denormalizes ids onto child documents so every read can use an index
 * (`config_versions.leagueId/teamId`, `run_steps.leagueId`, …) and folds
 * one-to-many join tables into their parent (`config_versions.skillIds` replaces
 * `config_version_skills`, `trades.items` replaces `trade_items`). Those keys are
 * present on the document and were not on the old row.
 */
function additiveColumn(...paths: string[]): string[] {
  return paths.map((path) => `${path}: unexpected`);
}

/**
 * Deviation C — **an intentional change to the read model**, each one named in the
 * Phase 2 reports (see `docs/verification/phase2.md`). Unlike A and B these are
 * decisions about the query, not about the document envelope.
 */
function phase2Deviation(...entries: string[]): string[] {
  return entries;
}

/**
 * Convex's document envelope, mapped onto the old row shape: `_id` is the old
 * `id`, `_creationTime` is bookkeeping the old rows never had, and `legacyId` is
 * the migration join key (`docs/CONVEX_CONVENTIONS.md`) that goes away in the
 * cleanup phase. Everything else is compared as-is.
 */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "_creationTime" || key === "legacyId") continue;
    out[key === "_id" ? "id" : key] = normalize(child);
  }
  return out;
}

// ------------------------------------------------------------ fixture helpers

function goldenTeam(name: string): Id<"teams"> {
  const row = readGolden("teams").find((r) => r.name === name);
  if (!row) throw new Error(`No golden team named ${name}`);
  return ref("teams", row.id)! as Id<"teams">;
}

/** The demo user: commissioner of the league and owner of "Regression to the Mean". */
function asDemo() {
  return fx.t.withIdentity({ subject: `${fx.demoUserId}|${fx.sessionId}` });
}

function anon() {
  return fx.t;
}

const PAGE = { numItems: 25, cursor: null };

// =============================================================== league (§2.1)

// ------------------------------------------------------------- old-type paths

/**
 * The return type of every old tRPC procedure this file checks, keyed by
 * `router.procedure`.
 *
 * `lib/trpc/**` is deleted by package H as part of Phase 3, so `inferRouterOutputs`
 * is no longer available; the shapes are instead composed from the service types
 * the routers returned (`docs/migration-plan.md` §2.1 names the procedure → service
 * mapping). Every member is a **type-only** import — nothing here reaches Drizzle at
 * runtime. Procedures whose router built an object literal inline (`league.get`,
 * `config.get`/`versions`/`version`, `cost.*`, `commissioner.settings`, `forum.get`,
 * `forum.karma`) are spelled out here, from the router source at commit 98eef3a.
 */
type Old = {
  league: {
    get: { league: League; teams: Team[]; membership: LeagueMember | null };
    listMine: LeagueSummary[];
  };
  config: {
    get: TeamConfigView & { lock: EditLockStatus; canEdit: boolean; viewerUserId: string | null };
    versions: Pick<TeamConfigView, "config" | "team" | "versions">;
    version: { version: ConfigVersionWithSkills; previous: ConfigVersionWithSkills | null };
    diff: ConfigDiff;
    lockStatus: EditLockStatus;
    estimate: PromptEstimate;
  };
  skills: { list: SkillWithMeta[]; get: SkillDetail };
  cost: {
    team: {
      week: SpendTotals & { teamId: string; weekNo: number };
      season: TeamSeasonSpend;
      costPerPoint: CostPerPoint;
      costPerWin: CostPerWin;
      budget: BudgetStatus;
    };
    league: {
      totals: SpendTotals;
      byTeam: TeamSpendRow[];
      byModel: ModelSpendRow[];
      expensive: ExpensiveRun[];
      trend: WeekSpendRow[];
    };
    benchmark: ModelBenchmarkRow[];
  };
  views: {
    home: LeagueHome | null;
    standings: StandingsRow[];
    teams: TeamCard[];
    team: TeamPage | null;
    matchups: MatchupCard[];
    matchup: MatchupPage | null;
    draftBoard: DraftBoard | null;
    waivers: WaiverWeekView;
    windowsForWeek: WindowView[];
    windowSchedule: WindowSchedule;
  };
  traces: {
    list: TraceListResult;
    get: TraceDetail;
    modelOptions: Array<{ modelId: string; label: string; runCount: number }>;
  };
  commissioner: {
    settings: {
      league: League;
      rules: LeagueRules;
      invite: InviteLink;
      changes: Array<LeagueRuleChange & { userName: string | null }>;
      modelsInUse: Array<{ modelId: string; teamCount: number }>;
      catalog: readonly ModelCatalogEntry[];
      locked: boolean;
    };
  };
  trades: { list: TradeSummary[]; get: TradeDetail };
  messaging: { listThreads: ThreadListItem[]; getThread: ThreadView };
  forum: {
    list: ForumView;
    get: { post: ForumPostView; karma: ForumView["karma"] };
    karma: Array<{ id: string; name: string; karma: number }>;
  };
};

const LEAGUE_ROW = {
  id: LEAF,
  name: LEAF,
  slug: LEAF,
  commissionerUserId: LEAF,
  season: LEAF,
  teamCount: LEAF,
  isPublic: LEAF,
  status: LEAF,
  draftType: LEAF,
  draftScheduledAt: DATE,
  joinCode: LEAF,
  createdAt: DATE,
  updatedAt: DATE,
} as const satisfies Shape<Old["league"]["get"]["league"]>;

const TEAM_ROW = {
  id: LEAF,
  leagueId: LEAF,
  ownerUserId: LEAF,
  name: LEAF,
  abbreviation: LEAF,
  faabRemaining: LEAF,
  draftBudgetRemaining: LEAF,
  waiverPriority: LEAF,
  karma: LEAF,
  createdAt: DATE,
} as const satisfies Shape<Old["league"]["get"]["teams"][number]>;

const MEMBER_ROW = {
  id: LEAF,
  leagueId: LEAF,
  userId: LEAF,
  role: LEAF,
  createdAt: DATE,
} as const satisfies Shape<NonNullable<Old["league"]["get"]["membership"]>>;

const LEAGUE_GET = {
  league: LEAGUE_ROW,
  teams: [TEAM_ROW],
  membership: MEMBER_ROW,
} as const satisfies Shape<Old["league"]["get"]>;

describe("leagues.get (was league.get)", () => {
  test("shape and values, as the demo commissioner", async () => {
    const actual = await asDemo().query(api.leagues.get, { leagueId: fx.leagueId });
    assertSameKeysExcept(LEAGUE_GET, normalize(actual), "league.get", [
      ...optionalUnset("league.get.league.joinCode", "league.get.teams[0].ownerUserId"),
      // DEVIATION (undocumented, additive): `leagues.get` returns a superset of the
      // old `league.get`. The old procedure returned `{ league, teams, membership }`
      // and the pages re-fetched rules and derived the viewer's role client-side;
      // the Convex query folds all four into one reactive read.
      ...phase2Deviation(
        "league.get.rules: unexpected",
        "league.get.role: unexpected",
        "league.get.isCommissioner: unexpected",
        "league.get.viewerTeamId: unexpected",
      ),
    ]);

    expect(actual?.league.name).toBe("Demo League");
    expect(actual?.league.slug).toBe("demo-league");
    expect(actual?.league.season).toBe(2026);
    expect(actual?.league.teamCount).toBe(12);
    expect(actual?.teams).toHaveLength(12);
    // Old: `ORDER BY teams.waiver_priority ASC`.
    expect(actual?.teams.map((team) => team.name).slice(0, 3)).toEqual([
      "Gradient Ascent",
      "Bayesian Ballers",
      "Regression to the Mean",
    ]);
    expect(actual?.membership?.role).toBe("commissioner");
  });

  test("a public league reads signed out, with no membership", async () => {
    const actual = await anon().query(api.leagues.get, { leagueId: fx.leagueId });
    assertSameKeysExcept(LEAGUE_GET, normalize(actual), "league.get(anon)", [
      ...optionalUnset("league.get(anon).league.joinCode", "league.get(anon).teams[0].ownerUserId"),
      ...phase2Deviation(
        "league.get(anon).rules: unexpected",
        "league.get(anon).role: unexpected",
        "league.get(anon).isCommissioner: unexpected",
        "league.get(anon).viewerTeamId: unexpected",
      ),
    ]);
    expect(actual?.membership).toBeNull();
    expect(actual?.role).toBeNull();
  });
});

const LEAGUE_SUMMARY = {
  ...LEAGUE_ROW,
  role: LEAF,
  teamCountActual: LEAF,
} as const satisfies Shape<Old["league"]["listMine"][number]>;

describe("leagues.listMine (was league.listMine)", () => {
  test("shape and values", async () => {
    const actual = await asDemo().query(api.leagues.listMine, {});
    assertSameKeysExcept(
      [LEAGUE_SUMMARY],
      normalize(actual),
      "league.listMine",
      optionalUnset("league.listMine[0].joinCode"),
    );
    expect(actual).toHaveLength(1);
    expect(actual[0].name).toBe("Demo League");
    expect(actual[0].role).toBe("commissioner");
    expect(actual[0].teamCountActual).toBe(12);
  });

  test("signed out is rejected, as the old protectedProcedure was", async () => {
    await expect(anon().query(api.leagues.listMine, {})).rejects.toThrow(/UNAUTHORIZED/);
  });
});

// =============================================================== config (§2.1)

const HARNESS = {
  maxSteps: LEAF,
  tokenBudget: LEAF,
  temperature: LEAF,
  reasoningEffort: LEAF,
  deliberateMode: LEAF,
} as const;

const SKILL_ROW = {
  id: LEAF,
  authorUserId: LEAF,
  name: LEAF,
  slug: LEAF,
  description: LEAF,
  bodyMd: LEAF,
  visibility: LEAF,
  forkedFromSkillId: LEAF,
  createdAt: DATE,
  updatedAt: DATE,
} as const satisfies Shape<ConfigVersionWithSkills["skills"][number]>;

const VERSION_WITH_SKILLS = {
  id: LEAF,
  configId: LEAF,
  versionNo: LEAF,
  contextMd: LEAF,
  modelId: LEAF,
  harness: HARNESS,
  createdAt: DATE,
  createdByUserId: LEAF,
  appliedAt: DATE,
  changeSummary: LEAF,
  skills: [SKILL_ROW],
} as const satisfies Shape<NonNullable<Old["config"]["get"]["current"]>>;

const VERSION_SUMMARY = {
  id: LEAF,
  configId: LEAF,
  versionNo: LEAF,
  contextMd: LEAF,
  modelId: LEAF,
  harness: HARNESS,
  createdAt: DATE,
  createdByUserId: LEAF,
  appliedAt: DATE,
  changeSummary: LEAF,
  createdByName: LEAF,
  skillCount: LEAF,
  isCurrent: LEAF,
  isPending: LEAF,
  changedThisWeek: LEAF,
  modelDisplayName: LEAF,
} as const satisfies Shape<Old["config"]["versions"]["versions"][number]>;

const LOCK_STATUS = {
  open: LEAF,
  nextChange: DATE,
  lock: { unlockDay: LEAF, unlockTime: LEAF, lockDay: LEAF, lockTime: LEAF },
} as const satisfies Shape<Old["config"]["lockStatus"]>;

const CONFIG_GET = {
  team: TEAM_ROW,
  league: LEAGUE_ROW,
  rules: LEAF,
  config: {
    id: LEAF,
    teamId: LEAF,
    currentVersionId: LEAF,
    pendingVersionId: LEAF,
    noteToAgent: LEAF,
    createdAt: DATE,
    updatedAt: DATE,
  },
  current: VERSION_WITH_SKILLS,
  pending: VERSION_WITH_SKILLS,
  versions: [VERSION_SUMMARY],
  lock: LOCK_STATUS,
  canEdit: LEAF,
  viewerUserId: LEAF,
} as const satisfies Shape<Old["config"]["get"]>;

describe("configs.* (was config.*)", () => {
  test("configs.get", async () => {
    const teamId = goldenTeam("Regression to the Mean");
    const actual = await asDemo().query(api.configs.get, { leagueId: fx.leagueId, teamId });
    assertSameKeysExcept(CONFIG_GET, normalize(actual), "config.get", [
      ...optionalUnset(
        "config.get.league.joinCode",
        "config.get.config.noteToAgent",
        "config.get.config.pendingVersionId",
        "config.get.current.createdByUserId",
        "config.get.versions[0].createdByUserId",
      ),
      ...additiveColumn(
        "config.get.config.leagueId",
        "config.get.current.leagueId",
        "config.get.current.teamId",
        "config.get.current.skillIds",
        "config.get.versions[0].leagueId",
        "config.get.versions[0].teamId",
        "config.get.versions[0].skillIds",
      ),
    ]);

    expect(actual.team.name).toBe("Regression to the Mean");
    expect(actual.current?.versionNo).toBe(1);
    expect(actual.current?.modelId).toBe("mock/scripted");
    expect(actual.versions).toHaveLength(1);
    expect(actual.canEdit).toBe(true);
  });

  test("configs.versions", async () => {
    const teamId = goldenTeam("Gradient Ascent");
    const actual = await asDemo().query(api.configs.versions, { leagueId: fx.leagueId, teamId });
    assertSameKeysExcept(
      { config: CONFIG_GET.config, team: TEAM_ROW, versions: [VERSION_SUMMARY] },
      normalize(actual),
      "config.versions",
      [
        ...optionalUnset(
          "config.versions.config.noteToAgent",
          "config.versions.config.pendingVersionId",
          "config.versions.team.ownerUserId",
          "config.versions.versions[0].createdByUserId",
        ),
        ...additiveColumn(
          "config.versions.config.leagueId",
          "config.versions.versions[0].leagueId",
          "config.versions.versions[0].teamId",
          "config.versions.versions[0].skillIds",
        ),
      ],
    );
    expect(actual.versions).toHaveLength(1);
    expect(actual.versions[0].isCurrent).toBe(true);
  });

  test("configs.version", async () => {
    const versionId = ref(
      "config_versions",
      readGolden("config_versions")[0].id,
    )! as Id<"config_versions">;
    const actual = await asDemo().query(api.configs.version, { leagueId: fx.leagueId, versionId });
    assertSameKeysExcept(
      { version: VERSION_WITH_SKILLS, previous: VERSION_WITH_SKILLS },
      normalize(actual),
      "config.version",
      [
        ...optionalUnset("config.version.version.createdByUserId"),
        ...additiveColumn(
          "config.version.version.leagueId",
          "config.version.version.teamId",
          "config.version.version.skillIds",
        ),
      ],
    );
    expect(actual.version.versionNo).toBe(1);
    // Only one version per team in the golden week, so there is no predecessor.
    expect(actual.previous).toBeNull();
  });

  test("configs.diff", async () => {
    const [a, b] = readGolden("config_versions").slice(0, 2);
    const actual = await asDemo().query(api.configs.diff, {
      leagueId: fx.leagueId,
      a: ref("config_versions", a.id)! as Id<"config_versions">,
      b: ref("config_versions", b.id)! as Id<"config_versions">,
    });
    const stamp = {
      id: LEAF,
      versionNo: LEAF,
      modelId: LEAF,
      createdAt: DATE,
      changeSummary: LEAF,
    } as const;
    const fieldDiff = { field: LEAF, label: LEAF, from: LEAF, to: LEAF, changed: LEAF } as const;
    const skillRef = { id: LEAF, name: LEAF, slug: LEAF } as const;
    const expected = {
      a: stamp,
      b: stamp,
      context: {
        changed: LEAF,
        unified: LEAF,
        hunks: [
          {
            oldStart: LEAF,
            oldLines: LEAF,
            newStart: LEAF,
            newLines: LEAF,
            header: LEAF,
            lines: [{ kind: LEAF, text: LEAF, oldNo: LEAF, newNo: LEAF }],
          },
        ],
        added: LEAF,
        removed: LEAF,
      },
      model: fieldDiff,
      harness: [fieldDiff],
      skills: {
        before: [skillRef],
        after: [skillRef],
        added: [skillRef],
        removed: [skillRef],
        reordered: LEAF,
        changed: LEAF,
      },
      changed: LEAF,
    } as const satisfies Shape<Old["config"]["diff"]>;
    assertSameKeys(expected, normalize(actual), "config.diff");

    // Old: the harness diff is always the same five fields in this order.
    expect(actual.harness.map((row) => row.field)).toEqual([
      "maxSteps",
      "tokenBudget",
      "temperature",
      "reasoningEffort",
      "deliberateMode",
    ]);
    expect(actual.model.field).toBe("modelId");
    expect(actual.model.label).toBe("Model");
  });

  test("configs.lockStatus", async () => {
    const actual = await asDemo().query(api.configs.lockStatus, { leagueId: fx.leagueId });
    assertSameKeys(LOCK_STATUS, normalize(actual), "config.lockStatus");
    expect(actual.lock).toEqual({
      unlockDay: "tue",
      unlockTime: "06:00",
      lockDay: "wed",
      lockTime: "03:00",
    });
    expect(typeof actual.nextChange).toBe("number");
  });

  test("configs.estimate", async () => {
    const skillId = ref("skills", readGolden("skills")[0].id)! as Id<"skills">;
    const actual = await asDemo().query(api.configs.estimate, {
      leagueId: fx.leagueId,
      contextMd: "x".repeat(4_000),
      skillIds: [skillId],
      modelId: "mock/scripted",
    });
    const expected = {
      tokens: LEAF,
      estimatedCostPerRunUsd: LEAF,
      breakdown: {
        baseTokens: LEAF,
        contextTokens: LEAF,
        skillTokens: LEAF,
        skills: [{ id: LEAF, name: LEAF, tokens: LEAF }],
        assumedSteps: LEAF,
        assumedOutputTokensPerStep: LEAF,
        inputPerM: LEAF,
        outputPerM: LEAF,
        modelId: LEAF,
        modelKnown: LEAF,
      },
    } as const satisfies Shape<Old["config"]["estimate"]>;
    assertSameKeys(expected, normalize(actual), "config.estimate");

    // Old constants: BASE_PROMPT_TOKENS 2500, CHARS_PER_TOKEN 4, ASSUMED_STEPS 4.
    expect(actual.breakdown.baseTokens).toBe(2_500);
    expect(actual.breakdown.contextTokens).toBe(1_000);
    expect(actual.breakdown.assumedSteps).toBe(4);
    expect(actual.breakdown.assumedOutputTokensPerStep).toBe(1_500);
    expect(actual.breakdown.skills).toHaveLength(1);
    expect(actual.tokens).toBe(
      2_500 + 1_000 + actual.breakdown.skillTokens,
    );
  });
});

// =============================================================== skills (§2.1)

const SKILL_WITH_META = {
  ...SKILL_ROW,
  authorName: LEAF,
  usageCount: LEAF,
} as const satisfies Shape<Old["skills"]["list"][number]>;

describe("skills.* (was skills.*)", () => {
  test("skills.list", async () => {
    const actual = await asDemo().query(api.skills.list, {});
    assertSameKeysExcept(
      [SKILL_WITH_META],
      normalize(actual),
      "skills.list",
      optionalUnset("skills.list[0].forkedFromSkillId"),
    );
    expect(actual).toHaveLength(3);
    // Old: `ORDER BY skills.name ASC`.
    expect(actual.map((skill) => skill.slug)).toEqual([
      "injury-aware-lineups",
      "trade-negotiation-etiquette",
      "value-based-drafting",
    ]);
  });

  test("skills.list filters by text", async () => {
    const actual = await asDemo().query(api.skills.list, { query: "drafting" });
    expect(actual.map((skill) => skill.slug)).toEqual(["value-based-drafting"]);
  });

  test("skills.get", async () => {
    const actual = await asDemo().query(api.skills.get, { slug: "value-based-drafting" });
    const expected = {
      ...SKILL_WITH_META,
      forkedFrom: { id: LEAF, name: LEAF, slug: LEAF },
      forks: [{ id: LEAF, name: LEAF, slug: LEAF }],
    } as const satisfies Shape<Old["skills"]["get"]>;
    assertSameKeysExcept(
      expected,
      normalize(actual),
      "skills.get",
      optionalUnset("skills.get.forkedFromSkillId"),
    );
    expect(actual?.name).toBe("Value-based drafting");
    expect(actual?.forkedFrom).toBeNull();
    expect(actual?.forks).toEqual([]);
  });

  test("skills.get and skills.list read signed out", async () => {
    expect(await anon().query(api.skills.list, {})).toHaveLength(3);
    expect(await anon().query(api.skills.get, { slug: "injury-aware-lineups" })).not.toBeNull();
  });
});

// ======================================================= cost → ledger.* (§2.1)

const SPEND_TOTALS = {
  usd: LEAF,
  tokens: LEAF,
  inputTokens: LEAF,
  outputTokens: LEAF,
  runCount: LEAF,
  stepCount: LEAF,
} as const;

describe("ledger.* (was cost.*)", () => {
  test("ledger.teamDashboard (was cost.team)", async () => {
    const teamId = goldenTeam("Regression to the Mean");
    const actual = await asDemo().query(api.ledger.teamDashboard, {
      leagueId: fx.leagueId,
      teamId,
      weekNo: 1,
    });
    const expected = {
      week: { ...SPEND_TOTALS, teamId: LEAF, weekNo: LEAF },
      season: { ...SPEND_TOTALS, teamId: LEAF, byWeek: [{ ...SPEND_TOTALS, weekNo: LEAF }] },
      costPerPoint: { teamId: LEAF, usd: LEAF, points: LEAF, costPerPoint: LEAF },
      costPerWin: {
        teamId: LEAF,
        usd: LEAF,
        wins: LEAF,
        losses: LEAF,
        ties: LEAF,
        costPerWin: LEAF,
      },
      budget: {
        teamId: LEAF,
        weekNo: LEAF,
        tokensUsed: LEAF,
        tokenCap: LEAF,
        tokensRemaining: LEAF,
        tokensPct: LEAF,
        overTokenCap: LEAF,
        teamWeekUsd: LEAF,
        leagueUsdUsed: LEAF,
        leagueUsdCap: LEAF,
        leagueUsdRemaining: LEAF,
        leagueUsdPct: LEAF,
        overUsdCap: LEAF,
        rollup: { tokensUsed: LEAF, usdUsed: LEAF, runCount: LEAF },
      },
    } as const satisfies Shape<Old["cost"]["team"]>;
    assertSameKeys(expected, normalize(actual), "cost.team");

    // Golden: every run is `mock/scripted` at $0, and no game was scored.
    expect(actual.week.weekNo).toBe(1);
    expect(actual.week.usd).toBe(0);
    expect(actual.week.tokens).toBeGreaterThan(0);
    expect(actual.costPerPoint.costPerPoint).toBeNull();
    expect(actual.costPerWin.costPerWin).toBeNull();
    expect(actual.budget.tokenCap).toBeNull();
    expect(actual.budget.leagueUsdCap).toBeNull();
  });

  test("ledger.leagueDashboard (was cost.league)", async () => {
    const actual = await asDemo().query(api.ledger.leagueDashboard, { leagueId: fx.leagueId });
    const expected = {
      totals: SPEND_TOTALS,
      byTeam: [
        {
          ...SPEND_TOTALS,
          teamId: LEAF,
          teamName: LEAF,
          abbreviation: LEAF,
          ownerUserId: LEAF,
          modelId: LEAF,
        },
      ],
      byModel: [{ ...SPEND_TOTALS, modelId: LEAF, provider: LEAF, displayName: LEAF }],
      expensive: [
        {
          runId: LEAF,
          teamId: LEAF,
          teamName: LEAF,
          modelId: LEAF,
          status: LEAF,
          outcome: LEAF,
          windowLabel: LEAF,
          windowType: LEAF,
          weekNo: LEAF,
          stepCount: LEAF,
          costUsd: LEAF,
          createdAt: DATE,
        },
      ],
      trend: [{ ...SPEND_TOTALS, weekNo: LEAF }],
    } as const satisfies Shape<Old["cost"]["league"]>;
    assertSameKeys(expected, normalize(actual), "cost.league");

    expect(actual.byTeam).toHaveLength(12);
    expect(actual.byModel.map((row) => row.modelId)).toEqual(["mock/scripted"]);
    expect(actual.totals.stepCount).toBe(readGolden("usage_events").length);
    // Old: `expensive` is `ORDER BY runs.total_cost_usd DESC LIMIT limit`, default 10.
    expect(actual.expensive.length).toBeLessThanOrEqual(10);
  });

  test("ledger.benchmark (was cost.benchmark)", async () => {
    const actual = await asDemo().query(api.ledger.benchmark, { leagueId: fx.leagueId });
    const expected = [
      {
        modelId: LEAF,
        displayName: LEAF,
        provider: LEAF,
        teamCount: LEAF,
        teamIds: [LEAF],
        usd: LEAF,
        tokens: LEAF,
        points: LEAF,
        wins: LEAF,
        pointsPerUsd: LEAF,
        costPerPoint: LEAF,
        costPerWin: LEAF,
      },
    ] as const satisfies Shape<Old["cost"]["benchmark"]>;
    assertSameKeys(expected, normalize(actual), "cost.benchmark");

    expect(actual).toHaveLength(1);
    expect(actual[0].modelId).toBe("mock/scripted");
    expect(actual[0].teamCount).toBe(12);
    expect(actual[0].pointsPerUsd).toBeNull();
  });
});

// ================================================================ views (§2.1)

const WINDOW_VIEW = {
  id: LEAF,
  type: LEAF,
  label: LEAF,
  labelText: LEAF,
  weekNo: LEAF,
  roundNo: LEAF,
  opensAt: DATE,
  submissionDeadlineAt: DATE,
  closesAt: DATE,
  status: LEAF,
  snapshotId: LEAF,
  runCount: LEAF,
  countdown: LEAF,
  phase: LEAF,
} as const satisfies Shape<Old["views"]["windowsForWeek"][number]>;

const STANDINGS_ROW = {
  rank: LEAF,
  teamId: LEAF,
  teamName: LEAF,
  abbreviation: LEAF,
  ownerUserId: LEAF,
  wins: LEAF,
  losses: LEAF,
  ties: LEAF,
  pointsFor: LEAF,
  pointsAgainst: LEAF,
  streak: LEAF,
  karma: LEAF,
  faabRemaining: LEAF,
  modelId: LEAF,
  configVersionNo: LEAF,
} as const satisfies Shape<Old["views"]["standings"][number]>;

const MATCHUP_SIDE = {
  teamId: LEAF,
  teamName: LEAF,
  abbreviation: LEAF,
  score: LEAF,
  live: LEAF,
  record: LEAF,
} as const;

const MATCHUP_CARD = {
  id: LEAF,
  weekNo: LEAF,
  isFinal: LEAF,
  home: MATCHUP_SIDE,
  away: MATCHUP_SIDE,
} as const satisfies Shape<Old["views"]["matchups"][number]>;

const TRACE_LIST_ITEM = {
  id: LEAF,
  leagueId: LEAF,
  teamId: LEAF,
  teamName: LEAF,
  teamAbbreviation: LEAF,
  windowId: LEAF,
  windowLabel: LEAF,
  windowLabelText: LEAF,
  windowType: LEAF,
  weekNo: LEAF,
  roundNo: LEAF,
  modelId: LEAF,
  modelLabel: LEAF,
  status: LEAF,
  outcome: LEAF,
  rationale: LEAF,
  costUsd: LEAF,
  stepCount: LEAF,
  actionCount: LEAF,
  startedAt: DATE,
  finishedAt: DATE,
  durationMs: LEAF,
  configVersionNo: LEAF,
  fallbackKind: LEAF,
  createdAt: DATE,
} as const satisfies Shape<Old["traces"]["list"]["items"][number]>;

describe("views.* (was views.*)", () => {
  test("views.home", async () => {
    const actual = await asDemo().query(api.views.home, { leagueId: fx.leagueId });
    const expected = {
      league: {
        id: LEAF,
        name: LEAF,
        slug: LEAF,
        season: LEAF,
        status: LEAF,
        isPublic: LEAF,
        teamCount: LEAF,
      },
      viewer: { isMember: LEAF, isCommissioner: LEAF, teamId: LEAF },
      currentWeek: LEAF,
      standings: [STANDINGS_ROW],
      matchups: [MATCHUP_CARD],
      forumPosts: [
        {
          id: LEAF,
          title: LEAF,
          teamName: LEAF,
          flair: LEAF,
          score: LEAF,
          commentCount: LEAF,
          createdAt: DATE,
          runId: LEAF,
          stepIndex: LEAF,
        },
      ],
      trades: [
        {
          id: LEAF,
          status: LEAF,
          proposerTeamName: LEAF,
          recipientTeamName: LEAF,
          playerCount: LEAF,
          fairnessScore: LEAF,
          flagged: LEAF,
          resolvedAt: DATE,
          createdAt: DATE,
        },
      ],
      spend: [
        {
          teamId: LEAF,
          teamName: LEAF,
          abbreviation: LEAF,
          usdUsed: LEAF,
          tokensUsed: LEAF,
          runCount: LEAF,
          modelId: LEAF,
          modelLabel: LEAF,
        },
      ],
      totalSpendUsd: LEAF,
      windows: { open: [WINDOW_VIEW], upcoming: [WINDOW_VIEW], next: WINDOW_VIEW },
      draft: {
        status: LEAF,
        draftType: LEAF,
        scheduledAt: DATE,
        picksMade: LEAF,
        totalPicks: LEAF,
      },
      snapshotTakenAt: DATE,
    } as const satisfies Shape<Old["views"]["home"]>;
    assertSameKeysExcept(expected, normalize(actual), "views.home", [
      // `windows.terminalRunCount` is a denormalized counter the write paths keep
      // (`docs/CONVEX_CONVENTIONS.md`, "Counters every write path must maintain");
      // the old `WindowView` had only `runCount`, computed by a correlated subquery.
      ...additiveColumn(
        "views.home.windows.open[0].terminalRunCount",
        "views.home.windows.upcoming[0].terminalRunCount",
        "views.home.windows.next.terminalRunCount",
      ),
    ]);

    expect(actual?.league.name).toBe("Demo League");
    expect(actual?.currentWeek).toBe(1);
    expect(actual?.standings).toHaveLength(12);
    expect(actual?.matchups).toHaveLength(6);
    // Old: hidden = false, `ORDER BY createdAt DESC LIMIT 5`; the golden week has 4.
    expect(actual?.forumPosts).toHaveLength(4);
    expect(actual?.viewer.isCommissioner).toBe(true);
    expect(actual?.draft.picksMade).toBe(180);
    expect(actual?.draft.totalPicks).toBe(180);
  });

  test("views.standings", async () => {
    const actual = await asDemo().query(api.views.standings, { leagueId: fx.leagueId });
    assertSameKeys([STANDINGS_ROW], normalize(actual), "views.standings");

    expect(actual).toHaveLength(12);
    expect(actual.map((row) => row.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    // No game was scored in the golden week, so the old tiebreak chain collapses to
    // `teamName.localeCompare` ascending.
    expect(actual[0].teamName).toBe("Attention Is All You Need");
    expect(actual.every((row) => row.wins === 0 && row.losses === 0)).toBe(true);
    expect(actual[0].modelId).toBe("mock/scripted");
  });

  test("views.teams", async () => {
    const actual = await asDemo().query(api.views.teams, { leagueId: fx.leagueId });
    const expected = [
      {
        id: LEAF,
        name: LEAF,
        abbreviation: LEAF,
        ownerUserId: LEAF,
        ownerName: LEAF,
        record: LEAF,
        rank: LEAF,
        pointsFor: LEAF,
        karma: LEAF,
        faabRemaining: LEAF,
        modelId: LEAF,
        modelLabel: LEAF,
        configVersionNo: LEAF,
      },
    ] as const satisfies Shape<Old["views"]["teams"]>;
    assertSameKeys(expected, normalize(actual), "views.teams");

    expect(actual).toHaveLength(12);
    expect(actual.every((row) => row.record === "0-0")).toBe(true);
    // The Phase 2 reports flagged `views.teams` ordering as a possible deviation.
    // It is not one on this dataset: the cards come back in `views.standings`
    // order (wins desc, pointsFor desc, teamName asc), which is what the old
    // `teamCards` did.
    const table = await asDemo().query(api.views.standings, { leagueId: fx.leagueId });
    expect(actual.map((card) => card.id)).toEqual(table.map((row) => row.teamId));
    expect(actual.map((card) => card.rank)).toEqual(table.map((row) => row.rank));
  });

  test("views.team", async () => {
    const teamId = goldenTeam("Regression to the Mean");
    const actual = await asDemo().query(api.views.team, { teamId });
    const rosterEntry = {
      playerId: LEAF,
      fullName: LEAF,
      position: LEAF,
      nflTeam: LEAF,
      injuryStatus: LEAF,
      byeWeek: LEAF,
      acquiredVia: LEAF,
      acquiredAt: DATE,
      projection: LEAF,
      livePoints: LEAF,
      kickoffAt: LEAF,
      opponent: LEAF,
      slot: LEAF,
      starting: LEAF,
    } as const;
    const expected = {
      team: {
        id: LEAF,
        leagueId: LEAF,
        name: LEAF,
        abbreviation: LEAF,
        ownerUserId: LEAF,
        ownerName: LEAF,
        ownerEmail: LEAF,
        faabRemaining: LEAF,
        faabBudget: LEAF,
        karma: LEAF,
        waiverPriority: LEAF,
      },
      league: { id: LEAF, name: LEAF, season: LEAF, status: LEAF },
      weekNo: LEAF,
      record: {
        wins: LEAF,
        losses: LEAF,
        ties: LEAF,
        pointsFor: LEAF,
        pointsAgainst: LEAF,
        rank: LEAF,
        streak: LEAF,
      },
      roster: [rosterEntry],
      lineup: [{ slot: LEAF, entry: rosterEntry, starting: LEAF }],
      lineupSource: LEAF,
      lineupSetByRunId: LEAF,
      projectedTotal: LEAF,
      liveTotal: LEAF,
      config: {
        configId: LEAF,
        versionId: LEAF,
        versionNo: LEAF,
        modelId: LEAF,
        modelLabel: LEAF,
        harness: HARNESS,
        changeSummary: LEAF,
        createdAt: DATE,
        contextChars: LEAF,
        hasPendingVersion: LEAF,
      },
      recentRuns: [TRACE_LIST_ITEM],
      cost: { seasonUsd: LEAF, weekUsd: LEAF, seasonTokens: LEAF, runCount: LEAF },
      snapshotTakenAt: DATE,
    } as const satisfies Shape<Old["views"]["team"]>;
    assertSameKeys(expected, normalize(actual), "views.team");

    expect(actual?.team.name).toBe("Regression to the Mean");
    expect(actual?.weekNo).toBe(1);
    // 15 roster slots per team in the golden league (180 roster_slots / 12 teams).
    expect(actual?.roster).toHaveLength(15);
    // 15 grid slots from `rosterSlots` (QB1 RB2 WR2 TE1 FLEX1 K1 DEF1 + BENCH6),
    // plus one trailing `BENCH` row per rostered player the stored week-1 lineup
    // does not place — the old `views.team` appended those the same way.
    expect(actual?.lineup.length).toBeGreaterThanOrEqual(15);
    expect(actual?.lineup.filter((row) => row.slot !== "BENCH")).toHaveLength(9);
    expect(actual?.lineup.filter((row) => row.starting)).toHaveLength(9);
    expect(actual?.config.modelId).toBe("mock/scripted");
    expect(actual?.config.versionNo).toBe(1);
  });

  test("views.matchups", async () => {
    const actual = await asDemo().query(api.views.matchups, { leagueId: fx.leagueId, weekNo: 1 });
    assertSameKeys([MATCHUP_CARD], normalize(actual), "views.matchups");
    expect(actual).toHaveLength(6);
    expect(actual.every((card) => card.weekNo === 1 && card.isFinal === false)).toBe(true);
  });

  test("views.matchup", async () => {
    const cards = await asDemo().query(api.views.matchups, { leagueId: fx.leagueId, weekNo: 1 });
    const actual = await asDemo().query(api.views.matchup, {
      leagueId: fx.leagueId,
      weekNo: 1,
      matchupId: cards[0].id as Id<"matchups">,
    });
    const side = {
      teamId: LEAF,
      teamName: LEAF,
      abbreviation: LEAF,
      record: LEAF,
      slots: [
        {
          slot: LEAF,
          starting: LEAF,
          playerId: LEAF,
          playerName: LEAF,
          position: LEAF,
          nflTeam: LEAF,
          opponent: LEAF,
          injuryStatus: LEAF,
          kickoffAt: LEAF,
          projection: LEAF,
          points: LEAF,
        },
      ],
      projectedTotal: LEAF,
      liveTotal: LEAF,
      officialScore: LEAF,
      lineupSource: LEAF,
      rationale: {
        runId: LEAF,
        windowLabel: LEAF,
        excerpt: LEAF,
        fullText: LEAF,
        modelId: LEAF,
        status: LEAF,
      },
    } as const;
    const expected = {
      leagueId: LEAF,
      weekNo: LEAF,
      matchupId: LEAF,
      isFinal: LEAF,
      home: side,
      away: side,
    } as const satisfies Shape<Old["views"]["matchup"]>;
    assertSameKeys(expected, normalize(actual), "views.matchup");

    expect(actual?.weekNo).toBe(1);
    expect(actual?.home.slots.filter((slot) => slot.starting)).toHaveLength(9);
    expect(actual?.home.officialScore).toBe(0);
  });

  test("draft.board (was views.draftBoard)", async () => {
    const actual = await asDemo().query(api.draft.board, { leagueId: fx.leagueId });
    const pick = {
      id: LEAF,
      round: LEAF,
      pickNo: LEAF,
      overallNo: LEAF,
      teamId: LEAF,
      teamName: LEAF,
      teamAbbreviation: LEAF,
      playerId: LEAF,
      playerName: LEAF,
      position: LEAF,
      nflTeam: LEAF,
      price: LEAF,
      auto: LEAF,
      rationale: LEAF,
      runId: LEAF,
      costUsd: LEAF,
      madeAt: DATE,
    } as const;
    const expected = {
      leagueId: LEAF,
      draftType: LEAF,
      status: LEAF,
      scheduledAt: DATE,
      rounds: LEAF,
      teams: [{ id: LEAF, name: LEAF, abbreviation: LEAF, slotIndex: LEAF }],
      picks: [pick],
      grid: [[pick]],
      onTheClock: {
        teamId: LEAF,
        teamName: LEAF,
        overallNo: LEAF,
        round: LEAF,
        pickNo: LEAF,
        deadlineAt: DATE,
      },
      picksMade: LEAF,
      totalPicks: LEAF,
      runningCostUsd: LEAF,
    } as const satisfies Shape<Old["views"]["draftBoard"]>;
    assertSameKeys(expected, normalize(actual), "views.draftBoard");

    expect(actual?.picks).toHaveLength(180);
    expect(actual?.picksMade).toBe(180);
    expect(actual?.rounds).toBe(15);
    expect(actual?.teams).toHaveLength(12);
    expect(actual?.grid).toHaveLength(15);
    // The draft is finished, so nobody is on the clock.
    expect(actual?.onTheClock).toBeNull();
  });

  test("waivers.results (was views.waivers)", async () => {
    const actual = await asDemo().query(api.waivers.results, { leagueId: fx.leagueId, weekNo: 1 });
    const expected = {
      leagueId: LEAF,
      weekNo: LEAF,
      results: [
        {
          claimId: LEAF,
          teamId: LEAF,
          teamName: LEAF,
          teamAbbreviation: LEAF,
          addPlayerId: LEAF,
          addPlayerName: LEAF,
          addPlayerPosition: LEAF,
          dropPlayerId: LEAF,
          dropPlayerName: LEAF,
          bid: LEAF,
          priority: LEAF,
          status: LEAF,
          resultReason: LEAF,
          processedAt: DATE,
          runId: LEAF,
          weekNo: LEAF,
        },
      ],
      pendingCount: LEAF,
      weeksWithClaims: [LEAF],
      faab: [
        { teamId: LEAF, teamName: LEAF, abbreviation: LEAF, remaining: LEAF, spent: LEAF },
      ],
      window: { id: LEAF, opensAt: DATE, closesAt: DATE, status: LEAF },
    } as const satisfies Shape<Old["views"]["waivers"]>;
    assertSameKeys(expected, normalize(actual), "views.waivers");

    expect(actual.results).toHaveLength(24);
    expect(actual.results.filter((row) => row.status === "won")).toHaveLength(2);
    expect(actual.pendingCount).toBe(0);
    expect(actual.weeksWithClaims).toEqual([1]);
    expect(actual.faab).toHaveLength(12);
    // Old: `ORDER BY bid DESC, priority ASC`.
    const bids = actual.results.map((row) => row.bid);
    expect(bids).toEqual([...bids].sort((a, b) => b - a));
  });

  test("windows.forWeek (was views.windowsForWeek)", async () => {
    const actual = await asDemo().query(api.windows.forWeek, { leagueId: fx.leagueId, weekNo: 1 });
    assertSameKeysExcept(
      [WINDOW_VIEW],
      normalize(actual),
      "views.windowsForWeek",
      additiveColumn("views.windowsForWeek[0].terminalRunCount"),
    );
    expect(actual.length).toBeGreaterThan(0);
    expect(actual.every((row) => row.weekNo === 1)).toBe(true);
    // Old: `ORDER BY opensAt ASC, roundNo ASC`.
    const opens = actual.map((row) => row.opensAt);
    expect(opens).toEqual([...opens].sort((a, b) => a - b));
  });

  test("windows.schedule (was views.windowSchedule)", async () => {
    const actual = await asDemo().query(api.windows.schedule, { leagueId: fx.leagueId });
    const expected = {
      open: [WINDOW_VIEW],
      upcoming: [WINDOW_VIEW],
      next: WINDOW_VIEW,
    } as const satisfies Shape<Old["views"]["windowSchedule"]>;
    assertSameKeysExcept(expected, normalize(actual), "views.windowSchedule", [
      ...additiveColumn(
        "views.windowSchedule.open[0].terminalRunCount",
        "views.windowSchedule.upcoming[0].terminalRunCount",
        "views.windowSchedule.next.terminalRunCount",
      ),
    ]);
    // Old: `upcoming` is sliced to the first 4.
    expect(actual.upcoming.length).toBeLessThanOrEqual(4);
    expect(actual.next).toEqual(actual.open[0] ?? actual.upcoming[0] ?? null);
  });
});

// ====================================================== traces → runs.* (§2.1)

/**
 * The paginated read model.
 *
 * DEVIATION (Phase 2, documented): the old `traces.list` returned
 * `{ items, page, pageSize, total, pageCount, matchedPlayers }` — an offset page
 * plus a `COUNT(*)`. Convex paginates by cursor and the plan (§2.1) drops the
 * totals: a count over an unbounded index range is exactly the read the limits
 * work is trying to remove. Callers get `{ page, isDone, continueCursor }`.
 */
function assertPaginationEnvelope(actual: unknown, path: string): void {
  expect(isPlainObject(actual)).toBe(true);
  const keys = liveKeys(actual as Record<string, unknown>);
  expect(keys).toContain("page");
  expect(keys).toContain("isDone");
  expect(keys).toContain("continueCursor");
  expect(keys).not.toContain("total");
  expect(keys).not.toContain("pageCount");
  void path;
}

describe("runs.* (was traces.*)", () => {
  test("runs.list", async () => {
    const first = await asDemo().query(api.runs.list, {
      leagueId: fx.leagueId,
      paginationOpts: PAGE,
    });
    assertPaginationEnvelope(first, "traces.list");
    assertSameKeys(TRACE_LIST_ITEM, normalize(first.page[0]), "traces.list.items[0]");

    expect(first.page).toHaveLength(25);
    expect(first.isDone).toBe(false);
    // Old: `ORDER BY runs.createdAt DESC`.
    const second = await asDemo().query(api.runs.list, {
      leagueId: fx.leagueId,
      paginationOpts: { numItems: 25, cursor: first.continueCursor },
    });
    expect(second.page).toHaveLength(13);
    expect(second.isDone).toBe(true);
    expect(first.page.length + second.page.length).toBe(38);
  });

  test("runs.list filters", async () => {
    const teamId = goldenTeam("Regression to the Mean");
    const byTeam = await asDemo().query(api.runs.list, {
      leagueId: fx.leagueId,
      teamId,
      paginationOpts: PAGE,
    });
    expect(byTeam.page.every((run) => run.teamId === teamId)).toBe(true);
    const byType = await asDemo().query(api.runs.list, {
      leagueId: fx.leagueId,
      windowType: "waiver",
      paginationOpts: PAGE,
    });
    expect(byType.page.every((run) => run.windowType === "waiver")).toBe(true);
  });

  test("runs.search", async () => {
    const actual = await asDemo().query(api.runs.search, {
      leagueId: fx.leagueId,
      q: "FAAB",
      paginationOpts: PAGE,
    });
    assertPaginationEnvelope(actual, "traces.search");
    expect(actual.page.length).toBeGreaterThan(0);
    assertSameKeys(TRACE_LIST_ITEM, normalize(actual.page[0]), "traces.search.items[0]");
  });

  test("runs.get + runs.steps", async () => {
    const list = await asDemo().query(api.runs.list, {
      leagueId: fx.leagueId,
      paginationOpts: PAGE,
    });
    const runId = list.page[0].id as Id<"runs">;
    const actual = await asDemo().query(api.runs.get, { runId });
    const expected = {
      run: {
        ...TRACE_LIST_ITEM,
        error: LEAF,
        fallback: { kind: LEAF, detail: LEAF, fromModelId: LEAF, toModelId: LEAF },
        totalInputTokens: LEAF,
        totalOutputTokens: LEAF,
        kind: LEAF,
        attempt: LEAF,
      },
      league: { id: LEAF, name: LEAF, isPublic: LEAF },
      window: {
        id: LEAF,
        type: LEAF,
        label: LEAF,
        labelText: LEAF,
        weekNo: LEAF,
        roundNo: LEAF,
        opensAt: DATE,
        submissionDeadlineAt: DATE,
        closesAt: DATE,
        snapshotId: LEAF,
      },
      team: { id: LEAF, name: LEAF, abbreviation: LEAF },
      configVersion: {
        id: LEAF,
        versionNo: LEAF,
        modelId: LEAF,
        changeSummary: LEAF,
        createdAt: DATE,
      },
      promptSections: [
        { id: LEAF, title: LEAF, role: LEAF, chars: LEAF, tokenEstimate: LEAF, text: LEAF },
      ],
      promptSectionsSource: LEAF,
      steps: [LEAF],
      actions: [
        {
          id: LEAF,
          toolCallId: LEAF,
          stepIndex: LEAF,
          actionType: LEAF,
          // A loose jsonb blob in both schemas; not descended into.
          payload: LEAF,
          validationResult: { ok: LEAF, errors: [LEAF] },
          committedAt: DATE,
          createdAt: DATE,
        },
      ],
      usage: [
        {
          id: LEAF,
          stepIndex: LEAF,
          modelId: LEAF,
          provider: LEAF,
          inputTokens: LEAF,
          outputTokens: LEAF,
          cachedInputTokens: LEAF,
          reasoningTokens: LEAF,
          latencyMs: LEAF,
          costUsd: LEAF,
          gatewayCostUsd: LEAF,
        },
      ],
    } as const satisfies Shape<Old["traces"]["get"]>;
    assertSameKeysExcept(expected, normalize(actual), "traces.get", [
      // DEVIATION (Phase 2, documented): `traces.get` inlined every step, action and
      // usage event into one payload. `runs.get` returns the run header only —
      // steps are a separate paginated query (`runs.steps`), usage events another
      // (`runs.usageEvents`) — and keeps just the *usage totals* on the header, so a
      // 200-step run cannot blow the 16 MiB / 32k-document transaction limits.
      ...phase2Deviation(
        "traces.get.steps: missing",
        "traces.get.usage: expected an array, got object",
      ),
      // `runs.lastPersistedStep` is the resume marker the Workpool runner writes
      // (`docs/migration-plan.md` §4); the old schema had no resumable runs.
      ...additiveColumn("traces.get.run.lastPersistedStep"),
    ]);

    expect(actual.run.status).toBe("succeeded");
    expect(actual.run.modelId).toBe("mock/scripted");
    expect(actual.team?.name).not.toBe("");

    const steps = await asDemo().query(api.runs.steps, { runId, paginationOpts: PAGE });
    assertPaginationEnvelope(steps, "traces.get.steps");
    assertSameKeysExcept(
      {
        id: LEAF,
        stepIndex: LEAF,
        modelId: LEAF,
        text: LEAF,
        reasoning: LEAF,
        toolCalls: [LEAF],
        toolResults: [LEAF],
        // Loose blobs in both schemas; not descended into.
        usage: LEAF,
        finishReason: LEAF,
        latencyMs: LEAF,
        costUsd: LEAF,
        createdAt: DATE,
        hasValidationError: LEAF,
      } as const satisfies Shape<Old["traces"]["get"]["steps"][number]>,
      normalize(steps.page[0]),
      "traces.get.steps[0]",
      // `run_steps.gatewayCostUsd` is carried on the step in Convex; the old trace
      // viewer read the gateway figure from the joined `usage_events` row instead.
      additiveColumn("traces.get.steps[0].gatewayCostUsd"),
    );
    expect(steps.page.map((step) => step.stepIndex)).toEqual(
      [...steps.page.map((step) => step.stepIndex)].sort((a, b) => a - b),
    );
  });

  test("runs.modelOptions", async () => {
    const actual = await asDemo().query(api.runs.modelOptions, { leagueId: fx.leagueId });
    assertSameKeys(
      [{ modelId: LEAF, label: LEAF, runCount: LEAF }] as const satisfies Shape<
        Old["traces"]["modelOptions"]
      >,
      normalize(actual),
      "traces.modelOptions",
    );
    // `label` is the catalog display name, exactly as the old `modelLabel` was.
    expect(actual).toEqual([
      { modelId: "mock/scripted", label: MODEL_CATALOG.find((m) => m.modelId === "mock/scripted")!.displayName, runCount: 38 },
    ]);
  });

  test("runs.export", async () => {
    const list = await asDemo().query(api.runs.list, {
      leagueId: fx.leagueId,
      paginationOpts: PAGE,
    });
    const actual = await asDemo().query(api.runs.export, {
      runId: list.page[0].id as Id<"runs">,
    });
    expect(actual.version).toBe(1);
    expect(actual.kind).toBe("run");
    // Old `TraceExport.exportedAt` was `new Date().toISOString()` — a string, not a
    // `Date`, so this is one of the two fields that stays a string after the move.
    expect(typeof actual.exportedAt).toBe("string");
    expect(Array.isArray(actual.trace.steps)).toBe(true);
    expect(actual.trace.steps.length).toBeGreaterThan(0);
  });

  test("runs.stepPayload has nothing to read on the golden week", async () => {
    // `run_step_payloads` only receives tool results over 64 KB (PRD 5.8). Every
    // golden step is well under that, so the overflow table is empty and
    // `runs.stepPayload` has no parity case here; it is exercised by
    // `scripts/limits-check.ts` on the load-test deployment instead.
    const overflow = await fx.t.run(async (ctx) =>
      (await ctx.db.query("run_step_payloads").collect()).length,
    );
    expect(overflow).toBe(0);
  });

  test("runs.exportTeamPage (was traces.exportTeam)", async () => {
    const teamId = goldenTeam("Regression to the Mean");
    const actual = await asDemo().query(api.runs.exportTeamPage, {
      teamId,
      paginationOpts: PAGE,
    });
    assertPaginationEnvelope(actual, "traces.exportTeam");
    expect(actual.page.length).toBeGreaterThan(0);
  });
});

// ========================================================= commissioner (§2.1)

describe("commissioner.* (was commissioner.*)", () => {
  test("commissioner.settings", async () => {
    const actual = await asDemo().query(api.commissioner.settings, { leagueId: fx.leagueId });
    const ruleChange = {
      id: LEAF,
      leagueId: LEAF,
      userId: LEAF,
      field: LEAF,
      fromValue: LEAF,
      toValue: LEAF,
      note: LEAF,
      createdAt: DATE,
      userName: LEAF,
    } as const satisfies Shape<Old["commissioner"]["settings"]["changes"][number]>;
    const expected = {
      league: LEAGUE_ROW,
      rules: LEAF,
      invite: { code: LEAF, url: LEAF },
      changes: [ruleChange],
      modelsInUse: [{ modelId: LEAF, teamCount: LEAF }],
      catalog: [
        {
          modelId: LEAF,
          provider: LEAF,
          displayName: LEAF,
          inputPerM: LEAF,
          outputPerM: LEAF,
          cachedInputPerM: LEAF,
          reasoningPerM: LEAF,
          supportsReasoning: LEAF,
        },
      ],
      locked: LEAF,
    } as const satisfies Shape<Old["commissioner"]["settings"]>;
    assertSameKeysExcept(expected, normalize(actual), "commissioner.settings", [
      ...optionalUnset("commissioner.settings.league.joinCode"),
      // The settings page renders team cards from the same read.
      ...additiveColumn("commissioner.settings.teams"),
    ]);

    // DEVIATION (Phase 2, documented): the old `commissioner.settings` *minted* a
    // join code as a side effect of reading (`ensureJoinCode` wrote to the league
    // row) so `invite.code`/`invite.url` were always strings. A Convex query cannot
    // write, so both stay null until `commissioner.rotateJoinCode` mints one; the
    // golden league has no join code.
    expect(actual.invite).toEqual({ code: null, url: null });
    expect(actual.league.name).toBe("Demo League");
    expect(actual.locked).toBe(true);
    expect(actual.changes).toEqual([]);
    expect(actual.modelsInUse).toEqual([{ modelId: "mock/scripted", teamCount: 12 }]);
    expect(actual.catalog).toHaveLength(MODEL_CATALOG.length);
  });

  test("commissioner.inviteLink", async () => {
    // Same deviation: no code until a mutation mints one.
    expect(await asDemo().query(api.commissioner.inviteLink, { leagueId: fx.leagueId })).toEqual({
      code: null,
      url: null,
    });
  });

  test("commissioner.changeLog", async () => {
    const actual = await asDemo().query(api.commissioner.changeLog, {
      leagueId: fx.leagueId,
      paginationOpts: PAGE,
    });
    assertPaginationEnvelope(actual, "commissioner.changeLog");
    // The golden dump has no rule changes.
    expect(actual.page).toEqual([]);
    expect(actual.isDone).toBe(true);
  });

  test("commissioner.* refuse a non-commissioner", async () => {
    await expect(
      anon().query(api.commissioner.settings, { leagueId: fx.leagueId }),
    ).rejects.toThrow(/UNAUTHORIZED|FORBIDDEN/);
  });
});

// =============================================================== trades (§2.1)

const TRADE_PLAYER_REF = {
  playerId: LEAF,
  playerName: LEAF,
  position: LEAF,
  nflTeam: LEAF,
} as const;

const TRADE_SUMMARY = {
  id: LEAF,
  status: LEAF,
  proposerTeamId: LEAF,
  recipientTeamId: LEAF,
  threadId: LEAF,
  give: [TRADE_PLAYER_REF],
  receive: [TRADE_PLAYER_REF],
  faab: LEAF,
  message: LEAF,
  fairnessScore: LEAF,
  flagged: LEAF,
  createdAt: LEAF,
  reviewEndsAt: LEAF,
  leagueId: LEAF,
  weekNo: LEAF,
  windowId: LEAF,
  proposerTeamName: LEAF,
  recipientTeamName: LEAF,
  parentTradeId: LEAF,
  resolvedAt: LEAF,
  fairnessDetail: LEAF,
  createdByRunId: LEAF,
} as const satisfies Shape<Old["trades"]["list"][number]>;

describe("trades.* (was trades.*)", () => {
  test("trades.list", async () => {
    const actual = await asDemo().query(api.trades.list, { leagueId: fx.leagueId });
    assertSameKeys([TRADE_SUMMARY], normalize(actual), "trades.list");

    expect(actual).toHaveLength(11);
    expect(actual.every((trade) => trade.status === "proposed")).toBe(true);
    // Old: `ORDER BY trades.created_at DESC`.
    const created = actual.map((trade) => trade.createdAt);
    expect(created).toEqual([...created].sort((a, b) => b - a));
    // The old service serialised timestamps with `.toISOString()`; Convex keeps
    // epoch ms everywhere and the UI formats at the edge.
    expect(typeof actual[0].createdAt).toBe("number");
    expect(actual[0].give.length + actual[0].receive.length).toBeGreaterThan(0);
  });

  test("trades.list filters by team", async () => {
    const teamId = goldenTeam("Regression to the Mean");
    const actual = await asDemo().query(api.trades.list, { leagueId: fx.leagueId, teamId });
    expect(actual.length).toBeGreaterThan(0);
    expect(
      actual.every(
        (trade) => trade.proposerTeamId === teamId || trade.recipientTeamId === teamId,
      ),
    ).toBe(true);
  });

  test("trades.get", async () => {
    const list = await asDemo().query(api.trades.list, { leagueId: fx.leagueId });
    const tradeId = list[0].id as Id<"trades">;
    const actual = await asDemo().query(api.trades.get, { leagueId: fx.leagueId, tradeId });
    const expected = {
      ...TRADE_SUMMARY,
      events: [
        {
          id: LEAF,
          type: LEAF,
          fromStatus: LEAF,
          toStatus: LEAF,
          runId: LEAF,
          stepIndex: LEAF,
          actorTeamId: LEAF,
          actorTeamName: LEAF,
          payload: LEAF,
          createdAt: LEAF,
        },
      ],
      votes: [{ userId: LEAF, vote: LEAF, createdAt: LEAF }],
      tally: {
        vetoes: LEAF,
        approvals: LEAF,
        ownerCount: LEAF,
        threshold: LEAF,
        blocked: LEAF,
      },
      counterTradeIds: [LEAF],
    } as const satisfies Shape<Old["trades"]["get"]>;
    assertSameKeysExcept(expected, normalize(actual), "trades.get", [
      // The viewer's own veto/approve vote, so the negotiation feed can render its
      // button state without a second round trip.
      ...additiveColumn("trades.get.myVote"),
    ]);

    expect(actual.id).toBe(tradeId);
    expect(actual.status).toBe("proposed");
    expect(actual.votes).toEqual([]);
    // Old: `tally` is null unless the trade is `in_review`.
    expect(actual.tally).toBeNull();
    expect(actual.events.length).toBeGreaterThan(0);
  });
});

// ============================================================ messaging (§2.1)

const THREAD_MESSAGE = {
  id: LEAF,
  threadId: LEAF,
  senderTeamId: LEAF,
  senderTeamName: LEAF,
  body: LEAF,
  withheld: LEAF,
  flags: LEAF,
  runId: LEAF,
  stepIndex: LEAF,
  configVersionId: LEAF,
  createdAt: LEAF,
} as const;

const THREAD_LIST_ITEM = {
  id: LEAF,
  leagueId: LEAF,
  teamA: { id: LEAF, name: LEAF, abbreviation: LEAF },
  teamB: { id: LEAF, name: LEAF, abbreviation: LEAF },
  createdInWindowId: LEAF,
  weekNo: LEAF,
  windowLabel: LEAF,
  createdAt: LEAF,
  lastMessageAt: LEAF,
  messageCount: LEAF,
  status: LEAF,
  openTradeCount: LEAF,
  flaggedCount: LEAF,
  lastMessage: THREAD_MESSAGE,
  delayed: LEAF,
  revealAt: LEAF,
} as const satisfies Shape<Old["messaging"]["listThreads"][number]>;

describe("messaging.* (was messaging.*)", () => {
  test("messaging.listThreads", async () => {
    const actual = await asDemo().query(api.messaging.listThreads, { leagueId: fx.leagueId });
    assertSameKeys([THREAD_LIST_ITEM], normalize(actual), "messaging.listThreads");

    expect(actual).toHaveLength(6);
    expect(actual.reduce((sum, thread) => sum + thread.messageCount, 0)).toBe(23);
    // Old: `ORDER BY last_message_at DESC, created_at DESC`.
    const stamps = actual.map((thread) => thread.lastMessageAt ?? 0);
    expect(stamps).toEqual([...stamps].sort((a, b) => b - a));
    // The league is `transparencyMode: "live"`, so nothing is withheld.
    expect(actual.every((thread) => thread.delayed === false)).toBe(true);
    expect(actual.every((thread) => thread.lastMessage?.withheld === false)).toBe(true);
  });

  test("messaging.getThread", async () => {
    const threads = await asDemo().query(api.messaging.listThreads, { leagueId: fx.leagueId });
    const threadId = threads[0].id as Id<"threads">;
    const actual = await asDemo().query(api.messaging.getThread, {
      leagueId: fx.leagueId,
      threadId,
      paginationOpts: PAGE,
    });
    assertSameKeysExcept(
      { ...THREAD_LIST_ITEM, messages: [THREAD_MESSAGE], trades: [TRADE_SUMMARY] },
      normalize(actual),
      "messaging.getThread",
      [
        // DEVIATION (Phase 2, documented): the old `getThread` returned the whole
        // message history in one array. `messaging.getThread` pages the messages
        // (`paginationOpts`), so `messages` is the pagination envelope, not an array,
        // and carries no total.
        ...phase2Deviation("messaging.getThread.messages: expected an array, got object"),
      ],
    );

    assertPaginationEnvelope(actual.messages, "messaging.getThread.messages");
    assertSameKeys(
      THREAD_MESSAGE,
      normalize(actual.messages.page[0]),
      "messaging.getThread.messages[0]",
    );
    // Old: `ORDER BY messages.created_at ASC`.
    const stamps = actual.messages.page.map((message) => message.createdAt);
    expect(stamps).toEqual([...stamps].sort((a, b) => a - b));
    expect(actual.messages.page.length).toBe(threads[0].messageCount);
  });
});

// ================================================================ forum (§2.1)

const FORUM_POST = {
  id: LEAF,
  teamId: LEAF,
  teamName: LEAF,
  title: LEAF,
  body: LEAF,
  flair: LEAF,
  score: LEAF,
  commentCount: LEAF,
  createdAt: LEAF,
  flags: LEAF,
  comments: [LEAF],
  hidden: LEAF,
  runId: LEAF,
  stepIndex: LEAF,
  hotScore: LEAF,
  myVote: LEAF,
} as const satisfies Shape<Old["forum"]["list"]["posts"][number]>;

describe("forum.* (was forum.*)", () => {
  test("forum.list", async () => {
    const actual = await asDemo().query(api.forum.list, {
      leagueId: fx.leagueId,
      sort: "hot",
      paginationOpts: PAGE,
    });
    assertPaginationEnvelope(actual, "forum.list");
    assertSameKeysExcept(FORUM_POST, normalize(actual.page[0]), "forum.list.posts[0]", [
      // `comments` was only ever populated by `forum.get`; the list query omits the
      // key entirely rather than returning `undefined`.
      ...optionalUnset("forum.list.posts[0].comments"),
    ]);

    expect(actual.page).toHaveLength(4);
    expect(actual.page.every((post) => post.score === 0)).toBe(true);
    expect(actual.page.map((post) => post.title)).toContain("Week 1 Recap");
    // Old: posts with no team render as the Commissioner Agent.
    expect(actual.page.every((post) => post.teamId === null)).toBe(true);
    // Old hot ranking: score / (ageHours + 2) ** 1.5, rounded to 5 decimals.
    expect(actual.page.every((post) => post.hotScore === 0)).toBe(true);
    // DEVIATION (Phase 2, documented): `hot` cannot be indexed, so `forum.list`
    // ranks the newest `HOT_WINDOW` (200) posts and slices the page out of that
    // ranking — hot is bounded, not paginated past 200. The old service had the
    // same shape of bound with a different constant (`max(limit * 4, 100)`), so
    // this is a wider window, not a narrower one. The golden league has 4 posts,
    // well inside both.
    expect(actual.isDone).toBe(true);
  });

  test("forum.list sorts and pages", async () => {
    const byNew = await asDemo().query(api.forum.list, {
      leagueId: fx.leagueId,
      sort: "new",
      paginationOpts: { numItems: 2, cursor: null },
    });
    expect(byNew.page).toHaveLength(2);
    expect(byNew.isDone).toBe(false);
    const second = await asDemo().query(api.forum.list, {
      leagueId: fx.leagueId,
      sort: "new",
      paginationOpts: { numItems: 2, cursor: byNew.continueCursor },
    });
    expect(second.page).toHaveLength(2);
    const created = [...byNew.page, ...second.page].map((post) => post.createdAt);
    expect(created).toEqual([...created].sort((a, b) => b - a));
  });

  test("forum.get", async () => {
    const list = await asDemo().query(api.forum.list, {
      leagueId: fx.leagueId,
      sort: "new",
      paginationOpts: PAGE,
    });
    const postId = list.page[0].id as Id<"forum_posts">;
    const actual = await asDemo().query(api.forum.get, { leagueId: fx.leagueId, postId });
    const expected = {
      post: {
        ...FORUM_POST,
        comments: [
          {
            id: LEAF,
            parentId: LEAF,
            teamId: LEAF,
            teamName: LEAF,
            body: LEAF,
            score: LEAF,
            createdAt: LEAF,
            flags: LEAF,
            hidden: LEAF,
            runId: LEAF,
            stepIndex: LEAF,
            depth: LEAF,
            myVote: LEAF,
          },
        ],
      },
      // `Record<teamId, karma>`; not descended into.
      karma: LEAF,
    } as const satisfies Shape<Old["forum"]["get"]>;
    assertSameKeys(expected, normalize(actual), "forum.get");

    expect(actual.post.id).toBe(postId);
    // The golden dump has no comments.
    expect(actual.post.comments).toEqual([]);
    expect(Object.keys(actual.karma)).toHaveLength(12);
  });

  test("forum.karma", async () => {
    const actual = await asDemo().query(api.forum.karma, { leagueId: fx.leagueId });
    assertSameKeysExcept(
      [{ id: LEAF, name: LEAF, karma: LEAF }] as const satisfies Shape<Old["forum"]["karma"]>,
      normalize(actual),
      "forum.karma",
      [
        // The Convex row names the team id `teamId`; the old inline projection called
        // it `id` because it selected the raw `teams.id` column.
        ...phase2Deviation("forum.karma[0].id: missing", "forum.karma[0].teamId: unexpected"),
      ],
    );
    expect(actual).toHaveLength(12);
    // Old: `rows.sort((a, b) => b.karma - a.karma)`.
    const karma = actual.map((row) => row.karma);
    expect(karma).toEqual([...karma].sort((a, b) => b - a));
  });
});
