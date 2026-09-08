/**
 * Read helpers + membership mutation. Kept here (not in the tRPC router) so RSC
 * pages and procedures share one implementation.
 */
import { and, asc, desc, eq, isNull } from "drizzle-orm";

import { db, type DbOrTx } from "@/lib/db";
import { leagueMembers, leagues, teams } from "@/lib/db/schema";
import type { League, LeagueMember, LeagueRole } from "@/lib/db/types";

export type LeagueWithRules = NonNullable<
  Awaited<ReturnType<typeof getLeagueById>>
>;

export async function getLeagueById(leagueId: string, executor: DbOrTx = db) {
  return executor.query.leagues.findFirst({
    where: eq(leagues.id, leagueId),
    with: { rules: true },
  });
}

export async function getLeagueBySlug(slug: string, executor: DbOrTx = db) {
  return executor.query.leagues.findFirst({
    where: eq(leagues.slug, slug),
    with: { rules: true },
  });
}

export type LeagueSummary = League & { role: LeagueRole; teamCountActual: number };

/** Every league the user belongs to, newest first. */
export async function listLeaguesForUser(
  userId: string,
  executor: DbOrTx = db,
): Promise<LeagueSummary[]> {
  const rows = await executor
    .select({ league: leagues, role: leagueMembers.role })
    .from(leagueMembers)
    .innerJoin(leagues, eq(leagues.id, leagueMembers.leagueId))
    .where(eq(leagueMembers.userId, userId))
    .orderBy(desc(leagues.createdAt));

  return rows.map((row) => ({
    ...row.league,
    role: row.role,
    teamCountActual: row.league.teamCount,
  }));
}

export async function getMembership(
  leagueId: string,
  userId: string,
  executor: DbOrTx = db,
): Promise<LeagueMember | undefined> {
  return executor.query.leagueMembers.findFirst({
    where: and(eq(leagueMembers.leagueId, leagueId), eq(leagueMembers.userId, userId)),
  });
}

/**
 * Join a league as an owner and claim the lowest-numbered unowned team.
 * Idempotent: joining twice returns the existing membership and team.
 */
export async function joinLeague(
  leagueId: string,
  userId: string,
  executor: DbOrTx = db,
): Promise<{ membership: LeagueMember; teamId: string | null }> {
  const existing = await getMembership(leagueId, userId, executor);
  if (existing) {
    const owned = await executor.query.teams.findFirst({
      where: and(eq(teams.leagueId, leagueId), eq(teams.ownerUserId, userId)),
    });
    return { membership: existing, teamId: owned?.id ?? null };
  }

  const [membership] = await executor
    .insert(leagueMembers)
    .values({ leagueId, userId, role: "owner" })
    .returning();

  const [openTeam] = await executor
    .select({ id: teams.id })
    .from(teams)
    .where(and(eq(teams.leagueId, leagueId), isNull(teams.ownerUserId)))
    .orderBy(asc(teams.waiverPriority))
    .limit(1);

  if (!openTeam) return { membership, teamId: null };

  // Re-check `owner_user_id is null` in the UPDATE so two simultaneous joins
  // cannot claim the same team.
  const [claimed] = await executor
    .update(teams)
    .set({ ownerUserId: userId })
    .where(and(eq(teams.id, openTeam.id), isNull(teams.ownerUserId)))
    .returning();

  return { membership, teamId: claimed?.id ?? null };
}
