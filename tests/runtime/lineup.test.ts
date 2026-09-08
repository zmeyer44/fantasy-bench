import { beforeAll, describe, expect, it } from "vitest";

import {
  applySafetyAutopilot,
  commitLineup,
  computeOptimalLineup,
  getCurrentLineup,
  lineupEfficiency,
  pointsLeftOnBench,
  scoreLineup,
  validateLineup,
} from "@/lib/services/lineup";

import { truncateAll } from "../setup";
import {
  EXPECTED_OPTIMAL,
  EXPECTED_OPTIMAL_POINTS,
  NOW,
  WEEK_NO,
  lineupOf,
  seedFixture,
  type Fixture,
} from "./fixtures";

const OPTIMAL_ENTRIES = EXPECTED_OPTIMAL;

describe("validateLineup", () => {
  let fx: Fixture;
  beforeAll(async () => {
    await truncateAll();
    fx = await seedFixture();
  });

  const validate = (entries: Array<{ slot: string; key: string | null }>, now = NOW) =>
    validateLineup({ snapshot: fx.snapshot, teamId: fx.teamAId, slots: lineupOf(fx, entries), now });

  it("accepts the optimal lineup", () => {
    const result = validate(OPTIMAL_ENTRIES);
    expect(result.ok).toBe(true);
  });

  it("rejects an unknown slot", () => {
    const result = validate([...OPTIMAL_ENTRIES, { slot: "SUPERFLEX", key: "qb2" }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/Unknown slot "SUPERFLEX"/);
  });

  it("rejects the wrong number of entries for a slot", () => {
    const result = validate(OPTIMAL_ENTRIES.filter((e) => e.key !== "rb2"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/Slot "RB" must appear exactly 2/);
  });

  it("rejects a duplicated player", () => {
    const result = validate(
      OPTIMAL_ENTRIES.map((e) => (e.slot === "FLEX" ? { slot: "FLEX", key: "rb1" } : e)),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/appears more than once/);
  });

  it("rejects a player who is not on the roster", () => {
    const result = validate(
      OPTIMAL_ENTRIES.map((e) => (e.slot === "FLEX" ? { slot: "FLEX", key: "fa_wr" } : e)),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/is not on your roster/);
  });

  it("rejects an ineligible position for the slot", () => {
    const result = validate(
      OPTIMAL_ENTRIES.map((e) => (e.slot === "FLEX" ? { slot: "FLEX", key: "qb2" } : e)),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/not eligible for slot "FLEX"/);
  });

  it("allows a QB at FLEX only in a superflex league", async () => {
    const superflexFixture = await seedFixture({
      superflex: true,
      currentLineup: [
        { slot: "QB", key: "qb1" },
        { slot: "RB", key: "rb1" },
        { slot: "RB", key: "rb2" },
        { slot: "WR", key: "wr1" },
        { slot: "WR", key: "wr2" },
        { slot: "TE", key: "te1" },
        { slot: "SUPERFLEX", key: "qb2" },
        { slot: "K", key: "k1" },
        { slot: "DEF", key: "def1" },
      ],
    });
    superflexFixture.snapshot.rules.rosterSlots = {
      QB: 1,
      RB: 2,
      WR: 2,
      TE: 1,
      SUPERFLEX: 1,
      K: 1,
      DEF: 1,
      BENCH: 6,
    };
    const entries = [
      { slot: "QB", key: "qb1" },
      { slot: "RB", key: "rb1" },
      { slot: "RB", key: "rb2" },
      { slot: "WR", key: "wr1" },
      { slot: "WR", key: "wr2" },
      { slot: "TE", key: "te1" },
      { slot: "SUPERFLEX", key: "qb2" },
      { slot: "K", key: "k1" },
      { slot: "DEF", key: "def1" },
    ];
    const ok = validateLineup({
      snapshot: superflexFixture.snapshot,
      teamId: superflexFixture.teamAId,
      slots: lineupOf(superflexFixture, entries),
      now: NOW,
    });
    expect(ok.ok).toBe(true);

    superflexFixture.snapshot.rules.superflex = false;
    const notOk = validateLineup({
      snapshot: superflexFixture.snapshot,
      teamId: superflexFixture.teamAId,
      slots: lineupOf(superflexFixture, entries),
      now: NOW,
    });
    expect(notOk.ok).toBe(false);
  });

  it("refuses to move a locked player out of the starting lineup", async () => {
    // rb1 starts at RB and has already kicked off.
    const locked = await seedFixture({
      seedOverrides: { rb1: { kickoff: "2026-10-04T13:00:00.000Z" } },
    });
    const benchTheLockedPlayer = [
      { slot: "QB", key: "qb1" },
      { slot: "RB", key: "rb2" },
      { slot: "RB", key: "rb3" },
      { slot: "WR", key: "wr1" },
      { slot: "WR", key: "wr2" },
      { slot: "TE", key: "te1" },
      { slot: "FLEX", key: "wr3" },
      { slot: "K", key: "k1" },
      { slot: "DEF", key: "def1" },
    ];
    const result = validateLineup({
      snapshot: locked.snapshot,
      teamId: locked.teamAId,
      slots: lineupOf(locked, benchTheLockedPlayer),
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/cannot be moved out of "RB"/);
  });

  it("refuses to move a locked bench player into the starting lineup", async () => {
    const locked = await seedFixture({
      seedOverrides: { wr3: { kickoff: "2026-10-04T13:00:00.000Z" } },
    });
    const result = validateLineup({
      snapshot: locked.snapshot,
      teamId: locked.teamAId,
      slots: lineupOf(locked, OPTIMAL_ENTRIES), // OPTIMAL starts wr3 at FLEX
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/cannot be moved into "FLEX"/);
  });

  it("warns rather than errors on a bye-week starter", async () => {
    const bye = await seedFixture({ seedOverrides: { wr3: { bye: WEEK_NO } } });
    const result = validateLineup({
      snapshot: bye.snapshot,
      teamId: bye.teamAId,
      slots: lineupOf(bye, OPTIMAL_ENTRIES),
      now: NOW,
    });
    expect(result.ok).toBe(true);
    expect(result.warnings.join(" ")).toMatch(/on bye/);
  });
});

describe("computeOptimalLineup", () => {
  it("finds the highest-projected legal lineup", async () => {
    await truncateAll();
    const fx = await seedFixture();
    const optimal = computeOptimalLineup({ snapshot: fx.snapshot, teamId: fx.teamAId, now: NOW });
    const starters = optimal.filter((s) => s.slot !== "BENCH");
    expect(starters.map((s) => ({ slot: s.slot, playerId: s.playerId }))).toEqual(
      lineupOf(fx, OPTIMAL_ENTRIES),
    );
    expect(scoreLineup({ snapshot: fx.snapshot, slots: optimal })).toBe(EXPECTED_OPTIMAL_POINTS);
    // Every rostered player appears exactly once.
    expect(new Set(optimal.map((s) => s.playerId)).size).toBe(12);
    expect(validateLineup({ snapshot: fx.snapshot, teamId: fx.teamAId, slots: optimal, now: NOW }).ok).toBe(
      true,
    );
  });

  it("keeps locked players where they are", async () => {
    await truncateAll();
    const fx = await seedFixture({ seedOverrides: { rb3: { kickoff: "2026-10-04T13:00:00.000Z" } } });
    // rb3 currently holds FLEX and is locked, so the optimizer must leave it there.
    const optimal = computeOptimalLineup({ snapshot: fx.snapshot, teamId: fx.teamAId, now: NOW });
    const flex = optimal.find((s) => s.slot === "FLEX");
    expect(flex?.playerId).toBe(fx.ids.rb3);
  });
});

describe("lineupEfficiency", () => {
  it("is actual over optimal, and 0 when the optimal is worthless", () => {
    expect(lineupEfficiency({ actual: 90, optimal: 120 })).toBe(0.75);
    expect(lineupEfficiency({ actual: 90, optimal: 0 })).toBe(0);
    expect(pointsLeftOnBench({ actual: 90, optimal: 120 })).toBe(30);
    expect(pointsLeftOnBench({ actual: 130, optimal: 120 })).toBe(0);
  });
});

describe("applySafetyAutopilot", () => {
  it("fills an empty starting slot and is idempotent", async () => {
    await truncateAll();
    const fx = await seedFixture();
    // Commit a lineup with an empty TE slot and te1 available on the bench.
    const withHole = lineupOf(fx, [
      { slot: "QB", key: "qb1" },
      { slot: "RB", key: "rb1" },
      { slot: "RB", key: "rb2" },
      { slot: "WR", key: "wr1" },
      { slot: "WR", key: "wr2" },
      { slot: "TE", key: null },
      { slot: "FLEX", key: "wr3" },
      { slot: "K", key: "k1" },
      { slot: "DEF", key: "def1" },
    ]);
    await commitLineup({ teamId: fx.teamAId, weekNo: WEEK_NO, slots: withHole, source: "agent" });

    const first = await applySafetyAutopilot({
      snapshot: fx.snapshot,
      teamId: fx.teamAId,
      weekNo: WEEK_NO,
      now: NOW,
    });
    expect(first.changed).toBe(true);
    expect(first.filledSlots).toEqual(["TE"]);
    expect(first.slots.find((s) => s.slot === "TE")?.playerId).toBe(fx.ids.te1);

    const stored = await getCurrentLineup({ teamId: fx.teamAId, weekNo: WEEK_NO });
    expect(stored?.source).toBe("autopilot");
    expect(stored?.version).toBe(2);

    const second = await applySafetyAutopilot({
      snapshot: fx.snapshot,
      teamId: fx.teamAId,
      weekNo: WEEK_NO,
      now: NOW,
    });
    expect(second.changed).toBe(false);
    const after = await getCurrentLineup({ teamId: fx.teamAId, weekNo: WEEK_NO });
    expect(after?.version).toBe(2);
  });

  it("replaces a starter who is ruled out", async () => {
    await truncateAll();
    const fx = await seedFixture({ seedOverrides: { te2: { injury: "Out" } } });
    // Default current lineup starts te2 (now Out) at TE.
    const result = await applySafetyAutopilot({
      snapshot: fx.snapshot,
      teamId: fx.teamAId,
      weekNo: WEEK_NO,
      now: NOW,
    });
    expect(result.changed).toBe(true);
    expect(result.slots.find((s) => s.slot === "TE")?.playerId).toBe(fx.ids.te1);
  });

  it("leaves a locked slot alone even when the player cannot play", async () => {
    await truncateAll();
    const fx = await seedFixture({
      seedOverrides: { te2: { injury: "Out", kickoff: "2026-10-04T13:00:00.000Z" } },
    });
    const result = await applySafetyAutopilot({
      snapshot: fx.snapshot,
      teamId: fx.teamAId,
      weekNo: WEEK_NO,
      now: NOW,
    });
    expect(result.slots.find((s) => s.slot === "TE")?.playerId).toBe(fx.ids.te2);
  });
});
