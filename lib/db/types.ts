/**
 * Row types for every table. Import these instead of re-deriving `$inferSelect`
 * at each call site so a schema change surfaces in one place.
 */
import type * as s from "./schema";

// ---------------------------------------------------------------- auth
export type User = typeof s.user.$inferSelect;
export type NewUser = typeof s.user.$inferInsert;
export type Session = typeof s.session.$inferSelect;
export type NewSession = typeof s.session.$inferInsert;
export type Account = typeof s.account.$inferSelect;
export type NewAccount = typeof s.account.$inferInsert;
export type Verification = typeof s.verification.$inferSelect;
export type NewVerification = typeof s.verification.$inferInsert;

// -------------------------------------------------------------- league
export type League = typeof s.leagues.$inferSelect;
export type NewLeague = typeof s.leagues.$inferInsert;
export type LeagueRules = typeof s.leagueRules.$inferSelect;
export type NewLeagueRules = typeof s.leagueRules.$inferInsert;
export type LeagueMember = typeof s.leagueMembers.$inferSelect;
export type NewLeagueMember = typeof s.leagueMembers.$inferInsert;
export type Team = typeof s.teams.$inferSelect;
export type NewTeam = typeof s.teams.$inferInsert;
export type Week = typeof s.weeks.$inferSelect;
export type NewWeek = typeof s.weeks.$inferInsert;
export type Matchup = typeof s.matchups.$inferSelect;
export type NewMatchup = typeof s.matchups.$inferInsert;
export type TeamResult = typeof s.teamResults.$inferSelect;
export type NewTeamResult = typeof s.teamResults.$inferInsert;

// ------------------------------------------------------------- players
export type Player = typeof s.players.$inferSelect;
export type NewPlayer = typeof s.players.$inferInsert;
export type NflGame = typeof s.nflGames.$inferSelect;
export type NewNflGame = typeof s.nflGames.$inferInsert;
export type PlayerStatsWeekly = typeof s.playerStatsWeekly.$inferSelect;
export type NewPlayerStatsWeekly = typeof s.playerStatsWeekly.$inferInsert;
export type PlayerProjection = typeof s.playerProjections.$inferSelect;
export type NewPlayerProjection = typeof s.playerProjections.$inferInsert;
export type NewsItem = typeof s.newsItems.$inferSelect;
export type NewNewsItem = typeof s.newsItems.$inferInsert;
export type InjuryDesignation = typeof s.injuryDesignations.$inferSelect;
export type NewInjuryDesignation = typeof s.injuryDesignations.$inferInsert;

// -------------------------------------------------------------- roster
export type RosterSlot = typeof s.rosterSlots.$inferSelect;
export type NewRosterSlot = typeof s.rosterSlots.$inferInsert;
export type Lineup = typeof s.lineups.$inferSelect;
export type NewLineup = typeof s.lineups.$inferInsert;
export type Transaction = typeof s.transactions.$inferSelect;
export type NewTransaction = typeof s.transactions.$inferInsert;

// -------------------------------------------------------------- config
export type AgentConfig = typeof s.agentConfigs.$inferSelect;
export type NewAgentConfig = typeof s.agentConfigs.$inferInsert;
export type ConfigVersion = typeof s.configVersions.$inferSelect;
export type NewConfigVersion = typeof s.configVersions.$inferInsert;
export type Skill = typeof s.skills.$inferSelect;
export type NewSkill = typeof s.skills.$inferInsert;
export type ConfigVersionSkill = typeof s.configVersionSkills.$inferSelect;
export type NewConfigVersionSkill = typeof s.configVersionSkills.$inferInsert;

// ---------------------------------------------------------------- runs
export type Window = typeof s.windows.$inferSelect;
export type NewWindow = typeof s.windows.$inferInsert;
export type Snapshot = typeof s.snapshots.$inferSelect;
export type NewSnapshot = typeof s.snapshots.$inferInsert;
export type Run = typeof s.runs.$inferSelect;
export type NewRun = typeof s.runs.$inferInsert;
export type RunStep = typeof s.runSteps.$inferSelect;
export type NewRunStep = typeof s.runSteps.$inferInsert;
export type RunAction = typeof s.runActions.$inferSelect;
export type NewRunAction = typeof s.runActions.$inferInsert;

// -------------------------------------------------------- transactions
export type WaiverClaim = typeof s.waiverClaims.$inferSelect;
export type NewWaiverClaim = typeof s.waiverClaims.$inferInsert;
export type Trade = typeof s.trades.$inferSelect;
export type NewTrade = typeof s.trades.$inferInsert;
export type TradeItem = typeof s.tradeItems.$inferSelect;
export type NewTradeItem = typeof s.tradeItems.$inferInsert;
export type TradeEvent = typeof s.tradeEvents.$inferSelect;
export type NewTradeEvent = typeof s.tradeEvents.$inferInsert;
export type TradeVote = typeof s.tradeVotes.$inferSelect;
export type NewTradeVote = typeof s.tradeVotes.$inferInsert;

// -------------------------------------------------------------- social
export type Thread = typeof s.threads.$inferSelect;
export type NewThread = typeof s.threads.$inferInsert;
export type Message = typeof s.messages.$inferSelect;
export type NewMessage = typeof s.messages.$inferInsert;
export type ForumPost = typeof s.forumPosts.$inferSelect;
export type NewForumPost = typeof s.forumPosts.$inferInsert;
export type ForumComment = typeof s.forumComments.$inferSelect;
export type NewForumComment = typeof s.forumComments.$inferInsert;
export type ForumVote = typeof s.forumVotes.$inferSelect;
export type NewForumVote = typeof s.forumVotes.$inferInsert;

// ---------------------------------------------------------------- cost
export type UsageEvent = typeof s.usageEvents.$inferSelect;
export type NewUsageEvent = typeof s.usageEvents.$inferInsert;
export type ModelPrice = typeof s.modelPrices.$inferSelect;
export type NewModelPrice = typeof s.modelPrices.$inferInsert;
export type Budget = typeof s.budgets.$inferSelect;
export type NewBudget = typeof s.budgets.$inferInsert;
export type BudgetRollup = typeof s.budgetRollups.$inferSelect;
export type NewBudgetRollup = typeof s.budgetRollups.$inferInsert;

// ----------------------------------------------------------- providers
export type CustomProvider = typeof s.customProviders.$inferSelect;
export type NewCustomProvider = typeof s.customProviders.$inferInsert;

// ------------------------------------------------------- enum unions
export type LeagueStatus = (typeof s.leagueStatusEnum.enumValues)[number];
export type DraftType = (typeof s.draftTypeEnum.enumValues)[number];
export type ScoringPreset = (typeof s.scoringPresetEnum.enumValues)[number];
export type TransparencyMode = (typeof s.transparencyModeEnum.enumValues)[number];
export type InjectionPolicy = (typeof s.injectionPolicyEnum.enumValues)[number];
export type LeagueRole = (typeof s.leagueRoleEnum.enumValues)[number];
export type WeekStatus = (typeof s.weekStatusEnum.enumValues)[number];
export type Position = (typeof s.positionEnum.enumValues)[number];
export type AcquiredVia = (typeof s.acquisitionEnum.enumValues)[number];
export type LineupSource = (typeof s.lineupSourceEnum.enumValues)[number];
export type TransactionType = (typeof s.transactionTypeEnum.enumValues)[number];
export type SkillVisibility = (typeof s.skillVisibilityEnum.enumValues)[number];
export type WindowType = (typeof s.windowTypeEnum.enumValues)[number];
export type WindowStatus = (typeof s.windowStatusEnum.enumValues)[number];
export type RunKind = (typeof s.runKindEnum.enumValues)[number];
export type RunStatus = (typeof s.runStatusEnum.enumValues)[number];
export type WaiverStatus = (typeof s.waiverStatusEnum.enumValues)[number];
export type TradeStatus = (typeof s.tradeStatusEnum.enumValues)[number];
export type TradeVoteValue = (typeof s.tradeVoteEnum.enumValues)[number];
export type ForumFlair = (typeof s.forumFlairEnum.enumValues)[number];
export type VoteTargetType = (typeof s.voteTargetEnum.enumValues)[number];
export type BudgetPeriod = (typeof s.budgetPeriodEnum.enumValues)[number];
export type CustomProviderKind = (typeof s.customProviderKindEnum.enumValues)[number];

// Added during integration: tables introduced by the scheduler and public packages.
export type LeagueRuleChange = typeof s.leagueRuleChanges.$inferSelect;
export type NewLeagueRuleChange = typeof s.leagueRuleChanges.$inferInsert;
export type DraftPick = typeof s.draftPicks.$inferSelect;
export type NewDraftPick = typeof s.draftPicks.$inferInsert;
export type AuctionNomination = typeof s.auctionNominations.$inferSelect;
export type NewAuctionNomination = typeof s.auctionNominations.$inferInsert;
export type AuctionBid = typeof s.auctionBids.$inferSelect;
export type NewAuctionBid = typeof s.auctionBids.$inferInsert;
