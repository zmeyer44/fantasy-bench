/**
 * Player universe and the normalized provider data that hangs off it.
 *
 * Sleeper is the canonical ID space (`players.sleeperId`); every other feed is
 * joined in through `sleeper_id` / `gsis_id`. Provider rows are effective-dated
 * so a snapshot can pin an exact vintage of projections / news / designations.
 */
import { relations } from "drizzle-orm";
import {
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

export const positionEnum = pgEnum("position", ["QB", "RB", "WR", "TE", "K", "DEF"]);
export type Position = (typeof positionEnum.enumValues)[number];

/** Raw Sleeper payload, kept verbatim so we can re-derive fields without refetching. */
export type PlayerRaw = Record<string, unknown>;

export const players = pgTable(
  "players",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sleeperId: text("sleeper_id").notNull().unique(),
    gsisId: text("gsis_id"),
    fullName: text("full_name").notNull(),
    firstName: text("first_name"),
    lastName: text("last_name"),
    position: positionEnum("position").notNull(),
    nflTeam: text("nfl_team"),
    status: text("status"),
    injuryStatus: text("injury_status"),
    injuryBodyPart: text("injury_body_part"),
    injuryNotes: text("injury_notes"),
    byeWeek: integer("bye_week"),
    yearsExp: integer("years_exp"),
    age: integer("age"),
    searchRank: integer("search_rank"),
    fantasyPositions: text("fantasy_positions").array(),
    raw: jsonb("raw").$type<PlayerRaw>(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("players_position_idx").on(t.position),
    index("players_nfl_team_idx").on(t.nflTeam),
    index("players_search_rank_idx").on(t.searchRank),
    index("players_full_name_idx").on(t.fullName),
  ],
);

export const nflGames = pgTable(
  "nfl_games",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    season: integer("season").notNull(),
    week: integer("week").notNull(),
    gameId: text("game_id").notNull().unique(),
    homeTeam: text("home_team").notNull(),
    awayTeam: text("away_team").notNull(),
    kickoffAt: timestamp("kickoff_at", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("scheduled"),
    homeScore: integer("home_score"),
    awayScore: integer("away_score"),
  },
  (t) => [
    index("nfl_games_season_week_idx").on(t.season, t.week),
    index("nfl_games_kickoff_idx").on(t.kickoffAt),
  ],
);

/** Loosely-typed stat bag; keys follow the source's naming (Sleeper/nflverse). */
export type StatLine = Record<string, number | string | null>;

export const playerStatsWeekly = pgTable(
  "player_stats_weekly",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    season: integer("season").notNull(),
    week: integer("week").notNull(),
    source: text("source").notNull(),
    stats: jsonb("stats").$type<StatLine>().notNull().default({}),
    fantasyPointsPpr: numeric("fantasy_points_ppr", {
      precision: 10,
      scale: 2,
      mode: "number",
    }),
    fantasyPointsHalf: numeric("fantasy_points_half", {
      precision: 10,
      scale: 2,
      mode: "number",
    }),
    fantasyPointsStd: numeric("fantasy_points_std", {
      precision: 10,
      scale: 2,
      mode: "number",
    }),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("player_stats_weekly_unique").on(t.playerId, t.season, t.week, t.source),
    index("player_stats_weekly_season_week_idx").on(t.season, t.week),
  ],
);

export const playerProjections = pgTable(
  "player_projections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    season: integer("season").notNull(),
    week: integer("week").notNull(),
    source: text("source").notNull(),
    projectedPointsPpr: numeric("projected_points_ppr", {
      precision: 10,
      scale: 2,
      mode: "number",
    }),
    projectedPointsHalf: numeric("projected_points_half", {
      precision: 10,
      scale: 2,
      mode: "number",
    }),
    projectedPointsStd: numeric("projected_points_std", {
      precision: 10,
      scale: 2,
      mode: "number",
    }),
    stats: jsonb("stats").$type<StatLine>().notNull().default({}),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Snapshots pin "latest projection as of taken_at" — this is the read path.
    index("player_projections_vintage_idx").on(t.season, t.week, t.source, t.effectiveAt),
    index("player_projections_player_idx").on(t.playerId, t.season, t.week),
  ],
);

export type NewsRaw = Record<string, unknown>;

export const newsItems = pgTable(
  "news_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    playerId: uuid("player_id").references(() => players.id, { onDelete: "set null" }),
    source: text("source").notNull(),
    headline: text("headline").notNull(),
    body: text("body"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull().defaultNow(),
    url: text("url"),
    raw: jsonb("raw").$type<NewsRaw>(),
  },
  (t) => [
    index("news_items_effective_idx").on(t.effectiveAt),
    index("news_items_player_idx").on(t.playerId, t.effectiveAt),
  ],
);

export const injuryDesignations = pgTable(
  "injury_designations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    season: integer("season").notNull(),
    week: integer("week").notNull(),
    /** Questionable | Doubtful | Out | IR | Inactive | … (source vocabulary). */
    designation: text("designation").notNull(),
    practiceStatus: text("practice_status"),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull().defaultNow(),
    source: text("source").notNull(),
  },
  (t) => [
    index("injury_designations_player_idx").on(t.playerId, t.season, t.week, t.effectiveAt),
    index("injury_designations_vintage_idx").on(t.season, t.week, t.effectiveAt),
  ],
);

export const playersRelations = relations(players, ({ many }) => ({
  statsWeekly: many(playerStatsWeekly),
  projections: many(playerProjections),
  news: many(newsItems),
  injuryDesignations: many(injuryDesignations),
}));

export const playerStatsWeeklyRelations = relations(playerStatsWeekly, ({ one }) => ({
  player: one(players, { fields: [playerStatsWeekly.playerId], references: [players.id] }),
}));

export const playerProjectionsRelations = relations(playerProjections, ({ one }) => ({
  player: one(players, { fields: [playerProjections.playerId], references: [players.id] }),
}));

export const newsItemsRelations = relations(newsItems, ({ one }) => ({
  player: one(players, { fields: [newsItems.playerId], references: [players.id] }),
}));

export const injuryDesignationsRelations = relations(injuryDesignations, ({ one }) => ({
  player: one(players, { fields: [injuryDesignations.playerId], references: [players.id] }),
}));
