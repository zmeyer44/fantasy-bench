/**
 * Waivers: submission validation, "last submission wins" inside a window, the
 * FAAB auction at close, and the idempotency contract every write tool shares.
 */
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import type { SnapshotPayload, SnapshotPlayer } from "../lib/snapshot/types";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { weeklyLineupDeadline } from "./lib/lineup_deadline";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const KICKOFF = "2026-09-13T17:00:00.000Z";
const NOW = Date.parse("2026-09-09T12:00:00.000Z");

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

const TEAM_NAMES = ["Alpha", "Bravo", "Charlie"];
/** Each team starts with these three; `fa1`/`fa2` are the wire. */
const OWNED = ["qbA", "qbB", "qbC"];
const FREE = ["fa1", "fa2"];

function snapshotPlayer(id: string, key: string, owner: string | null): SnapshotPlayer {
  return {
    id,
    sleeperId: key,
    fullName: key.toUpperCase(),
    position: "RB",
    nflTeam: "SF",
    status: "active",
    injuryStatus: null,
    injuryNotes: null,
    byeWeek: null,
    projection: { ppr: 10, half: 10, std: 10, source: "t", effectiveAt: KICKOFF },
    rosProjection: null,
    lastWeekPoints: null,
    seasonPoints: null,
    ownerTeamId: owner,
    opponent: "SEA",
    gameId: "g1",
    kickoffAt: KICKOFF,
    ownedPct: null,
    startedPct: null,
  };
}

async function fixture(t: TestConvex<typeof schema>, opts: { faab?: number[] } = {}) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: "commish@x.dev" });
    const leagueId = await ctx.db.insert("leagues", {
      name: "Waivers",
      slug: `wv-${Math.random()}`,
      commissionerUserId: userId,
      season: 2026,
      teamCount: 3,
      isPublic: true,
      status: "in_season",
      draftType: "snake",
      updatedAt: NOW,
    });
    await ctx.db.insert("league_rules", { leagueId, ...RULES });

    const teamIds: Id<"teams">[] = [];
    for (const [i, name] of TEAM_NAMES.entries()) {
      teamIds.push(
        await ctx.db.insert("teams", {
          leagueId,
          name,
          abbreviation: name.slice(0, 2).toUpperCase(),
          faabRemaining: opts.faab?.[i] ?? 100,
          waiverPriority: i + 1,
          karma: 0,
          draftBudgetRemaining: 200,
        }),
      );
    }

    const idOf: Record<string, Id<"players">> = {};
    for (const key of [...OWNED, ...FREE]) {
      idOf[key] = await ctx.db.insert("players", {
        sleeperId: key,
        fullName: key.toUpperCase(),
        position: "RB",
        nflTeam: "SF",
        fantasyPositions: ["RB"],
        externalIds: {},
        updatedAt: NOW,
      });
    }
    for (const [i, key] of OWNED.entries()) {
      await ctx.db.insert("roster_slots", {
        leagueId,
        teamId: teamIds[i],
        playerId: idOf[key],
        acquiredAt: NOW,
        acquiredVia: "draft",
      });
    }

    const players: Record<string, SnapshotPlayer> = {};
    OWNED.forEach((key, i) => {
      players[idOf[key]] = snapshotPlayer(idOf[key], key, teamIds[i]);
    });
    for (const key of FREE) players[idOf[key]] = snapshotPlayer(idOf[key], key, null);

    const payload: SnapshotPayload = {
      version: 1,
      leagueId,
      leagueName: "Waivers",
      season: 2026,
      weekNo: 2,
      takenAt: new Date(NOW).toISOString(),
      rules: RULES,
      teams: teamIds.map((id, i) => ({
        id,
        name: TEAM_NAMES[i],
        abbreviation: TEAM_NAMES[i].slice(0, 2).toUpperCase(),
        ownerUserId: null,
        faabRemaining: opts.faab?.[i] ?? 100,
        waiverPriority: i + 1,
        karma: 0,
        record: { wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0 },
        rosterPlayerIds: [idOf[OWNED[i]]],
        lineup: [],
        modelId: null,
      })),
      players,
      freeAgentIds: FREE.map((k) => idOf[k]),
      games: [],
      matchups: [],
      standings: [],
      news: [],
      injuries: [],
      liveScores: {},
    };

    const windowId = await ctx.db.insert("windows", {
      leagueId,
      type: "waiver",
      label: "waiver",
      weekNo: 2,
      roundNo: 1,
      opensAt: NOW - 3_600_000,
      submissionDeadlineAt: NOW + 3_000_000,
      closesAt: NOW + 3_600_000,
      status: "open",
      scope: {},
      runCount: 3,
      terminalRunCount: 0,
    });
    const snapshotId = await ctx.db.insert("snapshots", {
      leagueId,
      windowId,
      season: 2026,
      weekNo: 2,
      takenAt: NOW,
      status: "ready",
      chunkCount: 2,
      playerCount: Object.keys(players).length,
    });
    const { players: playerMap, ...meta } = payload;
    await ctx.db.insert("snapshot_chunks", { snapshotId, kind: "meta", part: 0, data: meta, bytes: 0 });
    await ctx.db.insert("snapshot_chunks", {
      snapshotId,
      kind: "players",
      part: 0,
      data: playerMap,
      bytes: 0,
    });
    await ctx.db.patch("windows", windowId, { snapshotId });

    const runIds: Id<"runs">[] = [];
    for (const teamId of teamIds) {
      runIds.push(
        await ctx.db.insert("runs", {
          windowId,
          leagueId,
          teamId,
          modelId: "test/model",
          kind: "team",
          status: "running",
          windowType: "waiver",
          windowLabel: "waiver",
          weekNo: 2,
          attempt: 1,
          lastPersistedStep: -1,
          totalCostUsd: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          stepCount: 0,
          committedActionCount: 0,
          rejectedActionCount: 0,
        }),
      );
    }

    return { leagueId, teamIds, runIds, windowId, snapshotId, idOf };
  });
}

const ctxFor = (
  f: { runIds: Id<"runs">[]; windowId: Id<"windows"> },
  team: number,
  toolCallId: string,
) => ({
  runId: f.runIds[team],
  stepIndex: 0,
  toolCallId,
  windowId: f.windowId,
  weekNo: 2,
});

describe("waivers.submit", () => {
  test("accepts a legal claim and replaces the team's earlier pending claims", async () => {
    const t = convexTest(schema, modules);
    const f = await fixture(t);

    const first = await t.mutation(internal.waivers.submit, {
      leagueId: f.leagueId,
      teamId: f.teamIds[0],
      windowId: f.windowId,
      weekNo: 2,
      claims: [{ addPlayerId: f.idOf.fa1, bid: 10 }],
      agentCtx: ctxFor(f, 0, "s1"),
    });
    expect(first).toMatchObject({ ok: true, accepted: 1, replaced: 0 });

    const second = await t.mutation(internal.waivers.submit, {
      leagueId: f.leagueId,
      teamId: f.teamIds[0],
      windowId: f.windowId,
      weekNo: 2,
      claims: [{ addPlayerId: f.idOf.fa1, bid: 25 }],
      agentCtx: ctxFor(f, 0, "s2"),
    });
    expect(second).toMatchObject({ ok: true, accepted: 1, replaced: 1 });

    const claims = await t.run(async (ctx) =>
      ctx.db
        .query("waiver_claims")
        .withIndex("by_windowId_teamId", (q) =>
          q.eq("windowId", f.windowId).eq("teamId", f.teamIds[0]),
        )
        .collect(),
    );
    expect(claims).toHaveLength(1);
    expect(claims[0].bid).toBe(25);
  });

  test("replays a duplicate toolCallId instead of re-submitting", async () => {
    const t = convexTest(schema, modules);
    const f = await fixture(t);
    const args = {
      leagueId: f.leagueId,
      teamId: f.teamIds[0],
      windowId: f.windowId,
      weekNo: 2,
      claims: [{ addPlayerId: f.idOf.fa1, bid: 10 }],
      agentCtx: ctxFor(f, 0, "same-call"),
    };
    const first = await t.mutation(internal.waivers.submit, args);
    const replay = await t.mutation(internal.waivers.submit, args);
    expect(replay).toEqual(first);

    const claims = await t.run(async (ctx) =>
      ctx.db
        .query("waiver_claims")
        .withIndex("by_windowId", (q) => q.eq("windowId", f.windowId))
        .collect(),
    );
    expect(claims).toHaveLength(1);
    const run = await t.run(async (ctx) => ctx.db.get("runs", f.runIds[0]));
    expect(run?.committedActionCount).toBe(1);
  });

  test("rejects an over-budget bid, a rostered target, a foreign drop and an overflow", async () => {
    const t = convexTest(schema, modules);
    const f = await fixture(t, { faab: [5, 100, 100] });

    const overBudget = await t.mutation(internal.waivers.submit, {
      leagueId: f.leagueId,
      teamId: f.teamIds[0],
      windowId: f.windowId,
      weekNo: 2,
      claims: [{ addPlayerId: f.idOf.fa1, bid: 50 }],
      agentCtx: ctxFor(f, 0, "e1"),
    });
    expect(overBudget.ok).toBe(false);
    expect(overBudget.ok === false && overBudget.errors.join(" ")).toContain("exceeds your remaining FAAB");

    const notFree = await t.mutation(internal.waivers.submit, {
      leagueId: f.leagueId,
      teamId: f.teamIds[1],
      windowId: f.windowId,
      weekNo: 2,
      claims: [{ addPlayerId: f.idOf.qbC, bid: 1 }],
      agentCtx: ctxFor(f, 1, "e2"),
    });
    expect(notFree.ok === false && notFree.errors.join(" ")).toContain("is not a free agent");

    const foreignDrop = await t.mutation(internal.waivers.submit, {
      leagueId: f.leagueId,
      teamId: f.teamIds[1],
      windowId: f.windowId,
      weekNo: 2,
      claims: [{ addPlayerId: f.idOf.fa1, dropPlayerId: f.idOf.qbC, bid: 1 }],
      agentCtx: ctxFor(f, 1, "e3"),
    });
    expect(foreignDrop.ok === false && foreignDrop.errors.join(" ")).toContain(
      "is not on your roster",
    );

    // Capacity is 4 (QB+RB+WR+BENCH) and the team holds 1: adding 5 overflows.
    const overflow = await t.mutation(internal.waivers.submit, {
      leagueId: f.leagueId,
      teamId: f.teamIds[1],
      windowId: f.windowId,
      weekNo: 2,
      claims: [
        { addPlayerId: f.idOf.fa1, bid: 1 },
        { addPlayerId: f.idOf.fa2, bid: 1 },
        { addPlayerId: f.idOf.fa1, bid: 1 },
      ],
      agentCtx: ctxFor(f, 1, "e4"),
    });
    expect(overflow.ok === false && overflow.errors.join(" ")).toContain("duplicate claim");

    const run = await t.run(async (ctx) => ctx.db.get("runs", f.runIds[1]));
    expect(run?.rejectedActionCount).toBe(3);
  });

  test("refuses a window that is not an open waiver window", async () => {
    const t = convexTest(schema, modules);
    const f = await fixture(t);
    await t.run(async (ctx) => ctx.db.patch("windows", f.windowId, { status: "closed" }));
    const result = await t.mutation(internal.waivers.submit, {
      leagueId: f.leagueId,
      teamId: f.teamIds[0],
      windowId: f.windowId,
      weekNo: 2,
      claims: [{ addPlayerId: f.idOf.fa1, bid: 1 }],
      agentCtx: ctxFor(f, 0, "closed"),
    });
    expect(result.ok === false && result.errors.join(" ")).toContain("is closed, not open");
  });
});

describe("waivers.drop", () => {
  test("drops immediately and writes a transaction", async () => {
    const t = convexTest(schema, modules);
    const f = await fixture(t);
    const result = await t.mutation(internal.waivers.drop, {
      leagueId: f.leagueId,
      teamId: f.teamIds[0],
      playerId: f.idOf.qbA,
      weekNo: 2,
      agentCtx: ctxFor(f, 0, "d1"),
      now: NOW,
    });
    expect(result.ok).toBe(true);

    const { roster, transactions } = await t.run(async (ctx) => ({
      roster: await ctx.db
        .query("roster_slots")
        .withIndex("by_teamId", (q) => q.eq("teamId", f.teamIds[0]))
        .collect(),
      transactions: await ctx.db
        .query("transactions")
        .withIndex("by_teamId", (q) => q.eq("teamId", f.teamIds[0]))
        .collect(),
    }));
    expect(roster).toHaveLength(0);
    expect(transactions.map((x) => x.type)).toEqual(["drop"]);
  });

  test("refuses to drop a player whose game has kicked off", async () => {
    const t = convexTest(schema, modules);
    const f = await fixture(t);
    const result = await t.mutation(internal.waivers.drop, {
      leagueId: f.leagueId,
      teamId: f.teamIds[0],
      playerId: f.idOf.qbA,
      weekNo: 2,
      agentCtx: ctxFor(f, 0, "d2"),
      now: Date.parse(KICKOFF) + 60_000,
    });
    expect(result.ok === false && result.errors.join(" ")).toContain("already kicked off");
  });

  test("refuses to drop an active starter at the exact Wednesday 7 PM ET deadline", async () => {
    const t = convexTest(schema, modules);
    const f = await fixture(t);
    const weekStartsAt = Date.parse("2026-09-08T10:00:00.000Z");
    await t.run(async (ctx) => {
      await ctx.db.insert("weeks", {
        leagueId: f.leagueId, weekNo: 2, startsAt: weekStartsAt,
        endsAt: weekStartsAt + 7 * 86_400_000, isPlayoff: false, status: "active",
      });
      await ctx.db.insert("lineups", {
        leagueId: f.leagueId, teamId: f.teamIds[0], weekNo: 2, version: 1,
        slots: [{ slot: "RB", playerId: f.idOf.qbA }], source: "agent",
      });
    });
    const result = await t.mutation(internal.waivers.drop, {
      leagueId: f.leagueId,
      teamId: f.teamIds[0],
      playerId: f.idOf.qbA,
      weekNo: 2,
      agentCtx: ctxFor(f, 0, "weekly-locked-drop"),
      now: weeklyLineupDeadline(weekStartsAt),
    });
    expect(result).toEqual({
      ok: false,
      errors: ["That player is in the lineup locked Wednesday at 7:00 PM ET."],
    });
  });
});

describe("waivers.process", () => {
  async function submitAll(
    t: TestConvex<typeof schema>,
    f: Awaited<ReturnType<typeof fixture>>,
    bids: Array<{ team: number; add: string; drop?: string; bid: number }>,
  ) {
    for (const [i, b] of bids.entries()) {
      await t.mutation(internal.waivers.submit, {
        leagueId: f.leagueId,
        teamId: f.teamIds[b.team],
        windowId: f.windowId,
        weekNo: 2,
        claims: [
          {
            addPlayerId: f.idOf[b.add],
            dropPlayerId: b.drop ? f.idOf[b.drop] : undefined,
            bid: b.bid,
          },
        ],
        agentCtx: ctxFor(f, b.team, `p${i}`),
      });
    }
  }

  test("a claim cannot drop a starter when processing occurs after the weekly deadline", async () => {
    const t = convexTest(schema, modules);
    const f = await fixture(t);
    const weekStartsAt = Date.parse("2026-09-08T10:00:00.000Z");
    await t.run(async (ctx) => {
      await ctx.db.insert("weeks", {
        leagueId: f.leagueId, weekNo: 2, startsAt: weekStartsAt,
        endsAt: weekStartsAt + 7 * 86_400_000, isPlayoff: false, status: "active",
      });
      await ctx.db.insert("lineups", {
        leagueId: f.leagueId, teamId: f.teamIds[0], weekNo: 2, version: 1,
        slots: [{ slot: "RB", playerId: f.idOf.qbA }], source: "agent",
      });
      await ctx.db.insert("waiver_claims", {
        leagueId: f.leagueId, teamId: f.teamIds[0], windowId: f.windowId, weekNo: 2,
        addPlayerId: f.idOf.fa1, dropPlayerId: f.idOf.qbA, bid: 10, priority: 1,
        runId: f.runIds[0], status: "pending",
      });
    });

    expect(
      await t.mutation(internal.waivers.process, {
        windowId: f.windowId,
        now: weeklyLineupDeadline(weekStartsAt) + 1,
      }),
    ).toEqual({ processed: 1, awarded: 0 });
    const state = await t.run(async (ctx) => ({
      roster: await ctx.db
        .query("roster_slots")
        .withIndex("by_teamId", (q) => q.eq("teamId", f.teamIds[0]))
        .collect(),
      claim: await ctx.db
        .query("waiver_claims")
        .withIndex("by_windowId_teamId", (q) =>
          q.eq("windowId", f.windowId).eq("teamId", f.teamIds[0]),
        )
        .first(),
    }));
    expect(state.roster.map((slot) => slot.playerId)).toEqual([f.idOf.qbA]);
    expect(state.claim).toMatchObject({
      status: "invalid",
      resultReason: "Drop player is in the lineup locked Wednesday at 7:00 PM ET.",
    });
  });

  test("awards to the highest bid, debits FAAB and moves the roster", async () => {
    const t = convexTest(schema, modules);
    const f = await fixture(t);
    await submitAll(t, f, [
      { team: 0, add: "fa1", bid: 10 },
      { team: 1, add: "fa1", bid: 30 },
    ]);

    const result = await t.mutation(internal.waivers.process, {
      windowId: f.windowId,
      now: NOW,
    });
    expect(result).toEqual({ processed: 2, awarded: 1 });

    const state = await t.run(async (ctx) => ({
      claims: await ctx.db
        .query("waiver_claims")
        .withIndex("by_windowId", (q) => q.eq("windowId", f.windowId))
        .collect(),
      winner: await ctx.db.get("teams", f.teamIds[1]),
      loser: await ctx.db.get("teams", f.teamIds[0]),
      winnerRoster: await ctx.db
        .query("roster_slots")
        .withIndex("by_teamId", (q) => q.eq("teamId", f.teamIds[1]))
        .collect(),
    }));
    const won = state.claims.find((c) => c.status === "won")!;
    expect(won.teamId).toBe(f.teamIds[1]);
    expect(won.resultReason).toBe("Won at $30.");
    expect(state.claims.find((c) => c.status === "lost")?.resultReason).toContain(
      "already claimed by a higher bid",
    );
    expect(state.winner?.faabRemaining).toBe(70);
    expect(state.loser?.faabRemaining).toBe(100);
    expect(state.winnerRoster.map((r) => r.playerId)).toContain(f.idOf.fa1);
  });

  test("breaks bid ties on waiver priority, worst record first", async () => {
    const t = convexTest(schema, modules);
    const f = await fixture(t);
    // Team C (priority 3) and team A (priority 1) tie at $20 — A is first in line.
    await submitAll(t, f, [
      { team: 2, add: "fa1", bid: 20 },
      { team: 0, add: "fa1", bid: 20 },
    ]);
    await t.mutation(internal.waivers.process, { windowId: f.windowId, now: NOW });

    const won = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("waiver_claims")
          .withIndex("by_windowId", (q) => q.eq("windowId", f.windowId))
          .collect()
      ).find((c) => c.status === "won"),
    );
    expect(won?.teamId).toBe(f.teamIds[0]);
  });

  test("rotates every winner to the back of the priority order", async () => {
    const t = convexTest(schema, modules);
    const f = await fixture(t);
    await submitAll(t, f, [{ team: 0, add: "fa1", bid: 5 }]);
    await t.mutation(internal.waivers.process, { windowId: f.windowId, now: NOW });

    const priorities = await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("teams")
        .withIndex("by_leagueId", (q) => q.eq("leagueId", f.leagueId))
        .collect();
      return Object.fromEntries(rows.map((r) => [r.name, r.waiverPriority]));
    });
    expect(priorities).toEqual({ Alpha: 3, Bravo: 1, Charlie: 2 });
  });

  test("invalidates a claim whose drop player is gone by processing time", async () => {
    const t = convexTest(schema, modules);
    const f = await fixture(t);
    await submitAll(t, f, [{ team: 0, add: "fa1", drop: "qbA", bid: 5 }]);
    // The team drops the same player before the window closes.
    await t.mutation(internal.waivers.drop, {
      leagueId: f.leagueId,
      teamId: f.teamIds[0],
      playerId: f.idOf.qbA,
      weekNo: 2,
      agentCtx: ctxFor(f, 0, "pre-drop"),
      now: NOW,
    });

    await t.mutation(internal.waivers.process, { windowId: f.windowId, now: NOW });
    const claim = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("waiver_claims")
          .withIndex("by_windowId", (q) => q.eq("windowId", f.windowId))
          .collect()
      )[0],
    );
    expect(claim.status).toBe("invalid");
    expect(claim.resultReason).toContain("no longer on the roster");
  });

  test("is a no-op when run twice", async () => {
    const t = convexTest(schema, modules);
    const f = await fixture(t);
    await submitAll(t, f, [
      { team: 0, add: "fa1", bid: 10 },
      { team: 1, add: "fa2", bid: 12 },
    ]);
    const first = await t.mutation(internal.waivers.process, { windowId: f.windowId, now: NOW });
    const second = await t.mutation(internal.waivers.process, { windowId: f.windowId, now: NOW });
    expect(first).toEqual({ processed: 2, awarded: 2 });
    expect(second).toEqual({ processed: 0, awarded: 0 });

    const faab = await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("teams")
        .withIndex("by_leagueId", (q) => q.eq("leagueId", f.leagueId))
        .collect();
      return Object.fromEntries(rows.map((r) => [r.name, r.faabRemaining]));
    });
    expect(faab).toEqual({ Alpha: 90, Bravo: 88, Charlie: 100 });
  });
});
