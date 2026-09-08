/**
 * The film room: lineup efficiency measured against the week's snapshot.
 *
 * The rule the old service established and this one keeps: the optimal lineup is
 * the best call available *from the snapshot's projections*, then both lineups
 * are scored on the same basis — actual stat lines once the week has them,
 * projections while it is still open.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import type { SnapshotPayload } from "../lib/snapshot/types";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const newTest = () => convexTest(schema, modules);
type T = ReturnType<typeof newTest>;

const NOW = Date.now();
const SEASON = 2026;
const TAKEN_AT = NOW - 3_600_000;

const RULES = {
  scoringPreset: "ppr" as const,
  superflex: false,
  tePremium: false,
  rosterSlots: { QB: 1, RB: 1, BENCH: 1 },
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

function snapshotPlayer(id: string, fullName: string, position: "QB" | "RB", ppr: number) {
  return {
    id,
    sleeperId: id,
    fullName,
    position,
    nflTeam: "KC",
    status: null,
    injuryStatus: null,
    injuryNotes: null,
    byeWeek: null,
    projection: { ppr, half: ppr, std: ppr, source: "test", effectiveAt: "x" },
    rosProjection: null,
    lastWeekPoints: null,
    seasonPoints: null,
    ownerTeamId: null,
    opponent: "DEN",
    gameId: "g1",
    kickoffAt: null,
    ownedPct: null,
    startedPct: null,
  };
}

/** One team starting its *worse* running back — the case the metric exists for. */
async function seed(t: T, opts: { snapshot?: boolean } = {}) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: "owner@x.dev" });
    const leagueId = await ctx.db.insert("leagues", {
      name: "Film",
      slug: `f-${Math.random()}`,
      commissionerUserId: userId,
      season: SEASON,
      teamCount: 1,
      isPublic: true,
      status: "in_season",
      draftType: "snake",
      updatedAt: NOW,
    });
    await ctx.db.insert("league_rules", { leagueId, ...RULES });
    await ctx.db.insert("league_members", { leagueId, userId, role: "commissioner" });
    await ctx.db.insert("weeks", {
      leagueId,
      weekNo: 1,
      startsAt: NOW - 14 * 86_400_000,
      endsAt: NOW - 7 * 86_400_000,
      isPlayoff: false,
      status: "complete",
    });
    await ctx.db.insert("weeks", {
      leagueId,
      weekNo: 2,
      startsAt: NOW - 7 * 86_400_000,
      endsAt: NOW + 86_400_000,
      isPlayoff: false,
      status: "active",
    });

    const teamId = await ctx.db.insert("teams", {
      leagueId,
      ownerUserId: userId,
      name: "Alpha",
      abbreviation: "ALP",
      faabRemaining: 80,
      waiverPriority: 1,
      karma: 0,
      draftBudgetRemaining: 200,
    });
    await ctx.db.insert("agent_configs", { teamId, leagueId, noteToAgent: "Start your studs." });

    const mkPlayer = (name: string, position: "QB" | "RB") =>
      ctx.db.insert("players", {
        sleeperId: name,
        fullName: name,
        position,
        nflTeam: "KC",
        fantasyPositions: [position],
        externalIds: {},
        updatedAt: NOW,
      });
    const qb = await mkPlayer("Quinn Back", "QB");
    const rbGood = await mkPlayer("Rick Runner", "RB");
    const rbBad = await mkPlayer("Benny Bench", "RB");
    for (const playerId of [qb, rbGood, rbBad]) {
      await ctx.db.insert("roster_slots", {
        leagueId,
        teamId,
        playerId,
        acquiredAt: NOW - 86_400_000,
        acquiredVia: "draft",
      });
    }

    // The agent started the worse back: efficiency should be below 1.
    await ctx.db.insert("lineups", {
      leagueId,
      teamId,
      weekNo: 1,
      version: 1,
      source: "agent",
      slots: [
        { slot: "QB", playerId: qb },
        { slot: "RB", playerId: rbBad },
        { slot: "BENCH", playerId: rbGood },
      ],
    });

    let snapshotId: Id<"snapshots"> | null = null;
    if (opts.snapshot !== false) {
      snapshotId = await ctx.db.insert("snapshots", {
        leagueId,
        season: SEASON,
        weekNo: 1,
        takenAt: TAKEN_AT,
        status: "ready",
        chunkCount: 2,
        playerCount: 3,
      });
      const meta: Omit<SnapshotPayload, "players"> = {
        version: 1,
        leagueId,
        leagueName: "Film",
        season: SEASON,
        weekNo: 1,
        takenAt: new Date(TAKEN_AT).toISOString(),
        rules: {
          scoringPreset: "ppr",
          superflex: false,
          tePremium: false,
          rosterSlots: RULES.rosterSlots,
          faabBudget: 100,
          injectionPolicy: "permitted",
          transparencyMode: "live",
          regularSeasonWeeks: 14,
          playoffStartWeek: 15,
          maxOpenProposals: 3,
          maxMessagesPerRun: 6,
          maxThreadsPerWindow: 4,
          forumPostsPerDay: 2,
          forumCommentsPerDay: 6,
          antiChurnWeeks: 3,
        },
        teams: [
          {
            id: teamId,
            name: "Alpha",
            abbreviation: "ALP",
            ownerUserId: userId,
            faabRemaining: 80,
            waiverPriority: 1,
            karma: 0,
            record: { wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0 },
            rosterPlayerIds: [qb, rbGood, rbBad],
            lineup: [
              { slot: "QB", playerId: qb },
              { slot: "RB", playerId: rbBad },
              { slot: "BENCH", playerId: rbGood },
            ],
            modelId: null,
          },
        ],
        freeAgentIds: [],
        games: [],
        matchups: [],
        standings: [],
        news: [],
        injuries: [],
        liveScores: {},
      };
      await ctx.db.insert("snapshot_chunks", {
        snapshotId,
        kind: "meta",
        part: 0,
        bytes: 100,
        data: meta,
      });
      await ctx.db.insert("snapshot_chunks", {
        snapshotId,
        kind: "players",
        part: 0,
        bytes: 100,
        data: {
          [qb]: snapshotPlayer(qb, "Quinn Back", "QB", 20),
          [rbGood]: snapshotPlayer(rbGood, "Rick Runner", "RB", 15),
          [rbBad]: snapshotPlayer(rbBad, "Benny Bench", "RB", 5),
        },
      });
    }

    return { leagueId, teamId, userId, qb, rbGood, rbBad, snapshotId };
  });
}

describe("metrics.filmRoom", () => {
  test("scores on projections while the week has no stat lines", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const film = await t.query(api.metrics.filmRoom, { teamId: s.teamId, weekNo: 1 });

    expect(film.efficiencyUnavailableReason).toBeNull();
    expect(film.efficiency).not.toBeNull();
    expect(film.efficiency!.basis).toBe("projected");
    // Started QB (20) + the worse RB (5); the optimal call was QB + the better RB.
    expect(film.efficiency!.actual).toBe(25);
    expect(film.efficiency!.optimal).toBe(35);
    expect(film.efficiency!.efficiency).toBeCloseTo(0.7143, 4);
    expect(film.efficiency!.pointsLeftOnBench).toBe(10);
    expect(film.efficiency!.fromMetrics).toBe(false);
    expect(film.efficiency!.actualSlots.map((slot) => slot.playerName)).toEqual([
      "Quinn Back",
      "Benny Bench",
    ]);
    expect(film.efficiency!.optimalSlots.map((slot) => slot.playerName)).toEqual([
      "Quinn Back",
      "Rick Runner",
    ]);
    expect(film.efficiency!.snapshotTakenAt).toBe(TAKEN_AT);
    expect(film.noteToAgent).toBe("Start your studs.");
    expect(film.availableWeeks).toEqual([1, 2]);
  });

  test("switches to actual points once stat lines land", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run(async (ctx) => {
      const stat = (playerId: Id<"players">, points: number) =>
        ctx.db.insert("player_stats_weekly", {
          playerId,
          season: SEASON,
          week: 1,
          source: "sleeper",
          stats: {},
          fantasyPointsPpr: points,
          fantasyPointsHalf: points,
          fantasyPointsStd: points,
          effectiveAt: NOW,
        });
      await stat(s.qb, 18);
      await stat(s.rbGood, 14);
      await stat(s.rbBad, 3);
    });

    const film = await t.query(api.metrics.filmRoom, { teamId: s.teamId, weekNo: 1 });
    expect(film.efficiency!.basis).toBe("actual");
    expect(film.efficiency!.actual).toBe(21);
    expect(film.efficiency!.optimal).toBe(32);
    expect(film.efficiency!.actualSlots[1].points).toBe(3);
  });

  test("prefers the stored team_week_metrics headline figures when they exist", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("team_week_metrics", {
        leagueId: s.leagueId,
        teamId: s.teamId,
        season: SEASON,
        weekNo: 1,
        actualPoints: 40,
        optimalPoints: 50,
        lineupEfficiency: 0.8,
        pointsLeftOnBench: 10,
        runCount: 3,
        fallbackCount: 0,
        updatedAt: NOW,
      });
    });

    const film = await t.query(api.metrics.filmRoom, { teamId: s.teamId, weekNo: 1 });
    expect(film.efficiency).toMatchObject({
      actual: 40,
      optimal: 50,
      efficiency: 0.8,
      pointsLeftOnBench: 10,
      fromMetrics: true,
    });
    // The slot-by-slot breakdown still comes from the snapshot.
    expect(film.efficiency!.actualSlots).toHaveLength(2);
  });

  test("explains itself when the week has no snapshot", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { snapshot: false });
    const film = await t.query(api.metrics.filmRoom, { teamId: s.teamId, weekNo: 1 });
    expect(film.efficiency).toBeNull();
    expect(film.efficiencyUnavailableReason).toMatch(/No snapshot was stored for week 1/);
  });

  test("defaults to the most recently finished week and carries runs, waivers and spend", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run(async (ctx) => {
      const windowId = await ctx.db.insert("windows", {
        leagueId: s.leagueId,
        type: "waiver",
        label: "waiver",
        weekNo: 1,
        roundNo: 1,
        opensAt: NOW - 10_000,
        submissionDeadlineAt: NOW - 5_000,
        closesAt: NOW - 1_000,
        status: "closed",
        scope: {},
        runCount: 1,
        terminalRunCount: 1,
      });
      await ctx.db.insert("runs", {
        leagueId: s.leagueId,
        windowId,
        teamId: s.teamId,
        modelId: "anthropic/claude-sonnet-4.5",
        kind: "team",
        status: "succeeded",
        windowType: "waiver",
        windowLabel: "waiver",
        weekNo: 1,
        attempt: 1,
        lastPersistedStep: 0,
        totalCostUsd: 0.3,
        totalInputTokens: 10,
        totalOutputTokens: 5,
        stepCount: 1,
        committedActionCount: 1,
        rejectedActionCount: 0,
      });
      await ctx.db.insert("waiver_claims", {
        leagueId: s.leagueId,
        teamId: s.teamId,
        windowId,
        weekNo: 1,
        addPlayerId: s.rbGood,
        dropPlayerId: s.rbBad,
        bid: 12,
        priority: 1,
        status: "won",
      });
      await ctx.db.insert("team_week_rollups", {
        leagueId: s.leagueId,
        teamId: s.teamId,
        season: SEASON,
        weekNo: 1,
        inputTokens: 100,
        outputTokens: 50,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        costUsd: 0.3,
        computedCostUsd: 0.3,
        gatewayCostUsd: 0,
        runCount: 1,
        stepCount: 1,
        fallbackCount: 0,
        invalidActionCount: 0,
        updatedAt: NOW,
      });
      await ctx.db.insert("team_results", {
        leagueId: s.leagueId,
        teamId: s.teamId,
        weekNo: 1,
        pointsFor: 21,
        pointsAgainst: 18,
        won: true,
        lost: false,
        tied: false,
      });
    });

    const film = await t.query(api.metrics.filmRoom, { teamId: s.teamId });
    expect(film.weekNo).toBe(1); // week 2 has not ended yet
    expect(film.runs.map((run) => run.windowLabel)).toEqual(["waiver"]);
    expect(film.waivers[0]).toMatchObject({
      addPlayerName: "Rick Runner",
      dropPlayerName: "Benny Bench",
      bid: 12,
      status: "won",
    });
    expect(film.spend).toMatchObject({ usd: 0.3, tokens: 150, runCount: 1 });
    expect(film.seasonSpend).toBe(0.3);
    expect(film.result).toMatchObject({ pointsFor: 21, won: true });
    expect(film.budget.teamWeekUsd).toBe(0.3);
  });
});

// ===========================================================================
// Phase 4 — the process-metrics writer
// ===========================================================================

/** A closed lineup window over the seeded snapshot, plus two runs for the team. */
async function seedWindow(
  t: T,
  s: Awaited<ReturnType<typeof seed>>,
  opts: { snapshot?: boolean } = {},
) {
  return t.run(async (ctx) => {
    const windowId = await ctx.db.insert("windows", {
      leagueId: s.leagueId,
      type: "lineup",
      label: "lineup_sun_early",
      weekNo: 1,
      roundNo: 1,
      opensAt: NOW - 7_200_000,
      submissionDeadlineAt: NOW - 3_600_000,
      closesAt: NOW - 3_000_000,
      snapshotId: opts.snapshot === false ? undefined : (s.snapshotId ?? undefined),
      status: "closed",
      scope: {},
      runCount: 2,
      terminalRunCount: 2,
    });
    const mkRun = (
      status: "succeeded" | "fallback",
      committed: number,
      rejected: number,
      fallback: boolean,
    ) =>
      ctx.db.insert("runs", {
        leagueId: s.leagueId,
        windowId,
        teamId: s.teamId,
        modelId: "mock/scripted",
        kind: "team",
        status,
        windowType: "lineup",
        windowLabel: "lineup_sun_early",
        weekNo: 1,
        attempt: 1,
        lastPersistedStep: 0,
        totalCostUsd: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        stepCount: 1,
        committedActionCount: committed,
        rejectedActionCount: rejected,
        fallbackApplied: fallback ? { kind: "safety_autopilot" as const } : undefined,
      });
    await mkRun("succeeded", 3, 1, false);
    await mkRun("fallback", 0, 1, true);
    return windowId;
  });
}

async function storedMetrics(t: T, teamId: Id<"teams">) {
  return t.run(async (ctx) =>
    ctx.db
      .query("team_week_metrics")
      .withIndex("by_teamId_season_weekNo", (q) =>
        q.eq("teamId", teamId).eq("season", SEASON).eq("weekNo", 1),
      )
      .unique(),
  );
}

describe("metrics.writeTeamWeek", () => {
  test("inserts, then overwrites — a recomputation clears a stale figure", async () => {
    const t = newTest();
    const s = await seed(t);

    await t.mutation(internal.metrics.writeTeamWeek, {
      leagueId: s.leagueId,
      teamId: s.teamId,
      season: SEASON,
      weekNo: 1,
      values: { actualPoints: 25, optimalPoints: 35, runCount: 2, fallbackCount: 1 },
    });
    const first = await storedMetrics(t, s.teamId);
    expect(first).toMatchObject({ actualPoints: 25, optimalPoints: 35, runCount: 2 });

    await t.mutation(internal.metrics.writeTeamWeek, {
      leagueId: s.leagueId,
      teamId: s.teamId,
      season: SEASON,
      weekNo: 1,
      values: { runCount: 3, fallbackCount: 0 },
    });
    const second = await storedMetrics(t, s.teamId);
    expect(second!._id).toBe(first!._id);
    expect(second!.runCount).toBe(3);
    expect(second!.actualPoints).toBeUndefined();
    expect(second!.optimalPoints).toBeUndefined();
  });
});

describe("metrics.computeForWindowClose", () => {
  test("scores the week against the window's snapshot once stat lines exist", async () => {
    const t = newTest();
    const s = await seed(t);
    await seedWindow(t, s);
    await t.run(async (ctx) => {
      const stat = (playerId: Id<"players">, points: number) =>
        ctx.db.insert("player_stats_weekly", {
          playerId,
          season: SEASON,
          week: 1,
          source: "sleeper",
          stats: {},
          fantasyPointsPpr: points,
          fantasyPointsHalf: points,
          fantasyPointsStd: points,
          effectiveAt: NOW,
        });
      await stat(s.qb, 18);
      await stat(s.rbGood, 14);
      await stat(s.rbBad, 3);
    });
    const windowId = await t.run(async (ctx) => {
      const rows = await ctx.db.query("windows").collect();
      return rows[0]._id;
    });

    const result = await t.mutation(internal.metrics.computeForWindowClose, { windowId });
    expect(result).toEqual({ teamCount: 1, weekNo: 1 });

    const metrics = await storedMetrics(t, s.teamId);
    // Started QB (18) + the worse RB (3); the optimal call was QB + Rick (14).
    expect(metrics).toMatchObject({
      actualPoints: 21,
      optimalPoints: 32,
      pointsLeftOnBench: 11,
      runCount: 2,
      fallbackCount: 1,
    });
    expect(metrics!.lineupEfficiency).toBeCloseTo(21 / 32, 4);
    // The started lineup was projected for 20 + 5 = 25 and banked 21.
    expect(metrics!.projectionCapture).toBeCloseTo(21 / 25, 4);
    // 2 rejected write-tool calls out of 5 attempted, across the window's two runs.
    expect(metrics!.invalidActionRate).toBeCloseTo(0.4, 8);
    expect(metrics!.waiverValue).toBeUndefined();
    expect(metrics!.tradeDelta).toBeUndefined();

    // The film room then prefers the stored headline figures.
    const film = await t.query(api.metrics.filmRoom, { teamId: s.teamId, weekNo: 1 });
    expect(film.efficiency).toMatchObject({ actual: 21, optimal: 32, fromMetrics: true });
  });

  test("records the run counters but no points before any stat line lands", async () => {
    const t = newTest();
    const s = await seed(t);
    const windowId = await seedWindow(t, s);

    await t.mutation(internal.metrics.computeForWindowClose, { windowId });
    const metrics = await storedMetrics(t, s.teamId);
    expect(metrics).toMatchObject({ runCount: 2, fallbackCount: 1 });
    expect(metrics!.actualPoints).toBeUndefined();
    expect(metrics!.optimalPoints).toBeUndefined();
    expect(metrics!.lineupEfficiency).toBeUndefined();
    expect(metrics!.projectionCapture).toBeUndefined();
    expect(metrics!.invalidActionRate).toBeCloseTo(0.4, 8);

    // Without stored points the film room keeps computing the projected view.
    const film = await t.query(api.metrics.filmRoom, { teamId: s.teamId, weekNo: 1 });
    expect(film.efficiency).toMatchObject({ basis: "projected", fromMetrics: false });
  });

  test("still writes run counters when the window has no snapshot", async () => {
    const t = newTest();
    const s = await seed(t, { snapshot: false });
    const windowId = await seedWindow(t, s, { snapshot: false });

    await t.mutation(internal.metrics.computeForWindowClose, { windowId });
    const metrics = await storedMetrics(t, s.teamId);
    expect(metrics).toMatchObject({ runCount: 2, fallbackCount: 1 });
    expect(metrics!.actualPoints).toBeUndefined();
  });

  test("is idempotent: closing twice recomputes rather than accumulating", async () => {
    const t = newTest();
    const s = await seed(t);
    const windowId = await seedWindow(t, s);

    await t.mutation(internal.metrics.computeForWindowClose, { windowId });
    const first = await storedMetrics(t, s.teamId);
    await t.mutation(internal.metrics.computeForWindowClose, { windowId });
    const second = await storedMetrics(t, s.teamId);

    expect(second!._id).toBe(first!._id);
    expect(second!.runCount).toBe(2);
    expect(await t.run(async (ctx) => ctx.db.query("team_week_metrics").collect())).toHaveLength(1);
  });
});
