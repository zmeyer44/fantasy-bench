/**
 * The snapshot builder — the contract every agent reads (lib/snapshot/types.ts).
 */
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import { playerProjections, rosterSlots } from "@/lib/db/schema";
import {
  FREE_AGENT_LIMIT,
  byeWeeksFromSchedule,
  dayBucketFor,
  defaultLineupSlots,
  loadSnapshot,
  takeSnapshot,
} from "@/lib/services/snapshot";
import { safeCommitLineup } from "@/lib/scheduler/lineup-fallback";

import { truncateAll } from "../setup";
import {
  createTestLeague,
  fillRoster,
  seedGames,
  seedPlayers,
  seedProjections,
  seedStats,
} from "./helpers";

const NOW = new Date("2026-09-08T14:00:00Z");

async function setup() {
  const league = await createTestLeague({ teamCount: 8 });
  const pool = await seedPlayers(140);
  await seedProjections(pool, league.season, 1);
  await seedGames(league.season, 1);
  const used = new Set<string>();
  for (const teamId of league.teamIds) await fillRoster(teamId, pool, used);
  return { league, pool, used };
}

describe("dayBucket", () => {
  it("buckets by Eastern kickoff, including the 16:00 boundary", () => {
    expect(dayBucketFor(new Date("2026-09-11T00:15:00Z"))).toBe("thu"); // Thu 20:15 ET
    expect(dayBucketFor(new Date("2026-09-13T17:00:00Z"))).toBe("sun_early"); // Sun 13:00 ET
    expect(dayBucketFor(new Date("2026-09-13T20:00:00Z"))).toBe("sun_late"); // Sun 16:00 ET exactly
    expect(dayBucketFor(new Date("2026-09-13T19:59:00Z"))).toBe("sun_early"); // Sun 15:59 ET
    expect(dayBucketFor(new Date("2026-09-15T00:15:00Z"))).toBe("mon"); // Mon 20:15 ET
    expect(dayBucketFor(new Date("2026-09-12T17:00:00Z"))).toBe("other"); // Saturday
  });

  it("stays correct across the DST switch", () => {
    // 2026-11-01 is the DST end date; 21:00Z is 16:00 EST, so `sun_late`.
    expect(dayBucketFor(new Date("2026-11-01T21:00:00Z"))).toBe("sun_late");
    // 20:00Z is 15:00 EST — still early.
    expect(dayBucketFor(new Date("2026-11-01T20:00:00Z"))).toBe("sun_early");
    // A week earlier (EDT) 20:00Z is 16:00 ET — late.
    expect(dayBucketFor(new Date("2026-10-25T20:00:00Z"))).toBe("sun_late");
  });
});

describe("bye weeks", () => {
  it("derives the missing week from the schedule", () => {
    const games: Array<{ week: number; homeTeam: string; awayTeam: string }> = [];
    for (let week = 1; week <= 18; week++) {
      if (week !== 7) games.push({ week, homeTeam: "KC", awayTeam: "BUF" });
    }
    expect(byeWeeksFromSchedule(games, 18).get("KC")).toBe(7);
  });

  it("refuses to guess from a partial schedule", () => {
    const games = [{ week: 1, homeTeam: "KC", awayTeam: "BUF" }];
    expect(byeWeeksFromSchedule(games, 18).has("KC")).toBe(false);
  });
});

describe("default lineup shape", () => {
  it("numbers repeated slots and keeps a stable order", () => {
    expect(defaultLineupSlots({ QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DEF: 1, BENCH: 3 })).toEqual([
      { slot: "QB", playerId: null },
      { slot: "RB1", playerId: null },
      { slot: "RB2", playerId: null },
      { slot: "WR1", playerId: null },
      { slot: "WR2", playerId: null },
      { slot: "TE", playerId: null },
      { slot: "FLEX", playerId: null },
      { slot: "K", playerId: null },
      { slot: "DEF", playerId: null },
      { slot: "BENCH1", playerId: null },
      { slot: "BENCH2", playerId: null },
      { slot: "BENCH3", playerId: null },
    ]);
  });
});

describe("takeSnapshot", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("produces a payload matching the contract", async () => {
    const { league } = await setup();
    const { snapshotId, payload, digest } = await takeSnapshot(
      { leagueId: league.leagueId, weekNo: 1, now: NOW },
      db,
    );

    expect(payload.version).toBe(1);
    expect(payload.leagueId).toBe(league.leagueId);
    expect(payload.weekNo).toBe(1);
    expect(payload.takenAt).toBe(NOW.toISOString());
    expect(payload.rules.scoringPreset).toBe("ppr");
    expect(payload.teams).toHaveLength(8);
    expect(payload.games).toHaveLength(4);
    expect(digest.headline).toContain("Week 1");

    const reloaded = await loadSnapshot(snapshotId, db);
    expect(reloaded.payload.leagueId).toBe(league.leagueId);
  });

  it("carries every rostered player plus ranked free agents", async () => {
    const { league } = await setup();
    const { payload } = await takeSnapshot({ leagueId: league.leagueId, weekNo: 1, now: NOW }, db);

    const rostered = await db
      .select({ playerId: rosterSlots.playerId })
      .from(rosterSlots);
    for (const row of rostered) {
      expect(payload.players[row.playerId]).toBeDefined();
      expect(payload.players[row.playerId].ownerTeamId).not.toBeNull();
    }

    expect(payload.freeAgentIds.length).toBeGreaterThan(0);
    expect(payload.freeAgentIds.length).toBeLessThanOrEqual(FREE_AGENT_LIMIT);
    for (const id of payload.freeAgentIds) {
      expect(payload.players[id].ownerTeamId).toBeNull();
    }
    // Free agents are ordered by this week's projection, descending.
    const points = payload.freeAgentIds.map((id) => payload.players[id].projection?.ppr ?? -1);
    expect([...points].sort((a, b) => b - a)).toEqual(points);
  });

  it("gives every player a numeric projection, a lock time and an opponent", async () => {
    const { league } = await setup();
    const { payload } = await takeSnapshot({ leagueId: league.leagueId, weekNo: 1, now: NOW }, db);
    const player = Object.values(payload.players).find((p) => p.projection && p.nflTeam === "KC");
    expect(player).toBeDefined();
    // Numeric, not the string postgres returns for `numeric` columns.
    expect(typeof player!.projection!.ppr).toBe("number");
    expect(player!.opponent).toBe("BUF");
    expect(player!.gameId).toBe(`${league.season}_1_KC_BUF`);
    expect(player!.kickoffAt).toBe("2026-09-11T00:15:00.000Z");
  });

  it("leaves opponent and lock time null for a team on bye", async () => {
    const league = await createTestLeague({ teamCount: 8 });
    const pool = await seedPlayers(60);
    await seedProjections(pool, league.season, 1);
    // Only one game: everyone else is effectively on bye this week.
    await seedGames(league.season, 1);
    const used = new Set<string>();
    await fillRoster(league.teamIds[0], pool, used);
    const { payload } = await takeSnapshot({ leagueId: league.leagueId, weekNo: 1, now: NOW }, db);
    const bye = Object.values(payload.players).find((p) => p.nflTeam === "PHI");
    // PHI plays in the seeded slate, so pick a team that does not.
    expect(bye).toBeDefined();
    const noGame = Object.values(payload.players).find(
      (p) => p.nflTeam !== null && !payload.games.some((g) => g.homeTeam === p.nflTeam || g.awayTeam === p.nflTeam),
    );
    if (noGame) {
      expect(noGame.opponent).toBeNull();
      expect(noGame.kickoffAt).toBeNull();
    }
  });

  it("pins the projection vintage to takenAt", async () => {
    const { league, pool } = await setup();
    const target = pool[0];
    // A later vintage that the snapshot must NOT see.
    await db.insert(playerProjections).values({
      playerId: target.id,
      season: league.season,
      week: 1,
      source: "test",
      projectedPointsPpr: 99,
      projectedPointsHalf: 99,
      projectedPointsStd: 99,
      stats: {},
      effectiveAt: new Date(NOW.getTime() + 60 * 60 * 1000),
    });

    const { payload } = await takeSnapshot({ leagueId: league.leagueId, weekNo: 1, now: NOW }, db);
    expect(payload.players[target.id].projection?.ppr).not.toBe(99);

    const later = await takeSnapshot(
      { leagueId: league.leagueId, weekNo: 1, now: new Date(NOW.getTime() + 2 * 60 * 60 * 1000) },
      db,
    );
    expect(later.payload.players[target.id].projection?.ppr).toBe(99);
  });

  it("sums rest-of-season projections from future weeks", async () => {
    const { league, pool } = await setup();
    await seedProjections(pool.slice(0, 5), league.season, 2, new Date("2026-09-08T11:00:00Z"));
    const { payload } = await takeSnapshot({ leagueId: league.leagueId, weekNo: 1, now: NOW }, db);
    expect(payload.players[pool[0].id].rosProjection).toBeGreaterThan(0);
  });

  it("reports last-week and season points from stored stats", async () => {
    const league = await createTestLeague({ teamCount: 8 });
    const pool = await seedPlayers(60);
    await seedProjections(pool, league.season, 2);
    await seedGames(league.season, 2);
    const used = new Set<string>();
    const roster = await fillRoster(league.teamIds[0], pool, used);
    await seedStats([{ playerId: roster[0], stats: { rec: 5 }, ppr: 17.5 }], league.season, 1);

    const { payload } = await takeSnapshot({ leagueId: league.leagueId, weekNo: 2, now: NOW }, db);
    expect(payload.players[roster[0]].lastWeekPoints).toBe(17.5);
    expect(payload.players[roster[0]].seasonPoints).toBe(17.5);
  });

  it("uses the team's latest lineup version, or the default shape", async () => {
    const { league } = await setup();
    const before = await takeSnapshot({ leagueId: league.leagueId, weekNo: 1, now: NOW }, db);
    const shaped = before.payload.teams[0].lineup;
    expect(shaped.every((s) => s.playerId === null)).toBe(true);
    expect(shaped).toHaveLength(15);

    const roster = before.payload.teams[0].rosterPlayerIds;
    await safeCommitLineup(
      {
        teamId: league.teamIds[0],
        weekNo: 1,
        slots: shaped.map((s, i) => ({ slot: s.slot, playerId: roster[i] ?? null })),
        source: "agent",
      },
      db,
    );

    const after = await takeSnapshot({ leagueId: league.leagueId, weekNo: 1, now: NOW }, db);
    const team = after.payload.teams.find((t) => t.id === league.teamIds[0])!;
    expect(team.lineup[0].playerId).toBe(roster[0]);
  });

  it("stays well under the 1.5 MB payload budget", async () => {
    const { league } = await setup();
    const { payload } = await takeSnapshot({ leagueId: league.leagueId, weekNo: 1, now: NOW }, db);
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(1_500_000);
  });

  it("diffs injuries and projections against the previous snapshot", async () => {
    const { league, pool } = await setup();
    await takeSnapshot({ leagueId: league.leagueId, weekNo: 1, now: NOW }, db);

    const later = new Date(NOW.getTime() + 60 * 60 * 1000);
    await db.insert(playerProjections).values({
      playerId: pool[0].id,
      season: league.season,
      week: 1,
      source: "test",
      projectedPointsPpr: 99,
      projectedPointsHalf: 99,
      projectedPointsStd: 99,
      stats: {},
      effectiveAt: later,
    });
    const second = await takeSnapshot({ leagueId: league.leagueId, weekNo: 1, now: later }, db);
    const mover = second.digest.projectionMovers.find((m) => m.playerId === pool[0].id);
    expect(mover).toBeDefined();
    expect(mover!.delta).toBeGreaterThan(50);
  });
});
