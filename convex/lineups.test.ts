/**
 * Lineups: the validation matrix the `set_lineup` tool has to enforce, the
 * safety autopilot, and the append-only version history.
 *
 * Everything is validated against a snapshot, never live tables, so these tests
 * build a payload and a `snapshot_chunks` pair exactly the way the builder does.
 */
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import type { SnapshotPayload, SnapshotPlayer } from "../lib/snapshot/types";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const KICKOFF = "2026-09-13T17:00:00.000Z";
const NOW = Date.parse("2026-09-13T12:00:00.000Z");
const AFTER_KICKOFF = Date.parse("2026-09-13T18:00:00.000Z");

const RULES = {
  scoringPreset: "ppr" as const,
  superflex: false,
  tePremium: false,
  rosterSlots: { QB: 1, RB: 1, WR: 1, FLEX: 1, BENCH: 3 },
  faabBudget: 100,
  playoffTeams: 4,
  playoffStartWeek: 15,
  regularSeasonWeeks: 14,
  seasonWeeks: 17,
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

type PlayerSpec = {
  key: string;
  position: "QB" | "RB" | "WR" | "TE" | "K" | "DEF";
  points: number;
  injuryStatus?: string;
  byeWeek?: number;
  kickoffAt?: string | null;
};

const ROSTER: PlayerSpec[] = [
  { key: "qb1", position: "QB", points: 20 },
  { key: "qb2", position: "QB", points: 12 },
  { key: "rb1", position: "RB", points: 18 },
  { key: "rb2", position: "RB", points: 9 },
  { key: "wr1", position: "WR", points: 16 },
  { key: "wr2", position: "WR", points: 7 },
];

function snapshotPlayer(id: string, spec: PlayerSpec): SnapshotPlayer {
  return {
    id,
    sleeperId: spec.key,
    fullName: spec.key.toUpperCase(),
    position: spec.position,
    nflTeam: "SF",
    status: "active",
    injuryStatus: spec.injuryStatus ?? null,
    injuryNotes: null,
    byeWeek: spec.byeWeek ?? null,
    projection: { ppr: spec.points, half: spec.points, std: spec.points, source: "t", effectiveAt: KICKOFF },
    rosProjection: null,
    lastWeekPoints: null,
    seasonPoints: null,
    ownerTeamId: null,
    opponent: "SEA",
    gameId: "g1",
    kickoffAt: spec.kickoffAt === undefined ? KICKOFF : spec.kickoffAt,
    ownedPct: null,
    startedPct: null,
  };
}

/**
 * One league, one team, one snapshot whose payload holds `roster`, plus a run to
 * carry the `agentCtx`. Everything a `set_lineup` call needs.
 */
async function fixture(
  t: TestConvex<typeof schema>,
  opts: {
    roster?: PlayerSpec[];
    superflex?: boolean;
    lineup?: Array<{ slot: string; key: string | null }>;
  } = {},
) {
  const roster = opts.roster ?? ROSTER;
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: "commish@x.dev" });
    const leagueId = await ctx.db.insert("leagues", {
      name: "Lineups",
      slug: `lu-${Math.random()}`,
      commissionerUserId: userId,
      season: 2026,
      teamCount: 1,
      isPublic: true,
      status: "in_season",
      draftType: "snake",
      updatedAt: NOW,
    });
    await ctx.db.insert("league_rules", {
      leagueId,
      ...RULES,
      superflex: opts.superflex ?? false,
    });
    const teamId = await ctx.db.insert("teams", {
      leagueId,
      name: "Team A",
      abbreviation: "TA",
      faabRemaining: 100,
      waiverPriority: 1,
      karma: 0,
      draftBudgetRemaining: 200,
    });

    const idOf: Record<string, Id<"players">> = {};
    for (const spec of roster) {
      idOf[spec.key] = await ctx.db.insert("players", {
        sleeperId: spec.key,
        fullName: spec.key.toUpperCase(),
        position: spec.position,
        nflTeam: "SF",
        fantasyPositions: [spec.position],
        externalIds: {},
        updatedAt: NOW,
      });
    }

    const players: Record<string, SnapshotPlayer> = {};
    for (const spec of roster) players[idOf[spec.key]] = snapshotPlayer(idOf[spec.key], spec);

    const payload: SnapshotPayload = {
      version: 1,
      leagueId,
      leagueName: "Lineups",
      season: 2026,
      weekNo: 1,
      takenAt: new Date(NOW).toISOString(),
      rules: { ...RULES, superflex: opts.superflex ?? false },
      teams: [
        {
          id: teamId,
          name: "Team A",
          abbreviation: "TA",
          ownerUserId: null,
          faabRemaining: 100,
          waiverPriority: 1,
          karma: 0,
          record: { wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0 },
          rosterPlayerIds: roster.map((r) => idOf[r.key]),
          lineup: (opts.lineup ?? []).map((s) => ({
            slot: s.slot,
            playerId: s.key ? idOf[s.key] : null,
          })),
          modelId: null,
        },
      ],
      players,
      freeAgentIds: [],
      games: [],
      matchups: [],
      standings: [],
      news: [],
      injuries: [],
      liveScores: {},
    };

    const windowId = await ctx.db.insert("windows", {
      leagueId,
      type: "lineup",
      label: "lineup_sun_early",
      weekNo: 1,
      roundNo: 1,
      opensAt: NOW - 3_600_000,
      submissionDeadlineAt: NOW + 3_000_000,
      closesAt: NOW + 3_600_000,
      status: "open",
      scope: {},
      runCount: 1,
      terminalRunCount: 0,
    });
    const snapshotId = await ctx.db.insert("snapshots", {
      leagueId,
      windowId,
      season: 2026,
      weekNo: 1,
      takenAt: NOW,
      status: "ready",
      chunkCount: 2,
      playerCount: roster.length,
    });
    const { players: playerMap, ...meta } = payload;
    await ctx.db.insert("snapshot_chunks", {
      snapshotId,
      kind: "meta",
      part: 0,
      data: meta,
      bytes: 0,
    });
    await ctx.db.insert("snapshot_chunks", {
      snapshotId,
      kind: "players",
      part: 0,
      data: playerMap,
      bytes: 0,
    });
    await ctx.db.patch("windows", windowId, { snapshotId });

    const runId = await ctx.db.insert("runs", {
      windowId,
      leagueId,
      teamId,
      modelId: "test/model",
      kind: "team",
      status: "running",
      windowType: "lineup",
      windowLabel: "lineup_sun_early",
      weekNo: 1,
      attempt: 1,
      lastPersistedStep: -1,
      totalCostUsd: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      stepCount: 0,
      committedActionCount: 0,
      rejectedActionCount: 0,
    });

    return { leagueId, teamId, windowId, snapshotId, runId, idOf };
  });
}

function agentCtx(f: { runId: Id<"runs">; windowId: Id<"windows"> }, toolCallId: string) {
  return {
    runId: f.runId,
    stepIndex: 0,
    toolCallId,
    windowId: f.windowId,
    weekNo: 1,
  };
}

const LEGAL = (idOf: Record<string, Id<"players">>) => [
  { slot: "QB", playerId: idOf.qb1 },
  { slot: "RB", playerId: idOf.rb1 },
  { slot: "WR", playerId: idOf.wr1 },
  { slot: "FLEX", playerId: idOf.rb2 },
  { slot: "BENCH", playerId: idOf.qb2 },
  { slot: "BENCH", playerId: idOf.wr2 },
];

describe("lineups.validate", () => {
  test("accepts a legal lineup and rejects the whole matrix of illegal ones", async () => {
    const t = convexTest(schema, modules);
    const f = await fixture(t);
    const check = (slots: Array<{ slot: string; playerId: Id<"players"> | null }>) =>
      t.query(internal.lineups.validate, {
        teamId: f.teamId,
        windowId: f.windowId,
        slots,
        now: NOW,
      });

    expect(await check(LEGAL(f.idOf))).toMatchObject({ ok: true, errors: [] });

    // unknown slot
    const badSlot = await check([...LEGAL(f.idOf).slice(1), { slot: "KICKER", playerId: f.idOf.qb1 }]);
    expect(badSlot.ok).toBe(false);
    expect(badSlot.errors.join(" ")).toContain('Unknown slot "KICKER"');

    // wrong count for a slot
    const wrongCount = await check(LEGAL(f.idOf).slice(1));
    expect(wrongCount.ok).toBe(false);
    expect(wrongCount.errors.join(" ")).toContain('Slot "QB" must appear exactly 1 time(s)');

    // duplicate player
    const dupe = await check([
      { slot: "QB", playerId: f.idOf.qb1 },
      { slot: "RB", playerId: f.idOf.rb1 },
      { slot: "WR", playerId: f.idOf.wr1 },
      { slot: "FLEX", playerId: f.idOf.rb1 },
      { slot: "BENCH", playerId: f.idOf.qb2 },
    ]);
    expect(dupe.ok).toBe(false);
    expect(dupe.errors.join(" ")).toContain("appears more than once");

    // not on the roster
    const stranger = await t.run(async (ctx) =>
      ctx.db.insert("players", {
        sleeperId: "x",
        fullName: "Stranger",
        position: "WR",
        fantasyPositions: ["WR"],
        externalIds: {},
        updatedAt: NOW,
      }),
    );
    const notMine = await check([
      { slot: "QB", playerId: f.idOf.qb1 },
      { slot: "RB", playerId: f.idOf.rb1 },
      { slot: "WR", playerId: stranger },
      { slot: "FLEX", playerId: f.idOf.rb2 },
    ]);
    expect(notMine.ok).toBe(false);
    expect(notMine.errors.join(" ")).toContain("is not on your roster");

    // ineligible position for the slot: a QB may not fill a plain FLEX
    const ineligible = await check([
      { slot: "QB", playerId: f.idOf.qb1 },
      { slot: "RB", playerId: f.idOf.rb1 },
      { slot: "WR", playerId: f.idOf.wr1 },
      { slot: "FLEX", playerId: f.idOf.qb2 },
    ]);
    expect(ineligible.ok).toBe(false);
    expect(ineligible.errors.join(" ")).toContain('not eligible for slot "FLEX"');
  });

  test("allows a QB at SUPERFLEX only when the league runs superflex", async () => {
    const shape = { QB: 1, RB: 1, WR: 1, SUPERFLEX: 1, BENCH: 3 };
    const build = async (superflex: boolean) => {
      const t = convexTest(schema, modules);
      const f = await fixture(t, { superflex });
      await t.run(async (ctx) => {
        // Rewrite the payload's slot shape for this case.
        const chunk = await ctx.db
          .query("snapshot_chunks")
          .withIndex("by_snapshotId_kind_part", (q) =>
            q.eq("snapshotId", f.snapshotId).eq("kind", "meta").eq("part", 0),
          )
          .unique();
        const data = chunk!.data as { rules: { rosterSlots: Record<string, number> } };
        await ctx.db.patch("snapshot_chunks", chunk!._id, {
          data: { ...data, rules: { ...data.rules, rosterSlots: shape, superflex } },
        });
      });
      return { t, f };
    };

    const slotsFor = (idOf: Record<string, Id<"players">>) => [
      { slot: "QB", playerId: idOf.qb1 },
      { slot: "RB", playerId: idOf.rb1 },
      { slot: "WR", playerId: idOf.wr1 },
      { slot: "SUPERFLEX", playerId: idOf.qb2 },
    ];

    const on = await build(true);
    expect(
      await on.t.query(internal.lineups.validate, {
        teamId: on.f.teamId,
        windowId: on.f.windowId,
        slots: slotsFor(on.f.idOf),
        now: NOW,
      }),
    ).toMatchObject({ ok: true });

    const off = await build(false);
    const result = await off.t.query(internal.lineups.validate, {
      teamId: off.f.teamId,
      windowId: off.f.windowId,
      slots: slotsFor(off.f.idOf),
      now: NOW,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("not eligible");
  });

  test("refuses to move a locked player and warns about a bye-week starter", async () => {
    const t = convexTest(schema, modules);
    const f = await fixture(t, {
      roster: [
        ...ROSTER.slice(0, 4),
        { key: "wr1", position: "WR", points: 16, byeWeek: 1 },
        ROSTER[5],
      ],
      lineup: [
        { slot: "QB", key: "qb1" },
        { slot: "RB", key: "rb1" },
        { slot: "WR", key: "wr1" },
        { slot: "FLEX", key: "rb2" },
        { slot: "BENCH", key: "qb2" },
        { slot: "BENCH", key: "wr2" },
      ],
    });

    // Before kickoff the bye-week starter is only a warning.
    const early = await t.query(internal.lineups.validate, {
      teamId: f.teamId,
      windowId: f.windowId,
      slots: LEGAL(f.idOf),
      now: NOW,
    });
    expect(early.ok).toBe(true);
    expect(early.warnings.join(" ")).toContain("on bye");

    // After kickoff every one of those players is locked into their slot.
    const late = await t.query(internal.lineups.validate, {
      teamId: f.teamId,
      windowId: f.windowId,
      slots: [
        { slot: "QB", playerId: f.idOf.qb1 },
        { slot: "RB", playerId: f.idOf.rb1 },
        { slot: "WR", playerId: f.idOf.wr2 },
        { slot: "FLEX", playerId: f.idOf.rb2 },
        { slot: "BENCH", playerId: f.idOf.qb2 },
        { slot: "BENCH", playerId: f.idOf.wr1 },
      ],
      now: AFTER_KICKOFF,
    });
    expect(late.ok).toBe(false);
    expect(late.errors.join(" ")).toContain("is locked");
  });
});

describe("lineups.commit", () => {
  test("appends a new version each time and records the action once per toolCallId", async () => {
    const t = convexTest(schema, modules);
    const f = await fixture(t);

    const first = await t.mutation(internal.lineups.commit, {
      teamId: f.teamId,
      weekNo: 1,
      slots: LEGAL(f.idOf),
      source: "agent",
      agentCtx: agentCtx(f, "call-1"),
      now: NOW,
    });
    expect(first).toMatchObject({ ok: true, version: 1 });

    const second = await t.mutation(internal.lineups.commit, {
      teamId: f.teamId,
      weekNo: 1,
      slots: LEGAL(f.idOf),
      source: "agent",
      agentCtx: agentCtx(f, "call-2"),
      now: NOW,
    });
    expect(second).toMatchObject({ ok: true, version: 2 });

    // A replay of call-2 returns the stored result and writes nothing new.
    const replay = await t.mutation(internal.lineups.commit, {
      teamId: f.teamId,
      weekNo: 1,
      slots: LEGAL(f.idOf),
      source: "agent",
      agentCtx: agentCtx(f, "call-2"),
      now: NOW,
    });
    expect(replay).toEqual(second);

    const current = await t.query(internal.lineups.current, { teamId: f.teamId, weekNo: 1 });
    expect(current?.version).toBe(2);

    const run = await t.run(async (ctx) => ctx.db.get("runs", f.runId));
    expect(run?.committedActionCount).toBe(2);
    expect(run?.rejectedActionCount).toBe(0);
  });

  test("records a rejection instead of throwing, and replays it too", async () => {
    const t = convexTest(schema, modules);
    const f = await fixture(t);
    const illegal = [
      { slot: "QB", playerId: f.idOf.qb1 },
      { slot: "RB", playerId: f.idOf.rb1 },
      { slot: "WR", playerId: f.idOf.wr1 },
      { slot: "FLEX", playerId: f.idOf.qb2 },
    ];

    const rejected = await t.mutation(internal.lineups.commit, {
      teamId: f.teamId,
      weekNo: 1,
      slots: illegal,
      source: "agent",
      agentCtx: agentCtx(f, "bad-1"),
      now: NOW,
    });
    expect(rejected.ok).toBe(false);

    expect(await t.query(internal.lineups.current, { teamId: f.teamId, weekNo: 1 })).toBeNull();
    const run = await t.run(async (ctx) => ctx.db.get("runs", f.runId));
    expect(run?.rejectedActionCount).toBe(1);
    expect(run?.committedActionCount).toBe(0);

    expect(
      await t.mutation(internal.lineups.commit, {
        teamId: f.teamId,
        weekNo: 1,
        slots: illegal,
        source: "agent",
        agentCtx: agentCtx(f, "bad-1"),
        now: NOW,
      }),
    ).toEqual(rejected);
  });

  test("platform commits skip snapshot validation", async () => {
    const t = convexTest(schema, modules);
    const f = await fixture(t);
    const result = await t.mutation(internal.lineups.commit, {
      teamId: f.teamId,
      weekNo: 2,
      slots: [{ slot: "QB", playerId: f.idOf.qb1 }],
      source: "draft_default",
    });
    expect(result).toMatchObject({ ok: true, version: 1 });
  });
});

describe("lineups.applySafetyAutopilot", () => {
  test("fills an empty starting slot, then is a no-op on the second call", async () => {
    const t = convexTest(schema, modules);
    const f = await fixture(t);
    // The stored lineup leaves FLEX empty and benches everyone else.
    await t.mutation(internal.lineups.commit, {
      teamId: f.teamId,
      weekNo: 1,
      slots: [
        { slot: "QB", playerId: f.idOf.qb1 },
        { slot: "RB", playerId: f.idOf.rb1 },
        { slot: "WR", playerId: f.idOf.wr1 },
        { slot: "FLEX", playerId: null },
        { slot: "BENCH", playerId: f.idOf.rb2 },
        { slot: "BENCH", playerId: f.idOf.qb2 },
        { slot: "BENCH", playerId: f.idOf.wr2 },
      ],
      source: "agent",
    });

    const first = await t.mutation(internal.lineups.applySafetyAutopilot, {
      snapshotId: f.snapshotId,
      teamId: f.teamId,
      weekNo: 1,
      now: NOW,
    });
    expect(first.changed).toBe(true);
    expect(first.filledSlots).toEqual(["FLEX"]);
    // The best eligible unused body is RB2 (9 pts) over WR2 (7 pts).
    expect(first.slots.find((s) => s.slot === "FLEX")?.playerId).toBe(f.idOf.rb2);
    expect(first.version).toBe(2);

    const second = await t.mutation(internal.lineups.applySafetyAutopilot, {
      snapshotId: f.snapshotId,
      teamId: f.teamId,
      weekNo: 1,
      now: NOW,
    });
    expect(second.changed).toBe(false);
    expect(second.filledSlots).toEqual([]);
    expect(await t.query(internal.lineups.current, { teamId: f.teamId, weekNo: 1 })).toMatchObject({
      version: 2,
      source: "autopilot",
    });
  });

  test("replaces a starter who is ruled out but leaves a locked slot alone", async () => {
    const t = convexTest(schema, modules);
    const f = await fixture(t, {
      roster: [
        // qb1 and wr1 have kicked off and are fine; rb1 is OUT but has not kicked
        // off (fixable); rb2 is OUT *and* locked (frozen); rb3 is the bench body.
        { key: "qb1", position: "QB", points: 20 },
        { key: "wr1", position: "WR", points: 16 },
        { key: "rb1", position: "RB", points: 18, injuryStatus: "out", kickoffAt: null },
        { key: "rb2", position: "RB", points: 9, injuryStatus: "out" },
        { key: "rb3", position: "RB", points: 11, kickoffAt: null },
        { key: "wr2", position: "WR", points: 7 },
      ],
    });
    await t.mutation(internal.lineups.commit, {
      teamId: f.teamId,
      weekNo: 1,
      slots: [
        { slot: "QB", playerId: f.idOf.qb1 },
        { slot: "RB", playerId: f.idOf.rb1 },
        { slot: "WR", playerId: f.idOf.wr1 },
        { slot: "FLEX", playerId: f.idOf.rb2 },
        { slot: "BENCH", playerId: f.idOf.rb3 },
        { slot: "BENCH", playerId: f.idOf.wr2 },
      ],
      source: "agent",
    });

    const result = await t.mutation(internal.lineups.applySafetyAutopilot, {
      snapshotId: f.snapshotId,
      teamId: f.teamId,
      weekNo: 1,
      now: AFTER_KICKOFF,
    });
    expect(result.changed).toBe(true);
    expect(result.filledSlots).toEqual(["RB"]);
    expect(result.slots.find((s) => s.slot === "RB")?.playerId).toBe(f.idOf.rb3);
    // FLEX is frozen on the locked, ruled-out rb2 — nothing can be done there.
    expect(result.slots.find((s) => s.slot === "FLEX")?.playerId).toBe(f.idOf.rb2);
  });

  test("persists a carryover version once when the week has no lineup at all", async () => {
    const t = convexTest(schema, modules);
    const f = await fixture(t, {
      lineup: [
        { slot: "QB", key: "qb1" },
        { slot: "RB", key: "rb1" },
        { slot: "WR", key: "wr1" },
        { slot: "FLEX", key: "rb2" },
      ],
    });
    const first = await t.mutation(internal.lineups.applySafetyAutopilot, {
      snapshotId: f.snapshotId,
      teamId: f.teamId,
      weekNo: 1,
      now: NOW,
    });
    expect(first.changed).toBe(true);
    expect(first.filledSlots).toEqual([]);
    expect(await t.query(internal.lineups.current, { teamId: f.teamId, weekNo: 1 })).toMatchObject({
      source: "carryover",
      version: 1,
    });

    const second = await t.mutation(internal.lineups.applySafetyAutopilot, {
      snapshotId: f.snapshotId,
      teamId: f.teamId,
      weekNo: 1,
      now: NOW,
    });
    expect(second.changed).toBe(false);
  });
});
