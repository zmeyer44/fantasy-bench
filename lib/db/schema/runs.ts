/**
 * Decision windows, snapshots, and the run/step/action trace.
 *
 * `runs` doubles as the work queue: the tick claims a row with a conditional
 * UPDATE and holds it under a lease. `run_steps` and `run_actions` are
 * append-only — never UPDATE them except to stamp `run_actions.committed_at`.
 */
import { relations } from "drizzle-orm";
import {
  type AnyPgColumn,
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

import type { SnapshotDigest, SnapshotPayload } from "@/lib/snapshot/types";

import { configVersions } from "./config";
import { leagues, teams } from "./league";

export const windowTypeEnum = pgEnum("window_type", [
  "draft",
  "waiver",
  "trade",
  "lineup",
  "forum",
  "commissioner",
]);
export const windowStatusEnum = pgEnum("window_status", [
  "scheduled",
  "open",
  "closing",
  "closed",
]);
export const runKindEnum = pgEnum("run_kind", ["team", "commissioner"]);
export const runStatusEnum = pgEnum("run_status", [
  "pending",
  "running",
  "succeeded",
  "partial",
  "failed",
  "timed_out",
  "fallback",
  "skipped",
]);

/**
 * Window-type-specific parameters. Lineup windows carry the game days they may
 * touch; draft windows carry the pick on the clock; trade windows carry the
 * negotiation round budget.
 */
export type WindowScope = {
  gameDays?: string[];
  slots?: string[];
  pickNo?: number;
  onTheClockTeamId?: string;
  nominationTeamId?: string;
  rounds?: number;
  [key: string]: unknown;
};

// Snapshot shapes are the cross-package contract in lib/snapshot/types.ts.
export type { SnapshotDigest, SnapshotPayload };

export const windows = pgTable(
  "windows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    type: windowTypeEnum("type").notNull(),
    /** Template key, e.g. `lineup_sun_early`, `waiver`, `trade_a`, `draft_pick`. */
    label: text("label").notNull(),
    weekNo: integer("week_no"),
    /** Negotiation / auction rounds are modeled as repeated windows. */
    roundNo: integer("round_no").notNull().default(1),
    opensAt: timestamp("opens_at", { withTimezone: true }).notNull(),
    submissionDeadlineAt: timestamp("submission_deadline_at", { withTimezone: true }).notNull(),
    closesAt: timestamp("closes_at", { withTimezone: true }).notNull(),
    snapshotId: uuid("snapshot_id").references((): AnyPgColumn => snapshots.id, {
      onDelete: "set null",
    }),
    status: windowStatusEnum("status").notNull().default("scheduled"),
    scope: jsonb("scope").$type<WindowScope>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("windows_league_status_idx").on(t.leagueId, t.status),
    index("windows_opens_at_idx").on(t.opensAt),
    index("windows_league_week_idx").on(t.leagueId, t.weekNo, t.type),
  ],
);

export const snapshots = pgTable(
  "snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    windowId: uuid("window_id").references((): AnyPgColumn => windows.id, {
      onDelete: "set null",
    }),
    takenAt: timestamp("taken_at", { withTimezone: true }).notNull().defaultNow(),
    season: integer("season").notNull(),
    weekNo: integer("week_no"),
    digest: jsonb("digest").$type<SnapshotDigest>().notNull(),
    payload: jsonb("payload").$type<SnapshotPayload>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("snapshots_league_taken_idx").on(t.leagueId, t.takenAt),
    index("snapshots_window_idx").on(t.windowId),
  ],
);

/** What the runtime substituted when the primary path failed. */
export type FallbackApplied = {
  kind: "safety_autopilot" | "fallback_model" | "carryover_lineup" | "budget_exhausted";
  detail?: string;
  fromModelId?: string;
  toModelId?: string;
};

export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    windowId: uuid("window_id")
      .notNull()
      .references(() => windows.id, { onDelete: "cascade" }),
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "cascade" }),
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    configVersionId: uuid("config_version_id").references(() => configVersions.id, {
      onDelete: "set null",
    }),
    modelId: text("model_id").notNull(),
    kind: runKindEnum("kind").notNull().default("team"),
    status: runStatusEnum("status").notNull().default("pending"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    /** Short machine-ish summary, e.g. `lineup_set`, `3_claims_submitted`. */
    outcome: text("outcome"),
    /** The agent's own public one-paragraph explanation (`set_rationale`). */
    rationale: text("rationale"),
    totalCostUsd: numeric("total_cost_usd", { precision: 14, scale: 8, mode: "number" })
      .notNull()
      .default(0),
    totalInputTokens: integer("total_input_tokens").notNull().default(0),
    totalOutputTokens: integer("total_output_tokens").notNull().default(0),
    stepCount: integer("step_count").notNull().default(0),
    error: text("error"),
    fallbackApplied: jsonb("fallback_applied").$type<FallbackApplied>(),
    attempt: integer("attempt").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("runs_window_status_idx").on(t.windowId, t.status),
    index("runs_team_created_idx").on(t.teamId, t.createdAt),
    // The tick's reaper: find claimed runs whose lease has expired.
    index("runs_status_lease_idx").on(t.status, t.leaseExpiresAt),
    index("runs_league_created_idx").on(t.leagueId, t.createdAt),
  ],
);

/** AI SDK shapes are stored verbatim; typed loosely so SDK upgrades don't break reads. */
export type StepMessages = unknown[];
export type StepToolCalls = unknown[];
export type StepToolResults = unknown[];
export type StepUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  [key: string]: unknown;
};

/** Append-only. One row per model call within a run. */
export const runSteps = pgTable(
  "run_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    stepIndex: integer("step_index").notNull(),
    modelId: text("model_id").notNull(),
    text: text("text"),
    reasoning: text("reasoning"),
    messages: jsonb("messages").$type<StepMessages>().notNull().default([]),
    toolCalls: jsonb("tool_calls").$type<StepToolCalls>().notNull().default([]),
    toolResults: jsonb("tool_results").$type<StepToolResults>().notNull().default([]),
    usage: jsonb("usage").$type<StepUsage>().notNull().default({}),
    finishReason: text("finish_reason"),
    latencyMs: integer("latency_ms"),
    costUsd: numeric("cost_usd", { precision: 14, scale: 8, mode: "number" })
      .notNull()
      .default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("run_steps_run_step_unique").on(t.runId, t.stepIndex)],
);

export type ValidationResult = { ok: boolean; errors?: string[] };

/**
 * Append-only idempotency + audit ledger for write tools. `(run_id, tool_call_id)`
 * is the idempotency key: a replayed tool call finds its row and does not re-commit.
 */
export const runActions = pgTable(
  "run_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    toolCallId: text("tool_call_id").notNull(),
    stepIndex: integer("step_index").notNull(),
    /** Tool name, e.g. `set_lineup`, `propose_trade`, `post_to_forum`. */
    actionType: text("action_type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    validationResult: jsonb("validation_result")
      .$type<ValidationResult>()
      .notNull()
      .default({ ok: true }),
    committedAt: timestamp("committed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("run_actions_run_tool_call_unique").on(t.runId, t.toolCallId),
    index("run_actions_run_step_idx").on(t.runId, t.stepIndex),
  ],
);

export const windowsRelations = relations(windows, ({ one, many }) => ({
  league: one(leagues, { fields: [windows.leagueId], references: [leagues.id] }),
  snapshot: one(snapshots, {
    fields: [windows.snapshotId],
    references: [snapshots.id],
    relationName: "window_snapshot",
  }),
  runs: many(runs),
}));

export const snapshotsRelations = relations(snapshots, ({ one }) => ({
  league: one(leagues, { fields: [snapshots.leagueId], references: [leagues.id] }),
  window: one(windows, {
    fields: [snapshots.windowId],
    references: [windows.id],
    relationName: "snapshot_window",
  }),
}));

export const runsRelations = relations(runs, ({ one, many }) => ({
  window: one(windows, { fields: [runs.windowId], references: [windows.id] }),
  team: one(teams, { fields: [runs.teamId], references: [teams.id] }),
  league: one(leagues, { fields: [runs.leagueId], references: [leagues.id] }),
  configVersion: one(configVersions, {
    fields: [runs.configVersionId],
    references: [configVersions.id],
  }),
  steps: many(runSteps),
  actions: many(runActions),
}));

export const runStepsRelations = relations(runSteps, ({ one }) => ({
  run: one(runs, { fields: [runSteps.runId], references: [runs.id] }),
}));

export const runActionsRelations = relations(runActions, ({ one }) => ({
  run: one(runs, { fields: [runActions.runId], references: [runs.id] }),
}));
