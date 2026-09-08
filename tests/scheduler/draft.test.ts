/**
 * Snake draft: the board, the pick clock, auto-picks, and what happens when the
 * last pick lands.
 */
import { and, eq, isNull } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/services/lineup", () => ({
  applySafetyAutopilot: vi.fn(async () => ({ slots: [], changed: false, filledSlots: [] })),
  // Force the scheduler's local fallback so the draft still produces lineups
  // while the runtime package is a stub.
  computeOptimalLineup: vi.fn(() => {
    throw new Error("not implemented (runtime package)");
  }),
  commitLineup: vi.fn(async () => {
    throw new Error("not implemented (runtime package)");
  }),
  validateLineup: vi.fn(() => ({ ok: true })),
}));

import { db } from "@/lib/db";
import { draftPicks, leagues, lineups, matchups, rosterSlots, runs, windows } from "@/lib/db/schema";
import { progressDraft } from "@/lib/scheduler/draft-progression";
import { isStarter } from "@/lib/scheduler/lineup-fallback";
import {
  getDraftBoard,
  nextPick,
  recordDraftPick,
  seededShuffle,
  startDraft,
  validatePickPosition,
} from "@/lib/services/draft";

import { truncateAll } from "../setup";
import { createTestLeague, seedGames, seedPlayers, seedProjections, setRules } from "./helpers";

const START = new Date("2026-09-01T18:00:00Z");

/** A small league so a whole draft runs in a handful of seconds. */
async function draftLeague() {
  const league = await createTestLeague({ teamCount: 8 });
  await setRules(league.leagueId, {
    rosterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DEF: 1, BENCH: 1 },
    draftPickSeconds: 240,
    reuseSnapshotWithinMs: 600_000,
  });
  const pool = await seedPlayers(220);
  await seedProjections(pool, league.season, 1);
  await seedGames(league.season, 1);
  return { league, pool };
}

describe("seeded order", () => {
  it("is deterministic for a given seed and a permutation of the input", () => {
    const ids = ["a", "b", "c", "d", "e"];
    expect(seededShuffle(ids, 42)).toEqual(seededShuffle(ids, 42));
    expect(seededShuffle(ids, 42)).not.toEqual(seededShuffle(ids, 43));
    expect([...seededShuffle(ids, 42)].sort()).toEqual(ids);
  });
});

describe("position sanity", () => {
  const shape = { QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DEF: 1, BENCH: 6 };

  it("caps streaming positions at starters + 1", () => {
    expect(
      validatePickPosition({
        position: "K",
        currentPositions: ["K", "K"],
        rosterShape: shape,
        picksRemainingAfter: 5,
        superflex: false,
      }),
    ).toContain("wastes a roster spot");
  });

  it("refuses a pick that would leave a mandatory slot unfillable", () => {
    expect(
      validatePickPosition({
        position: "WR",
        currentPositions: ["WR", "WR", "RB", "RB", "QB", "TE"],
        rosterShape: shape,
        // Only one pick left, but K and DEF are both still empty.
        picksRemainingAfter: 1,
        superflex: false,
      }),
    ).toContain("unable to fill");
  });

  it("allows an ordinary pick", () => {
    expect(
      validatePickPosition({
        position: "RB",
        currentPositions: ["QB"],
        rosterShape: shape,
        picksRemainingAfter: 10,
        superflex: false,
      }),
    ).toBeNull();
  });
});

describe("startDraft", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("materializes a snake board and flips the league to drafting", async () => {
    const { league } = await draftLeague();
    const result = await startDraft(league.leagueId, { type: "snake", seed: 7, scheduledAt: START }, db);
    expect(result.rounds).toBe(9);
    expect(result.picks).toBe(9 * 8);

    const picks = await db
      .select()
      .from(draftPicks)
      .where(eq(draftPicks.leagueId, league.leagueId))
      .orderBy(draftPicks.overallNo);
    expect(picks).toHaveLength(72);
    // Round 1 forward, round 2 reversed — that is what makes it a snake.
    const round1 = picks.filter((p) => p.round === 1).map((p) => p.teamId);
    const round2 = picks.filter((p) => p.round === 2).map((p) => p.teamId);
    expect(round2).toEqual([...round1].reverse());
    // Every team gets exactly `rounds` picks.
    for (const teamId of league.teamIds) {
      expect(picks.filter((p) => p.teamId === teamId)).toHaveLength(9);
    }

    const updated = await db.query.leagues.findFirst({ where: eq(leagues.id, league.leagueId) });
    expect(updated!.status).toBe("drafting");
  });

  it("is idempotent", async () => {
    const { league } = await draftLeague();
    await startDraft(league.leagueId, { type: "snake", seed: 7, scheduledAt: START }, db);
    const again = await startDraft(league.leagueId, { type: "snake", seed: 7, scheduledAt: START }, db);
    expect(again.picks).toBe(0);
    const picks = await db.select().from(draftPicks).where(eq(draftPicks.leagueId, league.leagueId));
    expect(picks).toHaveLength(72);
  });
});

describe("draft progression", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("opens one window for the team on the clock and creates its run", async () => {
    const { league } = await draftLeague();
    await startDraft(league.leagueId, { type: "snake", seed: 7, scheduledAt: START }, db);

    const report = await progressDraft(league.leagueId, START, db);
    expect(report.opened).toBe(1);

    const open = await db
      .select()
      .from(windows)
      .where(and(eq(windows.leagueId, league.leagueId), eq(windows.status, "open")));
    expect(open).toHaveLength(1);
    expect(open[0].label).toBe("draft_pick");
    expect(open[0].scope.pickNo).toBe(1);
    expect(open[0].snapshotId).not.toBeNull();
    // 4-minute pick clock from league_rules.
    expect(open[0].closesAt.getTime() - open[0].opensAt.getTime()).toBe(240_000);

    const created = await db.select().from(runs).where(eq(runs.windowId, open[0].id));
    expect(created).toHaveLength(1);
    expect(created[0].teamId).toBe(open[0].scope.onTheClockTeamId);
  });

  it("leaves the window alone while the clock is running", async () => {
    const { league } = await draftLeague();
    await startDraft(league.leagueId, { type: "snake", seed: 7, scheduledAt: START }, db);
    await progressDraft(league.leagueId, START, db);
    const second = await progressDraft(league.leagueId, new Date(START.getTime() + 60_000), db);
    expect(second.opened).toBe(0);
    expect(second.closed).toBe(0);
  });

  it("auto-picks the best available when the clock expires", async () => {
    const { league } = await draftLeague();
    await startDraft(league.leagueId, { type: "snake", seed: 7, scheduledAt: START }, db);
    await progressDraft(league.leagueId, START, db);

    const report = await progressDraft(league.leagueId, new Date(START.getTime() + 300_000), db);
    expect(report.closed).toBe(1);
    expect(report.autoPicks).toBe(1);

    const first = await db.query.draftPicks.findFirst({
      where: and(eq(draftPicks.leagueId, league.leagueId), eq(draftPicks.overallNo, 1)),
    });
    expect(first!.playerId).not.toBeNull();
    expect(first!.auto).toBe(true);
    expect(first!.rationale).toContain("Auto-pick");
    const roster = await db.select().from(rosterSlots).where(eq(rosterSlots.teamId, first!.teamId));
    expect(roster.some((r) => r.playerId === first!.playerId)).toBe(true);
  });

  it("reuses a fresh snapshot instead of rebuilding one per pick", async () => {
    const { league } = await draftLeague();
    await startDraft(league.leagueId, { type: "snake", seed: 7, scheduledAt: START }, db);
    await progressDraft(league.leagueId, START, db);
    await progressDraft(league.leagueId, new Date(START.getTime() + 300_000), db);
    const openWindows = await db
      .select()
      .from(windows)
      .where(eq(windows.leagueId, league.leagueId))
      .orderBy(windows.roundNo);
    // Two pick windows, one snapshot (well inside reuseSnapshotWithinMs).
    expect(openWindows).toHaveLength(2);
    expect(openWindows[0].snapshotId).toBe(openWindows[1].snapshotId);
  });

  it("runs a whole draft to completion, producing legal rosters and default lineups", async () => {
    const { league } = await draftLeague();
    await startDraft(league.leagueId, { type: "snake", seed: 7, scheduledAt: START }, db);

    let now = START;
    for (let i = 0; i < 200; i++) {
      const report = await progressDraft(league.leagueId, now, db);
      if (report.finalized) break;
      now = new Date(now.getTime() + 300_000);
    }

    const unfilled = await db
      .select()
      .from(draftPicks)
      .where(and(eq(draftPicks.leagueId, league.leagueId), isNull(draftPicks.playerId)));
    expect(unfilled).toHaveLength(0);

    // Legal rosters: 9 players each, nobody drafted twice.
    const rostered = await db.select().from(rosterSlots);
    expect(rostered).toHaveLength(72);
    expect(new Set(rostered.map((r) => r.playerId)).size).toBe(72);
    for (const teamId of league.teamIds) {
      expect(rostered.filter((r) => r.teamId === teamId)).toHaveLength(9);
    }

    // A default week-1 lineup per team, with every starting slot filled.
    const week1 = await db.select().from(lineups).where(eq(lineups.weekNo, 1));
    expect(week1).toHaveLength(8);
    for (const lineup of week1) {
      expect(lineup.source).toBe("draft_default");
      const starters = lineup.slots.filter((s) => isStarter(s.slot));
      expect(starters).toHaveLength(8);
      expect(starters.every((s) => s.playerId !== null)).toBe(true);
      // No player may occupy two slots.
      const ids = lineup.slots.map((s) => s.playerId).filter(Boolean);
      expect(new Set(ids).size).toBe(ids.length);
    }

    const schedule = await db.select().from(matchups).where(eq(matchups.leagueId, league.leagueId));
    expect(schedule.length).toBe(14 * 4);

    const updated = await db.query.leagues.findFirst({ where: eq(leagues.id, league.leagueId) });
    expect(updated!.status).toBe("in_season");
  }, 120_000);
});

describe("recordDraftPick", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("rejects a pick from a team that is not on the clock and a drafted player", async () => {
    const { league, pool } = await draftLeague();
    await startDraft(league.leagueId, { type: "snake", seed: 7, scheduledAt: START }, db);
    await progressDraft(league.leagueId, START, db);
    const [window] = await db
      .select()
      .from(windows)
      .where(and(eq(windows.leagueId, league.leagueId), eq(windows.status, "open")));
    const onTheClock = window.scope.onTheClockTeamId as string;
    const other = league.teamIds.find((id) => id !== onTheClock)!;
    const ctx = {
      runId: "",
      stepIndex: 0,
      toolCallId: "t",
      configVersionId: null,
      windowId: window.id,
      weekNo: 0,
    };

    const wrongTeam = await recordDraftPick(
      { leagueId: league.leagueId, windowId: window.id, teamId: other, playerId: pool[0].id, ctx },
      db,
    );
    expect(wrongTeam.ok).toBe(false);
    if (!wrongTeam.ok) expect(wrongTeam.errors.join(" ")).toContain("not on the clock");

    const good = await recordDraftPick(
      {
        leagueId: league.leagueId,
        windowId: window.id,
        teamId: onTheClock,
        playerId: pool[0].id,
        ctx,
      },
      db,
    );
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.overallNo).toBe(1);

    // The next team may not take the same player.
    await progressDraft(league.leagueId, new Date(START.getTime() + 300_000), db);
    const [next] = await db
      .select()
      .from(windows)
      .where(and(eq(windows.leagueId, league.leagueId), eq(windows.status, "open")));
    const duplicate = await recordDraftPick(
      {
        leagueId: league.leagueId,
        windowId: next.id,
        teamId: next.scope.onTheClockTeamId as string,
        playerId: pool[0].id,
        ctx: { ...ctx, windowId: next.id },
      },
      db,
    );
    expect(duplicate.ok).toBe(false);
  });
});

describe("getDraftBoard", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("renders the board before a pick is made and names who is on the clock", async () => {
    const { league } = await draftLeague();
    await startDraft(league.leagueId, { type: "snake", seed: 7, scheduledAt: START }, db);
    await progressDraft(league.leagueId, START, db);

    const board = await getDraftBoard(league.leagueId);
    expect(board.draftType).toBe("snake");
    expect(board.status).toBe("drafting");
    expect(board.rounds).toBe(9);
    expect(board.picks).toHaveLength(72);
    expect(board.picks[0].teamName).toBeTruthy();
    expect(board.onTheClock?.overallNo).toBe(1);
    expect(board.onTheClock?.deadlineAt).not.toBeNull();
    expect(board.runningCostUsd).toBe(0);

    const pick = await nextPick(league.leagueId, db);
    expect(board.onTheClock?.teamId).toBe(pick!.teamId);
  });
});
