import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { leagueRules, playerProjections } from "@/lib/db/schema";
import {
  DEFAULT_FAIRNESS_FLOOR,
  POSITION_SCARCITY,
  scoreTrade,
  startingSlotsFor,
  wouldStart,
} from "@/lib/services/trades/fairness";

import { db, truncateAll } from "../setup";
import { SEASON, seedLeague } from "./helpers";

beforeAll(async () => {
  await truncateAll();
});

/** Overwrite the seeded projection ladder so a test can dial exact values. */
async function setProjection(playerId: string, weekNo: number, points: number) {
  await db
    .update(playerProjections)
    .set({
      projectedPointsPpr: points,
      projectedPointsHalf: points,
      projectedPointsStd: points,
    })
    .where(eq(playerProjections.playerId, playerId));
  // Guard against the seed row being for a different week.
  const rows = await db
    .select()
    .from(playerProjections)
    .where(eq(playerProjections.playerId, playerId));
  if (rows.length === 0) {
    await db.insert(playerProjections).values({
      playerId,
      season: SEASON,
      week: weekNo,
      source: "test",
      projectedPointsPpr: points,
      projectedPointsHalf: points,
      projectedPointsStd: points,
    });
  }
}

describe("fairness scoring", () => {
  it("scores an even swap near 1 and a lopsided one near 0", async () => {
    const seed = await seedLeague();
    const [a, b] = seed.teams;
    // Same position, same projection: as even as a trade gets.
    await setProjection(seed.roster[a.id][1], seed.weekNo, 12);
    await setProjection(seed.roster[b.id][1], seed.weekNo, 12);

    const even = await scoreTrade({
      leagueId: seed.leagueId,
      proposerTeamId: a.id,
      recipientTeamId: b.id,
      weekNo: seed.weekNo,
      give: [seed.roster[a.id][1]],
      receive: [seed.roster[b.id][1]],
    });
    expect(even.score).toBeGreaterThan(0.95);
    expect(even.flagged).toBe(false);

    await setProjection(seed.roster[a.id][1], seed.weekNo, 1);
    const lopsided = await scoreTrade({
      leagueId: seed.leagueId,
      proposerTeamId: a.id,
      recipientTeamId: b.id,
      weekNo: seed.weekNo,
      give: [seed.roster[a.id][1]],
      receive: [seed.roster[b.id][1]],
    });
    expect(lopsided.score).toBeLessThan(0.2);
    expect(lopsided.flagged).toBe(true);
    expect(lopsided.detail.floor).toBe(DEFAULT_FAIRNESS_FLOOR);
  });

  it("is monotonic: adding value to the light side raises the score", async () => {
    const seed = await seedLeague({ playersPerTeam: 6 });
    const [a, b] = seed.teams;
    // A sends a 4-point player; B sends a 20-point player.
    await setProjection(seed.roster[a.id][1], seed.weekNo, 4);
    await setProjection(seed.roster[a.id][5], seed.weekNo, 4);
    await setProjection(seed.roster[b.id][1], seed.weekNo, 20);

    const base = {
      leagueId: seed.leagueId,
      proposerTeamId: a.id,
      recipientTeamId: b.id,
      weekNo: seed.weekNo,
      receive: [seed.roster[b.id][1]],
    };

    const thin = await scoreTrade({ ...base, give: [seed.roster[a.id][1]] });
    const fatter = await scoreTrade({
      ...base,
      give: [seed.roster[a.id][1], seed.roster[a.id][5]],
    });
    const withFaab = await scoreTrade({
      ...base,
      give: [seed.roster[a.id][1], seed.roster[a.id][5]],
      faab: 20,
    });

    expect(fatter.score).toBeGreaterThan(thin.score);
    expect(withFaab.score).toBeGreaterThan(fatter.score);
    expect(withFaab.detail.faabPoints).toBeGreaterThan(0);
  });

  it("respects a league's custom fairness floor", async () => {
    const seed = await seedLeague();
    const [a, b] = seed.teams;
    await setProjection(seed.roster[a.id][1], seed.weekNo, 8);
    await setProjection(seed.roster[b.id][1], seed.weekNo, 10);

    const loose = await scoreTrade({
      leagueId: seed.leagueId,
      proposerTeamId: a.id,
      recipientTeamId: b.id,
      weekNo: seed.weekNo,
      give: [seed.roster[a.id][1]],
      receive: [seed.roster[b.id][1]],
    });
    expect(loose.flagged).toBe(false);

    await db
      .update(leagueRules)
      .set({ fairnessFloor: 0.95 })
      .where(eq(leagueRules.leagueId, seed.leagueId));

    const strict = await scoreTrade({
      leagueId: seed.leagueId,
      proposerTeamId: a.id,
      recipientTeamId: b.id,
      weekNo: seed.weekNo,
      give: [seed.roster[a.id][1]],
      receive: [seed.roster[b.id][1]],
    });
    expect(strict.score).toBe(loose.score);
    expect(strict.flagged).toBe(true);
    expect(strict.detail.floor).toBe(0.95);
  });

  it("publishes a per-player breakdown", async () => {
    const seed = await seedLeague();
    const [a, b] = seed.teams;
    const result = await scoreTrade({
      leagueId: seed.leagueId,
      proposerTeamId: a.id,
      recipientTeamId: b.id,
      weekNo: seed.weekNo,
      give: [seed.roster[a.id][1]],
      receive: [seed.roster[b.id][1]],
    });

    expect(result.detail.version).toBe(1);
    expect(result.detail.method).toBe("ros_projection_v1");
    expect(result.detail.items).toHaveLength(2);
    for (const item of result.detail.items) {
      expect(item.baseRos).toBeGreaterThan(0);
      expect(item.scarcity).toBe(POSITION_SCARCITY[item.position]);
      expect(item.value).toBeCloseTo(item.baseRos * item.scarcity * item.rosterFit, 1);
    }
  });

  it("scores a trade with no projection data as neutral rather than flagged", async () => {
    const seed = await seedLeague();
    const [a, b] = seed.teams;
    await db.delete(playerProjections);

    const result = await scoreTrade({
      leagueId: seed.leagueId,
      proposerTeamId: a.id,
      recipientTeamId: b.id,
      weekNo: seed.weekNo,
      give: [seed.roster[a.id][0]],
      receive: [seed.roster[b.id][0]],
    });
    expect(result.score).toBe(1);
    expect(result.flagged).toBe(false);
    expect(result.detail.notes.join(" ")).toMatch(/no projection data/i);
  });
});

describe("roster fit", () => {
  const slots = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DEF: 1, BENCH: 6 };

  it("counts FLEX toward RB/WR/TE but not QB", () => {
    expect(startingSlotsFor("RB", slots)).toBe(3);
    expect(startingSlotsFor("WR", slots)).toBe(3);
    expect(startingSlotsFor("QB", slots)).toBe(1);
  });

  it("starts a player only when he beats the incumbents", () => {
    const incoming = { playerId: "in", name: "In", position: "QB", ros: 100 };
    const strongRoom = [
      { playerId: "x", name: "X", position: "QB", ros: 200 },
      { playerId: "y", name: "Y", position: "QB", ros: 150 },
    ];
    expect(wouldStart(incoming, strongRoom, slots)).toBe(false);
    expect(wouldStart(incoming, [{ ...strongRoom[0], ros: 50 }], slots)).toBe(true);
    expect(wouldStart(incoming, [], slots)).toBe(true);
  });
});
