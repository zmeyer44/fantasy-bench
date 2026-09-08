/**
 * Leagues, their rule set, membership, teams, the week grid, and matchups.
 *
 * `league_rules` is 1:1 with a league and holds everything a commissioner can
 * turn: scoring, roster shape, budgets, transparency, rate limits, edit lock.
 */
import { relations } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { user } from "./auth";

export const leagueStatusEnum = pgEnum("league_status", [
  "setup",
  "drafting",
  "in_season",
  "complete",
]);
export const draftTypeEnum = pgEnum("draft_type", ["snake", "auction"]);
export const scoringPresetEnum = pgEnum("scoring_preset", ["ppr", "half_ppr", "standard"]);
export const transparencyModeEnum = pgEnum("transparency_mode", ["live", "delayed"]);
export const injectionPolicyEnum = pgEnum("injection_policy", ["permitted", "prohibited"]);
export const leagueRoleEnum = pgEnum("league_role", ["commissioner", "owner", "spectator"]);
export const weekStatusEnum = pgEnum("week_status", ["upcoming", "active", "complete"]);

export const leagues = pgTable(
  "leagues",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    commissionerUserId: text("commissioner_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    season: integer("season").notNull(),
    teamCount: integer("team_count").notNull(),
    isPublic: boolean("is_public").notNull().default(true),
    status: leagueStatusEnum("status").notNull().default("setup"),
    draftType: draftTypeEnum("draft_type").notNull().default("snake"),
    draftScheduledAt: timestamp("draft_scheduled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("leagues_commissioner_idx").on(t.commissionerUserId),
    index("leagues_status_idx").on(t.status),
  ],
);

/** Starting-slot shape, e.g. `{ QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DEF: 1, BENCH: 6 }`. */
export type RosterSlots = Record<string, number>;

/** Weekly recurring config-edit window, Eastern. See `lib/time.ts`. */
export type EditLockConfig = {
  unlockDay: string;
  unlockTime: string;
  lockDay: string;
  lockTime: string;
};

/** Per-window-label overrides of the default schedule templates (Eastern). */
export type WindowOverrides = Record<
  string,
  {
    enabled?: boolean;
    opensDay?: string;
    opensTime?: string;
    closesDay?: string;
    closesTime?: string;
    submissionLeadMinutes?: number;
    rounds?: number;
  }
>;

export const DEFAULT_ROSTER_SLOTS: RosterSlots = {
  QB: 1,
  RB: 2,
  WR: 2,
  TE: 1,
  FLEX: 1,
  K: 1,
  DEF: 1,
  BENCH: 6,
};

export const DEFAULT_EDIT_LOCK_CONFIG: EditLockConfig = {
  unlockDay: "tue",
  unlockTime: "06:00",
  lockDay: "wed",
  lockTime: "03:00",
};

export const leagueRules = pgTable("league_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  leagueId: uuid("league_id")
    .notNull()
    .unique()
    .references(() => leagues.id, { onDelete: "cascade" }),

  // Scoring & roster shape
  scoringPreset: scoringPresetEnum("scoring_preset").notNull().default("ppr"),
  superflex: boolean("superflex").notNull().default(false),
  tePremium: boolean("te_premium").notNull().default(false),
  rosterSlots: jsonb("roster_slots").$type<RosterSlots>().notNull().default(DEFAULT_ROSTER_SLOTS),

  // League format
  faabBudget: integer("faab_budget").notNull().default(100),
  playoffTeams: integer("playoff_teams").notNull().default(6),
  playoffStartWeek: integer("playoff_start_week").notNull().default(15),
  regularSeasonWeeks: integer("regular_season_weeks").notNull().default(14),
  seasonWeeks: integer("season_weeks").notNull().default(17),

  // Visibility & conduct
  transparencyMode: transparencyModeEnum("transparency_mode").notNull().default("live"),
  injectionPolicy: injectionPolicyEnum("injection_policy").notNull().default("permitted"),

  // Models & budgets
  modelAllowlist: jsonb("model_allowlist").$type<string[]>().notNull().default([]),
  fallbackModelId: text("fallback_model_id"),
  weeklyTokenCapPerTeam: integer("weekly_token_cap_per_team"),
  leagueUsdHardCap: numeric("league_usd_hard_cap", {
    precision: 14,
    scale: 8,
    mode: "number",
  }),

  // Harness bounds
  contextCharLimit: integer("context_char_limit").notNull().default(8000),
  maxStepsCap: integer("max_steps_cap").notNull().default(30),

  // Windows & the config edit lock (Eastern)
  editLock: jsonb("edit_lock").$type<EditLockConfig>().notNull().default(DEFAULT_EDIT_LOCK_CONFIG),
  windowOverrides: jsonb("window_overrides").$type<WindowOverrides>(),

  // Trades
  tradeReviewHours: integer("trade_review_hours").notNull().default(24),
  fairnessFloor: numeric("fairness_floor", { precision: 6, scale: 3, mode: "number" })
    .notNull()
    .default(0.6),
  antiChurnWeeks: integer("anti_churn_weeks").notNull().default(3),
  maxOpenProposals: integer("max_open_proposals").notNull().default(3),
  maxMessagesPerRun: integer("max_messages_per_run").notNull().default(6),
  maxThreadsPerWindow: integer("max_threads_per_window").notNull().default(4),

  // Forum rate limits
  forumPostsPerDay: integer("forum_posts_per_day").notNull().default(2),
  forumCommentsPerDay: integer("forum_comments_per_day").notNull().default(6),

  safetyAutopilot: boolean("safety_autopilot").notNull().default(true),
  /** Set when the draft begins; rules become immutable except budgets/moderation. */
  rulesLockedAt: timestamp("rules_locked_at", { withTimezone: true }),
});

export const leagueMembers = pgTable(
  "league_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: leagueRoleEnum("role").notNull().default("owner"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("league_members_league_user_unique").on(t.leagueId, t.userId),
    index("league_members_user_idx").on(t.userId),
  ],
);

export const teams = pgTable(
  "teams",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id").references(() => user.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    abbreviation: text("abbreviation").notNull(),
    faabRemaining: integer("faab_remaining").notNull().default(100),
    waiverPriority: integer("waiver_priority").notNull().default(1),
    karma: integer("karma").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("teams_league_name_unique").on(t.leagueId, t.name),
    index("teams_league_idx").on(t.leagueId),
    index("teams_owner_idx").on(t.ownerUserId),
  ],
);

export const weeks = pgTable(
  "weeks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    weekNo: integer("week_no").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    isPlayoff: boolean("is_playoff").notNull().default(false),
    status: weekStatusEnum("status").notNull().default("upcoming"),
  },
  (t) => [
    uniqueIndex("weeks_league_week_unique").on(t.leagueId, t.weekNo),
    index("weeks_starts_at_idx").on(t.startsAt),
  ],
);

export const matchups = pgTable(
  "matchups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    weekNo: integer("week_no").notNull(),
    homeTeamId: uuid("home_team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    awayTeamId: uuid("away_team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    homeScore: numeric("home_score", { precision: 10, scale: 2, mode: "number" })
      .notNull()
      .default(0),
    awayScore: numeric("away_score", { precision: 10, scale: 2, mode: "number" })
      .notNull()
      .default(0),
    isFinal: boolean("is_final").notNull().default(false),
  },
  (t) => [
    index("matchups_league_week_idx").on(t.leagueId, t.weekNo),
    index("matchups_home_team_idx").on(t.homeTeamId),
    index("matchups_away_team_idx").on(t.awayTeamId),
  ],
);

/** Per-team, per-week standings rollup. Recomputed when a week is finalized. */
export const teamResults = pgTable(
  "team_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    weekNo: integer("week_no").notNull(),
    pointsFor: numeric("points_for", { precision: 10, scale: 2, mode: "number" })
      .notNull()
      .default(0),
    pointsAgainst: numeric("points_against", { precision: 10, scale: 2, mode: "number" })
      .notNull()
      .default(0),
    won: boolean("won").notNull().default(false),
    lost: boolean("lost").notNull().default(false),
    tied: boolean("tied").notNull().default(false),
  },
  (t) => [uniqueIndex("team_results_team_week_unique").on(t.teamId, t.weekNo)],
);

export const leaguesRelations = relations(leagues, ({ one, many }) => ({
  commissioner: one(user, { fields: [leagues.commissionerUserId], references: [user.id] }),
  rules: one(leagueRules, { fields: [leagues.id], references: [leagueRules.leagueId] }),
  members: many(leagueMembers),
  teams: many(teams),
  weeks: many(weeks),
  matchups: many(matchups),
}));

export const leagueRulesRelations = relations(leagueRules, ({ one }) => ({
  league: one(leagues, { fields: [leagueRules.leagueId], references: [leagues.id] }),
}));

export const leagueMembersRelations = relations(leagueMembers, ({ one }) => ({
  league: one(leagues, { fields: [leagueMembers.leagueId], references: [leagues.id] }),
  user: one(user, { fields: [leagueMembers.userId], references: [user.id] }),
}));

export const teamsRelations = relations(teams, ({ one, many }) => ({
  league: one(leagues, { fields: [teams.leagueId], references: [leagues.id] }),
  owner: one(user, { fields: [teams.ownerUserId], references: [user.id] }),
  results: many(teamResults),
}));

export const weeksRelations = relations(weeks, ({ one }) => ({
  league: one(leagues, { fields: [weeks.leagueId], references: [leagues.id] }),
}));

export const matchupsRelations = relations(matchups, ({ one }) => ({
  league: one(leagues, { fields: [matchups.leagueId], references: [leagues.id] }),
  homeTeam: one(teams, { fields: [matchups.homeTeamId], references: [teams.id] }),
  awayTeam: one(teams, { fields: [matchups.awayTeamId], references: [teams.id] }),
}));

export const teamResultsRelations = relations(teamResults, ({ one }) => ({
  team: one(teams, { fields: [teamResults.teamId], references: [teams.id] }),
}));
