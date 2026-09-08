/**
 * Waivers and the trade state machine.
 *
 * `trade_events` is append-only: every state transition writes a row carrying
 * the run/step that caused it, which is what the negotiation viewer links to.
 */
import { relations } from "drizzle-orm";
import {
  type AnyPgColumn,
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
import { leagues, teams } from "./league";
import { players } from "./players";
import { runs, windows } from "./runs";
import { threads } from "./social";

export const waiverStatusEnum = pgEnum("waiver_status", ["pending", "won", "lost", "invalid"]);
export const tradeStatusEnum = pgEnum("trade_status", [
  "proposed",
  "countered",
  "accepted",
  "rejected",
  "expired",
  "in_review",
  "vetoed",
  "completed",
  "cancelled",
]);
export const tradeVoteEnum = pgEnum("trade_vote", ["veto", "approve"]);

export const waiverClaims = pgTable(
  "waiver_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    windowId: uuid("window_id")
      .notNull()
      .references(() => windows.id, { onDelete: "cascade" }),
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    weekNo: integer("week_no").notNull(),
    addPlayerId: uuid("add_player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    dropPlayerId: uuid("drop_player_id").references(() => players.id, { onDelete: "set null" }),
    bid: integer("bid").notNull().default(0),
    /** Agent-declared ordering of its own claims (1 = run first). */
    priority: integer("priority").notNull().default(1),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    status: waiverStatusEnum("status").notNull().default("pending"),
    resultReason: text("result_reason"),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("waiver_claims_window_idx").on(t.windowId),
    index("waiver_claims_team_idx").on(t.teamId, t.weekNo),
    index("waiver_claims_league_week_idx").on(t.leagueId, t.weekNo),
  ],
);

/** Commissioner-Agent fairness breakdown, published with the score. */
export type FairnessDetail = {
  proposerValue?: number;
  recipientValue?: number;
  rosterFitAdjustment?: number;
  rationale?: string;
  [key: string]: unknown;
};

export const trades = pgTable(
  "trades",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    proposerTeamId: uuid("proposer_team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    recipientTeamId: uuid("recipient_team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id").references(() => threads.id, { onDelete: "set null" }),
    windowId: uuid("window_id").references(() => windows.id, { onDelete: "set null" }),
    weekNo: integer("week_no"),
    status: tradeStatusEnum("status").notNull().default("proposed"),
    fairnessScore: numeric("fairness_score", { precision: 6, scale: 3, mode: "number" }),
    fairnessDetail: jsonb("fairness_detail").$type<FairnessDetail>(),
    flagged: boolean("flagged").notNull().default(false),
    reviewEndsAt: timestamp("review_ends_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    /** A counter-offer points at the proposal it answers. */
    parentTradeId: uuid("parent_trade_id").references((): AnyPgColumn => trades.id, {
      onDelete: "set null",
    }),
    message: text("message"),
    createdByRunId: uuid("created_by_run_id").references(() => runs.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("trades_league_status_idx").on(t.leagueId, t.status),
    index("trades_proposer_idx").on(t.proposerTeamId, t.createdAt),
    index("trades_recipient_idx").on(t.recipientTeamId, t.createdAt),
    index("trades_thread_idx").on(t.threadId),
    index("trades_review_ends_idx").on(t.reviewEndsAt),
  ],
);

/** One leg of a trade: a player or a FAAB amount moving from one team to another. */
export const tradeItems = pgTable(
  "trade_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tradeId: uuid("trade_id")
      .notNull()
      .references(() => trades.id, { onDelete: "cascade" }),
    fromTeamId: uuid("from_team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    toTeamId: uuid("to_team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    playerId: uuid("player_id").references(() => players.id, { onDelete: "cascade" }),
    faab: integer("faab"),
  },
  (t) => [
    index("trade_items_trade_idx").on(t.tradeId),
    index("trade_items_player_idx").on(t.playerId),
  ],
);

/** Append-only transition log. */
export const tradeEvents = pgTable(
  "trade_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tradeId: uuid("trade_id")
      .notNull()
      .references(() => trades.id, { onDelete: "cascade" }),
    /** e.g. `proposed`, `countered`, `accepted`, `fairness_scored`, `vetoed`. */
    type: text("type").notNull(),
    fromStatus: tradeStatusEnum("from_status"),
    toStatus: tradeStatusEnum("to_status"),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    stepIndex: integer("step_index"),
    actorTeamId: uuid("actor_team_id").references(() => teams.id, { onDelete: "set null" }),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("trade_events_trade_created_idx").on(t.tradeId, t.createdAt)],
);

/** Human veto vote on a flagged trade. Majority blocks. */
export const tradeVotes = pgTable(
  "trade_votes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tradeId: uuid("trade_id")
      .notNull()
      .references(() => trades.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    vote: tradeVoteEnum("vote").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("trade_votes_trade_user_unique").on(t.tradeId, t.userId)],
);

export const waiverClaimsRelations = relations(waiverClaims, ({ one }) => ({
  team: one(teams, { fields: [waiverClaims.teamId], references: [teams.id] }),
  window: one(windows, { fields: [waiverClaims.windowId], references: [windows.id] }),
  league: one(leagues, { fields: [waiverClaims.leagueId], references: [leagues.id] }),
  addPlayer: one(players, {
    fields: [waiverClaims.addPlayerId],
    references: [players.id],
    relationName: "waiver_add",
  }),
  dropPlayer: one(players, {
    fields: [waiverClaims.dropPlayerId],
    references: [players.id],
    relationName: "waiver_drop",
  }),
  run: one(runs, { fields: [waiverClaims.runId], references: [runs.id] }),
}));

export const tradesRelations = relations(trades, ({ one, many }) => ({
  league: one(leagues, { fields: [trades.leagueId], references: [leagues.id] }),
  proposerTeam: one(teams, {
    fields: [trades.proposerTeamId],
    references: [teams.id],
    relationName: "trade_proposer",
  }),
  recipientTeam: one(teams, {
    fields: [trades.recipientTeamId],
    references: [teams.id],
    relationName: "trade_recipient",
  }),
  thread: one(threads, { fields: [trades.threadId], references: [threads.id] }),
  window: one(windows, { fields: [trades.windowId], references: [windows.id] }),
  parentTrade: one(trades, {
    fields: [trades.parentTradeId],
    references: [trades.id],
    relationName: "trade_parent",
  }),
  counters: many(trades, { relationName: "trade_parent" }),
  items: many(tradeItems),
  events: many(tradeEvents),
  votes: many(tradeVotes),
}));

export const tradeItemsRelations = relations(tradeItems, ({ one }) => ({
  trade: one(trades, { fields: [tradeItems.tradeId], references: [trades.id] }),
  fromTeam: one(teams, {
    fields: [tradeItems.fromTeamId],
    references: [teams.id],
    relationName: "trade_item_from",
  }),
  toTeam: one(teams, {
    fields: [tradeItems.toTeamId],
    references: [teams.id],
    relationName: "trade_item_to",
  }),
  player: one(players, { fields: [tradeItems.playerId], references: [players.id] }),
}));

export const tradeEventsRelations = relations(tradeEvents, ({ one }) => ({
  trade: one(trades, { fields: [tradeEvents.tradeId], references: [trades.id] }),
  run: one(runs, { fields: [tradeEvents.runId], references: [runs.id] }),
  actorTeam: one(teams, { fields: [tradeEvents.actorTeamId], references: [teams.id] }),
}));

export const tradeVotesRelations = relations(tradeVotes, ({ one }) => ({
  trade: one(trades, { fields: [tradeVotes.tradeId], references: [trades.id] }),
  user: one(user, { fields: [tradeVotes.userId], references: [user.id] }),
}));

// ---------------------------------------------------------------------------
// Draft (scheduler package)
//
// `draft_picks` is created up-front for the whole draft (one row per slot) and
// filled in as picks land, so "who is on the clock" is a query rather than a
// counter, and the board renders before a single pick is made. Auction lots use
// the same table: `price` carries the winning bid.
// ---------------------------------------------------------------------------

export const draftPicks = pgTable(
  "draft_picks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    round: integer("round").notNull(),
    /** 1-based position within the round. */
    pickNo: integer("pick_no").notNull(),
    /** 1-based position across the whole draft. */
    overallNo: integer("overall_no").notNull(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    playerId: uuid("player_id").references(() => players.id, { onDelete: "set null" }),
    /** Auction only: the winning bid. */
    price: integer("price"),
    madeByRunId: uuid("made_by_run_id").references(() => runs.id, { onDelete: "set null" }),
    windowId: uuid("window_id").references(() => windows.id, { onDelete: "set null" }),
    /** True when the pick clock expired and the platform auto-picked. */
    auto: boolean("auto").notNull().default(false),
    /** Agent-authored public explanation, published to the draft board. */
    rationale: text("rationale"),
    madeAt: timestamp("made_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("draft_picks_league_overall_unique").on(t.leagueId, t.overallNo),
    index("draft_picks_league_team_idx").on(t.leagueId, t.teamId),
    index("draft_picks_player_idx").on(t.playerId),
  ],
);

/** Auction: one lot = one nomination, opened by the nominating team. */
export const auctionNominations = pgTable(
  "auction_nominations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    /** 1-based lot number; matches `draft_picks.overall_no` once resolved. */
    lotNo: integer("lot_no").notNull(),
    nominatingTeamId: uuid("nominating_team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    playerId: uuid("player_id").references(() => players.id, { onDelete: "set null" }),
    openingBid: integer("opening_bid").notNull().default(1),
    windowId: uuid("window_id").references(() => windows.id, { onDelete: "set null" }),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    /** `open` while bids are accepted, then `resolved` (or `abandoned`). */
    status: text("status").notNull().default("open"),
    winningTeamId: uuid("winning_team_id").references(() => teams.id, { onDelete: "set null" }),
    winningBid: integer("winning_bid"),
    /** How a tie was broken, recorded in the trace (PRD 5.2). */
    tiebreak: jsonb("tiebreak").$type<Record<string, unknown>>(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("auction_nominations_league_lot_unique").on(t.leagueId, t.lotNo),
    index("auction_nominations_league_status_idx").on(t.leagueId, t.status),
  ],
);

/** Sealed bids (PRD 5.2 / open question 4). One row per team per lot. */
export const auctionBids = pgTable(
  "auction_bids",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    nominationId: uuid("nomination_id")
      .notNull()
      .references(() => auctionNominations.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    amount: integer("amount").notNull(),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    windowId: uuid("window_id").references(() => windows.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("auction_bids_nomination_team_unique").on(t.nominationId, t.teamId)],
);

export const draftPicksRelations = relations(draftPicks, ({ one }) => ({
  league: one(leagues, { fields: [draftPicks.leagueId], references: [leagues.id] }),
  team: one(teams, { fields: [draftPicks.teamId], references: [teams.id] }),
  player: one(players, { fields: [draftPicks.playerId], references: [players.id] }),
  madeByRun: one(runs, { fields: [draftPicks.madeByRunId], references: [runs.id] }),
  window: one(windows, { fields: [draftPicks.windowId], references: [windows.id] }),
}));

export const auctionNominationsRelations = relations(auctionNominations, ({ one, many }) => ({
  league: one(leagues, { fields: [auctionNominations.leagueId], references: [leagues.id] }),
  nominatingTeam: one(teams, {
    fields: [auctionNominations.nominatingTeamId],
    references: [teams.id],
    relationName: "auction_nominator",
  }),
  winningTeam: one(teams, {
    fields: [auctionNominations.winningTeamId],
    references: [teams.id],
    relationName: "auction_winner",
  }),
  player: one(players, { fields: [auctionNominations.playerId], references: [players.id] }),
  bids: many(auctionBids),
}));

export const auctionBidsRelations = relations(auctionBids, ({ one }) => ({
  nomination: one(auctionNominations, {
    fields: [auctionBids.nominationId],
    references: [auctionNominations.id],
  }),
  team: one(teams, { fields: [auctionBids.teamId], references: [teams.id] }),
}));
