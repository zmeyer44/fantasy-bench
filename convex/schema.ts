/**
 * Fantasy Bench — Convex schema (migration Phase 1 artifact).
 *
 * Conventions
 * - Convex `_id` replaces every Postgres primary key. `legacyId` is kept on every
 *   table during the migration so seed/parity tests can cross-reference rows; it is
 *   removed in the cleanup phase.
 * - Foreign keys are `v.id("table")`. There are no joins: each read path fetches by
 *   id or uses an index named `by_<field>_<field>` that matches its access pattern.
 * - Timestamps are epoch milliseconds (`v.number()`). Convex has no Date type.
 * - Money is USD as a float64 (`v.number()`), tokens are integers in `v.number()`.
 * - Enumerations are `v.union(v.literal(...))` — exported below so functions and
 *   the UI share one definition.
 * - Documents stay small by design (< ~500 KB): snapshot payloads are chunked,
 *   large tool results are split into `run_step_payloads`, and the full per-run
 *   message array is never stored on `runs` (it is rebuilt from `run_steps`).
 * - Auth is Convex Auth (`@convex-dev/auth`): `authTables` are spread into the
 *   schema and `users` is extended in place; app tables reference `v.id("users")`.
 *
 * Every index is justified in docs/migration-plan.md ("Index list").
 */
import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// ---------------------------------------------------------------------------
// Shared enum validators
// ---------------------------------------------------------------------------

export const leagueStatus = v.union(
  v.literal("setup"),
  v.literal("drafting"),
  v.literal("in_season"),
  v.literal("complete"),
);
export const draftType = v.union(v.literal("snake"), v.literal("auction"));
export const scoringPreset = v.union(v.literal("ppr"), v.literal("half_ppr"), v.literal("standard"));
export const transparencyMode = v.union(v.literal("live"), v.literal("delayed"));
export const injectionPolicy = v.union(v.literal("permitted"), v.literal("prohibited"));
export const leagueRole = v.union(v.literal("commissioner"), v.literal("owner"), v.literal("spectator"));
export const weekStatus = v.union(v.literal("upcoming"), v.literal("active"), v.literal("complete"));
export const position = v.union(
  v.literal("QB"),
  v.literal("RB"),
  v.literal("WR"),
  v.literal("TE"),
  v.literal("K"),
  v.literal("DEF"),
);
export const acquiredVia = v.union(
  v.literal("draft"),
  v.literal("waiver"),
  v.literal("free_agent"),
  v.literal("trade"),
);
export const lineupSource = v.union(
  v.literal("agent"),
  v.literal("autopilot"),
  v.literal("carryover"),
  v.literal("draft_default"),
);
export const transactionType = v.union(
  v.literal("add"),
  v.literal("drop"),
  v.literal("trade"),
  v.literal("draft"),
);
export const skillVisibility = v.union(v.literal("public"), v.literal("private"));
export const windowType = v.union(
  v.literal("draft"),
  v.literal("waiver"),
  v.literal("trade"),
  v.literal("lineup"),
  v.literal("forum"),
  v.literal("commissioner"),
);
export const windowStatus = v.union(
  v.literal("scheduled"),
  v.literal("open"),
  v.literal("closing"),
  v.literal("closed"),
);
export const runKind = v.union(v.literal("team"), v.literal("commissioner"));
export const runStatus = v.union(
  v.literal("pending"),
  v.literal("running"),
  v.literal("succeeded"),
  v.literal("partial"),
  v.literal("failed"),
  v.literal("timed_out"),
  v.literal("fallback"),
  v.literal("skipped"),
);
export const waiverStatus = v.union(
  v.literal("pending"),
  v.literal("won"),
  v.literal("lost"),
  v.literal("invalid"),
);
export const tradeStatus = v.union(
  v.literal("proposed"),
  v.literal("countered"),
  v.literal("accepted"),
  v.literal("rejected"),
  v.literal("expired"),
  v.literal("in_review"),
  v.literal("vetoed"),
  v.literal("completed"),
  v.literal("cancelled"),
);
export const tradeVote = v.union(v.literal("veto"), v.literal("approve"));
export const forumFlair = v.union(
  v.literal("trash_talk"),
  v.literal("trade_block"),
  v.literal("analysis"),
  v.literal("announcement"),
);
export const voteTargetType = v.union(v.literal("post"), v.literal("comment"));
export const budgetPeriod = v.union(v.literal("week"), v.literal("season"));
export const customProviderKind = v.literal("http_json");
export const reasoningEffort = v.union(v.literal("low"), v.literal("medium"), v.literal("high"));

// ---------------------------------------------------------------------------
// Shared object validators
// ---------------------------------------------------------------------------

/** Owner-tunable harness settings (PRD 5.4). Stored on config_versions. */
export const harnessSettings = v.object({
  maxSteps: v.number(),
  tokenBudget: v.number(),
  temperature: v.number(),
  reasoningEffort: v.optional(v.nullable(reasoningEffort)),
  deliberateMode: v.boolean(),
});

export const editLockConfig = v.object({
  unlockDay: v.string(),
  unlockTime: v.string(),
  lockDay: v.string(),
  lockTime: v.string(),
});

/** Per-window-label overrides of the schedule templates (PRD 5.3). */
export const windowOverride = v.object({
  enabled: v.optional(v.boolean()),
  opensDay: v.optional(v.string()),
  opensTime: v.optional(v.string()),
  closesDay: v.optional(v.string()),
  closesTime: v.optional(v.string()),
  submissionLeadMinutes: v.optional(v.number()),
  rounds: v.optional(v.number()),
});

export const lineupSlot = v.object({ slot: v.string(), playerId: v.nullable(v.id("players")) });

/**
 * Injection-classifier output attached to agent-authored content (PRD 6.7).
 *
 * `categories` (machine keys of the rules that fired) and `notes` (the reasons
 * joined for display) are what `buildContentFlags` in
 * `convex/lib/moderation_pure.ts` writes; both are optional so the Phase 2
 * golden import, which only carried `injectionSuspected`/`score`/`reasons`,
 * still validates.
 */
export const contentFlags = v.object({
  injectionSuspected: v.boolean(),
  score: v.number(),
  categories: v.optional(v.array(v.string())),
  reasons: v.optional(v.array(v.string())),
  notes: v.optional(v.string()),
});

export const fallbackApplied = v.object({
  kind: v.union(
    v.literal("safety_autopilot"),
    v.literal("fallback_model"),
    v.literal("carryover_lineup"),
    v.literal("budget_exhausted"),
  ),
  detail: v.optional(v.string()),
  fromModelId: v.optional(v.string()),
  toModelId: v.optional(v.string()),
});

export const promptSection = v.object({
  id: v.string(),
  title: v.string(),
  role: v.union(v.literal("system"), v.literal("user")),
  chars: v.number(),
  tokenEstimate: v.number(),
  text: v.string(),
});

/** Token accounting for one model step (AI SDK usage, flattened). */
export const stepUsage = v.object({
  inputTokens: v.number(),
  outputTokens: v.number(),
  totalTokens: v.number(),
  cachedInputTokens: v.number(),
  reasoningTokens: v.number(),
});

/** Aggregate counters shared by every rollup table (PRD 5.9). */
const rollupCounters = {
  inputTokens: v.number(),
  outputTokens: v.number(),
  cachedInputTokens: v.number(),
  reasoningTokens: v.number(),
  /** Preferred figure: gateway-reported when present, else computed. */
  costUsd: v.number(),
  computedCostUsd: v.number(),
  gatewayCostUsd: v.number(),
  runCount: v.number(),
  stepCount: v.number(),
  fallbackCount: v.number(),
  invalidActionCount: v.number(),
  updatedAt: v.number(),
};

const legacy = { legacyId: v.optional(v.string()) };

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export default defineSchema({
  // ---- identity -----------------------------------------------------------

  /**
   * Convex Auth tables (authSessions, authAccounts, authRefreshTokens,
   * authVerificationCodes, authVerifiers, authRateLimits) plus our extended
   * `users` table. `users` keeps Convex Auth's fields and indexes and adds ours.
   * App tables reference users with `v.id("users")`.
   */
  ...authTables,
  users: defineTable({
    ...authTables.users.validator.fields,
    ...legacy,
  })
    .index("email", ["email"])
    .index("phone", ["phone"]),

  // ---- league core --------------------------------------------------------

  leagues: defineTable({
    ...legacy,
    name: v.string(),
    slug: v.string(),
    commissionerUserId: v.id("users"),
    season: v.number(),
    teamCount: v.number(),
    isPublic: v.boolean(),
    status: leagueStatus,
    draftType: draftType,
    draftScheduledAt: v.optional(v.number()),
    joinCode: v.optional(v.string()),
    /** Scheduled `internal.draft.openNextPick` job while drafting; cancelled on reschedule. */
    draftJobId: v.optional(v.id("_scheduled_functions")),
    /**
     * Postgres `created_at`, preserved by the golden-dataset seed. `_creationTime`
     * is the insert instant and cannot be back-dated, but `leagues.listMine` orders
     * by creation date, so the original value is kept here. Removed in cleanup.
     */
    createdAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_slug", ["slug"])
    .index("by_joinCode", ["joinCode"])
    .index("by_commissionerUserId", ["commissionerUserId"])
    .index("by_status", ["status"]),

  /**
   * Kept as its own table (one document per league) because it is edited
   * independently by the commissioner console and read by every run; keeping it
   * off the `leagues` document avoids invalidating every league subscription on a
   * rules edit.
   */
  league_rules: defineTable({
    ...legacy,
    leagueId: v.id("leagues"),
    scoringPreset: scoringPreset,
    superflex: v.boolean(),
    tePremium: v.boolean(),
    rosterSlots: v.record(v.string(), v.number()),
    faabBudget: v.number(),
    playoffTeams: v.number(),
    playoffStartWeek: v.number(),
    regularSeasonWeeks: v.number(),
    seasonWeeks: v.number(),
    transparencyMode: transparencyMode,
    injectionPolicy: injectionPolicy,
    modelAllowlist: v.array(v.string()),
    fallbackModelId: v.optional(v.string()),
    weeklyTokenCapPerTeam: v.optional(v.number()),
    leagueUsdHardCap: v.optional(v.number()),
    contextCharLimit: v.number(),
    maxStepsCap: v.number(),
    editLock: editLockConfig,
    windowOverrides: v.optional(v.record(v.string(), windowOverride)),
    tradeReviewHours: v.number(),
    fairnessFloor: v.optional(v.number()),
    antiChurnWeeks: v.number(),
    maxOpenProposals: v.number(),
    maxMessagesPerRun: v.number(),
    maxThreadsPerWindow: v.number(),
    forumPostsPerDay: v.number(),
    forumCommentsPerDay: v.number(),
    safetyAutopilot: v.boolean(),
    runWallclockSeconds: v.number(),
    draftPickSeconds: v.number(),
    reuseSnapshotWithinMs: v.number(),
    draftBudget: v.number(),
    rulesLockedAt: v.optional(v.number()),
  }).index("by_leagueId", ["leagueId"]),

  league_rule_changes: defineTable({
    ...legacy,
    leagueId: v.id("leagues"),
    userId: v.optional(v.id("users")),
    field: v.string(),
    fromValue: v.optional(v.any()),
    toValue: v.optional(v.any()),
    note: v.optional(v.string()),
    /** Postgres `created_at`, preserved by the seed (change log orders by it). */
    createdAt: v.optional(v.number()),
  }).index("by_leagueId", ["leagueId"]),

  league_members: defineTable({
    ...legacy,
    leagueId: v.id("leagues"),
    userId: v.id("users"),
    role: leagueRole,
    /** Postgres `created_at`, preserved by the seed. */
    createdAt: v.optional(v.number()),
  })
    .index("by_leagueId_userId", ["leagueId", "userId"])
    .index("by_userId", ["userId"]),

  teams: defineTable({
    ...legacy,
    leagueId: v.id("leagues"),
    ownerUserId: v.optional(v.id("users")),
    name: v.string(),
    abbreviation: v.string(),
    faabRemaining: v.number(),
    waiverPriority: v.number(),
    karma: v.number(),
    draftBudgetRemaining: v.number(),
    /** Postgres `created_at`, preserved by the seed. */
    createdAt: v.optional(v.number()),
  })
    .index("by_leagueId", ["leagueId"])
    .index("by_leagueId_name", ["leagueId", "name"])
    .index("by_ownerUserId", ["ownerUserId"]),

  weeks: defineTable({
    ...legacy,
    leagueId: v.id("leagues"),
    weekNo: v.number(),
    startsAt: v.number(),
    endsAt: v.number(),
    isPlayoff: v.boolean(),
    status: weekStatus,
    /** Scheduled jobs owned by this week (rollover at startsAt, config unlock apply). */
    rolloverJobId: v.optional(v.id("_scheduled_functions")),
    unlockJobId: v.optional(v.id("_scheduled_functions")),
  })
    .index("by_leagueId_weekNo", ["leagueId", "weekNo"])
    .index("by_leagueId_startsAt", ["leagueId", "startsAt"]),

  matchups: defineTable({
    ...legacy,
    leagueId: v.id("leagues"),
    weekNo: v.number(),
    homeTeamId: v.id("teams"),
    awayTeamId: v.id("teams"),
    homeScore: v.optional(v.number()),
    awayScore: v.optional(v.number()),
    isFinal: v.boolean(),
  })
    .index("by_leagueId_weekNo", ["leagueId", "weekNo"])
    .index("by_homeTeamId_weekNo", ["homeTeamId", "weekNo"])
    .index("by_awayTeamId_weekNo", ["awayTeamId", "weekNo"]),

  /** Per-team weekly result; season totals live on `team_standings`. */
  team_results: defineTable({
    ...legacy,
    leagueId: v.id("leagues"),
    teamId: v.id("teams"),
    weekNo: v.number(),
    pointsFor: v.number(),
    pointsAgainst: v.number(),
    won: v.boolean(),
    lost: v.boolean(),
    tied: v.boolean(),
  })
    .index("by_teamId_weekNo", ["teamId", "weekNo"])
    .index("by_leagueId_weekNo", ["leagueId", "weekNo"]),

  /**
   * Season standings rollup, maintained by the scoring mutation that writes
   * team_results (no query-time aggregation over team_results).
   */
  team_standings: defineTable({
    leagueId: v.id("leagues"),
    teamId: v.id("teams"),
    season: v.number(),
    wins: v.number(),
    losses: v.number(),
    ties: v.number(),
    pointsFor: v.number(),
    pointsAgainst: v.number(),
    streak: v.string(),
    updatedAt: v.number(),
  })
    .index("by_teamId_season", ["teamId", "season"])
    .index("by_leagueId_season", ["leagueId", "season"]),

  // ---- players & NFL data -------------------------------------------------

  players: defineTable({
    ...legacy,
    sleeperId: v.string(),
    gsisId: v.optional(v.string()),
    espnId: v.optional(v.string()),
    fullName: v.string(),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    position: position,
    nflTeam: v.optional(v.string()),
    status: v.optional(v.string()),
    injuryStatus: v.optional(v.string()),
    injuryBodyPart: v.optional(v.string()),
    injuryNotes: v.optional(v.string()),
    byeWeek: v.optional(v.number()),
    yearsExp: v.optional(v.number()),
    age: v.optional(v.number()),
    searchRank: v.optional(v.number()),
    fantasyPositions: v.array(v.string()),
    /** Cross ids and other provider fields. Kept small (ids only, not the raw Sleeper blob). */
    externalIds: v.record(v.string(), v.string()),
    updatedAt: v.number(),
  })
    .index("by_sleeperId", ["sleeperId"])
    .index("by_position_searchRank", ["position", "searchRank"])
    .index("by_nflTeam", ["nflTeam"])
    .searchIndex("search_fullName", { searchField: "fullName", filterFields: ["position"] }),

  nfl_games: defineTable({
    ...legacy,
    season: v.number(),
    week: v.number(),
    gameId: v.string(),
    espnId: v.optional(v.string()),
    homeTeam: v.string(),
    awayTeam: v.string(),
    kickoffAt: v.number(),
    status: v.string(),
    homeScore: v.optional(v.number()),
    awayScore: v.optional(v.number()),
  })
    .index("by_gameId", ["gameId"])
    .index("by_season_week", ["season", "week"]),

  player_stats_weekly: defineTable({
    ...legacy,
    playerId: v.id("players"),
    season: v.number(),
    week: v.number(),
    source: v.string(),
    stats: v.record(v.string(), v.number()),
    fantasyPointsPpr: v.number(),
    fantasyPointsHalf: v.number(),
    fantasyPointsStd: v.number(),
    effectiveAt: v.number(),
  })
    .index("by_playerId_season_week", ["playerId", "season", "week"])
    .index("by_season_week", ["season", "week"]),

  /** Append-only projection vintages (PRD 6.5: snapshots pin a vintage). */
  player_projections: defineTable({
    ...legacy,
    playerId: v.id("players"),
    season: v.number(),
    week: v.number(),
    source: v.string(),
    projectedPointsPpr: v.number(),
    projectedPointsHalf: v.number(),
    projectedPointsStd: v.number(),
    stats: v.record(v.string(), v.number()),
    effectiveAt: v.number(),
  })
    .index("by_playerId_week_effectiveAt", ["playerId", "week", "effectiveAt"])
    .index("by_season_week_source_effectiveAt", ["season", "week", "source", "effectiveAt"]),

  /**
   * Latest projection per (player, season, week, source), upserted by ingest in the
   * same mutation that appends to player_projections. The snapshot builder reads this
   * table (one bounded range per week) instead of de-duplicating vintages.
   */
  player_projection_latest: defineTable({
    playerId: v.id("players"),
    season: v.number(),
    week: v.number(),
    source: v.string(),
    position: position,
    projectedPointsPpr: v.number(),
    projectedPointsHalf: v.number(),
    projectedPointsStd: v.number(),
    stats: v.record(v.string(), v.number()),
    effectiveAt: v.number(),
  })
    .index("by_playerId_season_week_source", ["playerId", "season", "week", "source"])
    .index("by_season_week_source_projectedPointsPpr", [
      "season",
      "week",
      "source",
      "projectedPointsPpr",
    ]),

  news_items: defineTable({
    ...legacy,
    playerId: v.optional(v.id("players")),
    source: v.string(),
    headline: v.string(),
    body: v.optional(v.string()),
    url: v.optional(v.string()),
    publishedAt: v.number(),
    effectiveAt: v.number(),
    dedupeKey: v.string(),
  })
    .index("by_effectiveAt", ["effectiveAt"])
    .index("by_playerId_effectiveAt", ["playerId", "effectiveAt"])
    .index("by_dedupeKey", ["dedupeKey"]),

  injury_designations: defineTable({
    ...legacy,
    playerId: v.id("players"),
    season: v.number(),
    week: v.number(),
    designation: v.string(),
    practiceStatus: v.optional(v.string()),
    source: v.string(),
    effectiveAt: v.number(),
  })
    .index("by_playerId_effectiveAt", ["playerId", "effectiveAt"])
    .index("by_season_week_effectiveAt", ["season", "week", "effectiveAt"]),

  /** Sleeper ownership percentages for the week (start/sit context). */
  player_ownership: defineTable({
    playerId: v.id("players"),
    season: v.number(),
    week: v.number(),
    ownedPct: v.number(),
    startedPct: v.number(),
    effectiveAt: v.number(),
  }).index("by_season_week_playerId", ["season", "week", "playerId"]),

  custom_providers: defineTable({
    ...legacy,
    leagueId: v.optional(v.id("leagues")),
    teamId: v.optional(v.id("teams")),
    name: v.string(),
    slug: v.string(),
    kind: customProviderKind,
    config: v.object({
      url: v.string(),
      method: v.optional(v.union(v.literal("GET"), v.literal("POST"))),
      headers: v.optional(v.record(v.string(), v.string())),
      jsonPath: v.optional(v.string()),
      description: v.optional(v.string()),
    }),
    enabled: v.boolean(),
    createdByUserId: v.optional(v.id("users")),
  })
    .index("by_leagueId", ["leagueId"])
    .index("by_teamId", ["teamId"]),

  // ---- rosters & lineups ---------------------------------------------------

  roster_slots: defineTable({
    ...legacy,
    leagueId: v.id("leagues"),
    teamId: v.id("teams"),
    playerId: v.id("players"),
    acquiredAt: v.number(),
    acquiredVia: acquiredVia,
  })
    .index("by_teamId", ["teamId"])
    .index("by_teamId_playerId", ["teamId", "playerId"])
    .index("by_leagueId_playerId", ["leagueId", "playerId"]),

  /** Versioned, append-only. The live lineup is the highest version for (team, week). */
  lineups: defineTable({
    ...legacy,
    teamId: v.id("teams"),
    leagueId: v.id("leagues"),
    weekNo: v.number(),
    version: v.number(),
    slots: v.array(lineupSlot),
    source: lineupSource,
    setByRunId: v.optional(v.id("runs")),
  })
    .index("by_teamId_weekNo_version", ["teamId", "weekNo", "version"])
    .index("by_setByRunId", ["setByRunId"]),

  transactions: defineTable({
    ...legacy,
    leagueId: v.id("leagues"),
    teamId: v.id("teams"),
    type: transactionType,
    weekNo: v.optional(v.number()),
    playerId: v.optional(v.id("players")),
    relatedTeamId: v.optional(v.id("teams")),
    tradeId: v.optional(v.id("trades")),
    runId: v.optional(v.id("runs")),
    details: v.optional(v.record(v.string(), v.any())),
  })
    .index("by_leagueId", ["leagueId"])
    .index("by_teamId", ["teamId"])
    .index("by_tradeId", ["tradeId"])
    .index("by_leagueId_playerId", ["leagueId", "playerId"]),

  // ---- agent configuration -----------------------------------------------

  agent_configs: defineTable({
    ...legacy,
    teamId: v.id("teams"),
    leagueId: v.id("leagues"),
    currentVersionId: v.optional(v.id("config_versions")),
    pendingVersionId: v.optional(v.id("config_versions")),
    noteToAgent: v.optional(v.string()),
    /** Postgres `created_at` / `updated_at`, preserved by the seed. */
    createdAt: v.optional(v.number()),
    updatedAt: v.optional(v.number()),
  })
    .index("by_teamId", ["teamId"])
    .index("by_leagueId", ["leagueId"]),

  /** IMMUTABLE after insert (only `appliedAt` is stamped once by applyPending). */
  config_versions: defineTable({
    ...legacy,
    configId: v.id("agent_configs"),
    teamId: v.id("teams"),
    leagueId: v.id("leagues"),
    versionNo: v.number(),
    contextMd: v.string(),
    modelId: v.string(),
    harness: harnessSettings,
    skillIds: v.array(v.id("skills")),
    createdByUserId: v.optional(v.id("users")),
    appliedAt: v.optional(v.number()),
    changeSummary: v.optional(v.string()),
    /**
     * Postgres `created_at`, preserved by the seed: `configs.versions` reports
     * `changedThisWeek` from it and the diff view stamps it. Removed in cleanup.
     */
    createdAt: v.optional(v.number()),
  })
    .index("by_configId_versionNo", ["configId", "versionNo"])
    .index("by_leagueId", ["leagueId"]),

  skills: defineTable({
    ...legacy,
    authorUserId: v.optional(v.id("users")),
    name: v.string(),
    slug: v.string(),
    description: v.optional(v.string()),
    bodyMd: v.string(),
    visibility: skillVisibility,
    forkedFromSkillId: v.optional(v.id("skills")),
    /** Denormalized: number of *current* config versions attaching this skill. */
    usageCount: v.number(),
    /** Postgres `created_at`, preserved by the seed (fork lists order by it). */
    createdAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_slug", ["slug"])
    .index("by_authorUserId", ["authorUserId"])
    .index("by_visibility", ["visibility"])
    .searchIndex("search_name", { searchField: "name", filterFields: ["visibility"] }),

  // ---- windows, snapshots, runs -------------------------------------------

  windows: defineTable({
    ...legacy,
    leagueId: v.id("leagues"),
    type: windowType,
    label: v.string(),
    /** 0 for week-less windows (draft) so the uniqueness index has a value. */
    weekNo: v.number(),
    roundNo: v.number(),
    opensAt: v.number(),
    submissionDeadlineAt: v.number(),
    closesAt: v.number(),
    snapshotId: v.optional(v.id("snapshots")),
    status: windowStatus,
    scope: v.object({
      gameDays: v.optional(v.array(v.string())),
      slots: v.optional(v.array(v.string())),
      pickNo: v.optional(v.number()),
      onTheClockTeamId: v.optional(v.id("teams")),
      nominationTeamId: v.optional(v.id("teams")),
      draftType: v.optional(draftType),
      rounds: v.optional(v.number()),
      round: v.optional(v.number()),
      /** Daily windows (the forum template) carry their day of the league week, 1-7. */
      dayIndex: v.optional(v.number()),
      lotNo: v.optional(v.number()),
      phase: v.optional(v.string()),
    }),
    /** Scheduled function ids; cancelled and recreated on reschedule. */
    openJobId: v.optional(v.id("_scheduled_functions")),
    closeJobId: v.optional(v.id("_scheduled_functions")),
    /** Denormalized counts for the schedule pages (maintained by open/persist/close). */
    runCount: v.number(),
    terminalRunCount: v.number(),
  })
    .index("by_leagueId_label_weekNo_roundNo", ["leagueId", "label", "weekNo", "roundNo"])
    .index("by_leagueId_weekNo_type", ["leagueId", "weekNo", "type"])
    .index("by_leagueId_status", ["leagueId", "status"])
    .index("by_leagueId_opensAt", ["leagueId", "opensAt"]),

  /**
   * A snapshot is a logical timestamp plus metadata. The frozen payload every
   * agent reads is stored in `snapshot_chunks`; the prompt digest in
   * `snapshot_digests`. Nothing large lives on this document.
   */
  snapshots: defineTable({
    ...legacy,
    leagueId: v.id("leagues"),
    windowId: v.optional(v.id("windows")),
    season: v.number(),
    weekNo: v.number(),
    takenAt: v.number(),
    status: v.union(v.literal("building"), v.literal("ready"), v.literal("failed")),
    chunkCount: v.number(),
    playerCount: v.number(),
    /** Projection vintage pinned by this snapshot (max effectiveAt <= takenAt). */
    projectionEffectiveAt: v.optional(v.number()),
    headline: v.optional(v.string()),
  })
    .index("by_leagueId_takenAt", ["leagueId", "takenAt"])
    .index("by_windowId", ["windowId"]),

  snapshot_digests: defineTable({
    snapshotId: v.id("snapshots"),
    headline: v.string(),
    topNews: v.array(
      v.object({ headline: v.string(), playerName: v.optional(v.string()), publishedAt: v.string() }),
    ),
    injuryChanges: v.array(
      v.object({
        playerName: v.string(),
        playerId: v.string(),
        from: v.nullable(v.string()),
        to: v.string(),
      }),
    ),
    projectionMovers: v.array(
      v.object({ playerName: v.string(), playerId: v.string(), delta: v.number() }),
    ),
    standingsSummary: v.string(),
  }).index("by_snapshotId", ["snapshotId"]),

  /**
   * The SnapshotPayload (lib/snapshot/types.ts) split by section and part so no
   * document exceeds ~200 KB: `meta` (rules, teams, games, matchups, standings,
   * news, injuries, liveScores, freeAgentIds) and `players` parts of 100 players.
   * The runtime loads all chunks for a snapshot with one indexed query and
   * reassembles the payload in memory; the tools are unchanged.
   */
  snapshot_chunks: defineTable({
    snapshotId: v.id("snapshots"),
    kind: v.union(v.literal("meta"), v.literal("players")),
    part: v.number(),
    // Documented v.any(): the section of a SnapshotPayload, typed in lib/snapshot/types.ts.
    data: v.any(),
    bytes: v.number(),
  }).index("by_snapshotId_kind_part", ["snapshotId", "kind", "part"]),

  runs: defineTable({
    ...legacy,
    windowId: v.id("windows"),
    leagueId: v.id("leagues"),
    teamId: v.optional(v.id("teams")),
    configVersionId: v.optional(v.id("config_versions")),
    modelId: v.string(),
    kind: runKind,
    status: runStatus,
    /** Denormalized from the window for trace-list filters. */
    windowType: windowType,
    windowLabel: v.string(),
    weekNo: v.number(),
    /** Workpool work id of the current attempt; retries re-use the run document. */
    workId: v.optional(v.string()),
    attempt: v.number(),
    /** Highest step index whose run_steps/usage/actions are committed. -1 when none. */
    lastPersistedStep: v.number(),
    startedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
    outcome: v.optional(v.string()),
    rationale: v.optional(v.string()),
    totalCostUsd: v.number(),
    totalInputTokens: v.number(),
    totalOutputTokens: v.number(),
    stepCount: v.number(),
    committedActionCount: v.number(),
    rejectedActionCount: v.number(),
    error: v.optional(v.string()),
    fallbackApplied: v.optional(fallbackApplied),
    promptSections: v.optional(v.array(promptSection)),
    /** Set when this run was enqueued by onComplete as the fallback-model retry of another run. */
    fallbackOfRunId: v.optional(v.id("runs")),
    /**
     * Ledger idempotency guard (Phase 4). Set once the run's fallback outcome has
     * been folded into `fallbackCount` — either by `internal.ledger.recordStep`
     * for a step flagged `isFallbackStep`, or by `internal.ledger.recordRunOutcome`
     * for a run that ended in `fallback` without ever taking such a step.
     */
    ledgerOutcomeRecorded: v.optional(v.boolean()),
  })
    .index("by_windowId_status", ["windowId", "status"])
    .index("by_teamId", ["teamId"])
    .index("by_leagueId", ["leagueId"])
    .index("by_leagueId_teamId", ["leagueId", "teamId"])
    .index("by_leagueId_status", ["leagueId", "status"])
    .index("by_leagueId_weekNo", ["leagueId", "weekNo"])
    .index("by_leagueId_windowType", ["leagueId", "windowType"])
    .index("by_leagueId_modelId", ["leagueId", "modelId"])
    .index("by_leagueId_kind", ["leagueId", "kind"]),

  /** One document per model call. Append-only. */
  run_steps: defineTable({
    ...legacy,
    runId: v.id("runs"),
    leagueId: v.id("leagues"),
    stepIndex: v.number(),
    modelId: v.string(),
    text: v.optional(v.string()),
    reasoning: v.optional(v.string()),
    // Documented v.any(): AI SDK ModelMessage[] produced by this step (assistant + tool
    // messages). Used verbatim to rebuild the conversation on resume.
    responseMessages: v.any(),
    // Documented v.any(): AI SDK tool-call objects for this step.
    toolCalls: v.any(),
    /**
     * Tool results inline when small; entries over `PAYLOAD_INLINE_LIMIT` are replaced
     * by `{ toolCallId, payloadRef: Id<"run_step_payloads"> }` and loaded lazily.
     */
    toolResults: v.any(),
    usage: stepUsage,
    finishReason: v.optional(v.string()),
    latencyMs: v.optional(v.number()),
    costUsd: v.number(),
    gatewayCostUsd: v.optional(v.number()),
    bytes: v.number(),
  }).index("by_runId_stepIndex", ["runId", "stepIndex"]),

  /** Overflow storage for large tool results (PRD 5.8 completeness without 1 MiB documents). */
  run_step_payloads: defineTable({
    runId: v.id("runs"),
    stepIndex: v.number(),
    toolCallId: v.string(),
    toolName: v.string(),
    // Documented v.any(): a single tool result object.
    payload: v.any(),
    bytes: v.number(),
  }).index("by_runId_stepIndex_toolCallId", ["runId", "stepIndex", "toolCallId"]),

  /** Idempotency + audit ledger for write tools. Unique per (runId, toolCallId). */
  run_actions: defineTable({
    ...legacy,
    runId: v.id("runs"),
    leagueId: v.id("leagues"),
    teamId: v.optional(v.id("teams")),
    toolCallId: v.string(),
    stepIndex: v.number(),
    actionType: v.string(),
    payload: v.record(v.string(), v.any()),
    validationResult: v.object({ ok: v.boolean(), errors: v.optional(v.array(v.string())) }),
    // Documented v.any(): the tool result replayed verbatim on a duplicate call.
    result: v.optional(v.any()),
    committedAt: v.optional(v.number()),
  })
    .index("by_runId_toolCallId", ["runId", "toolCallId"])
    .index("by_runId_stepIndex", ["runId", "stepIndex"]),

  /**
   * One small searchable document per run, written at finalize (and refreshed by
   * persistStep for player/tool names). Replaces the Postgres ILIKE trace search.
   */
  run_search_docs: defineTable({
    runId: v.id("runs"),
    leagueId: v.id("leagues"),
    teamId: v.optional(v.id("teams")),
    windowType: windowType,
    weekNo: v.number(),
    status: runStatus,
    modelId: v.string(),
    /** Player names, tool names, rationale, outcome and model text, capped at 64 KB. */
    text: v.string(),
  })
    .index("by_runId", ["runId"])
    .searchIndex("search_text", {
      searchField: "text",
      filterFields: ["leagueId", "teamId", "windowType", "weekNo", "status", "modelId"],
    }),

  // ---- transactions: waivers, draft, trades -------------------------------

  waiver_claims: defineTable({
    ...legacy,
    leagueId: v.id("leagues"),
    teamId: v.id("teams"),
    windowId: v.id("windows"),
    weekNo: v.number(),
    addPlayerId: v.id("players"),
    dropPlayerId: v.optional(v.id("players")),
    bid: v.number(),
    priority: v.number(),
    runId: v.optional(v.id("runs")),
    status: waiverStatus,
    resultReason: v.optional(v.string()),
    processedAt: v.optional(v.number()),
  })
    .index("by_windowId", ["windowId"])
    .index("by_windowId_teamId", ["windowId", "teamId"])
    .index("by_teamId_weekNo", ["teamId", "weekNo"])
    .index("by_leagueId_weekNo", ["leagueId", "weekNo"]),

  draft_picks: defineTable({
    ...legacy,
    leagueId: v.id("leagues"),
    round: v.number(),
    pickNo: v.number(),
    overallNo: v.number(),
    teamId: v.id("teams"),
    playerId: v.optional(v.id("players")),
    price: v.optional(v.number()),
    madeByRunId: v.optional(v.id("runs")),
    windowId: v.optional(v.id("windows")),
    auto: v.boolean(),
    rationale: v.optional(v.string()),
    madeAt: v.optional(v.number()),
  })
    .index("by_leagueId_overallNo", ["leagueId", "overallNo"])
    .index("by_leagueId_teamId", ["leagueId", "teamId"])
    .index("by_leagueId_playerId", ["leagueId", "playerId"]),

  auction_nominations: defineTable({
    ...legacy,
    leagueId: v.id("leagues"),
    lotNo: v.number(),
    nominatingTeamId: v.id("teams"),
    playerId: v.optional(v.id("players")),
    openingBid: v.number(),
    windowId: v.optional(v.id("windows")),
    runId: v.optional(v.id("runs")),
    status: v.union(
      v.literal("pending"),
      v.literal("nominated"),
      v.literal("bidding"),
      v.literal("resolved"),
      v.literal("abandoned"),
    ),
    winningTeamId: v.optional(v.id("teams")),
    winningBid: v.optional(v.number()),
    tiebreak: v.optional(v.record(v.string(), v.any())),
    resolvedAt: v.optional(v.number()),
  })
    .index("by_leagueId_lotNo", ["leagueId", "lotNo"])
    .index("by_leagueId_status", ["leagueId", "status"]),

  auction_bids: defineTable({
    ...legacy,
    nominationId: v.id("auction_nominations"),
    leagueId: v.id("leagues"),
    teamId: v.id("teams"),
    amount: v.number(),
    runId: v.optional(v.id("runs")),
    windowId: v.optional(v.id("windows")),
  }).index("by_nominationId_teamId", ["nominationId", "teamId"]),

  trades: defineTable({
    ...legacy,
    leagueId: v.id("leagues"),
    proposerTeamId: v.id("teams"),
    recipientTeamId: v.id("teams"),
    threadId: v.optional(v.id("threads")),
    windowId: v.optional(v.id("windows")),
    weekNo: v.number(),
    status: tradeStatus,
    /** trade_items folded in (PRD 6.4). */
    items: v.array(
      v.object({
        fromTeamId: v.id("teams"),
        toTeamId: v.id("teams"),
        playerId: v.optional(v.id("players")),
        faab: v.optional(v.number()),
      }),
    ),
    fairnessScore: v.optional(v.number()),
    fairnessDetail: v.optional(v.any()), // documented: FairnessDetailV1 (lib/services/trades/fairness.ts)
    flagged: v.boolean(),
    reviewEndsAt: v.optional(v.number()),
    resolvedAt: v.optional(v.number()),
    parentTradeId: v.optional(v.id("trades")),
    message: v.optional(v.string()),
    createdByRunId: v.optional(v.id("runs")),
    /** Denormalized veto tally for the detail page and review processing. */
    vetoCount: v.number(),
    approveCount: v.number(),
  })
    .index("by_leagueId", ["leagueId"])
    .index("by_leagueId_status", ["leagueId", "status"])
    .index("by_leagueId_weekNo", ["leagueId", "weekNo"])
    .index("by_proposerTeamId_status", ["proposerTeamId", "status"])
    .index("by_recipientTeamId_status", ["recipientTeamId", "status"])
    .index("by_threadId", ["threadId"])
    .index("by_windowId_status", ["windowId", "status"])
    .index("by_status_reviewEndsAt", ["status", "reviewEndsAt"])
    /** Counter-offers of a trade, for `trades.get`'s `counterTradeIds`. */
    .index("by_parentTradeId", ["parentTradeId"]),

  trade_events: defineTable({
    ...legacy,
    tradeId: v.id("trades"),
    leagueId: v.id("leagues"),
    type: v.string(),
    fromStatus: v.optional(tradeStatus),
    toStatus: v.optional(tradeStatus),
    runId: v.optional(v.id("runs")),
    stepIndex: v.optional(v.number()),
    actorTeamId: v.optional(v.id("teams")),
    payload: v.optional(v.record(v.string(), v.any())),
  }).index("by_tradeId", ["tradeId"]),

  trade_votes: defineTable({
    ...legacy,
    tradeId: v.id("trades"),
    userId: v.id("users"),
    vote: tradeVote,
  }).index("by_tradeId_userId", ["tradeId", "userId"]),

  // ---- messaging & forum ----------------------------------------------------

  threads: defineTable({
    ...legacy,
    leagueId: v.id("leagues"),
    /** Canonical pair: teamAId < teamBId (string compare of ids), enforced in the mutation. */
    teamAId: v.id("teams"),
    teamBId: v.id("teams"),
    createdInWindowId: v.optional(v.id("windows")),
    lastMessageAt: v.optional(v.number()),
    messageCount: v.number(),
    /**
     * Denormalized count of messages in the thread whose injection classifier
     * fired. `messaging.listThreads` shows it on every thread card and cannot
     * afford to read every thread's messages; maintained by `messaging.send`
     * (Phase 3) and by the golden-data import. Absent = 0.
     */
    flaggedCount: v.optional(v.number()),
  })
    .index("by_leagueId_teamAId_teamBId", ["leagueId", "teamAId", "teamBId"])
    .index("by_leagueId_lastMessageAt", ["leagueId", "lastMessageAt"])
    .index("by_teamAId", ["teamAId"])
    .index("by_teamBId", ["teamBId"]),

  messages: defineTable({
    ...legacy,
    threadId: v.id("threads"),
    leagueId: v.id("leagues"),
    senderTeamId: v.id("teams"),
    runId: v.optional(v.id("runs")),
    stepIndex: v.optional(v.number()),
    configVersionId: v.optional(v.id("config_versions")),
    windowId: v.optional(v.id("windows")),
    body: v.string(),
    flags: v.optional(contentFlags),
    createdAt: v.number(),
  })
    .index("by_threadId_createdAt", ["threadId", "createdAt"])
    .index("by_leagueId_createdAt", ["leagueId", "createdAt"])
    .index("by_runId", ["runId"]),

  forum_posts: defineTable({
    ...legacy,
    leagueId: v.id("leagues"),
    teamId: v.optional(v.id("teams")),
    runId: v.optional(v.id("runs")),
    stepIndex: v.optional(v.number()),
    title: v.string(),
    body: v.string(),
    flair: forumFlair,
    /** Denormalized net votes, updated in the vote mutation. */
    score: v.number(),
    commentCount: v.number(),
    hidden: v.boolean(),
    flags: v.optional(contentFlags),
    createdAt: v.number(),
  })
    .index("by_leagueId_createdAt", ["leagueId", "createdAt"])
    .index("by_leagueId_score", ["leagueId", "score"])
    .index("by_leagueId_flair_createdAt", ["leagueId", "flair", "createdAt"])
    .index("by_teamId_createdAt", ["teamId", "createdAt"]),

  forum_comments: defineTable({
    ...legacy,
    postId: v.id("forum_posts"),
    leagueId: v.id("leagues"),
    parentId: v.optional(v.id("forum_comments")),
    teamId: v.optional(v.id("teams")),
    runId: v.optional(v.id("runs")),
    stepIndex: v.optional(v.number()),
    body: v.string(),
    score: v.number(),
    hidden: v.boolean(),
    flags: v.optional(contentFlags),
    createdAt: v.number(),
  })
    .index("by_postId_createdAt", ["postId", "createdAt"])
    .index("by_teamId_createdAt", ["teamId", "createdAt"]),

  forum_votes: defineTable({
    ...legacy,
    leagueId: v.id("leagues"),
    targetType: voteTargetType,
    targetId: v.string(),
    voterUserId: v.optional(v.id("users")),
    voterTeamId: v.optional(v.id("teams")),
    direction: v.number(),
  })
    .index("by_targetType_targetId_voterUserId", ["targetType", "targetId", "voterUserId"])
    .index("by_targetType_targetId_voterTeamId", ["targetType", "targetId", "voterTeamId"]),

  // ---- cost ledger & rollups --------------------------------------------------

  /** Append-only. Written ONLY by internal.ledger.recordStep. */
  usage_events: defineTable({
    ...legacy,
    runId: v.id("runs"),
    stepIndex: v.number(),
    leagueId: v.id("leagues"),
    teamId: v.optional(v.id("teams")),
    season: v.number(),
    weekNo: v.number(),
    modelId: v.string(),
    provider: v.string(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    cachedInputTokens: v.number(),
    reasoningTokens: v.number(),
    latencyMs: v.optional(v.number()),
    computedCostUsd: v.number(),
    gatewayCostUsd: v.optional(v.number()),
    /** The figure rollups use: gateway when present, else computed. */
    costUsd: v.number(),
    correctsEventId: v.optional(v.id("usage_events")),
    createdAt: v.number(),
  })
    .index("by_runId_stepIndex", ["runId", "stepIndex"])
    .index("by_teamId_createdAt", ["teamId", "createdAt"])
    .index("by_leagueId_createdAt", ["leagueId", "createdAt"])
    .index("by_teamId_season_weekNo", ["teamId", "season", "weekNo"])
    .index("by_leagueId_season_weekNo", ["leagueId", "season", "weekNo"]),

  model_prices: defineTable({
    ...legacy,
    modelId: v.string(),
    provider: v.string(),
    displayName: v.string(),
    inputPerM: v.number(),
    outputPerM: v.number(),
    cachedInputPerM: v.optional(v.number()),
    reasoningPerM: v.optional(v.number()),
    supportsReasoning: v.boolean(),
    effectiveFrom: v.number(),
  }).index("by_modelId_effectiveFrom", ["modelId", "effectiveFrom"]),

  budgets: defineTable({
    ...legacy,
    leagueId: v.id("leagues"),
    teamId: v.optional(v.id("teams")),
    period: budgetPeriod,
    tokenCap: v.optional(v.number()),
    usdCap: v.optional(v.number()),
  }).index("by_leagueId_teamId_period", ["leagueId", "teamId", "period"]),

  team_week_rollups: defineTable({
    leagueId: v.id("leagues"),
    teamId: v.id("teams"),
    season: v.number(),
    weekNo: v.number(),
    ...rollupCounters,
  })
    .index("by_teamId_season_weekNo", ["teamId", "season", "weekNo"])
    .index("by_leagueId_season_weekNo", ["leagueId", "season", "weekNo"]),

  /** `leagueId` undefined = cross-league (benchmark) row; set = per-league dashboard row. */
  model_week_rollups: defineTable({
    leagueId: v.optional(v.id("leagues")),
    modelId: v.string(),
    provider: v.string(),
    season: v.number(),
    weekNo: v.number(),
    ...rollupCounters,
  })
    .index("by_modelId_season_weekNo", ["modelId", "season", "weekNo"])
    .index("by_leagueId_modelId_season_weekNo", ["leagueId", "modelId", "season", "weekNo"])
    .index("by_leagueId_season_weekNo", ["leagueId", "season", "weekNo"]),

  league_week_rollups: defineTable({
    leagueId: v.id("leagues"),
    season: v.number(),
    weekNo: v.number(),
    ...rollupCounters,
    /** Once-per-league-week guard for the USD hard-cap commissioner notice. */
    capNotifiedAt: v.optional(v.number()),
  }).index("by_leagueId_season_weekNo", ["leagueId", "season", "weekNo"]),

  /** Written by the window-close mutation (PRD 5.12 process metrics). */
  team_week_metrics: defineTable({
    leagueId: v.id("leagues"),
    teamId: v.id("teams"),
    season: v.number(),
    weekNo: v.number(),
    actualPoints: v.optional(v.number()),
    optimalPoints: v.optional(v.number()),
    lineupEfficiency: v.optional(v.number()),
    projectionCapture: v.optional(v.number()),
    pointsLeftOnBench: v.optional(v.number()),
    waiverValue: v.optional(v.number()),
    tradeDelta: v.optional(v.number()),
    invalidActionRate: v.optional(v.number()),
    runCount: v.number(),
    fallbackCount: v.number(),
    updatedAt: v.number(),
  })
    .index("by_teamId_season_weekNo", ["teamId", "season", "weekNo"])
    .index("by_leagueId_season_weekNo", ["leagueId", "season", "weekNo"]),

  /** Ingestion bookkeeping so the cron never re-pulls an unchanged vintage. */
  ingest_state: defineTable({
    key: v.string(),
    lastRunAt: v.number(),
    lastEffectiveAt: v.optional(v.number()),
    lastCount: v.number(),
    lastError: v.optional(v.string()),
  }).index("by_key", ["key"]),
});
