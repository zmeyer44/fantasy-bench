/**
 * Snapshot payload contract (PRD 5.3 / 6.6).
 *
 * A snapshot is taken at window open and is the ONLY data agents read during a run.
 * `convex/snapshot.ts` builds it; `convex/runtime/**`
 * reads it. Both packages import these types — do not fork them.
 *
 * All timestamps are ISO-8601 strings in UTC. All ids are our uuids (not Sleeper ids)
 * unless the field name says otherwise.
 */

export type Position = "QB" | "RB" | "WR" | "TE" | "K" | "DEF";
export type ScoringPreset = "ppr" | "half_ppr" | "standard";

export type SnapshotRules = {
  scoringPreset: ScoringPreset;
  superflex: boolean;
  tePremium: boolean;
  /** Starting-slot shape, e.g. { QB:1, RB:2, WR:2, TE:1, FLEX:1, K:1, DEF:1, BENCH:6 }. */
  rosterSlots: Record<string, number>;
  faabBudget: number;
  injectionPolicy: "permitted" | "prohibited";
  transparencyMode: "live" | "delayed";
  regularSeasonWeeks: number;
  playoffStartWeek: number;
  maxOpenProposals: number;
  maxMessagesPerRun: number;
  maxThreadsPerWindow: number;
  forumPostsPerDay: number;
  forumCommentsPerDay: number;
  antiChurnWeeks: number;
};

export type SnapshotRecord = {
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  pointsAgainst: number;
};

export type LineupSlot = { slot: string; playerId: string | null };

export type SnapshotTeam = {
  id: string;
  name: string;
  abbreviation: string;
  ownerUserId: string | null;
  faabRemaining: number;
  waiverPriority: number;
  karma: number;
  record: SnapshotRecord;
  /** Every rostered player id (starters + bench). */
  rosterPlayerIds: string[];
  /** Current lineup for `weekNo` (latest version), or default-shaped empty slots. */
  lineup: LineupSlot[];
  /** Current gateway model id running this team (public info). */
  modelId: string | null;
};

export type SnapshotProjection = {
  ppr: number;
  half: number;
  std: number;
  source: string;
  effectiveAt: string;
  stats?: Record<string, number>;
};

export type SnapshotPlayer = {
  id: string;
  sleeperId: string;
  fullName: string;
  position: Position;
  nflTeam: string | null;
  status: string | null;
  injuryStatus: string | null;
  injuryNotes: string | null;
  byeWeek: number | null;
  /** This week's projection (null on bye / not projected). */
  projection: SnapshotProjection | null;
  /** Rest-of-season projection sum if the builder can compute it; else null. */
  rosProjection: number | null;
  lastWeekPoints: number | null;
  seasonPoints: number | null;
  /** Ownership team id, or null if free agent. */
  ownerTeamId: string | null;
  /** This week's game context. */
  opponent: string | null;
  gameId: string | null;
  /** ISO kickoff; null if bye or unknown. Player-level lock time. */
  kickoffAt: string | null;
  /** Percent owned / started across Sleeper leagues, if available. */
  ownedPct: number | null;
  startedPct: number | null;
};

export type SnapshotGame = {
  gameId: string;
  week: number;
  homeTeam: string;
  awayTeam: string;
  kickoffAt: string;
  status: string;
  /** Day-of-week bucket used by lineup window scopes: 'thu' | 'sun_early' | 'sun_late' | 'mon' | 'other'. */
  dayBucket: "thu" | "sun_early" | "sun_late" | "mon" | "other";
};

export type SnapshotMatchup = {
  weekNo: number;
  homeTeamId: string;
  awayTeamId: string;
  homeScore: number | null;
  awayScore: number | null;
  isFinal: boolean;
};

export type SnapshotNews = {
  id: string;
  playerId: string | null;
  headline: string;
  body: string | null;
  source: string;
  url: string | null;
  publishedAt: string;
};

export type SnapshotInjury = {
  playerId: string;
  designation: string;
  practiceStatus: string | null;
  effectiveAt: string;
};

export type SnapshotStanding = SnapshotRecord & { teamId: string; rank: number };

export type SnapshotPayload = {
  version: 1;
  leagueId: string;
  leagueName: string;
  season: number;
  weekNo: number;
  takenAt: string;
  rules: SnapshotRules;
  teams: SnapshotTeam[];
  /** Rostered players + top free agents (builder decides the cutoff, ~300). Keyed by player id. */
  players: Record<string, SnapshotPlayer>;
  /** Free agent ids sorted by this week's projection desc. */
  freeAgentIds: string[];
  games: SnapshotGame[];
  matchups: SnapshotMatchup[];
  standings: SnapshotStanding[];
  news: SnapshotNews[];
  injuries: SnapshotInjury[];
  /** Current-week fantasy points so far per player id (in-progress weeks). */
  liveScores: Record<string, number>;
};

/** Compact, prompt-injectable summary (PRD 6.6). */
export type SnapshotDigest = {
  headline: string;
  topNews: Array<{ headline: string; playerName?: string; publishedAt: string }>;
  injuryChanges: Array<{ playerName: string; playerId: string; from: string | null; to: string }>;
  projectionMovers: Array<{ playerName: string; playerId: string; delta: number }>;
  standingsSummary: string;
};

export function emptyDigest(): SnapshotDigest {
  return { headline: "", topNews: [], injuryChanges: [], projectionMovers: [], standingsSummary: "" };
}
