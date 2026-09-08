/**
 * Schedule generation and the standings-derived orderings.
 *
 * The round robin is pure, so it is checked directly for the two properties the
 * season depends on: every pair meets exactly once per cycle, and home/away
 * stays balanced. `generateSchedule` then has to be idempotent, because a draft
 * can finalize more than once.
 */
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { bracketForSeeds, roundRobinRounds, streakOf, winnerOf } from "./lib/standings_pure";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const NOW = Date.parse("2026-09-15T12:00:00.000Z");

const RULES = {
  scoringPreset: "ppr" as const,
  superflex: false,
  tePremium: false,
  rosterSlots: { QB: 1, RB: 1, BENCH: 1 },
  faabBudget: 100,
  playoffTeams: 6,
  playoffStartWeek: 7,
  regularSeasonWeeks: 6,
  seasonWeeks: 8,
  transparencyMode: "live" as const,
  injectionPolicy: "permitted" as const,
  modelAllowlist: [],
  contextCharLimit: 8000,
  maxStepsCap: 12,
  editLock: { unlockDay: "tue", unlockTime: "06:00", lockDay: "wed", lockTime: "03:00" },
  tradeReviewHours: 24,
  antiChurnWeeks: 3,
  maxOpenProposals: 3,
  maxMessagesPerRun: 6,
  maxThreadsPerWindow: 4,
  forumPostsPerDay: 2,
  forumCommentsPerDay: 6,
  safetyAutopilot: true,
  runWallclockSeconds: 300,
  draftPickSeconds: 90,
  reuseSnapshotWithinMs: 60_000,
  draftBudget: 200,
};

const NAMES = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"];

async function fixture(t: TestConvex<typeof schema>, teamCount = 6) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: "commish@x.dev" });
    const leagueId = await ctx.db.insert("leagues", {
      name: "Standings",
      slug: `st-${Math.random()}`,
      commissionerUserId: userId,
      season: 2026,
      teamCount,
      isPublic: true,
      status: "in_season",
      draftType: "snake",
      updatedAt: NOW,
    });
    await ctx.db.insert("league_rules", { leagueId, ...RULES });
    const teamIds: Id<"teams">[] = [];
    for (let i = 0; i < teamCount; i++) {
      teamIds.push(
        await ctx.db.insert("teams", {
          leagueId,
          name: NAMES[i],
          abbreviation: NAMES[i].slice(0, 2).toUpperCase(),
          faabRemaining: 100,
          waiverPriority: i + 1,
          karma: 0,
          draftBudgetRemaining: 0,
          createdAt: NOW + i,
        }),
      );
    }
    return { leagueId, teamIds };
  });
}

describe("standings_pure", () => {
  test("pairs everyone exactly once per cycle with no repeats", () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    const rounds = roundRobinRounds(ids);
    expect(rounds).toHaveLength(5);
    const seen = new Set<string>();
    for (const round of rounds) {
      expect(round).toHaveLength(3);
      const inRound = new Set<string>();
      for (const [home, away] of round) {
        const key = [home, away].sort().join("|");
        expect(seen.has(key)).toBe(false);
        seen.add(key);
        expect(inRound.has(home)).toBe(false);
        expect(inRound.has(away)).toBe(false);
        inRound.add(home);
        inRound.add(away);
      }
      expect(inRound.size).toBe(6);
    }
    expect(seen.size).toBe(15);
  });

  test("gives one team a bye each round when the count is odd", () => {
    const rounds = roundRobinRounds(["a", "b", "c", "d", "e"]);
    expect(rounds).toHaveLength(5);
    for (const round of rounds) expect(round).toHaveLength(2);
  });

  test("balances home and away across the cycle", () => {
    const rounds = roundRobinRounds(["a", "b", "c", "d"]);
    const home = new Map<string, number>();
    for (const round of rounds) {
      for (const [h] of round) home.set(h, (home.get(h) ?? 0) + 1);
    }
    for (const count of home.values()) expect(Math.abs(count - 1.5)).toBeLessThanOrEqual(0.5);
  });

  test("seeds a 6-team bracket with byes and a 4-team bracket 1v4 / 2v3", () => {
    const six = bracketForSeeds(["s1", "s2", "s3", "s4", "s5", "s6"], 6, 15);
    expect(six).toEqual([
      { weekNo: 15, homeTeamId: "s3", awayTeamId: "s6" },
      { weekNo: 15, homeTeamId: "s4", awayTeamId: "s5" },
    ]);
    const four = bracketForSeeds(["s1", "s2", "s3", "s4"], 4, 15);
    expect(four).toEqual([
      { weekNo: 15, homeTeamId: "s1", awayTeamId: "s4" },
      { weekNo: 15, homeTeamId: "s2", awayTeamId: "s3" },
    ]);
    expect(bracketForSeeds(["only"], 4, 15)).toEqual([]);
  });

  test("reads a winner and a streak", () => {
    expect(winnerOf({ homeTeamId: "h", awayTeamId: "a", homeScore: 10, awayScore: 9 })).toBe("h");
    expect(winnerOf({ homeTeamId: "h", awayTeamId: "a", homeScore: 9, awayScore: 9 })).toBeNull();
    expect(streakOf([])).toBe("—");
    expect(
      streakOf([
        { won: false, lost: true, tied: false },
        { won: true, lost: false, tied: false },
        { won: true, lost: false, tied: false },
      ]),
    ).toBe("W2");
  });
});

describe("standings.generateSchedule", () => {
  test("writes one balanced matchup set per regular-season week", async () => {
    const t = convexTest(schema, modules);
    const f = await fixture(t);
    const result = await t.mutation(internal.standings.generateSchedule, {
      leagueId: f.leagueId,
    });
    expect(result).toEqual({ weeks: 6, matchups: 18 });

    const perTeam = new Map<string, number>();
    for (let weekNo = 1; weekNo <= 6; weekNo++) {
      const rows = await t.run(async (ctx) =>
        ctx.db
          .query("matchups")
          .withIndex("by_leagueId_weekNo", (q) => q.eq("leagueId", f.leagueId).eq("weekNo", weekNo))
          .collect(),
      );
      expect(rows).toHaveLength(3);
      const playing = new Set(rows.flatMap((m) => [m.homeTeamId, m.awayTeamId]));
      expect(playing.size).toBe(6);
      for (const id of playing) perTeam.set(id, (perTeam.get(id) ?? 0) + 1);
    }
    // Every team plays every week.
    for (const teamId of f.teamIds) expect(perTeam.get(teamId)).toBe(6);
  });

  test("is idempotent", async () => {
    const t = convexTest(schema, modules);
    const f = await fixture(t);
    await t.mutation(internal.standings.generateSchedule, { leagueId: f.leagueId });
    expect(
      await t.mutation(internal.standings.generateSchedule, { leagueId: f.leagueId }),
    ).toEqual({ weeks: 0, matchups: 0 });
  });

  test("does nothing for a league that cannot field a game", async () => {
    const t = convexTest(schema, modules);
    const f = await fixture(t, 1);
    expect(
      await t.mutation(internal.standings.generateSchedule, { leagueId: f.leagueId }),
    ).toEqual({ weeks: 0, matchups: 0 });
  });
});

describe("standings.waiverPriorityOrder", () => {
  test("is worst-record-first, and the creation order before a game is played", async () => {
    const t = convexTest(schema, modules);
    const f = await fixture(t, 3);

    // No standings rows yet: everybody is 0-0-0 and the name tiebreak decides,
    // reversed — Charlie, Bravo, Alpha.
    expect(await t.query(internal.standings.waiverPriorityOrder, { leagueId: f.leagueId })).toEqual([
      f.teamIds[2],
      f.teamIds[1],
      f.teamIds[0],
    ]);

    await t.run(async (ctx) => {
      const rows = [
        { teamId: f.teamIds[0], wins: 3, losses: 0, pointsFor: 300 },
        { teamId: f.teamIds[1], wins: 1, losses: 2, pointsFor: 200 },
        { teamId: f.teamIds[2], wins: 2, losses: 1, pointsFor: 250 },
      ];
      for (const row of rows) {
        await ctx.db.insert("team_standings", {
          leagueId: f.leagueId,
          teamId: row.teamId,
          season: 2026,
          wins: row.wins,
          losses: row.losses,
          ties: 0,
          pointsFor: row.pointsFor,
          pointsAgainst: 0,
          streak: "W1",
          updatedAt: NOW,
        });
      }
    });

    expect(await t.query(internal.standings.waiverPriorityOrder, { leagueId: f.leagueId })).toEqual([
      f.teamIds[1],
      f.teamIds[2],
      f.teamIds[0],
    ]);
  });
});
