/**
 * Schedule generation, scoring, and standings.
 */
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import { matchups, nflGames, teamResults } from "@/lib/db/schema";
import { finalizeWeek, isWeekComplete, scoreWeek, liveScoresForWeek } from "@/lib/services/scoring";
import {
  bracketForSeeds,
  generateSchedule,
  getStandings,
  roundRobinRounds,
  seedPlayoffs,
  waiverPriorityOrder,
} from "@/lib/services/standings";
import { safeCommitLineup } from "@/lib/scheduler/lineup-fallback";

import { truncateAll } from "../setup";
import { createTestLeague, fillRoster, seedGames, seedPlayers, seedStats } from "./helpers";

describe("round robin", () => {
  it("pairs everyone exactly once per round with no repeats in a cycle", () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    const rounds = roundRobinRounds(ids);
    expect(rounds).toHaveLength(5);
    const seen = new Set<string>();
    for (const round of rounds) {
      expect(round).toHaveLength(3);
      const inRound = new Set<string>();
      for (const [home, away] of round) {
        expect(inRound.has(home)).toBe(false);
        expect(inRound.has(away)).toBe(false);
        inRound.add(home);
        inRound.add(away);
        const key = [home, away].sort().join("|");
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
      expect(inRound.size).toBe(6);
    }
    expect(seen.size).toBe(15); // C(6,2)
  });

  it("gives one team a bye each round when the count is odd", () => {
    const rounds = roundRobinRounds(["a", "b", "c", "d", "e"]);
    expect(rounds).toHaveLength(5);
    for (const round of rounds) expect(round).toHaveLength(2);
  });

  it("balances home and away across rounds", () => {
    const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const home: Record<string, number> = Object.fromEntries(ids.map((id) => [id, 0]));
    for (const round of roundRobinRounds(ids)) {
      for (const [h] of round) home[h] += 1;
    }
    const counts = Object.values(home);
    // 7 rounds, so a perfect split is impossible; the spread must stay within
    // one game either side of the ideal. (Home has no scoring effect here — it
    // only decides which side of the matchup card a team renders on.)
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(2);
    expect(Math.min(...counts)).toBeGreaterThan(0);
  });
});

describe("generateSchedule", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("writes one balanced matchup set per regular-season week", async () => {
    const league = await createTestLeague({ teamCount: 8, regularSeasonWeeks: 14 });
    const result = await generateSchedule(league.leagueId);
    expect(result.weeks).toBe(14);
    expect(result.matchups).toBe(14 * 4);

    const rows = await db.select().from(matchups).where(eq(matchups.leagueId, league.leagueId));
    const games: Record<string, number> = {};
    for (const m of rows) {
      games[m.homeTeamId] = (games[m.homeTeamId] ?? 0) + 1;
      games[m.awayTeamId] = (games[m.awayTeamId] ?? 0) + 1;
    }
    for (const teamId of league.teamIds) expect(games[teamId]).toBe(14);
  });

  it("is idempotent", async () => {
    const league = await createTestLeague({ teamCount: 8 });
    await generateSchedule(league.leagueId);
    const second = await generateSchedule(league.leagueId);
    expect(second.matchups).toBe(0);
    const rows = await db.select().from(matchups).where(eq(matchups.leagueId, league.leagueId));
    expect(rows).toHaveLength(14 * 4);
  });
});

describe("scoreWeek", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  async function seasonSetup() {
    const league = await createTestLeague({ teamCount: 8, regularSeasonWeeks: 3 });
    const pool = await seedPlayers(60);
    await seedGames(league.season, 1);
    await generateSchedule(league.leagueId);

    const used = new Set<string>();
    const rosters: Record<string, string[]> = {};
    for (const teamId of league.teamIds) {
      rosters[teamId] = await fillRoster(teamId, pool, used, { QB: 1, RB: 2, WR: 2 });
      await safeCommitLineup(
        {
          teamId,
          weekNo: 1,
          slots: [
            { slot: "QB", playerId: rosters[teamId][0] },
            { slot: "RB1", playerId: rosters[teamId][1] },
            { slot: "BENCH1", playerId: rosters[teamId][2] },
          ],
          source: "agent",
        },
        db,
      );
    }
    return { league, rosters };
  }

  it("sums only starting slots into the matchup score", async () => {
    const { league, rosters } = await seasonSetup();
    const entries = league.teamIds.flatMap((teamId, i) =>
      rosters[teamId].map((playerId, j) => ({
        playerId,
        stats: { rec: 1 },
        // Starters (j < 2) score 10 * (i+1); the bench player scores 1000.
        ppr: j < 2 ? 10 * (i + 1) : 1000,
      })),
    );
    await seedStats(entries, league.season, 1);

    await scoreWeek(league.leagueId, 1);
    const rows = await db
      .select()
      .from(matchups)
      .where(and(eq(matchups.leagueId, league.leagueId), eq(matchups.weekNo, 1)));
    expect(rows).toHaveLength(4);
    for (const m of rows) {
      // Two starters each, never the 1000-point bench player.
      expect(m.homeScore).toBeLessThan(200);
      expect(m.homeScore % 20).toBe(0);
      expect(m.isFinal).toBe(false); // games are still `scheduled`
    }
  });

  it("does not decide wins until every NFL game is final", async () => {
    const { league, rosters } = await seasonSetup();
    await seedStats(
      league.teamIds.map((teamId, i) => ({ playerId: rosters[teamId][0], stats: {}, ppr: 10 * (i + 1) })),
      league.season,
      1,
    );
    await scoreWeek(league.leagueId, 1);
    let results = await db.select().from(teamResults);
    expect(results.every((r) => !r.won && !r.lost && !r.tied)).toBe(true);

    await db.update(nflGames).set({ status: "final" });
    expect(await isWeekComplete(league.season, 1)).toBe(true);
    const finalized = await finalizeWeek(league.leagueId, 1);
    expect(finalized.finalized).toBe(true);

    results = await db.select().from(teamResults);
    expect(results.filter((r) => r.won)).toHaveLength(4);
    expect(results.filter((r) => r.lost)).toHaveLength(4);
  });

  it("ranks standings by record then points for", async () => {
    const { league, rosters } = await seasonSetup();
    await seedStats(
      league.teamIds.map((teamId, i) => ({ playerId: rosters[teamId][0], stats: {}, ppr: 10 * (i + 1) })),
      league.season,
      1,
    );
    await db.update(nflGames).set({ status: "final" });
    await finalizeWeek(league.leagueId, 1);

    const standings = await getStandings(league.leagueId);
    expect(standings).toHaveLength(8);
    expect(standings[0].rank).toBe(1);
    expect(standings[0].wins).toBe(1);
    expect(standings[7].losses).toBe(1);
    for (let i = 1; i < standings.length; i++) {
      const a = standings[i - 1];
      const b = standings[i];
      expect(a.wins > b.wins || (a.wins === b.wins && a.pointsFor >= b.pointsFor)).toBe(true);
    }

    // Waiver priority is the standings, reversed: worst record picks first.
    const priority = await waiverPriorityOrder(league.leagueId);
    expect(priority[0]).toBe(standings[7].teamId);
  });

  it("exposes live scores for the snapshot", async () => {
    const { league, rosters } = await seasonSetup();
    const first = league.teamIds[0];
    await seedStats([{ playerId: rosters[first][0], stats: {}, ppr: 21.5 }], league.season, 1);
    const live = await liveScoresForWeek(league.leagueId, 1);
    expect(live[rosters[first][0]]).toBe(21.5);
  });
});

describe("playoffs", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("gives the top two seeds a bye in a 6-team bracket", () => {
    const seeds = ["s1", "s2", "s3", "s4", "s5", "s6"];
    const bracket = bracketForSeeds(seeds, 6, 15);
    expect(bracket).toEqual([
      { weekNo: 15, homeTeamId: "s3", awayTeamId: "s6" },
      { weekNo: 15, homeTeamId: "s4", awayTeamId: "s5" },
    ]);
  });

  it("pairs 1v4 / 2v3 in a 4-team bracket", () => {
    expect(bracketForSeeds(["a", "b", "c", "d"], 4, 15)).toEqual([
      { weekNo: 15, homeTeamId: "a", awayTeamId: "d" },
      { weekNo: 15, homeTeamId: "b", awayTeamId: "c" },
    ]);
  });

  it("writes the first playoff round from the standings", async () => {
    const league = await createTestLeague({ teamCount: 8, regularSeasonWeeks: 14 });
    await generateSchedule(league.leagueId);
    const result = await seedPlayoffs(league.leagueId);
    expect(result.startWeek).toBe(15);
    expect(result.created).toBe(2);
    const rows = await db
      .select()
      .from(matchups)
      .where(and(eq(matchups.leagueId, league.leagueId), eq(matchups.weekNo, 15)));
    expect(rows).toHaveLength(2);
  });
});
