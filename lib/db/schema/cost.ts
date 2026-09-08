/**
 * The ledger. `usage_events` is append-only and immutable: corrections are new
 * rows pointing at the row they correct via `corrects_event_id`.
 *
 * Cost is computed from `model_prices` (effective-dated) unless the gateway
 * reports a figure directly, in which case both are stored and the gateway
 * figure wins.
 */
import { relations } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { leagues, teams } from "./league";
import { runs } from "./runs";

export const budgetPeriodEnum = pgEnum("budget_period", ["week", "season"]);

export const usageEvents = pgTable(
  "usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    stepIndex: integer("step_index").notNull(),
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "set null" }),
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    modelId: text("model_id").notNull(),
    provider: text("provider").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    reasoningTokens: integer("reasoning_tokens").notNull().default(0),
    latencyMs: integer("latency_ms"),
    /** Computed from `model_prices`. */
    costUsd: numeric("cost_usd", { precision: 14, scale: 8, mode: "number" })
      .notNull()
      .default(0),
    /** As reported by the gateway, when available. Preferred for reconciliation. */
    gatewayCostUsd: numeric("gateway_cost_usd", { precision: 14, scale: 8, mode: "number" }),
    /** Set on a correcting row; points at the row being superseded. */
    correctsEventId: uuid("corrects_event_id").references((): AnyPgColumn => usageEvents.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("usage_events_team_created_idx").on(t.teamId, t.createdAt),
    index("usage_events_league_created_idx").on(t.leagueId, t.createdAt),
    index("usage_events_run_idx").on(t.runId, t.stepIndex),
    index("usage_events_model_created_idx").on(t.modelId, t.createdAt),
  ],
);

/**
 * Effective-dated price book, USD per million tokens. Look up the row with the
 * greatest `effective_from <= usage_event.created_at`.
 */
export const modelPrices = pgTable(
  "model_prices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Gateway ID, e.g. `anthropic/claude-sonnet-4.5`. Always pinned, never an alias. */
    modelId: text("model_id").notNull(),
    provider: text("provider").notNull(),
    displayName: text("display_name").notNull(),
    inputPerM: numeric("input_per_m", { precision: 14, scale: 8, mode: "number" }).notNull(),
    outputPerM: numeric("output_per_m", { precision: 14, scale: 8, mode: "number" }).notNull(),
    cachedInputPerM: numeric("cached_input_per_m", {
      precision: 14,
      scale: 8,
      mode: "number",
    }),
    reasoningPerM: numeric("reasoning_per_m", { precision: 14, scale: 8, mode: "number" }),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
    supportsReasoning: boolean("supports_reasoning").notNull().default(false),
  },
  (t) => [
    uniqueIndex("model_prices_model_effective_unique").on(t.modelId, t.effectiveFrom),
    index("model_prices_model_idx").on(t.modelId),
  ],
);

/** `team_id = null` means the budget applies to the whole league. */
export const budgets = pgTable(
  "budgets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "cascade" }),
    period: budgetPeriodEnum("period").notNull().default("week"),
    tokenCap: integer("token_cap"),
    usdCap: numeric("usd_cap", { precision: 14, scale: 8, mode: "number" }),
  },
  (t) => [index("budgets_league_idx").on(t.leagueId, t.teamId, t.period)],
);

/** Materialized per team-week (and per league when `team_id` is null). */
export const budgetRollups = pgTable(
  "budget_rollups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "cascade" }),
    weekNo: integer("week_no").notNull(),
    tokensUsed: integer("tokens_used").notNull().default(0),
    usdUsed: numeric("usd_used", { precision: 14, scale: 8, mode: "number" })
      .notNull()
      .default(0),
    runCount: integer("run_count").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("budget_rollups_league_team_week_unique").on(t.leagueId, t.teamId, t.weekNo),
    index("budget_rollups_league_week_idx").on(t.leagueId, t.weekNo),
  ],
);

export const usageEventsRelations = relations(usageEvents, ({ one }) => ({
  run: one(runs, { fields: [usageEvents.runId], references: [runs.id] }),
  team: one(teams, { fields: [usageEvents.teamId], references: [teams.id] }),
  league: one(leagues, { fields: [usageEvents.leagueId], references: [leagues.id] }),
}));

export const budgetsRelations = relations(budgets, ({ one }) => ({
  league: one(leagues, { fields: [budgets.leagueId], references: [leagues.id] }),
  team: one(teams, { fields: [budgets.teamId], references: [teams.id] }),
}));

export const budgetRollupsRelations = relations(budgetRollups, ({ one }) => ({
  league: one(leagues, { fields: [budgetRollups.leagueId], references: [leagues.id] }),
  team: one(teams, { fields: [budgetRollups.teamId], references: [teams.id] }),
}));
