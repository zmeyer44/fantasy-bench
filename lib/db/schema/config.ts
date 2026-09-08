/**
 * Agent configuration: the only thing a human owner may touch.
 *
 * `agent_configs` is the mutable pointer (one per team); `config_versions` are
 * immutable snapshots. Every run records the version it used. Edits made while
 * the league's edit lock is closed land in `pending_version_id` and are applied
 * at the next unlock.
 */
import { relations } from "drizzle-orm";
import {
  type AnyPgColumn,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { user } from "./auth";
import { teams } from "./league";

export const skillVisibilityEnum = pgEnum("skill_visibility", ["public", "private"]);

/** Reasoning effort, where the model supports it. `null` = not requested. */
export type ReasoningEffort = "low" | "medium" | "high";

/**
 * Owner-tunable runtime knobs, bounded by `league_rules`.
 *
 * `reasoningEffort` accepts `null` as well as `undefined` so a saved version can
 * record "explicitly off" — `lib/services/config` normalises both to `null`.
 */
export type HarnessSettings = {
  maxSteps: number;
  tokenBudget: number;
  temperature: number;
  reasoningEffort?: ReasoningEffort | null;
  /** Ask the model for an explicit plan step before it may call tools. */
  deliberateMode: boolean;
};

/**
 * The single source of truth for default harness settings. Used as the column
 * default, by `createDefaultAgentConfig` for version 1, and by the console's
 * `parseHarness` normaliser (which re-exports it as `DEFAULT_HARNESS_SETTINGS`).
 */
export const DEFAULT_HARNESS: HarnessSettings = {
  maxSteps: 12,
  tokenBudget: 60_000,
  temperature: 0.3,
  reasoningEffort: null,
  deliberateMode: false,
};

export const agentConfigs = pgTable("agent_configs", {
  id: uuid("id").primaryKey().defaultRandom(),
  teamId: uuid("team_id")
    .notNull()
    .unique()
    .references(() => teams.id, { onDelete: "cascade" }),
  currentVersionId: uuid("current_version_id").references((): AnyPgColumn => configVersions.id, {
    onDelete: "set null",
  }),
  /** Set when an edit is saved during the lock; applied at the next unlock. */
  pendingVersionId: uuid("pending_version_id").references((): AnyPgColumn => configVersions.id, {
    onDelete: "set null",
  }),
  /** Owner scratchpad appended to context on the next save (see PRD 5.5). */
  noteToAgent: text("note_to_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Immutable. Never UPDATE a row here except to stamp `applied_at`. */
export const configVersions = pgTable(
  "config_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    configId: uuid("config_id")
      .notNull()
      .references((): AnyPgColumn => agentConfigs.id, { onDelete: "cascade" }),
    versionNo: integer("version_no").notNull(),
    contextMd: text("context_md").notNull().default(""),
    modelId: text("model_id").notNull(),
    harness: jsonb("harness").$type<HarnessSettings>().notNull().default(DEFAULT_HARNESS),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    /** When this version first became the live config. */
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    changeSummary: text("change_summary"),
  },
  (t) => [
    uniqueIndex("config_versions_config_version_unique").on(t.configId, t.versionNo),
    index("config_versions_created_idx").on(t.createdAt),
  ],
);

/** Markdown documents injected into agent context. The library is league-wide. */
export const skills = pgTable(
  "skills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    authorUserId: text("author_user_id").references(() => user.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    description: text("description").notNull().default(""),
    bodyMd: text("body_md").notNull(),
    visibility: skillVisibilityEnum("visibility").notNull().default("public"),
    /** Set when this skill was created with `forkSkill`; points at the original. */
    forkedFromSkillId: uuid("forked_from_skill_id").references((): AnyPgColumn => skills.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("skills_visibility_idx").on(t.visibility),
    index("skills_author_idx").on(t.authorUserId),
  ],
);

export const configVersionSkills = pgTable(
  "config_version_skills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    configVersionId: uuid("config_version_id")
      .notNull()
      .references(() => configVersions.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    /** Injection order within the prompt. */
    position: integer("position").notNull().default(0),
  },
  (t) => [
    uniqueIndex("config_version_skills_unique").on(t.configVersionId, t.skillId),
    index("config_version_skills_skill_idx").on(t.skillId),
  ],
);

export const agentConfigsRelations = relations(agentConfigs, ({ one, many }) => ({
  team: one(teams, { fields: [agentConfigs.teamId], references: [teams.id] }),
  currentVersion: one(configVersions, {
    fields: [agentConfigs.currentVersionId],
    references: [configVersions.id],
    relationName: "current_version",
  }),
  pendingVersion: one(configVersions, {
    fields: [agentConfigs.pendingVersionId],
    references: [configVersions.id],
    relationName: "pending_version",
  }),
  versions: many(configVersions, { relationName: "config_versions" }),
}));

export const configVersionsRelations = relations(configVersions, ({ one, many }) => ({
  config: one(agentConfigs, {
    fields: [configVersions.configId],
    references: [agentConfigs.id],
    relationName: "config_versions",
  }),
  createdBy: one(user, { fields: [configVersions.createdByUserId], references: [user.id] }),
  skills: many(configVersionSkills),
}));

export const skillsRelations = relations(skills, ({ one, many }) => ({
  author: one(user, { fields: [skills.authorUserId], references: [user.id] }),
  forkedFrom: one(skills, {
    fields: [skills.forkedFromSkillId],
    references: [skills.id],
    relationName: "skill_forks",
  }),
  forks: many(skills, { relationName: "skill_forks" }),
  configVersions: many(configVersionSkills),
}));

export const configVersionSkillsRelations = relations(configVersionSkills, ({ one }) => ({
  configVersion: one(configVersions, {
    fields: [configVersionSkills.configVersionId],
    references: [configVersions.id],
  }),
  skill: one(skills, { fields: [configVersionSkills.skillId], references: [skills.id] }),
}));
