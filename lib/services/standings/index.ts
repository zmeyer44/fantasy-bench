/**
 * Schedule generation, standings, and the playoff bracket.
 *
 * The regular season is a circle-method round robin so every team plays every
 * other as evenly as the week count allows; playoffs are a straight single
 * elimination seeded on the final standings, with byes for the top seeds when
 * the field is 6 (the PRD default).
 */
import { and, asc, eq, inArray } from "drizzle-orm";

import { db, withTransaction, type DbOrTx } from "@/lib/db";
import { leagueRules, matchups, teamResults, teams, weeks } from "@/lib/db/schema";
import type { Matchup, Team } from "@/lib/db/types";

export type StandingRow = {
  teamId: string;
  teamName: string;
  abbreviation: string;
  rank: number;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  pointsAgainst: number;
  streak: number;
};

// --------------------------------------------------------------- schedule

/**
 * Circle-method round robin. With an odd team count one team sits each round
 * (a bye), which the caller sees as "fewer matchups that week".
 */
export function roundRobinRounds(teamIds: string[]): Array<Array<[string, string]>> {
  const ids = [...teamIds];
  const hasBye = ids.length % 2 === 1;
  if (hasBye) ids.push("__BYE__");
  const n = ids.length;
  const rounds: Array<Array<[string, string]>> = [];
  // `fixed` stays put; the rest rotate one position per round.
  const rotating = ids.slice(1);
  for (let round = 0; round < n - 1; round++) {
    const order = [ids[0], ...rotating];
    const pairs: Array<[string, string]> = [];
    for (let i = 0; i < n / 2; i++) {
      const a = order[i];
      const b = order[n - 1 - i];
      if (a === "__BYE__" || b === "__BYE__") continue;
      // Alternate home/away by round so home games stay balanced.
      pairs.push(round % 2 === 0 ? [a, b] : [b, a]);
    }
    rounds.push(pairs);
    rotating.unshift(rotating.pop() as string);
  }
  return rounds;
}

/**
 * Write `matchups` for weeks 1..regularSeasonWeeks. Idempotent: a league that
 * already has matchups for a week is left alone.
 */
export async function generateSchedule(
  leagueId: string,
  executor: DbOrTx = db,
): Promise<{ weeks: number; matchups: number }> {
  return withTransaction(async (tx) => {
    const rules = await tx.query.leagueRules.findFirst({
      where: eq(leagueRules.leagueId, leagueId),
    });
    if (!rules) throw new Error(`League ${leagueId} has no rules row`);

    const leagueTeams = await tx
      .select()
      .from(teams)
      .where(eq(teams.leagueId, leagueId))
      .orderBy(asc(teams.createdAt), asc(teams.name));
    if (leagueTeams.length < 2) return { weeks: 0, matchups: 0 };

    const existing = await tx
      .select({ weekNo: matchups.weekNo })
      .from(matchups)
      .where(eq(matchups.leagueId, leagueId));
    const done = new Set(existing.map((r) => r.weekNo));

    const rounds = roundRobinRounds(leagueTeams.map((t) => t.id));
    const rows: Array<{
      leagueId: string;
      weekNo: number;
      homeTeamId: string;
      awayTeamId: string;
    }> = [];
    let weeksWritten = 0;
    for (let weekNo = 1; weekNo <= rules.regularSeasonWeeks; weekNo++) {
      if (done.has(weekNo)) continue;
      const pairs = rounds[(weekNo - 1) % rounds.length];
      for (const [home, away] of pairs) {
        rows.push({ leagueId, weekNo, homeTeamId: home, awayTeamId: away });
      }
      weeksWritten++;
    }
    if (rows.length > 0) await tx.insert(matchups).values(rows);
    return { weeks: weeksWritten, matchups: rows.length };
  }, executor);
}

// -------------------------------------------------------------- standings

function compareStandings(a: StandingRow, b: StandingRow): number {
  const aPct = a.wins + a.ties * 0.5;
  const bPct = b.wins + b.ties * 0.5;
  if (bPct !== aPct) return bPct - aPct;
  if (b.pointsFor !== a.pointsFor) return b.pointsFor - a.pointsFor;
  if (a.losses !== b.losses) return a.losses - b.losses;
  return a.teamName.localeCompare(b.teamName);
}

export async function getStandings(
  leagueId: string,
  executor: DbOrTx = db,
): Promise<StandingRow[]> {
  const leagueTeams = await executor
    .select()
    .from(teams)
    .where(eq(teams.leagueId, leagueId))
    .orderBy(asc(teams.name));
  if (leagueTeams.length === 0) return [];

  const results = await executor
    .select()
    .from(teamResults)
    .where(
      inArray(
        teamResults.teamId,
        leagueTeams.map((t) => t.id),
      ),
    )
    .orderBy(asc(teamResults.weekNo));

  const byTeam = new Map<string, StandingRow>();
  for (const team of leagueTeams) {
    byTeam.set(team.id, {
      teamId: team.id,
      teamName: team.name,
      abbreviation: team.abbreviation,
      rank: 0,
      wins: 0,
      losses: 0,
      ties: 0,
      pointsFor: 0,
      pointsAgainst: 0,
      streak: 0,
    });
  }
  for (const row of results) {
    const standing = byTeam.get(row.teamId);
    if (!standing) continue;
    standing.pointsFor += row.pointsFor;
    standing.pointsAgainst += row.pointsAgainst;
    if (row.won) {
      standing.wins++;
      standing.streak = standing.streak >= 0 ? standing.streak + 1 : 1;
    } else if (row.lost) {
      standing.losses++;
      standing.streak = standing.streak <= 0 ? standing.streak - 1 : -1;
    } else if (row.tied) {
      standing.ties++;
      standing.streak = 0;
    }
  }

  const rows = [...byTeam.values()].sort(compareStandings);
  rows.forEach((row, i) => {
    row.rank = i + 1;
    row.pointsFor = Math.round(row.pointsFor * 100) / 100;
    row.pointsAgainst = Math.round(row.pointsAgainst * 100) / 100;
  });
  return rows;
}

/** Waiver priority is worst-record-first (PRD 5.3 tiebreak for FAAB ties). */
export async function waiverPriorityOrder(
  leagueId: string,
  executor: DbOrTx = db,
): Promise<string[]> {
  const standings = await getStandings(leagueId, executor);
  return [...standings].reverse().map((s) => s.teamId);
}

// ---------------------------------------------------------------- playoffs

export type BracketSlot = { weekNo: number; homeTeamId: string; awayTeamId: string };

/**
 * Seed the bracket at `playoffStartWeek`. 6 teams: seeds 1-2 get a bye and enter
 * in round 2. 4 teams: 1v4 / 2v3 then the final. Other sizes fall back to the
 * largest power of two that fits.
 */
export function bracketForSeeds(
  seeds: string[],
  playoffTeams: number,
  playoffStartWeek: number,
): BracketSlot[] {
  const field = seeds.slice(0, Math.min(playoffTeams, seeds.length));
  if (field.length < 2) return [];

  if (field.length === 6) {
    return [
      // Round 1 (byes for seeds 1 and 2)
      { weekNo: playoffStartWeek, homeTeamId: field[2], awayTeamId: field[5] },
      { weekNo: playoffStartWeek, homeTeamId: field[3], awayTeamId: field[4] },
    ];
  }
  const size = 2 ** Math.floor(Math.log2(field.length));
  const bracket = field.slice(0, size);
  const slots: BracketSlot[] = [];
  for (let i = 0; i < size / 2; i++) {
    slots.push({
      weekNo: playoffStartWeek,
      homeTeamId: bracket[i],
      awayTeamId: bracket[size - 1 - i],
    });
  }
  return slots;
}

/**
 * Write the first playoff round. Later rounds are appended by `advanceBracket`
 * once the previous round is final, because the participants are not known yet.
 */
export async function seedPlayoffs(
  leagueId: string,
  executor: DbOrTx = db,
): Promise<{ created: number; startWeek: number }> {
  return withTransaction(async (tx) => {
    const rules = await tx.query.leagueRules.findFirst({
      where: eq(leagueRules.leagueId, leagueId),
    });
    if (!rules) return { created: 0, startWeek: 0 };
    const startWeek = rules.playoffStartWeek;

    const already = await tx
      .select({ id: matchups.id })
      .from(matchups)
      .where(and(eq(matchups.leagueId, leagueId), eq(matchups.weekNo, startWeek)));
    if (already.length > 0) return { created: 0, startWeek };

    const standings = await getStandings(leagueId, tx);
    const slots = bracketForSeeds(
      standings.map((s) => s.teamId),
      rules.playoffTeams,
      startWeek,
    );
    if (slots.length === 0) return { created: 0, startWeek };
    await tx
      .insert(matchups)
      .values(slots.map((s) => ({ leagueId, ...s })));
    await tx
      .update(weeks)
      .set({ isPlayoff: true })
      .where(and(eq(weeks.leagueId, leagueId), eq(weeks.weekNo, startWeek)));
    return { created: slots.length, startWeek };
  }, executor);
}

/**
 * After week `weekNo` is final, create the next round from its winners (plus
 * the bye seeds when leaving round 1 of a 6-team bracket).
 */
export async function advanceBracket(
  leagueId: string,
  weekNo: number,
  executor: DbOrTx = db,
): Promise<{ created: number }> {
  return withTransaction(async (tx) => {
    const rules = await tx.query.leagueRules.findFirst({
      where: eq(leagueRules.leagueId, leagueId),
    });
    if (!rules || weekNo < rules.playoffStartWeek) return { created: 0 };

    const round = await tx
      .select()
      .from(matchups)
      .where(and(eq(matchups.leagueId, leagueId), eq(matchups.weekNo, weekNo)));
    if (round.length === 0 || !round.every((m) => m.isFinal)) return { created: 0 };
    if (round.length === 1) return { created: 0 }; // the final was just played

    const nextWeek = weekNo + 1;
    const existing = await tx
      .select({ id: matchups.id })
      .from(matchups)
      .where(and(eq(matchups.leagueId, leagueId), eq(matchups.weekNo, nextWeek)));
    if (existing.length > 0) return { created: 0 };

    const standings = await getStandings(leagueId, tx);
    const seedOf = new Map(standings.map((s, i) => [s.teamId, i]));
    const winners = round.map((m) => winnerOf(m)).filter((id): id is string => id !== null);

    // Leaving round 1 of a 6-team bracket the byes join the field.
    const byes =
      rules.playoffTeams === 6 && weekNo === rules.playoffStartWeek
        ? standings.slice(0, 2).map((s) => s.teamId)
        : [];
    const field = [...byes, ...winners].sort(
      (a, b) => (seedOf.get(a) ?? 99) - (seedOf.get(b) ?? 99),
    );
    if (field.length < 2) return { created: 0 };

    const rows: Array<{ leagueId: string; weekNo: number; homeTeamId: string; awayTeamId: string }> = [];
    for (let i = 0; i < Math.floor(field.length / 2); i++) {
      rows.push({
        leagueId,
        weekNo: nextWeek,
        homeTeamId: field[i],
        awayTeamId: field[field.length - 1 - i],
      });
    }
    await tx.insert(matchups).values(rows);
    await tx
      .update(weeks)
      .set({ isPlayoff: true })
      .where(and(eq(weeks.leagueId, leagueId), eq(weeks.weekNo, nextWeek)));
    return { created: rows.length };
  }, executor);
}

export function winnerOf(m: Pick<Matchup, "homeTeamId" | "awayTeamId" | "homeScore" | "awayScore">): string | null {
  if (m.homeScore > m.awayScore) return m.homeTeamId;
  if (m.awayScore > m.homeScore) return m.awayTeamId;
  return null;
}

export async function listTeams(leagueId: string, executor: DbOrTx = db): Promise<Team[]> {
  return executor.select().from(teams).where(eq(teams.leagueId, leagueId)).orderBy(asc(teams.name));
}
