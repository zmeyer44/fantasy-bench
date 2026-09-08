/**
 * Weekly scoring: lineup x stats -> matchup scores, team results, standings.
 *
 * The scorer always reads the *latest lineup version* for the week (lineups are
 * append-only history, per lib/db/schema/roster.ts) and the stored stat line for
 * each starter. It is safe to run on every tick: scores are recomputed from
 * scratch and written idempotently, so a mid-game run just refreshes the
 * partial totals.
 */
import { and, asc, desc, eq, inArray } from "drizzle-orm";

import { db, withTransaction, type DbOrTx } from "@/lib/db";
import {
  leagueRules,
  leagues,
  lineups,
  matchups,
  nflGames,
  players,
  playerStatsWeekly,
  rosterSlots,
  teamResults,
  teams,
  weeks,
} from "@/lib/db/schema";
import type { LineupSlot } from "@/lib/snapshot/types";

import { computeFantasyPoints, round2, type ScoringPreset, type StatMap } from "./points";

export * from "./points";
export * from "./table";

/** Bench slots never score. Anything else is a starter. */
export function isStartingSlot(slot: string): boolean {
  const upper = slot.toUpperCase();
  return upper !== "BENCH" && !upper.startsWith("BENCH") && upper !== "IR";
}

export type TeamWeekScore = {
  teamId: string;
  points: number;
  perPlayer: Record<string, number>;
  emptySlots: string[];
};

async function leagueScoringContext(leagueId: string, executor: DbOrTx) {
  const league = await executor.query.leagues.findFirst({ where: eq(leagues.id, leagueId) });
  const rules = await executor.query.leagueRules.findFirst({
    where: eq(leagueRules.leagueId, leagueId),
  });
  if (!league || !rules) throw new Error(`League ${leagueId} not found`);
  return {
    season: league.season,
    preset: rules.scoringPreset as ScoringPreset,
    tePremium: rules.tePremium,
    rules,
    league,
  };
}

/** Latest lineup version per team for a week. */
export async function latestLineups(
  teamIds: string[],
  weekNo: number,
  executor: DbOrTx = db,
): Promise<Map<string, { slots: LineupSlot[]; version: number }>> {
  const out = new Map<string, { slots: LineupSlot[]; version: number }>();
  if (teamIds.length === 0) return out;
  const rows = await executor
    .select({ teamId: lineups.teamId, slots: lineups.slots, version: lineups.version })
    .from(lineups)
    .where(and(inArray(lineups.teamId, teamIds), eq(lineups.weekNo, weekNo)))
    .orderBy(asc(lineups.teamId), desc(lineups.version));
  for (const row of rows) {
    if (!out.has(row.teamId)) out.set(row.teamId, { slots: row.slots, version: row.version });
  }
  return out;
}

/** Fantasy points for every player with a stat line this week, by player id. */
export async function playerPointsForWeek(
  season: number,
  weekNo: number,
  preset: ScoringPreset,
  opts: { tePremium?: boolean; playerIds?: string[] } = {},
  executor: DbOrTx = db,
): Promise<Record<string, number>> {
  const conditions = [eq(playerStatsWeekly.season, season), eq(playerStatsWeekly.week, weekNo)];
  if (opts.playerIds && opts.playerIds.length > 0) {
    conditions.push(inArray(playerStatsWeekly.playerId, opts.playerIds));
  }
  const rows = await executor
    .select({
      playerId: playerStatsWeekly.playerId,
      stats: playerStatsWeekly.stats,
      ppr: playerStatsWeekly.fantasyPointsPpr,
      half: playerStatsWeekly.fantasyPointsHalf,
      std: playerStatsWeekly.fantasyPointsStd,
      position: players.position,
    })
    .from(playerStatsWeekly)
    .innerJoin(players, eq(players.id, playerStatsWeekly.playerId))
    .where(and(...conditions));

  const out: Record<string, number> = {};
  for (const row of rows) {
    const stored = preset === "ppr" ? row.ppr : preset === "half_ppr" ? row.half : row.std;
    // TE premium is a league toggle, so a stored (league-agnostic) column can
    // only be trusted when the league does not run it.
    out[row.playerId] =
      stored !== null && stored !== undefined && !opts.tePremium
        ? stored
        : computeFantasyPoints(row.stats as StatMap, preset, {
            position: row.position,
            tePremium: opts.tePremium,
          });
  }
  return out;
}

/**
 * Points so far this week for every rostered player in the league — the
 * snapshot's `liveScores` (PRD 5.11 live scoring).
 */
export async function liveScoresForWeek(
  leagueId: string,
  weekNo: number,
  executor: DbOrTx = db,
): Promise<Record<string, number>> {
  const { season, preset, tePremium } = await leagueScoringContext(leagueId, executor);
  const rostered = await executor
    .select({ playerId: rosterSlots.playerId })
    .from(rosterSlots)
    .innerJoin(teams, eq(teams.id, rosterSlots.teamId))
    .where(eq(teams.leagueId, leagueId));
  const ids = [...new Set(rostered.map((r) => r.playerId))];
  if (ids.length === 0) return {};
  return playerPointsForWeek(season, weekNo, preset, { tePremium, playerIds: ids }, executor);
}

/**
 * Recompute every matchup score and team result for a week.
 *
 * Idempotent. Does *not* decide wins/losses unless the week is final — an
 * in-progress week records points only, so the standings never flap.
 */
export async function scoreWeek(
  leagueId: string,
  weekNo: number,
  executor: DbOrTx = db,
): Promise<{ teams: number; matchups: number; finalized: boolean }> {
  return withTransaction(async (tx) => {
    const { season, preset, tePremium } = await leagueScoringContext(leagueId, tx);
    const leagueTeams = await tx.select().from(teams).where(eq(teams.leagueId, leagueId));
    if (leagueTeams.length === 0) return { teams: 0, matchups: 0, finalized: false };

    const teamIds = leagueTeams.map((t) => t.id);
    const lineupByTeam = await latestLineups(teamIds, weekNo, tx);
    const points = await playerPointsForWeek(season, weekNo, preset, { tePremium }, tx);

    const scores = new Map<string, number>();
    for (const team of leagueTeams) {
      const lineup = lineupByTeam.get(team.id);
      let total = 0;
      for (const slot of lineup?.slots ?? []) {
        if (!isStartingSlot(slot.slot) || !slot.playerId) continue;
        total += points[slot.playerId] ?? 0;
      }
      scores.set(team.id, round2(total));
    }

    const weekMatchups = await tx
      .select()
      .from(matchups)
      .where(and(eq(matchups.leagueId, leagueId), eq(matchups.weekNo, weekNo)));

    const complete = await isWeekComplete(season, weekNo, tx);

    for (const m of weekMatchups) {
      const home = scores.get(m.homeTeamId) ?? 0;
      const away = scores.get(m.awayTeamId) ?? 0;
      await tx
        .update(matchups)
        .set({ homeScore: home, awayScore: away, isFinal: complete })
        .where(eq(matchups.id, m.id));

      await upsertTeamResult(tx, m.homeTeamId, weekNo, home, away, complete);
      await upsertTeamResult(tx, m.awayTeamId, weekNo, away, home, complete);
    }

    return { teams: leagueTeams.length, matchups: weekMatchups.length, finalized: complete };
  }, executor);
}

async function upsertTeamResult(
  tx: DbOrTx,
  teamId: string,
  weekNo: number,
  pointsFor: number,
  pointsAgainst: number,
  final: boolean,
): Promise<void> {
  const won = final && pointsFor > pointsAgainst;
  const lost = final && pointsFor < pointsAgainst;
  const tied = final && pointsFor === pointsAgainst;
  await tx
    .insert(teamResults)
    .values({ teamId, weekNo, pointsFor, pointsAgainst, won, lost, tied })
    .onConflictDoUpdate({
      target: [teamResults.teamId, teamResults.weekNo],
      set: { pointsFor, pointsAgainst, won, lost, tied },
    });
}

/** True when every NFL game in the week has a final status. */
export async function isWeekComplete(
  season: number,
  weekNo: number,
  executor: DbOrTx = db,
): Promise<boolean> {
  const games = await executor
    .select({ status: nflGames.status })
    .from(nflGames)
    .where(and(eq(nflGames.season, season), eq(nflGames.week, weekNo)));
  if (games.length === 0) return false;
  return games.every((g) => g.status === "final" || g.status === "canceled");
}

/**
 * Close the week: score it one last time, mark the matchups final, and flip the
 * `weeks` row to `complete`. No-op until every NFL game is final.
 */
export async function finalizeWeek(
  leagueId: string,
  weekNo: number,
  executor: DbOrTx = db,
): Promise<{ finalized: boolean }> {
  return withTransaction(async (tx) => {
    const { season } = await leagueScoringContext(leagueId, tx);
    if (!(await isWeekComplete(season, weekNo, tx))) return { finalized: false };
    await scoreWeek(leagueId, weekNo, tx);
    await tx
      .update(weeks)
      .set({ status: "complete" })
      .where(and(eq(weeks.leagueId, leagueId), eq(weeks.weekNo, weekNo)));
    return { finalized: true };
  }, executor);
}
