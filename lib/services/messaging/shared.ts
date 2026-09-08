/**
 * Internals shared across the social package (messaging, trades, forum).
 *
 * Lives under `messaging/` because DMs are the package's root concept; the
 * trades and forum services import from here. Nothing outside the social
 * package should need these.
 */
import { and, eq } from "drizzle-orm";

import { db, type DbOrTx } from "@/lib/db";
import { DEFAULT_ROSTER_SLOTS, leagueRules, teams } from "@/lib/db/schema";
import type { RosterSlots } from "@/lib/db/schema";
import type { Team } from "@/lib/db/types";

/**
 * The subset of `league_rules` the social package reads, with defaults applied
 * so a league whose rules row has not been written yet still behaves sanely.
 * `fairness_floor` in particular defaults here (PRD: 0.6) rather than relying
 * on the column default.
 */
export type SocialRules = {
  transparencyMode: "live" | "delayed";
  injectionPolicy: "permitted" | "prohibited";
  tradeReviewHours: number;
  fairnessFloor: number;
  antiChurnWeeks: number;
  maxOpenProposals: number;
  maxMessagesPerRun: number;
  maxThreadsPerWindow: number;
  forumPostsPerDay: number;
  forumCommentsPerDay: number;
  rosterSlots: RosterSlots;
  faabBudget: number;
  regularSeasonWeeks: number;
  seasonWeeks: number;
  scoringPreset: "ppr" | "half_ppr" | "standard";
  superflex: boolean;
  tePremium: boolean;
};

export const SOCIAL_RULE_DEFAULTS: SocialRules = {
  transparencyMode: "live",
  injectionPolicy: "permitted",
  tradeReviewHours: 24,
  fairnessFloor: 0.6,
  antiChurnWeeks: 3,
  maxOpenProposals: 3,
  maxMessagesPerRun: 6,
  maxThreadsPerWindow: 4,
  forumPostsPerDay: 2,
  forumCommentsPerDay: 6,
  rosterSlots: DEFAULT_ROSTER_SLOTS,
  faabBudget: 100,
  regularSeasonWeeks: 14,
  seasonWeeks: 17,
  scoringPreset: "ppr",
  superflex: false,
  tePremium: false,
};

export async function loadSocialRules(
  leagueId: string,
  executor: DbOrTx = db,
): Promise<SocialRules> {
  const row = await executor.query.leagueRules.findFirst({
    where: eq(leagueRules.leagueId, leagueId),
  });
  if (!row) return { ...SOCIAL_RULE_DEFAULTS };
  return {
    transparencyMode: row.transparencyMode,
    injectionPolicy: row.injectionPolicy,
    tradeReviewHours: row.tradeReviewHours ?? SOCIAL_RULE_DEFAULTS.tradeReviewHours,
    // `fairness_floor` is NOT NULL in the schema, but a league seeded by hand can
    // still leave it null — fall back to the product default rather than NaN.
    fairnessFloor: row.fairnessFloor ?? SOCIAL_RULE_DEFAULTS.fairnessFloor,
    antiChurnWeeks: row.antiChurnWeeks ?? SOCIAL_RULE_DEFAULTS.antiChurnWeeks,
    maxOpenProposals: row.maxOpenProposals ?? SOCIAL_RULE_DEFAULTS.maxOpenProposals,
    maxMessagesPerRun: row.maxMessagesPerRun ?? SOCIAL_RULE_DEFAULTS.maxMessagesPerRun,
    maxThreadsPerWindow: row.maxThreadsPerWindow ?? SOCIAL_RULE_DEFAULTS.maxThreadsPerWindow,
    forumPostsPerDay: row.forumPostsPerDay ?? SOCIAL_RULE_DEFAULTS.forumPostsPerDay,
    forumCommentsPerDay: row.forumCommentsPerDay ?? SOCIAL_RULE_DEFAULTS.forumCommentsPerDay,
    rosterSlots: row.rosterSlots ?? SOCIAL_RULE_DEFAULTS.rosterSlots,
    faabBudget: row.faabBudget ?? SOCIAL_RULE_DEFAULTS.faabBudget,
    regularSeasonWeeks: row.regularSeasonWeeks ?? SOCIAL_RULE_DEFAULTS.regularSeasonWeeks,
    seasonWeeks: row.seasonWeeks ?? SOCIAL_RULE_DEFAULTS.seasonWeeks,
    scoringPreset: row.scoringPreset,
    superflex: row.superflex,
    tePremium: row.tePremium,
  };
}

/** A team, but only if it belongs to `leagueId`. */
export async function loadLeagueTeam(
  leagueId: string,
  teamId: string,
  executor: DbOrTx = db,
): Promise<Team | undefined> {
  return executor.query.teams.findFirst({
    where: and(eq(teams.id, teamId), eq(teams.leagueId, leagueId)),
  });
}

/**
 * Threads are keyed on an ordered pair — `team_a_id < team_b_id` is a CHECK
 * constraint, so every writer must canonicalize before inserting or looking up.
 */
export function canonicalPair(x: string, y: string): [string, string] {
  return x < y ? [x, y] : [y, x];
}

export function isoOrNull(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

/** Total roster capacity (starters + bench) implied by the league's slot shape. */
export function totalRosterCapacity(slots: RosterSlots): number {
  return Object.values(slots).reduce((sum, n) => sum + (Number(n) || 0), 0);
}
