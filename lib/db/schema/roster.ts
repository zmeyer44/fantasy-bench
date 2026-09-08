/**
 * Roster state: who is on a team, what the weekly lineup is, and the unified
 * transaction feed.
 *
 * NOTE on lineup history: `lineups` IS the history table. Every `set_lineup`
 * commit inserts a new row with `version = max(version) + 1` for
 * `(team_id, week_no)` rather than updating in place, so the PRD's
 * "lineup_history" is satisfied by querying `lineups` ordered by `version`.
 * The live lineup is the highest version for the week. Rows are append-only.
 */
import { relations } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { leagues, teams } from "./league";
import { players } from "./players";
import { runs } from "./runs";

export const acquisitionEnum = pgEnum("acquired_via", [
  "draft",
  "waiver",
  "free_agent",
  "trade",
]);
export const lineupSourceEnum = pgEnum("lineup_source", [
  "agent",
  "autopilot",
  "carryover",
  "draft_default",
]);
export const transactionTypeEnum = pgEnum("transaction_type", ["add", "drop", "trade", "draft"]);

export const rosterSlots = pgTable(
  "roster_slots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull().defaultNow(),
    acquiredVia: acquisitionEnum("acquired_via").notNull().default("free_agent"),
  },
  (t) => [
    uniqueIndex("roster_slots_team_player_unique").on(t.teamId, t.playerId),
    // "Is this player rostered anywhere in the league?" — the free-agent check.
    index("roster_slots_player_idx").on(t.playerId),
  ],
);

/** One entry per starting/bench slot for the week. */
export type LineupSlot = { slot: string; playerId: string | null };

export const lineups = pgTable(
  "lineups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    weekNo: integer("week_no").notNull(),
    version: integer("version").notNull().default(1),
    slots: jsonb("slots").$type<LineupSlot[]>().notNull().default([]),
    setByRunId: uuid("set_by_run_id").references(() => runs.id, { onDelete: "set null" }),
    source: lineupSourceEnum("source").notNull().default("agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("lineups_team_week_version_unique").on(t.teamId, t.weekNo, t.version),
    index("lineups_team_week_idx").on(t.teamId, t.weekNo),
    index("lineups_run_idx").on(t.setByRunId),
  ],
);

/** Unified league activity feed. Append-only. */
export const transactions = pgTable(
  "transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    type: transactionTypeEnum("type").notNull(),
    weekNo: integer("week_no"),
    playerId: uuid("player_id").references(() => players.id, { onDelete: "set null" }),
    relatedTeamId: uuid("related_team_id").references(() => teams.id, { onDelete: "set null" }),
    /** Soft reference to `trades.id` — declared in transactions.ts to avoid a module cycle. */
    tradeId: uuid("trade_id"),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("transactions_league_created_idx").on(t.leagueId, t.createdAt),
    index("transactions_team_created_idx").on(t.teamId, t.createdAt),
    index("transactions_trade_idx").on(t.tradeId),
  ],
);

export const rosterSlotsRelations = relations(rosterSlots, ({ one }) => ({
  team: one(teams, { fields: [rosterSlots.teamId], references: [teams.id] }),
  player: one(players, { fields: [rosterSlots.playerId], references: [players.id] }),
}));

export const lineupsRelations = relations(lineups, ({ one }) => ({
  team: one(teams, { fields: [lineups.teamId], references: [teams.id] }),
  setByRun: one(runs, { fields: [lineups.setByRunId], references: [runs.id] }),
}));

export const transactionsRelations = relations(transactions, ({ one }) => ({
  league: one(leagues, { fields: [transactions.leagueId], references: [leagues.id] }),
  team: one(teams, { fields: [transactions.teamId], references: [teams.id] }),
  player: one(players, { fields: [transactions.playerId], references: [players.id] }),
  relatedTeam: one(teams, {
    fields: [transactions.relatedTeamId],
    references: [teams.id],
    relationName: "related_team",
  }),
  run: one(runs, { fields: [transactions.runId], references: [runs.id] }),
}));
