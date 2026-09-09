/**
 * The window lifecycle: job scheduling, `open`, `dispatch`, `close`, the draft
 * chain and the season tick.
 *
 * This is the behavioural port of `tests/scheduler/tick.test.ts`. The old tick
 * was a poll, so its tests asserted "run the tick, then look"; here the same
 * behaviour is driven by `ctx.scheduler` jobs stored on the rows, so the tests
 * assert "let every scheduled function finish, then look"
 * (`t.finishAllScheduledFunctions` + fake timers).
 *
 * `RUN_DISPATCH=skip` keeps `dispatch` from enqueueing on the Workpool: the
 * component is not registered in the `convex-test` harness, and what these tests
 * are about is the run documents, not the queue that executes them.
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { GAME_WINDOW_TAIL_MS } from "./lib/game_calendar";
import { fromETParts } from "./lib/templates";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

/**
 * A bare `ReturnType<typeof convexTest>` erases the schema, which makes
 * `withIndex` in the helpers below fall back to the system-table indexes.
 * Inferring the type from a concrete call keeps them checked against the real
 * data model.
 */
let finishInProgress: (() => Promise<void>) | undefined;
function harness() {
  const t = convexTest(schema, modules);
  finishInProgress = () => t.finishInProgressScheduledFunctions();
  return t;
}
type TestHarness = ReturnType<typeof harness>;

const SEASON = 2026;
/**
 * Everything is anchored to the real clock, three days ahead, so every window
 * these tests materialise is genuinely in the future and its job's
 * `scheduledTime` is the window's own instant rather than "now, we are late".
 * (The Eastern wall-clock arithmetic itself is covered by `windows.test.ts`.)
 */
const NOW = Date.now();
const WEEK_MS = 7 * 24 * 3_600_000;
const WEEK1_START = NOW + 3 * 86_400_000;
/** Every seeded NFL game kicks off well after any window these tests close. */
const KICKOFF = NOW + 10 * 86_400_000;

const RULES = {
  scoringPreset: "ppr" as const,
  superflex: false,
  tePremium: false,
  rosterSlots: { QB: 1, RB: 1, WR: 1, BENCH: 1 },
  faabBudget: 100,
  playoffTeams: 4,
  playoffStartWeek: 15,
  regularSeasonWeeks: 14,
  seasonWeeks: 17,
  transparencyMode: "live" as const,
  injectionPolicy: "permitted" as const,
  modelAllowlist: ["google/gemini-3.8-flash"],
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
  reuseSnapshotWithinMs: 600_000,
  draftBudget: 200,
};

const POSITIONS = ["QB", "RB", "WR"] as const;

type Seed = {
  leagueId: Id<"leagues">;
  teamIds: Id<"teams">[];
  players: Id<"players">[];
  userId: Id<"users">;
};

/**
 * A league with everything `snapshot.build` needs: rules, teams with rosters and
 * lineups, a week grid, NFL games, players with projections.
 */
async function seed(
  t: TestHarness,
  opts: { teams?: number; status?: "in_season" | "drafting" | "setup"; weeks?: number } = {},
): Promise<Seed> {
  const teamCount = opts.teams ?? 3;
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: `c-${Math.random()}@x.dev` });
    const leagueId = await ctx.db.insert("leagues", {
      name: "Lifecycle League",
      slug: `l-${Math.random()}`,
      commissionerUserId: userId,
      season: SEASON,
      teamCount,
      isPublic: true,
      status: opts.status ?? "in_season",
      draftType: "snake",
      updatedAt: NOW,
    });
    await ctx.db.insert("league_rules", { leagueId, ...RULES });
    await ctx.db.insert("league_members", { leagueId, userId, role: "commissioner" });

    for (let weekNo = 1; weekNo <= (opts.weeks ?? 3); weekNo++) {
      await ctx.db.insert("weeks", {
        leagueId,
        weekNo,
        startsAt: WEEK1_START + (weekNo - 1) * WEEK_MS,
        endsAt: WEEK1_START + weekNo * WEEK_MS,
        isPlayoff: false,
        status: weekNo === 1 ? "active" : "upcoming",
      });
    }

    // Every NFL team the seeded players belong to needs a week-1 game: a team
    // with no game is on bye, and the safety autopilot will not start a player
    // who is not playing.
    for (const [home, away] of [
      ["KC", "DEN"],
      ["SF", "SEA"],
    ]) {
      await ctx.db.insert("nfl_games", {
        season: SEASON,
        week: 1,
        gameId: `2026-01-${home}-${away}`,
        homeTeam: home,
        awayTeam: away,
        kickoffAt: KICKOFF,
        status: "scheduled",
      });
    }

    const players: Id<"players">[] = [];
    const nflTeams = ["KC", "SF", "SEA", "DEN"];
    for (let i = 0; i < 24; i++) {
      const position = POSITIONS[i % 3];
      const playerId = await ctx.db.insert("players", {
        sleeperId: `p${i}`,
        fullName: `Player ${String(i).padStart(2, "0")}`,
        position,
        nflTeam: nflTeams[i % nflTeams.length],
        fantasyPositions: [position],
        externalIds: {},
        searchRank: i + 1,
        updatedAt: NOW,
      });
      players.push(playerId);
      await ctx.db.insert("player_projection_latest", {
        playerId,
        season: SEASON,
        week: 1,
        source: "sleeper_rotowire",
        position,
        projectedPointsPpr: 40 - i,
        projectedPointsHalf: 38 - i,
        projectedPointsStd: 36 - i,
        stats: { rec: 4 },
        effectiveAt: NOW - 3_600_000,
      });
    }

    const teamIds: Id<"teams">[] = [];
    for (let i = 0; i < teamCount; i++) {
      const teamId = await ctx.db.insert("teams", {
        leagueId,
        name: `Team ${i}`,
        abbreviation: `T${i}`,
        faabRemaining: 100,
        waiverPriority: i + 1,
        karma: 0,
        draftBudgetRemaining: 200,
      });
      teamIds.push(teamId);
      if ((opts.status ?? "in_season") === "in_season") {
        // One QB, one RB and one WR each: positions cycle every three players.
        const roster = [players[i * 3], players[i * 3 + 1], players[i * 3 + 2]];
        for (const playerId of roster) {
          await ctx.db.insert("roster_slots", {
            leagueId,
            teamId,
            playerId,
            acquiredAt: NOW - 86_400_000,
            acquiredVia: "draft",
          });
        }
        await ctx.db.insert("lineups", {
          leagueId,
          teamId,
          weekNo: 1,
          version: 1,
          source: "draft_default",
          slots: [
            { slot: "QB", playerId: roster[0] },
            // Left empty on purpose: this is the hole the safety autopilot fills
            // when the window closes with no run having set a lineup.
            { slot: "RB", playerId: null },
            { slot: "WR", playerId: roster[2] },
          ],
        });
      }
    }
    return { leagueId, teamIds, players, userId };
  });
}

async function insertWindow(
  t: TestHarness,
  seeded: Seed,
  overrides: Partial<Doc<"windows">> & { label: string },
): Promise<Id<"windows">> {
  return t.run(async (ctx) =>
    ctx.db.insert("windows", {
      leagueId: seeded.leagueId,
      type: "lineup",
      weekNo: 1,
      roundNo: 1,
      opensAt: NOW,
      submissionDeadlineAt: NOW + 30_000,
      closesAt: NOW + 40_000,
      status: "scheduled",
      scope: {},
      runCount: 0,
      terminalRunCount: 0,
      ...overrides,
    } as Parameters<typeof ctx.db.insert<"windows">>[1]),
  );
}

async function jobs(t: TestHarness) {
  return t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect());
}

async function windowRow(t: TestHarness, windowId: Id<"windows">) {
  return t.run(async (ctx) => ctx.db.get("windows", windowId));
}

async function runsFor(t: TestHarness, windowId: Id<"windows">) {
  return t.run(async (ctx) =>
    ctx.db
      .query("runs")
      .withIndex("by_windowId_status", (q) => q.eq("windowId", windowId))
      .collect(),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  finishInProgress = undefined;
  vi.stubEnv("RUN_DISPATCH", "skip");
  vi.stubEnv("COMMISSIONER_MODEL_ID", "mock/scripted");
});

afterEach(async () => {
  await finishInProgress?.();
  vi.clearAllTimers();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

// ======================================================== job scheduling

describe("scheduleWindowJobs", () => {
  test("materialising a week arms an open and a close job for every window", async () => {
    const t = harness();
    const s = await seed(t);
    const result = await t.mutation(internal.windows.materializeWindows, {
      leagueId: s.leagueId,
      weekNo: 1,
    });
    expect(result.created).toBe(15);

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("windows")
        .withIndex("by_leagueId_weekNo_type", (q) =>
          q.eq("leagueId", s.leagueId).eq("weekNo", 1),
        )
        .collect(),
    );
    expect(rows.every((row) => row.openJobId !== undefined)).toBe(true);
    expect(rows.every((row) => row.closeJobId !== undefined)).toBe(true);

    const scheduled = await jobs(t);
    // Two jobs per window and nothing else.
    expect(scheduled).toHaveLength(30);
    const opens = scheduled.filter((j) => j.name === "windows:open");
    expect(opens).toHaveLength(15);
    // Each job fires at its window's instant.
    const waiver = rows.find((r) => r.label === "waiver")!;
    const waiverOpen = scheduled.find((j) => j._id === waiver.openJobId)!;
    expect(waiverOpen.scheduledTime).toBe(waiver.opensAt);
    const waiverClose = scheduled.find((j) => j._id === waiver.closeJobId)!;
    expect(waiverClose.scheduledTime).toBe(waiver.closesAt);
  });

  test("a window whose clock has already passed opens (and closes) immediately", async () => {
    const t = harness();
    const s = await seed(t);
    const windowId = await insertWindow(t, s, {
      label: "late",
      opensAt: NOW - 3_600_000,
      submissionDeadlineAt: NOW - 3_500_000,
      closesAt: NOW - 3_400_000,
    });
    await t.mutation(internal.windows.rescheduleNow, { windowId, now: NOW });

    const row = await windowRow(t, windowId);
    const scheduled = await jobs(t);
    const open = scheduled.find((j) => j._id === row!.openJobId)!;
    // "Now", not the instant in the past: a late league still gets its window.
    expect(open.scheduledTime).toBeGreaterThan(NOW - 3_600_000);
  });

  test("rescheduling cancels the jobs it replaces", async () => {
    const t = harness();
    const s = await seed(t);
    const windowId = await insertWindow(t, s, { label: "moves" });
    await t.mutation(internal.windows.rescheduleNow, { windowId, now: NOW });
    const before = await windowRow(t, windowId);

    await t.mutation(internal.windows.rescheduleNow, {
      windowId,
      opensAt: NOW + 7_200_000,
      closesAt: NOW + 10_800_000,
      now: NOW,
    });
    const after = await windowRow(t, windowId);

    expect(after!.openJobId).not.toBe(before!.openJobId);
    expect(after!.opensAt).toBe(NOW + 7_200_000);
    const scheduled = await jobs(t);
    const old = scheduled.find((j) => j._id === before!.openJobId)!;
    expect(old.state.kind).toBe("canceled");
    const current = scheduled.find((j) => j._id === after!.openJobId)!;
    expect(current.state.kind).toBe("pending");
    expect(current.scheduledTime).toBe(NOW + 7_200_000);
    // The submission lead time rides along with the close.
    expect(after!.closesAt - after!.submissionDeadlineAt).toBe(
      before!.closesAt - before!.submissionDeadlineAt,
    );
  });

  test("an already-closed window is never re-armed", async () => {
    const t = harness();
    const s = await seed(t);
    const windowId = await insertWindow(t, s, { label: "done", status: "closed" });
    await t.mutation(internal.windows.rescheduleNow, { windowId, now: NOW });
    const row = await windowRow(t, windowId);
    expect(row!.openJobId).toBeUndefined();
    expect(row!.closeJobId).toBeUndefined();
  });
});

// ================================================================= open

describe("windows.open", () => {
  test("freezes a snapshot, binds it to the window and schedules the build", async () => {
    const t = harness();
    const s = await seed(t);
    const windowId = await insertWindow(t, s, { label: "lineup_sun_early" });

    const result = await t.mutation(internal.windows.open, { windowId, now: NOW });
    expect(result.opened).toBe(true);
    expect(result.reusedSnapshot).toBe(false);

    const row = await windowRow(t, windowId);
    expect(row!.status).toBe("open");
    expect(row!.snapshotId).toBe(result.snapshotId);
    expect(row!.openJobId).toBeUndefined();

    const snapshot = await t.run(async (ctx) => ctx.db.get("snapshots", result.snapshotId!));
    expect(snapshot!.status).toBe("building");
    expect(snapshot!.windowId).toBe(windowId);
    expect(snapshot!.takenAt).toBe(NOW);

    const scheduled = await jobs(t);
    expect(scheduled.some((j) => j.name === "snapshot:build")).toBe(true);
    expect(scheduled.some((j) => j.name === "windows:dispatch")).toBe(true);
  });

  test("is idempotent — a duplicate job cannot open a window twice", async () => {
    const t = harness();
    const s = await seed(t);
    const windowId = await insertWindow(t, s, { label: "lineup_sun_early" });

    const first = await t.mutation(internal.windows.open, { windowId, now: NOW });
    const second = await t.mutation(internal.windows.open, { windowId, now: NOW });
    expect(first.opened).toBe(true);
    expect(second).toEqual({ opened: false, snapshotId: null, reusedSnapshot: false });

    const snapshots = await t.run(async (ctx) => ctx.db.query("snapshots").collect());
    expect(snapshots).toHaveLength(1);
  });

  test("a draft window rides a fresh snapshot instead of building a new one", async () => {
    const t = harness();
    const s = await seed(t);
    const snapshotId = await t.run(async (ctx) =>
      ctx.db.insert("snapshots", {
        leagueId: s.leagueId,
        season: SEASON,
        weekNo: 1,
        takenAt: NOW - 60_000,
        status: "ready",
        chunkCount: 1,
        playerCount: 10,
      }),
    );
    const windowId = await insertWindow(t, s, {
      label: "draft_pick",
      type: "draft",
      weekNo: 0,
      roundNo: 1,
      scope: { pickNo: 1, onTheClockTeamId: s.teamIds[0], draftType: "snake" },
    });

    const result = await t.mutation(internal.windows.open, { windowId, now: NOW });
    expect(result.reusedSnapshot).toBe(true);
    expect(result.snapshotId).toBe(snapshotId);
    expect((await jobs(t)).some((j) => j.name === "snapshot:build")).toBe(false);
  });

  test("but not a stale one — past reuseSnapshotWithinMs it builds again", async () => {
    const t = harness();
    const s = await seed(t);
    await t.run(async (ctx) =>
      ctx.db.insert("snapshots", {
        leagueId: s.leagueId,
        season: SEASON,
        weekNo: 1,
        takenAt: NOW - RULES.reuseSnapshotWithinMs - 1,
        status: "ready",
        chunkCount: 1,
        playerCount: 10,
      }),
    );
    const windowId = await insertWindow(t, s, {
      label: "draft_pick",
      type: "draft",
      weekNo: 0,
      scope: { pickNo: 1, onTheClockTeamId: s.teamIds[0] },
    });
    const result = await t.mutation(internal.windows.open, { windowId, now: NOW });
    expect(result.reusedSnapshot).toBe(false);
  });
});

// ============================================================= dispatch

describe("windows.dispatch", () => {
  async function openWithReadySnapshot(t: TestHarness, windowId: Id<"windows">) {
    await t.mutation(internal.windows.open, { windowId, now: NOW });
    const row = await windowRow(t, windowId);
    await t.run(async (ctx) => {
      await ctx.db.patch("snapshots", row!.snapshotId!, { status: "ready" });
    });
    return row!.snapshotId!;
  }

  test("creates one pending run per team, denormalised for the trace list", async () => {
    const t = harness();
    const s = await seed(t);
    const windowId = await insertWindow(t, s, { label: "lineup_sun_early" });
    await openWithReadySnapshot(t, windowId);

    expect(await t.mutation(internal.windows.dispatch, { windowId })).toEqual({
      created: 3,
      waiting: false,
    });

    const runs = await runsFor(t, windowId);
    expect(runs).toHaveLength(3);
    expect(new Set(runs.map((r) => r.teamId))).toEqual(new Set(s.teamIds));
    for (const run of runs) {
      expect(run.status).toBe("pending");
      expect(run.kind).toBe("team");
      expect(run.windowType).toBe("lineup");
      expect(run.windowLabel).toBe("lineup_sun_early");
      expect(run.weekNo).toBe(1);
      expect(run.lastPersistedStep).toBe(-1);
      expect(run.attempt).toBe(1);
      // No agent config, so the league's first allowlisted model.
      expect(run.modelId).toBe("google/gemini-3.8-flash");
      expect(run.configVersionId).toBeUndefined();
    }
    expect((await windowRow(t, windowId))!.runCount).toBe(3);
  });

  test("uses the team's applied config version and its model when there is one", async () => {
    const t = harness();
    const s = await seed(t);
    const versionId = await t.run(async (ctx) => {
      const configId = await ctx.db.insert("agent_configs", {
        leagueId: s.leagueId,
        teamId: s.teamIds[0],
        updatedAt: NOW,
      });
      const versionId = await ctx.db.insert("config_versions", {
        configId,
        leagueId: s.leagueId,
        teamId: s.teamIds[0],
        versionNo: 1,
        modelId: "openai/gpt-6-astra",
        contextMd: "Be good.",
        skillIds: [],
        harness: {
          maxSteps: 6,
          tokenBudget: 20_000,
          temperature: 0.7,
          deliberateMode: false,
        },
        appliedAt: NOW,
      });
      await ctx.db.patch("agent_configs", configId, { currentVersionId: versionId });
      return versionId;
    });

    const windowId = await insertWindow(t, s, { label: "lineup_sun_early" });
    await openWithReadySnapshot(t, windowId);
    await t.mutation(internal.windows.dispatch, { windowId });

    const runs = await runsFor(t, windowId);
    const configured = runs.find((r) => r.teamId === s.teamIds[0])!;
    expect(configured.modelId).toBe("openai/gpt-6-astra");
    expect(configured.configVersionId).toBe(versionId);
    expect(runs.filter((r) => r.modelId === "google/gemini-3.8-flash")).toHaveLength(2);
  });

  test("is idempotent — a team that already has a run in the window is skipped", async () => {
    const t = harness();
    const s = await seed(t);
    const windowId = await insertWindow(t, s, { label: "lineup_sun_early" });
    await openWithReadySnapshot(t, windowId);

    await t.mutation(internal.windows.dispatch, { windowId });
    expect(await t.mutation(internal.windows.dispatch, { windowId })).toEqual({
      created: 0,
      waiting: false,
    });
    expect(await runsFor(t, windowId)).toHaveLength(3);
    expect((await windowRow(t, windowId))!.runCount).toBe(3);
  });

  test("a commissioner window creates no runs", async () => {
    const t = harness();
    const s = await seed(t);
    const windowId = await insertWindow(t, s, { label: "commish", type: "commissioner" });
    await openWithReadySnapshot(t, windowId);
    expect(await t.mutation(internal.windows.dispatch, { windowId })).toEqual({
      created: 0,
      waiting: false,
    });
    expect(await runsFor(t, windowId)).toHaveLength(0);
  });

  test("a snake pick window creates one run, for the team on the clock", async () => {
    const t = harness();
    const s = await seed(t);
    const windowId = await insertWindow(t, s, {
      label: "draft_pick",
      type: "draft",
      weekNo: 0,
      roundNo: 7,
      scope: { pickNo: 7, onTheClockTeamId: s.teamIds[1], draftType: "snake" },
    });
    await openWithReadySnapshot(t, windowId);
    await t.mutation(internal.windows.dispatch, { windowId });

    const runs = await runsFor(t, windowId);
    expect(runs).toHaveLength(1);
    expect(runs[0].teamId).toBe(s.teamIds[1]);
    expect(runs[0].windowType).toBe("draft");
  });

  test("an auction bidding window creates one run per team (sealed bids)", async () => {
    const t = harness();
    const s = await seed(t);
    const windowId = await insertWindow(t, s, {
      label: "auction_bid",
      type: "draft",
      weekNo: 0,
      roundNo: 3,
      scope: { lotNo: 3, draftType: "auction", phase: "bid" },
    });
    await openWithReadySnapshot(t, windowId);
    expect((await t.mutation(internal.windows.dispatch, { windowId })).created).toBe(3);
  });

  test("waits for a building snapshot, then dispatches", async () => {
    const t = harness();
    const s = await seed(t);
    const windowId = await insertWindow(t, s, { label: "lineup_sun_early" });
    await t.mutation(internal.windows.open, { windowId, now: NOW });

    expect(await t.mutation(internal.windows.dispatch, { windowId, attempt: 0 })).toEqual({
      created: 0,
      waiting: true,
    });
    expect(await runsFor(t, windowId)).toHaveLength(0);
    // It rescheduled itself five seconds out rather than giving up.
    const retry = (await jobs(t)).filter((j) => j.name === "windows:dispatch");
    expect(retry.length).toBeGreaterThanOrEqual(1);

    await t.run(async (ctx) => {
      const row = await ctx.db.get("windows", windowId);
      await ctx.db.patch("snapshots", row!.snapshotId!, { status: "ready" });
    });
    expect((await t.mutation(internal.windows.dispatch, { windowId, attempt: 1 })).created).toBe(3);
  });

  test("a failed snapshot still gets runs — the close fallback is the safety net", async () => {
    const t = harness();
    const s = await seed(t);
    const windowId = await insertWindow(t, s, { label: "lineup_sun_early" });
    await t.mutation(internal.windows.open, { windowId, now: NOW });
    await t.run(async (ctx) => {
      const row = await ctx.db.get("windows", windowId);
      await ctx.db.patch("snapshots", row!.snapshotId!, { status: "failed" });
    });
    expect((await t.mutation(internal.windows.dispatch, { windowId })).created).toBe(3);
  });

  test("gives up after the poll budget rather than rescheduling forever", async () => {
    const t = harness();
    const s = await seed(t);
    const windowId = await insertWindow(t, s, { label: "lineup_sun_early" });
    await t.mutation(internal.windows.open, { windowId, now: NOW });
    // 60 attempts * 5 s = five minutes of headroom; then it dispatches anyway.
    expect((await t.mutation(internal.windows.dispatch, { windowId, attempt: 60 })).created).toBe(3);
  });
});

// ================================================================ close

describe("windows.close", () => {
  async function openAndDispatch(t: TestHarness, windowId: Id<"windows">) {
    await t.mutation(internal.windows.open, { windowId, now: NOW });
    const row = await windowRow(t, windowId);
    await t.run(async (ctx) => ctx.db.patch("snapshots", row!.snapshotId!, { status: "ready" }));
    await t.mutation(internal.windows.dispatch, { windowId });
  }

  test("terminates every non-terminal run and marks the window closed", async () => {
    const t = harness();
    const s = await seed(t);
    const windowId = await insertWindow(t, s, { label: "lineup_sun_early" });
    await openAndDispatch(t, windowId);

    // One run "finished" normally; the other two never did.
    const runs = await runsFor(t, windowId);
    await t.run(async (ctx) =>
      ctx.db.patch("runs", runs[0]._id, { status: "succeeded", finishedAt: NOW + 10_000 }),
    );
    await t.run(async (ctx) => ctx.db.patch("runs", runs[1]._id, { status: "running" }));

    const result = await t.mutation(internal.windows.close, { windowId, now: NOW + 40_000 });
    expect(result.closed).toBe(true);
    expect((await windowRow(t, windowId))!.status).toBe("closed");

    const after = await runsFor(t, windowId);
    expect(after.find((r) => r._id === runs[0]._id)!.status).toBe("succeeded");
    expect(after.find((r) => r._id === runs[1]._id)!.status).not.toBe("running");
    expect(after.find((r) => r._id === runs[2]._id)!.status).not.toBe("pending");
    expect(after.every((r) => r.finishedAt !== undefined)).toBe(true);
  });

  test("is idempotent", async () => {
    const t = harness();
    const s = await seed(t);
    const windowId = await insertWindow(t, s, { label: "lineup_sun_early" });
    await openAndDispatch(t, windowId);
    expect((await t.mutation(internal.windows.close, { windowId })).closed).toBe(true);
    expect((await t.mutation(internal.windows.close, { windowId })).closed).toBe(false);
  });

  test("schedules one safety autopilot per team, and the film-room metrics", async () => {
    const t = harness();
    const s = await seed(t);
    const windowId = await insertWindow(t, s, { label: "lineup_sun_early" });
    await openAndDispatch(t, windowId);

    const result = await t.mutation(internal.windows.close, { windowId, now: NOW + 40_000 });
    // Per-team follow-ups, not twelve snapshot reassemblies in one transaction.
    expect(result.autopilots).toBe(3);
    const scheduled = await jobs(t);
    expect(
      scheduled.filter((j) => j.name === "windows:autopilotForTeam"),
    ).toHaveLength(3);
    expect(
      scheduled.some((j) => j.name === "metrics:computeForWindowClose"),
    ).toBe(true);
  });

  test("does not run the autopilot when the commissioner turned it off", async () => {
    const t = harness();
    const s = await seed(t);
    await t.run(async (ctx) => {
      const rules = await ctx.db
        .query("league_rules")
        .withIndex("by_leagueId", (q) => q.eq("leagueId", s.leagueId))
        .unique();
      await ctx.db.patch("league_rules", rules!._id, { safetyAutopilot: false });
    });
    const windowId = await insertWindow(t, s, { label: "lineup_sun_early" });
    await openAndDispatch(t, windowId);
    expect((await t.mutation(internal.windows.close, { windowId })).autopilots).toBe(0);
  });

  test("a waiver window hands the claims to the waiver processor", async () => {
    const t = harness();
    const s = await seed(t);
    const windowId = await insertWindow(t, s, { label: "waiver", type: "waiver" });
    await openAndDispatch(t, windowId);
    await t.mutation(internal.windows.close, { windowId, now: NOW + 40_000 });
    expect((await jobs(t)).some((j) => j.name === "waivers:process")).toBe(true);
  });

  test("only the last trade round sweeps open proposals, across every sibling", async () => {
    const t = harness();
    const s = await seed(t);
    const rounds: Id<"windows">[] = [];
    for (let round = 1; round <= 3; round++) {
      rounds.push(
        await insertWindow(t, s, {
          label: "trade_a",
          type: "trade",
          roundNo: round,
          opensAt: NOW + round * 1000,
          submissionDeadlineAt: NOW + round * 1000 + 500,
          closesAt: NOW + round * 1000 + 900,
          scope: { rounds: 3, round },
        }),
      );
    }

    // Rounds 1 and 2 close without expiring anything: an offer made in round 1
    // must still be answerable in rounds 2 and 3 (PRD 5.6).
    for (const round of [0, 1]) {
      const result = await t.mutation(internal.windows.close, { windowId: rounds[round] });
      expect(result.tradeSiblingsExpired).toBe(0);
    }
    // The last round sweeps all three sub-windows.
    const last = await t.mutation(internal.windows.close, { windowId: rounds[2] });
    expect(last.tradeSiblingsExpired).toBe(3);

    const scheduled = await jobs(t);
    expect(
      scheduled.filter((j) => j.name === "trades:expireForWindow"),
    ).toHaveLength(3);
    // Review processing runs at every round's close, not just the last.
    expect(
      scheduled.filter((j) => j.name === "trades:processReviews"),
    ).toHaveLength(3);
  });

  test("a draft window hands the clock to the draft chain", async () => {
    const t = harness();
    const s = await seed(t);
    const windowId = await insertWindow(t, s, {
      label: "draft_pick",
      type: "draft",
      weekNo: 0,
      scope: { pickNo: 1, onTheClockTeamId: s.teamIds[0], draftType: "snake" },
    });
    await t.mutation(internal.windows.close, { windowId });
    expect(
      (await jobs(t)).some((j) => j.name === "draft_progression:onPickWindowClosed"),
    ).toBe(true);
  });
});

// ========================================== the end-to-end window lifecycle

describe("a window's whole life, driven only by its scheduled jobs", () => {
  test("opens on its clock, snapshots, runs, and closes with the fallbacks", async () => {
    vi.useFakeTimers();
    const t = harness();
    const s = await seed(t);

    // Opens in ten seconds, closes in forty — the brief's scheduler test.
    const windowId = await t.run(async (ctx) => {
      const now = Date.now();
      return ctx.db.insert("windows", {
        leagueId: s.leagueId,
        type: "lineup",
        label: "lineup_sun_early",
        weekNo: 1,
        roundNo: 1,
        opensAt: now + 10_000,
        submissionDeadlineAt: now + 35_000,
        closesAt: now + 40_000,
        status: "scheduled",
        scope: {},
        runCount: 0,
        terminalRunCount: 0,
      });
    });
    await t.mutation(internal.windows.rescheduleNow, { windowId, now: NOW });

    // Nothing has happened yet: the jobs are armed, the window is scheduled.
    expect((await windowRow(t, windowId))!.status).toBe("scheduled");
    expect(await runsFor(t, windowId)).toHaveLength(0);

    // Let snapshot construction and dispatch finish at the opening clock.
    // Pumping whole seconds while cold modules load can otherwise manufacture
    // a timeout by advancing through the close before dispatch gets CPU time.
    await vi.advanceTimersByTimeAsync(10_000);
    await t.finishInProgressScheduledFunctions();
    for (let attempt = 0; attempt < 100 && (await runsFor(t, windowId)).length < s.teamIds.length; attempt++) {
      await vi.advanceTimersByTimeAsync(100);
      await t.finishInProgressScheduledFunctions();
    }
    expect(await runsFor(t, windowId)).toHaveLength(s.teamIds.length);
    await vi.advanceTimersByTimeAsync(30_000);
    await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(1), 200);

    const row = await windowRow(t, windowId);
    expect(row!.status).toBe("closed");

    // The snapshot was built and bound to the window.
    const snapshot = await t.run(async (ctx) => ctx.db.get("snapshots", row!.snapshotId!));
    expect(snapshot!.status).toBe("ready");
    expect(snapshot!.windowId).toBe(windowId);
    expect(snapshot!.chunkCount).toBeGreaterThan(0);

    // One run per team, all terminal — nothing executed them (the Workpool is
    // not registered here), so the close timed every one of them out.
    const runs = await runsFor(t, windowId);
    expect(runs).toHaveLength(s.teamIds.length);
    expect(runs.every((r) => r.status !== "pending" && r.status !== "running")).toBe(true);

    // And the safety autopilot filled the empty RB slot every team was left
    // with, writing a new lineup version (PRD §12: an outage must not blank a
    // lineup).
    const lineups = await t.run(async (ctx) =>
      ctx.db
        .query("lineups")
        .withIndex("by_teamId_weekNo_version", (q) =>
          q.eq("teamId", s.teamIds[0]).eq("weekNo", 1),
        )
        .order("desc")
        .collect(),
    );
    expect(lineups.length).toBeGreaterThan(1);
    expect(lineups[0].source).toBe("autopilot");
    expect(lineups[0].slots.find((slot) => slot.slot === "RB")?.playerId).not.toBeNull();
  });
});

// ====================================================== rescheduleForLeague

describe("windows.rescheduleForLeague", () => {
  test("moves the windows a commissioner override changed, and re-arms them", async () => {
    const t = harness();
    const s = await seed(t);
    await t.mutation(internal.windows.materializeWindows, { leagueId: s.leagueId, weekNo: 1 });
    const before = await t.run(async (ctx) =>
      ctx.db
        .query("windows")
        .withIndex("by_leagueId_label_weekNo_roundNo", (q) =>
          q.eq("leagueId", s.leagueId).eq("label", "waiver").eq("weekNo", 1).eq("roundNo", 1),
        )
        .unique(),
    );

    await t.run(async (ctx) => {
      const rules = await ctx.db
        .query("league_rules")
        .withIndex("by_leagueId", (q) => q.eq("leagueId", s.leagueId))
        .unique();
      await ctx.db.patch("league_rules", rules!._id, {
        windowOverrides: {
          waiver: { opensTime: "07:30" },
          trade_b: { enabled: false },
        },
      });
    });

    const result = await t.mutation(internal.windows.rescheduleForLeague, {
      leagueId: s.leagueId,
      weekNo: 1,
      now: NOW,
    });
    expect(result.removed).toBe(3); // all three trade_b rounds, disabled and never opened
    expect(result.rescheduled).toBeGreaterThan(0);

    const after = await t.run(async (ctx) =>
      ctx.db
        .query("windows")
        .withIndex("by_leagueId_label_weekNo_roundNo", (q) =>
          q.eq("leagueId", s.leagueId).eq("label", "waiver").eq("weekNo", 1).eq("roundNo", 1),
        )
        .unique(),
    );
    expect(after!.opensAt).toBe(before!.opensAt + 90 * 60_000);
    expect(after!.openJobId).not.toBe(before!.openJobId);
    const scheduled = await jobs(t);
    expect(scheduled.find((j) => j._id === before!.openJobId)!.state.kind).toBe("canceled");
    expect(scheduled.find((j) => j._id === after!.openJobId)!.scheduledTime).toBe(after!.opensAt);

    expect(
      await t.run(async (ctx) =>
        ctx.db
          .query("windows")
          .withIndex("by_leagueId_label_weekNo_roundNo", (q) =>
            q.eq("leagueId", s.leagueId).eq("label", "trade_b").eq("weekNo", 1),
          )
          .collect(),
      ),
    ).toHaveLength(0);
  });

  test("never moves the clock out from under a window that already opened", async () => {
    const t = harness();
    const s = await seed(t);
    await t.mutation(internal.windows.materializeWindows, { leagueId: s.leagueId, weekNo: 1 });
    const waiver = await t.run(async (ctx) =>
      ctx.db
        .query("windows")
        .withIndex("by_leagueId_label_weekNo_roundNo", (q) =>
          q.eq("leagueId", s.leagueId).eq("label", "waiver").eq("weekNo", 1).eq("roundNo", 1),
        )
        .unique(),
    );
    await t.mutation(internal.windows.open, { windowId: waiver!._id, now: NOW });

    await t.run(async (ctx) => {
      const rules = await ctx.db
        .query("league_rules")
        .withIndex("by_leagueId", (q) => q.eq("leagueId", s.leagueId))
        .unique();
      await ctx.db.patch("league_rules", rules!._id, {
        windowOverrides: { waiver: { opensTime: "07:30" } },
      });
    });
    await t.mutation(internal.windows.rescheduleForLeague, {
      leagueId: s.leagueId,
      weekNo: 1,
      now: NOW,
    });

    const after = await windowRow(t, waiver!._id);
    expect(after!.opensAt).toBe(waiver!.opensAt);
    expect(after!.status).toBe("open");
  });
});

// =============================================================== season tick

describe("season.tickAll", () => {
  test("does nothing off an NFL game day", async () => {
    const t = harness();
    await seed(t);
    const wednesday = fromETParts({ year: 2026, month: 9, day: 16, hour: 12 });
    expect(await t.mutation(internal.season.tickAll, { now: wednesday })).toEqual({
      leagues: 0,
      skipped: true,
    });
    expect(await jobs(t)).toHaveLength(0);
  });

  test("fans out one mutation per in-season league on a game day", async () => {
    const t = harness();
    await seed(t);
    await seed(t);
    // A league still drafting is not scored.
    await seed(t, { status: "drafting" });

    const sunday = fromETParts({ year: 2026, month: 9, day: 13, hour: 13 });
    await t.run(async (ctx) => {
      await ctx.db.insert("nfl_games", {
        season: SEASON, week: 1, gameId: "tick-sunday", homeTeam: "BUF", awayTeam: "MIA",
        kickoffAt: sunday, status: "in_progress",
      });
    });
    expect(await t.mutation(internal.season.tickAll, { now: sunday })).toEqual({
      leagues: 2,
      skipped: false,
    });
    expect((await jobs(t)).filter((j) => j.name === "season:scoreOne")).toHaveLength(2);
  });

  test("continues scoring through overnight finalization, then stops", async () => {
    const t = harness();
    const kickoffAt = fromETParts({ year: 2026, month: 9, day: 10, hour: 20 });
    await t.run(async (ctx) => {
      await ctx.db.insert("nfl_games", {
        season: SEASON, week: 1, gameId: "overnight", homeTeam: "KC", awayTeam: "DEN",
        kickoffAt, status: "final",
      });
    });
    expect((await t.mutation(internal.season.tickAll, {
      now: kickoffAt + GAME_WINDOW_TAIL_MS,
    })).skipped).toBe(false);
    expect(await t.mutation(internal.season.tickAll, {
      now: kickoffAt + GAME_WINDOW_TAIL_MS + 1,
    })).toEqual({ leagues: 0, skipped: true });
  });

  test("scores the active week and hands a finalized week to the commissioner once", async () => {
    const t = harness();
    const s = await seed(t);
    // Every game of week 1 is final, so `finalizeWeek` will finalize.
    await t.run(async (ctx) => {
      const games = await ctx.db
        .query("nfl_games")
        .withIndex("by_season_week", (q) => q.eq("season", SEASON).eq("week", 1))
        .collect();
      for (const game of games) await ctx.db.patch("nfl_games", game._id, { status: "final" });
      await ctx.db.insert("matchups", {
        leagueId: s.leagueId,
        weekNo: 1,
        homeTeamId: s.teamIds[0],
        awayTeamId: s.teamIds[1],
        isFinal: false,
      });
    });

    const first = await t.mutation(internal.season.scoreOne, { leagueId: s.leagueId, now: NOW });
    expect(first.weekNo).toBe(1);
    expect(first.finalized).toBe(true);
    expect(first.commissionerScheduled).toBe(true);

    // Fifteen minutes later the week is still final — but the recap is not
    // posted a second time.
    const second = await t.mutation(internal.season.scoreOne, {
      leagueId: s.leagueId,
      now: NOW + 900_000,
    });
    expect(second.finalized).toBe(true);
    expect(second.commissionerScheduled).toBe(false);
    expect(
      (await jobs(t)).filter((j) => j.name === "commissioner_agent:runWeekly"),
    ).toHaveLength(1);
  });
});

// ========================================================= draft progression

/**
 * A league on the clock: two teams, a four-slot roster (so the board is eight
 * picks) and a two-second pick clock, which keeps the whole chain inside a
 * handful of fake-timer iterations.
 */
async function seedDraft(
  t: TestHarness,
  opts: { draftType?: "snake" | "auction"; pickSeconds?: number } = {},
): Promise<Seed> {
  const s = await seed(t, { status: "drafting", teams: 2 });
  await t.run(async (ctx) => {
    await ctx.db.patch("leagues", s.leagueId, { draftType: opts.draftType ?? "snake" });
    const rules = await ctx.db
      .query("league_rules")
      .withIndex("by_leagueId", (q) => q.eq("leagueId", s.leagueId))
      .unique();
    await ctx.db.patch("league_rules", rules!._id, {
      draftPickSeconds: opts.pickSeconds ?? 2,
    });
  });
  return s;
}

async function draftWindows(t: TestHarness, leagueId: Id<"leagues">) {
  return t.run(async (ctx) =>
    ctx.db
      .query("windows")
      .withIndex("by_leagueId_weekNo_type", (q) =>
        q.eq("leagueId", leagueId).eq("weekNo", 0).eq("type", "draft"),
      )
      .collect(),
  );
}

describe("draft_progression.begin / openNextPick", () => {
  test("starting a draft puts the first team on the clock", async () => {
    const t = harness();
    const s = await seedDraft(t);

    const board = await t.mutation(internal.draft_progression.begin, { leagueId: s.leagueId });
    expect(board.type).toBe("snake");
    expect(board.picks).toBe(8); // 2 teams x 4 roster slots

    const windows = await draftWindows(t, s.leagueId);
    expect(windows).toHaveLength(1);
    const [window] = windows;
    expect(window.label).toBe("draft_pick");
    expect(window.weekNo).toBe(0);
    expect(window.roundNo).toBe(1);
    expect(window.scope.pickNo).toBe(1);
    expect(window.scope.draftType).toBe("snake");
    expect(window.scope.onTheClockTeamId).toBe(board.order[0]);
    // The pick clock: a two-second window with a proportionally short lead.
    expect(window.closesAt - window.opensAt).toBe(2_000);
    expect(window.closesAt - window.submissionDeadlineAt).toBe(500);

    // `leagues.draftJobId` is the pick clock itself.
    const league = await t.run(async (ctx) => ctx.db.get("leagues", s.leagueId));
    expect(league!.draftJobId).toBe(window.closeJobId);
  });

  test("is idempotent: a second call does not open a second window for the pick", async () => {
    const t = harness();
    const s = await seedDraft(t);
    await t.mutation(internal.draft_progression.begin, { leagueId: s.leagueId });
    await t.mutation(internal.draft_progression.openNextPick, { leagueId: s.leagueId });
    expect(await draftWindows(t, s.leagueId)).toHaveLength(1);
  });

  test("a draft scheduled for later arms a job instead of opening anything", async () => {
    const t = harness();
    const s = await seedDraft(t);
    const startsAt = Date.now() + 3_600_000;
    await t.mutation(internal.draft_progression.begin, {
      leagueId: s.leagueId,
      scheduledAt: startsAt,
    });

    expect(await draftWindows(t, s.leagueId)).toHaveLength(0);
    const league = await t.run(async (ctx) => ctx.db.get("leagues", s.leagueId));
    const job = (await jobs(t)).find((j) => j._id === league!.draftJobId)!;
    expect(job.name).toBe("draft_progression:openNextPick");
    expect(job.scheduledTime).toBe(startsAt);
  });
});

describe("draft_progression.onPickWindowClosed", () => {
  test("auto-picks the best available when the clock expires with no pick", async () => {
    const t = harness();
    const s = await seedDraft(t);
    await t.mutation(internal.draft_progression.begin, { leagueId: s.leagueId });
    const [window] = await draftWindows(t, s.leagueId);

    const result = await t.mutation(internal.draft_progression.onPickWindowClosed, {
      windowId: window._id,
    });
    expect(result.autoPicked).toBe(true);
    expect(result.advanced).toBe(true);

    const picks = await t.run(async (ctx) =>
      ctx.db
        .query("draft_picks")
        .withIndex("by_leagueId_overallNo", (q) => q.eq("leagueId", s.leagueId))
        .collect(),
    );
    const first = picks.find((p) => p.overallNo === 1)!;
    expect(first.playerId).toBeDefined();
    expect(first.auto).toBe(true);

    // And the next team is on the clock.
    const windows = await draftWindows(t, s.leagueId);
    expect(windows).toHaveLength(2);
    expect(windows.find((w) => w.roundNo === 2)!.scope.onTheClockTeamId).not.toBe(
      window.scope.onTheClockTeamId,
    );
  });

  test("leaves a pick the agent already made alone", async () => {
    const t = harness();
    const s = await seedDraft(t);
    await t.mutation(internal.draft_progression.begin, { leagueId: s.leagueId });
    const [window] = await draftWindows(t, s.leagueId);

    const onTheClock = window.scope.onTheClockTeamId!;
    const made = await t.mutation(internal.draft.recordPick, {
      leagueId: s.leagueId,
      windowId: window._id,
      teamId: onTheClock,
      playerId: s.players[5],
    });
    expect(made.ok).toBe(true);

    const result = await t.mutation(internal.draft_progression.onPickWindowClosed, {
      windowId: window._id,
    });
    expect(result.autoPicked).toBe(false);

    const first = await t.run(async (ctx) =>
      ctx.db
        .query("draft_picks")
        .withIndex("by_leagueId_overallNo", (q) =>
          q.eq("leagueId", s.leagueId).eq("overallNo", 1),
        )
        .first(),
    );
    expect(first!.playerId).toBe(s.players[5]);
    expect(first!.auto).toBe(false);
  });
});

describe("a whole snake draft, driven only by its pick clocks", () => {
  test("auto-picks every pick, finalizes, and arms the season", async () => {
    vi.useFakeTimers();
    const t = harness();
    const s = await seedDraft(t);
    await t.mutation(internal.draft_progression.begin, { leagueId: s.leagueId });

    await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(1_000), 400);

    const picks = await t.run(async (ctx) =>
      ctx.db
        .query("draft_picks")
        .withIndex("by_leagueId_overallNo", (q) => q.eq("leagueId", s.leagueId))
        .collect(),
    );
    expect(picks).toHaveLength(8);
    expect(picks.every((p) => p.playerId !== undefined)).toBe(true);
    expect(new Set(picks.map((p) => p.playerId)).size).toBe(8); // nobody drafted twice

    // Eight pick windows, each opened and closed by its own jobs.
    const windows = await draftWindows(t, s.leagueId);
    expect(windows).toHaveLength(8);
    expect(windows.every((w) => w.status === "closed")).toBe(true);
    // The snapshot was built once and reused across the whole draft.
    const snapshots = await t.run(async (ctx) => ctx.db.query("snapshots").collect());
    expect(snapshots).toHaveLength(1);

    const league = await t.run(async (ctx) => ctx.db.get("leagues", s.leagueId));
    expect(league!.status).toBe("in_season");
    expect(league!.draftJobId).toBeUndefined();

    // `finalize` handed off to the week-rollover chain and the draft recap.
    const weeks = await t.run(async (ctx) =>
      ctx.db
        .query("weeks")
        .withIndex("by_leagueId_weekNo", (q) => q.eq("leagueId", s.leagueId))
        .take(22),
    );
    expect(weeks.some((w) => w.rolloverJobId !== undefined || w.status !== "upcoming")).toBe(true);
    expect((await jobs(t)).some((j) => j.name === "commissioner_agent:draftRecap")).toBe(true);
  });
});

describe("an auction draft", () => {
  test("opens a nomination window, then a sealed-bid window for the lot", async () => {
    const t = harness();
    const s = await seedDraft(t, { draftType: "auction" });
    await t.mutation(internal.draft_progression.begin, {
      leagueId: s.leagueId,
      type: "auction",
    });

    const [nomination] = await draftWindows(t, s.leagueId);
    expect(nomination.label).toBe("auction_nominate");
    expect(nomination.roundNo).toBe(1);
    expect(nomination.scope.lotNo).toBe(1);
    expect(nomination.scope.phase).toBe("nominate");
    expect(nomination.scope.nominationTeamId).toBeDefined();

    const nominationBoard = await t.query(api.draft.board, { leagueId: s.leagueId });
    expect(nominationBoard.auction).toMatchObject({
      phase: "nomination",
      bidsSealed: true,
      currentLot: {
        lotNo: 1,
        status: "pending",
        nominatorTeamId: nomination.scope.nominationTeamId,
        playerId: null,
        deadlineAt: nomination.closesAt,
      },
    });
    expect(nominationBoard.picksMade).toBe(0);
    expect(nominationBoard.totalPicks).toBe(8);

    // Nobody nominated: the platform nominates the best available at $1.
    const result = await t.mutation(internal.draft_progression.onPickWindowClosed, {
      windowId: nomination._id,
    });
    expect(result.autoPicked).toBe(true);

    const lot = await t.run(async (ctx) =>
      ctx.db
        .query("auction_nominations")
        .withIndex("by_leagueId_lotNo", (q) => q.eq("leagueId", s.leagueId).eq("lotNo", 1))
        .unique(),
    );
    expect(lot!.status).toBe("bidding");
    expect(lot!.openingBid).toBe(1);

    const bidWindow = (await draftWindows(t, s.leagueId)).find(
      (w) => w.label === "auction_bid",
    );
    expect(bidWindow).toBeDefined();
    expect(bidWindow!.scope.lotNo).toBe(1);
    expect(bidWindow!.scope.phase).toBe("bid");

    const biddingBoard = await t.query(api.draft.board, { leagueId: s.leagueId });
    expect(biddingBoard.auction).toMatchObject({
      phase: "bidding",
      bidsSealed: true,
      currentLot: {
        lotNo: 1,
        status: "bidding",
        playerId: lot!.playerId,
        openingBid: 1,
        deadlineAt: bidWindow!.closesAt,
      },
    });
  });

  test("closing the bidding window resolves the lot and rotates the nomination", async () => {
    const t = harness();
    const s = await seedDraft(t, { draftType: "auction" });
    await t.mutation(internal.draft_progression.begin, {
      leagueId: s.leagueId,
      type: "auction",
    });
    const [nomination] = await draftWindows(t, s.leagueId);
    await t.mutation(internal.draft_progression.onPickWindowClosed, {
      windowId: nomination._id,
    });
    const bidWindow = (await draftWindows(t, s.leagueId)).find((w) => w.label === "auction_bid")!;

    await t.mutation(internal.draft_progression.onPickWindowClosed, { windowId: bidWindow._id });

    const lots = await t.run(async (ctx) =>
      ctx.db
        .query("auction_nominations")
        .withIndex("by_leagueId_lotNo", (q) => q.eq("leagueId", s.leagueId))
        .collect(),
    );
    expect(lots.find((l) => l.lotNo === 1)!.status).toBe("resolved");
    // The nominator's opening bid won it, and lot 2 awaits its nomination.
    const next = lots.find((l) => l.lotNo === 2);
    expect(next?.status).toBe("pending");
    expect(s.teamIds).toContain(next?.nominatingTeamId);
    expect(
      (await draftWindows(t, s.leagueId)).some(
        (w) => w.label === "auction_nominate" && w.roundNo === 2,
      ),
    ).toBe(true);
  });
});
