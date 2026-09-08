/**
 * Scoring: the position-aware point table (pure), the weekly scorer that feeds
 * `matchups` / `team_results` / `team_standings`, and week finalization with
 * playoff seeding.
 */
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { computeFantasyPoints, isStartingSlot } from "./lib/scoring_pure";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const NOW = Date.parse("2026-09-15T12:00:00.000Z");

const RULES = {
  scoringPreset: "ppr" as const,
  superflex: false,
  tePremium: false,
  rosterSlots: { QB: 1, RB: 1, K: 1, DEF: 1, BENCH: 1 },
  faabBudget: 100,
  playoffTeams: 4,
  playoffStartWeek: 3,
  regularSeasonWeeks: 2,
  seasonWeeks: 4,
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

/** Alpha scores 40 a week, Bravo 30, Charlie 20, Delta 10 — plus 99 on the bench. */
const TEAMS = [
  { name: "Alpha", points: 40 },
  { name: "Bravo", points: 30 },
  { name: "Charlie", points: 20 },
  { name: "Delta", points: 10 },
];

const POSITIONS = ["QB", "RB", "K", "DEF"] as const;

async function fixture(t: TestConvex<typeof schema>, opts: { gameStatus?: string } = {}) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: "commish@x.dev" });
    const leagueId = await ctx.db.insert("leagues", {
      name: "Scoring",
      slug: `sc-${Math.random()}`,
      commissionerUserId: userId,
      season: 2026,
      teamCount: 4,
      isPublic: true,
      status: "in_season",
      draftType: "snake",
      updatedAt: NOW,
    });
    await ctx.db.insert("league_rules", { leagueId, ...RULES });
    for (let weekNo = 1; weekNo <= 4; weekNo++) {
      await ctx.db.insert("weeks", {
        leagueId,
        weekNo,
        startsAt: NOW - (5 - weekNo) * 86_400_000,
        endsAt: NOW - (4 - weekNo) * 86_400_000,
        isPlayoff: false,
        status: "active",
      });
    }
    for (let week = 1; week <= 2; week++) {
      await ctx.db.insert("nfl_games", {
        season: 2026,
        week,
        gameId: `g${week}`,
        homeTeam: "SF",
        awayTeam: "SEA",
        kickoffAt: NOW - 86_400_000,
        status: opts.gameStatus ?? "final",
      });
    }

    const teamIds: Id<"teams">[] = [];
    for (const [i, spec] of TEAMS.entries()) {
      const teamId = await ctx.db.insert("teams", {
        leagueId,
        name: spec.name,
        abbreviation: spec.name.slice(0, 2).toUpperCase(),
        faabRemaining: 100,
        waiverPriority: i + 1,
        karma: 0,
        draftBudgetRemaining: 0,
        createdAt: NOW + i,
      });
      teamIds.push(teamId);

      // Four starters worth a quarter of the team's total each, plus a 99-point
      // bench player who must never appear in the score.
      const slots: Array<{ slot: string; playerId: Id<"players"> | null }> = [];
      for (const position of POSITIONS) {
        const playerId = await ctx.db.insert("players", {
          sleeperId: `${spec.name}-${position}`,
          fullName: `${spec.name} ${position}`,
          position,
          nflTeam: "SF",
          fantasyPositions: [position],
          externalIds: {},
          updatedAt: NOW,
        });
        slots.push({ slot: position, playerId });
        for (let week = 1; week <= 2; week++) {
          await ctx.db.insert("player_stats_weekly", {
            playerId,
            season: 2026,
            week,
            source: "sleeper",
            stats: {},
            fantasyPointsPpr: spec.points / 4,
            fantasyPointsHalf: spec.points / 4,
            fantasyPointsStd: spec.points / 4,
            effectiveAt: NOW,
          });
        }
        await ctx.db.insert("roster_slots", {
          leagueId,
          teamId,
          playerId,
          acquiredAt: NOW,
          acquiredVia: "draft",
        });
      }
      const benchId = await ctx.db.insert("players", {
        sleeperId: `${spec.name}-bench`,
        fullName: `${spec.name} Bench`,
        position: "RB",
        nflTeam: "SF",
        fantasyPositions: ["RB"],
        externalIds: {},
        updatedAt: NOW,
      });
      slots.push({ slot: "BENCH", playerId: benchId });
      for (let week = 1; week <= 2; week++) {
        await ctx.db.insert("player_stats_weekly", {
          playerId: benchId,
          season: 2026,
          week,
          source: "sleeper",
          stats: {},
          fantasyPointsPpr: 99,
          fantasyPointsHalf: 99,
          fantasyPointsStd: 99,
          effectiveAt: NOW,
        });
      }
      await ctx.db.insert("roster_slots", {
        leagueId,
        teamId,
        playerId: benchId,
        acquiredAt: NOW,
        acquiredVia: "draft",
      });

      for (let week = 1; week <= 2; week++) {
        await ctx.db.insert("lineups", {
          teamId,
          leagueId,
          weekNo: week,
          version: 1,
          slots,
          source: "agent",
        });
      }
    }

    return { leagueId, teamIds };
  });
}

describe("computeFantasyPoints", () => {
  test("scores a QB the same under every preset", () => {
    const line = { pass_yd: 300, pass_td: 3, pass_int: 1, rush_yd: 20, rush_td: 1 };
    const expected = 300 * 0.04 + 12 - 2 + 2 + 6;
    for (const preset of ["ppr", "half_ppr", "standard"] as const) {
      expect(computeFantasyPoints(line, preset, { position: "QB" })).toBe(expected);
    }
  });

  test("applies the reception value per preset for a pass catcher", () => {
    const line = { rec: 8, rec_yd: 90, rec_td: 1 };
    expect(computeFantasyPoints(line, "ppr", { position: "WR" })).toBe(23);
    expect(computeFantasyPoints(line, "half_ppr", { position: "WR" })).toBe(19);
    expect(computeFantasyPoints(line, "standard", { position: "WR" })).toBe(15);
    // TE premium is a TE-only bonus.
    expect(computeFantasyPoints(line, "ppr", { position: "TE", tePremium: true })).toBe(27);
    expect(computeFantasyPoints(line, "ppr", { position: "WR", tePremium: true })).toBe(23);
  });

  test("scores a kicker's buckets without double-counting the 50+ overlap", () => {
    expect(
      computeFantasyPoints({ fgm_0_19: 1, fgm_40_49: 1, fgm_50p: 1, xpm: 3, fgmiss: 1 }, "ppr", {
        position: "K",
      }),
    ).toBe(3 + 4 + 5 + 3 - 1);
    expect(
      computeFantasyPoints({ fgm_50p: 2, fgm_50_59: 1, fgm_60p: 1 }, "ppr", { position: "K" }),
    ).toBe(10);
  });

  test("scores a defense's turnovers, TDs and points-allowed tier", () => {
    expect(
      computeFantasyPoints(
        { sack: 3, int: 2, fum_rec: 1, def_td: 1, safe: 1, pts_allow: 10 },
        "ppr",
        { position: "DEF" },
      ),
    ).toBe(3 + 4 + 2 + 6 + 2 + 4);
    // Sleeper's actual DEF rows use `td` rather than `def_td`.
    expect(computeFantasyPoints({ td: 1, pts_allow: 0 }, "ppr", { position: "DEF" })).toBe(16);
  });

  test("knows which slots score", () => {
    expect(isStartingSlot("QB")).toBe(true);
    expect(isStartingSlot("BENCH")).toBe(false);
    expect(isStartingSlot("IR")).toBe(false);
  });
});

describe("scoring.scoreLeague", () => {
  test("sums only starting slots and maintains team_standings with a streak", async () => {
    const t = convexTest(schema, modules);
    const f = await fixture(t);
    await t.mutation(internal.standings.generateSchedule, { leagueId: f.leagueId });

    for (const weekNo of [1, 2]) {
      const result = await t.mutation(internal.scoring.scoreLeague, {
        leagueId: f.leagueId,
        weekNo,
      });
      expect(result).toEqual({ teams: 4, matchups: 2, finalized: true });
    }

    const state = await t.run(async (ctx) => ({
      week1: await ctx.db
        .query("matchups")
        .withIndex("by_leagueId_weekNo", (q) => q.eq("leagueId", f.leagueId).eq("weekNo", 1))
        .collect(),
      standings: await ctx.db
        .query("team_standings")
        .withIndex("by_leagueId_season", (q) => q.eq("leagueId", f.leagueId).eq("season", 2026))
        .collect(),
      teams: await ctx.db
        .query("teams")
        .withIndex("by_leagueId", (q) => q.eq("leagueId", f.leagueId))
        .collect(),
    }));

    // The 99-point bench player is nowhere in the scores.
    const scored = state.week1.flatMap((m) => [m.homeScore, m.awayScore]).sort((a, b) => a! - b!);
    expect(scored).toEqual([10, 20, 30, 40]);
    expect(state.week1.every((m) => m.isFinal)).toBe(true);

    const nameOf = new Map(state.teams.map((team) => [team._id as string, team.name]));
    const byName = Object.fromEntries(
      state.standings.map((s) => [nameOf.get(s.teamId)!, s]),
    );
    expect(byName.Alpha).toMatchObject({ wins: 2, losses: 0, ties: 0, pointsFor: 80, streak: "W2" });
    expect(byName.Delta).toMatchObject({ wins: 0, losses: 2, pointsFor: 20, streak: "L2" });
    expect(byName.Alpha.pointsAgainst).toBeGreaterThan(0);
  });

  test("records points but decides nothing while a game is still live", async () => {
    const t = convexTest(schema, modules);
    const f = await fixture(t, { gameStatus: "in_progress" });
    await t.mutation(internal.standings.generateSchedule, { leagueId: f.leagueId });
    const result = await t.mutation(internal.scoring.scoreLeague, {
      leagueId: f.leagueId,
      weekNo: 1,
    });
    expect(result.finalized).toBe(false);

    const state = await t.run(async (ctx) => ({
      matchups: await ctx.db
        .query("matchups")
        .withIndex("by_leagueId_weekNo", (q) => q.eq("leagueId", f.leagueId).eq("weekNo", 1))
        .collect(),
      standings: await ctx.db
        .query("team_standings")
        .withIndex("by_leagueId_season", (q) => q.eq("leagueId", f.leagueId).eq("season", 2026))
        .collect(),
    }));
    expect(state.matchups.every((m) => !m.isFinal)).toBe(true);
    expect(state.matchups.every((m) => (m.homeScore ?? 0) > 0)).toBe(true);
    expect(state.standings.every((s) => s.wins === 0 && s.losses === 0)).toBe(true);
    expect(state.standings.every((s) => s.streak === "—")).toBe(true);
  });

  test("exposes live scores for the snapshot builder", async () => {
    const t = convexTest(schema, modules);
    const f = await fixture(t);
    const live = await t.query(internal.scoring.liveScoresForWeek, {
      leagueId: f.leagueId,
      weekNo: 1,
    });
    // 4 starters + 1 bench player per team, all with a stat line.
    expect(Object.keys(live)).toHaveLength(20);
    expect(Object.values(live).filter((p) => p === 99)).toHaveLength(4);
  });
});

describe("scoring.finalizeWeek", () => {
  test("waits for every NFL game, then closes the week and seeds the bracket", async () => {
    const t = convexTest(schema, modules);
    const f = await fixture(t, { gameStatus: "in_progress" });
    await t.mutation(internal.standings.generateSchedule, { leagueId: f.leagueId });

    expect(
      await t.mutation(internal.scoring.finalizeWeek, { leagueId: f.leagueId, weekNo: 1 }),
    ).toMatchObject({ finalized: false });
    const stillOpen = await t.run(async (ctx) =>
      ctx.db
        .query("weeks")
        .withIndex("by_leagueId_weekNo", (q) => q.eq("leagueId", f.leagueId).eq("weekNo", 1))
        .first(),
    );
    expect(stillOpen?.status).toBe("active");

    await t.run(async (ctx) => {
      for (const game of await ctx.db
        .query("nfl_games")
        .withIndex("by_season_week", (q) => q.eq("season", 2026))
        .collect()) {
        await ctx.db.patch("nfl_games", game._id, { status: "final" });
      }
    });

    expect(
      await t.mutation(internal.scoring.finalizeWeek, { leagueId: f.leagueId, weekNo: 1 }),
    ).toMatchObject({ finalized: true, playoffsSeeded: 0 });

    // Week 2 is the last regular-season week: finalizing it seeds week 3.
    const closed = await t.mutation(internal.scoring.finalizeWeek, {
      leagueId: f.leagueId,
      weekNo: 2,
    });
    expect(closed).toMatchObject({ finalized: true, playoffsSeeded: 2 });

    const bracket = await t.run(async (ctx) => ({
      matchups: await ctx.db
        .query("matchups")
        .withIndex("by_leagueId_weekNo", (q) => q.eq("leagueId", f.leagueId).eq("weekNo", 3))
        .collect(),
      week3: await ctx.db
        .query("weeks")
        .withIndex("by_leagueId_weekNo", (q) => q.eq("leagueId", f.leagueId).eq("weekNo", 3))
        .first(),
      week2: await ctx.db
        .query("weeks")
        .withIndex("by_leagueId_weekNo", (q) => q.eq("leagueId", f.leagueId).eq("weekNo", 2))
        .first(),
      teams: await ctx.db
        .query("teams")
        .withIndex("by_leagueId", (q) => q.eq("leagueId", f.leagueId))
        .collect(),
    }));
    expect(bracket.week2?.status).toBe("complete");
    expect(bracket.week3?.isPlayoff).toBe(true);
    const nameOf = new Map(bracket.teams.map((team) => [team._id as string, team.name]));
    // 1v4 and 2v3 on the final standings: Alpha is the top seed, Delta the last.
    const pairs = bracket.matchups.map((m) => [nameOf.get(m.homeTeamId), nameOf.get(m.awayTeamId)]);
    expect(pairs).toContainEqual(["Alpha", "Delta"]);
    expect(pairs).toContainEqual(["Bravo", "Charlie"]);

    // Seeding is idempotent.
    expect(
      (await t.mutation(internal.scoring.finalizeWeek, { leagueId: f.leagueId, weekNo: 2 }))
        .playoffsSeeded,
    ).toBe(0);
  });
});
