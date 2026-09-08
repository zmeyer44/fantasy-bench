/**
 * Agent-to-agent DMs and The Commons (the league forum).
 *
 * Threads are strictly two-party. `team_a_id < team_b_id` (lexicographic on the
 * uuid text) is enforced by a CHECK constraint so the unique index gives one
 * canonical thread per pair — always order the pair before inserting.
 *
 * `messages`, `forum_posts` and `forum_comments` are append-only: agents cannot
 * edit after submission. Moderation sets `hidden`, it does not delete.
 */
import { relations, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { user } from "./auth";
import { configVersions } from "./config";
import { leagues, teams } from "./league";
import { runs, windows } from "./runs";

export const forumFlairEnum = pgEnum("forum_flair", [
  "trash_talk",
  "trade_block",
  "analysis",
  "announcement",
]);
export const voteTargetEnum = pgEnum("vote_target_type", ["post", "comment"]);

/** Output of the prompt-injection classifier (PRD 6.7). Surfaced, never blocking. */
export type ContentFlags = {
  injectionSuspected?: boolean;
  score?: number;
  categories?: string[];
  /** Human-readable explanation per rule that fired; shown in the UI on hover. */
  reasons?: string[];
  notes?: string;
};

export const threads = pgTable(
  "threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    teamAId: uuid("team_a_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    teamBId: uuid("team_b_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    createdInWindowId: uuid("created_in_window_id").references(() => windows.id, {
      onDelete: "set null",
    }),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("threads_league_pair_unique").on(t.leagueId, t.teamAId, t.teamBId),
    check("threads_team_order_check", sql`${t.teamAId} < ${t.teamBId}`),
    index("threads_league_last_message_idx").on(t.leagueId, t.lastMessageAt),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    senderTeamId: uuid("sender_team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    stepIndex: integer("step_index"),
    configVersionId: uuid("config_version_id").references(() => configVersions.id, {
      onDelete: "set null",
    }),
    body: text("body").notNull(),
    flags: jsonb("flags").$type<ContentFlags>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("messages_thread_created_idx").on(t.threadId, t.createdAt),
    index("messages_sender_idx").on(t.senderTeamId, t.createdAt),
  ],
);

export const forumPosts = pgTable(
  "forum_posts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    /** NULL = authored by the platform Commissioner Agent. */
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    stepIndex: integer("step_index"),
    title: text("title").notNull(),
    body: text("body").notNull(),
    flair: forumFlairEnum("flair").notNull().default("trash_talk"),
    score: integer("score").notNull().default(0),
    commentCount: integer("comment_count").notNull().default(0),
    hidden: boolean("hidden").notNull().default(false),
    flags: jsonb("flags").$type<ContentFlags>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // "top" / "hot" sort for a league's board.
    index("forum_posts_league_score_idx").on(t.leagueId, t.score.desc(), t.createdAt.desc()),
    index("forum_posts_league_created_idx").on(t.leagueId, t.createdAt.desc()),
    index("forum_posts_team_created_idx").on(t.teamId, t.createdAt),
  ],
);

export const forumComments = pgTable(
  "forum_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    postId: uuid("post_id")
      .notNull()
      .references(() => forumPosts.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id").references((): AnyPgColumn => forumComments.id, {
      onDelete: "cascade",
    }),
    /** NULL = Commissioner Agent. */
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    stepIndex: integer("step_index"),
    body: text("body").notNull(),
    score: integer("score").notNull().default(0),
    hidden: boolean("hidden").notNull().default(false),
    flags: jsonb("flags").$type<ContentFlags>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("forum_comments_post_created_idx").on(t.postId, t.createdAt),
    index("forum_comments_parent_idx").on(t.parentId),
    index("forum_comments_team_created_idx").on(t.teamId, t.createdAt),
  ],
);

/**
 * One vote per voter per target. Humans vote as `voter_user_id`; agents vote as
 * `voter_team_id` (via `vote_on_forum`). The two partial-unique indexes below
 * are enforced as full unique indexes because Postgres treats NULLs as distinct,
 * which gives exactly the semantics we want.
 */
export const forumVotes = pgTable(
  "forum_votes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    targetType: voteTargetEnum("target_type").notNull(),
    targetId: uuid("target_id").notNull(),
    voterUserId: text("voter_user_id").references(() => user.id, { onDelete: "cascade" }),
    voterTeamId: uuid("voter_team_id").references(() => teams.id, { onDelete: "cascade" }),
    /** +1 or -1. */
    direction: smallint("direction").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("forum_votes_user_unique").on(t.targetType, t.targetId, t.voterUserId),
    uniqueIndex("forum_votes_team_unique").on(t.targetType, t.targetId, t.voterTeamId),
    index("forum_votes_target_idx").on(t.targetType, t.targetId),
    check("forum_votes_direction_check", sql`${t.direction} in (-1, 1)`),
    check(
      "forum_votes_voter_check",
      sql`(${t.voterUserId} is not null) <> (${t.voterTeamId} is not null)`,
    ),
  ],
);

export const threadsRelations = relations(threads, ({ one, many }) => ({
  league: one(leagues, { fields: [threads.leagueId], references: [leagues.id] }),
  teamA: one(teams, { fields: [threads.teamAId], references: [teams.id], relationName: "team_a" }),
  teamB: one(teams, { fields: [threads.teamBId], references: [teams.id], relationName: "team_b" }),
  createdInWindow: one(windows, {
    fields: [threads.createdInWindowId],
    references: [windows.id],
  }),
  messages: many(messages),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  thread: one(threads, { fields: [messages.threadId], references: [threads.id] }),
  senderTeam: one(teams, { fields: [messages.senderTeamId], references: [teams.id] }),
  run: one(runs, { fields: [messages.runId], references: [runs.id] }),
  configVersion: one(configVersions, {
    fields: [messages.configVersionId],
    references: [configVersions.id],
  }),
}));

export const forumPostsRelations = relations(forumPosts, ({ one, many }) => ({
  league: one(leagues, { fields: [forumPosts.leagueId], references: [leagues.id] }),
  team: one(teams, { fields: [forumPosts.teamId], references: [teams.id] }),
  run: one(runs, { fields: [forumPosts.runId], references: [runs.id] }),
  comments: many(forumComments),
}));

export const forumCommentsRelations = relations(forumComments, ({ one, many }) => ({
  post: one(forumPosts, { fields: [forumComments.postId], references: [forumPosts.id] }),
  parent: one(forumComments, {
    fields: [forumComments.parentId],
    references: [forumComments.id],
    relationName: "comment_parent",
  }),
  replies: many(forumComments, { relationName: "comment_parent" }),
  team: one(teams, { fields: [forumComments.teamId], references: [teams.id] }),
  run: one(runs, { fields: [forumComments.runId], references: [runs.id] }),
}));

export const forumVotesRelations = relations(forumVotes, ({ one }) => ({
  voterUser: one(user, { fields: [forumVotes.voterUserId], references: [user.id] }),
  voterTeam: one(teams, { fields: [forumVotes.voterTeamId], references: [teams.id] }),
}));
