/**
 * The normalized shapes every provider produces.
 *
 * `ProjectionProvider` is the swap point (PRD §6.5 / open question 5): Sleeper's
 * Rotowire feed is the default, FantasyPros is a keyed alternative, and a
 * league can later register a custom source. Every row carries the `source`
 * string that is stored on `player_projections.source`.
 */
import type { HttpOptions } from "./http";

export type NormalizedProjection = {
  /** Sleeper id space. Team defenses use the team abbreviation (`"JAX"`). */
  sleeperId: string;
  season: number;
  week: number;
  position: string | null;
  team: string | null;
  opponent: string | null;
  gameId: string | null;
  pointsPpr: number | null;
  pointsHalf: number | null;
  pointsStd: number | null;
  stats: Record<string, number>;
  /** Provider vintage — snapshots pin "latest projection with effectiveAt <= takenAt". */
  effectiveAt: Date;
  source: string;
};

export type NormalizedStatLine = {
  sleeperId: string;
  season: number;
  week: number;
  position: string | null;
  team: string | null;
  opponent: string | null;
  gameId: string | null;
  stats: Record<string, number>;
  effectiveAt: Date;
  source: string;
};

export type NormalizedPlayer = {
  sleeperId: string;
  gsisId: string | null;
  fullName: string;
  firstName: string | null;
  lastName: string | null;
  position: string;
  nflTeam: string | null;
  status: string | null;
  injuryStatus: string | null;
  injuryBodyPart: string | null;
  injuryNotes: string | null;
  practiceParticipation: string | null;
  yearsExp: number | null;
  age: number | null;
  searchRank: number | null;
  fantasyPositions: string[];
  newsUpdated: number | null;
  /** Cross-provider ids kept in `players.raw` so we never have to refetch. */
  crossIds: Record<string, string | null>;
  raw: Record<string, unknown>;
};

export type NormalizedGame = {
  season: number;
  week: number;
  /** Our stable key: `${season}_${week}_${away}_${home}`. */
  gameId: string;
  espnId: string | null;
  homeTeam: string;
  awayTeam: string;
  kickoffAt: Date;
  status: string;
  homeScore: number | null;
  awayScore: number | null;
  source: string;
};

export type NormalizedInjury = {
  espnAthleteId: string | null;
  playerName: string;
  nflTeam: string | null;
  designation: string;
  practiceStatus: string | null;
  comment: string | null;
  effectiveAt: Date;
  source: string;
};

export type NormalizedNews = {
  externalId: string;
  espnAthleteId: string | null;
  headline: string;
  body: string | null;
  url: string | null;
  publishedAt: Date | null;
  source: string;
  raw: Record<string, unknown>;
};

export type NormalizedOwnership = {
  sleeperId: string;
  ownedPct: number | null;
  startedPct: number | null;
};

export type NormalizedTrending = {
  sleeperId: string;
  count: number;
};

export type SeasonState = {
  season: number;
  week: number;
  displayWeek: number;
  seasonType: string;
  seasonStartDate: string | null;
};

/** A swappable weekly-projection source. */
export interface ProjectionProvider {
  readonly source: string;
  /** False when the provider needs a key that is not set — callers skip it. */
  isConfigured(): boolean;
  fetchProjections(
    season: number,
    week: number,
    opts?: HttpOptions,
  ): Promise<NormalizedProjection[]>;
}
