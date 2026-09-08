/**
 * League creation.
 *
 * Deliberately modest: it builds the skeleton (league, rules, commissioner
 * membership, 17 weeks, N unowned teams, one default agent config per team) and
 * stops. Draft scheduling, matchup generation and window templating belong to
 * the scheduler package.
 */
import { and, eq, sql } from "drizzle-orm";

import { db, withTransaction, type DbOrTx } from "@/lib/db";
import {
  agentConfigs,
  configVersions,
  DEFAULT_EDIT_LOCK_CONFIG,
  DEFAULT_HARNESS,
  DEFAULT_ROSTER_SLOTS,
  leagueMembers,
  leagueRules,
  leagues,
  teams,
  weeks,
  type RosterSlots,
} from "@/lib/db/schema";
import type { AgentConfig, ConfigVersion, League, LeagueRules, Team } from "@/lib/db/types";
import {
  DEFAULT_FALLBACK_MODEL_ID,
  DEFAULT_MODEL_ALLOWLIST,
  DEFAULT_MODEL_ID,
} from "@/lib/models";
import { fromET, nextWeekdayAtET } from "@/lib/time";

import {
  DEFAULT_AGENT_CONTEXT,
  defaultTeamAbbreviation,
  defaultTeamName,
} from "./defaults";

export type CreateLeagueInput = {
  name: string;
  commissionerUserId: string;
  teamCount?: number;
  season?: number;
  scoringPreset?: "ppr" | "half_ppr" | "standard";
  draftType?: "snake" | "auction";
  isPublic?: boolean;
  superflex?: boolean;
  tePremium?: boolean;
  rosterSlots?: RosterSlots;
  faabBudget?: number;
  playoffTeams?: number;
  playoffStartWeek?: number;
  regularSeasonWeeks?: number;
  modelAllowlist?: string[];
  draftScheduledAt?: Date | null;
};

export type CreateLeagueResult = {
  league: League;
  rules: LeagueRules;
  teams: Team[];
};

export const MIN_TEAMS = 8;
export const MAX_TEAMS = 14;
export const SEASON_WEEKS = 17;

/** `My Cool League` → `my-cool-league`. */
export function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/[\s_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "league"
  );
}

/** Default season = current year (NFL seasons are named for their September). */
export function currentSeason(now = new Date()): number {
  return now.getUTCFullYear();
}

/**
 * Week 1 starts on the first Tuesday at 06:00 ET on or after September 1 —
 * the waiver-open boundary defined in ARCHITECTURE.md. Each week is 7 days.
 */
export function weekBoundaries(season: number, weekNo: number): { startsAt: Date; endsAt: Date } {
  const septemberFirst = fromET({ year: season, month: 9, day: 1, hour: 0, minute: 0 });
  const week1Start = nextWeekdayAtET(septemberFirst, "tue", 6, 0);
  const startsAt = new Date(week1Start.getTime() + (weekNo - 1) * 7 * 24 * 60 * 60 * 1000);
  const endsAt = new Date(startsAt.getTime() + 7 * 24 * 60 * 60 * 1000);
  return { startsAt, endsAt };
}

async function uniqueSlug(base: string, executor: DbOrTx): Promise<string> {
  const candidate = slugify(base);
  const existing = await executor
    .select({ slug: leagues.slug })
    .from(leagues)
    .where(sql`${leagues.slug} = ${candidate} or ${leagues.slug} like ${candidate + "-%"}`);
  if (!existing.some((row) => row.slug === candidate)) return candidate;
  const taken = new Set(existing.map((row) => row.slug));
  for (let n = 2; n < 1000; n++) {
    const next = `${candidate}-${n}`;
    if (!taken.has(next)) return next;
  }
  return `${candidate}-${Date.now()}`;
}

export async function createLeague(
  input: CreateLeagueInput,
  executor: DbOrTx = db,
): Promise<CreateLeagueResult> {
  const teamCount = input.teamCount ?? 12;
  if (teamCount < MIN_TEAMS || teamCount > MAX_TEAMS) {
    throw new Error(`teamCount must be between ${MIN_TEAMS} and ${MAX_TEAMS}`);
  }
  const name = input.name.trim();
  if (!name) throw new Error("League name is required");

  const season = input.season ?? currentSeason();
  const faabBudget = input.faabBudget ?? 100;
  const regularSeasonWeeks = input.regularSeasonWeeks ?? 14;
  const playoffStartWeek = input.playoffStartWeek ?? regularSeasonWeeks + 1;

  return withTransaction(async (tx) => {
    const slug = await uniqueSlug(name, tx);

    const [league] = await tx
      .insert(leagues)
      .values({
        name,
        slug,
        commissionerUserId: input.commissionerUserId,
        season,
        teamCount,
        isPublic: input.isPublic ?? true,
        status: "setup",
        draftType: input.draftType ?? "snake",
        draftScheduledAt: input.draftScheduledAt ?? null,
      })
      .returning();

    const [rules] = await tx
      .insert(leagueRules)
      .values({
        leagueId: league.id,
        scoringPreset: input.scoringPreset ?? "ppr",
        superflex: input.superflex ?? false,
        tePremium: input.tePremium ?? false,
        rosterSlots: input.rosterSlots ?? DEFAULT_ROSTER_SLOTS,
        faabBudget,
        playoffTeams: input.playoffTeams ?? 6,
        playoffStartWeek,
        regularSeasonWeeks,
        seasonWeeks: SEASON_WEEKS,
        modelAllowlist: input.modelAllowlist ?? DEFAULT_MODEL_ALLOWLIST,
        fallbackModelId: DEFAULT_FALLBACK_MODEL_ID,
        editLock: DEFAULT_EDIT_LOCK_CONFIG,
      })
      .returning();

    await tx.insert(leagueMembers).values({
      leagueId: league.id,
      userId: input.commissionerUserId,
      role: "commissioner",
    });

    await tx.insert(weeks).values(
      Array.from({ length: SEASON_WEEKS }, (_, i) => {
        const weekNo = i + 1;
        const { startsAt, endsAt } = weekBoundaries(season, weekNo);
        return {
          leagueId: league.id,
          weekNo,
          startsAt,
          endsAt,
          isPlayoff: weekNo >= playoffStartWeek,
          status: "upcoming" as const,
        };
      }),
    );

    const createdTeams = await tx
      .insert(teams)
      .values(
        Array.from({ length: teamCount }, (_, i) => ({
          leagueId: league.id,
          ownerUserId: null,
          name: defaultTeamName(i),
          abbreviation: defaultTeamAbbreviation(i),
          faabRemaining: faabBudget,
          waiverPriority: i + 1,
        })),
      )
      .returning();

    const allowlist = rules.modelAllowlist;
    for (const team of createdTeams) {
      await createDefaultAgentConfig(team.id, tx, allowlist[0]);
    }

    return { league, rules, teams: createdTeams };
  }, executor);
}

/**
 * Create a team's agent config and its immutable version 1.
 *
 * The starting model is the first entry in the league's allowlist so a league
 * that narrows the allowlist still gets a legal config out of the box.
 */
export async function createDefaultAgentConfig(
  teamId: string,
  executor: DbOrTx = db,
  modelId: string = DEFAULT_MODEL_ID,
): Promise<{ config: AgentConfig; version: ConfigVersion }> {
  return withTransaction(async (tx) => {
    const [config] = await tx
      .insert(agentConfigs)
      .values({ teamId })
      .onConflictDoNothing({ target: agentConfigs.teamId })
      .returning();

    const existing =
      config ??
      (await tx.query.agentConfigs.findFirst({ where: eq(agentConfigs.teamId, teamId) }));
    if (!existing) throw new Error(`Failed to create agent config for team ${teamId}`);

    const alreadyV1 = await tx.query.configVersions.findFirst({
      where: and(eq(configVersions.configId, existing.id), eq(configVersions.versionNo, 1)),
    });
    if (alreadyV1) return { config: existing, version: alreadyV1 };

    const [version] = await tx
      .insert(configVersions)
      .values({
        configId: existing.id,
        versionNo: 1,
        contextMd: DEFAULT_AGENT_CONTEXT,
        modelId: modelId || DEFAULT_MODEL_ID,
        harness: DEFAULT_HARNESS,
        appliedAt: new Date(),
        changeSummary: "Initial configuration",
      })
      .returning();

    const [updated] = await tx
      .update(agentConfigs)
      .set({ currentVersionId: version.id, updatedAt: new Date() })
      .where(eq(agentConfigs.id, existing.id))
      .returning();

    return { config: updated, version };
  }, executor);
}
