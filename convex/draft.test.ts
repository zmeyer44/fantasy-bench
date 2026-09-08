/**
 * Draft: the seeded order and position rules (pure), the snake board from
 * `start` to `finalize`, and sealed-bid auction resolution including both
 * tie-breaks.
 */
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import type { SnapshotPayload, SnapshotPlayer } from "../lib/snapshot/types";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  resolveSealedBids,
  rosterCapacity,
  seededShuffle,
  snakeBoard,
  validatePickPosition,
} from "./lib/draft_pure";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const NOW = Date.parse("2026-09-01T12:00:00.000Z");

const RULES = {
  scoringPreset: "ppr" as const,
  superflex: false,
  tePremium: false,
  rosterSlots: { QB: 1, RB: 1, BENCH: 1 },
  faabBudget: 100,
  playoffTeams: 4,
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

const TEAM_NAMES = ["Alpha", "Bravo", "Charlie", "Delta"];
const POOL: Array<{ key: string; position: "QB" | "RB" | "WR"; points: number }> = [];
for (let i = 0; i < 6; i++) {
  POOL.push({ key: `qb${i}`, position: "QB", points: 30 - i });
  POOL.push({ key: `rb${i}`, position: "RB", points: 24 - i });
  POOL.push({ key: `wr${i}`, position: "WR", points: 18 - i });
}

async function fixture(
  t: TestConvex<typeof schema>,
  opts: { draftType?: "snake" | "auction" } = {},
) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: "commish@x.dev" });
    const leagueId = await ctx.db.insert("leagues", {
      name: "Draft",
      slug: `dr-${Math.random()}`,
      commissionerUserId: userId,
      season: 2026,
      teamCount: TEAM_NAMES.length,
      isPublic: true,
      status: "setup",
      draftType: opts.draftType ?? "snake",
      updatedAt: NOW,
    });
    await ctx.db.insert("league_rules", { leagueId, ...RULES });
    await ctx.db.insert("weeks", {
      leagueId,
      weekNo: 1,
      startsAt: NOW - 86_400_000,
      endsAt: NOW + 6 * 86_400_000,
      isPlayoff: false,
      status: "active",
    });

    const teamIds: Id<"teams">[] = [];
    for (const [i, name] of TEAM_NAMES.entries()) {
      teamIds.push(
        await ctx.db.insert("teams", {
          leagueId,
          name,
          abbreviation: name.slice(0, 2).toUpperCase(),
          faabRemaining: 100,
          waiverPriority: i + 1,
          karma: 0,
          draftBudgetRemaining: 0,
          createdAt: NOW + i,
        }),
      );
    }

    const idOf: Record<string, Id<"players">> = {};
    for (const spec of POOL) {
      const playerId = await ctx.db.insert("players", {
        sleeperId: spec.key,
        fullName: spec.key.toUpperCase(),
        position: spec.position,
        nflTeam: "SF",
        fantasyPositions: [spec.position],
        externalIds: {},
        updatedAt: NOW,
      });
      idOf[spec.key] = playerId;
      await ctx.db.insert("player_projection_latest", {
        playerId,
        season: 2026,
        week: 1,
        source: "sleeper_rotowire",
        position: spec.position,
        projectedPointsPpr: spec.points,
        projectedPointsHalf: spec.points,
        projectedPointsStd: spec.points,
        stats: {},
        effectiveAt: NOW,
      });
    }

    return { leagueId, teamIds, idOf };
  });
}

/** A snapshot built from the league's *current* rosters — what `finalize` reads. */
async function snapshotFromRosters(
  t: TestConvex<typeof schema>,
  leagueId: Id<"leagues">,
): Promise<Id<"snapshots">> {
  return t.run(async (ctx) => {
    const teams = await ctx.db
      .query("teams")
      .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
      .collect();
    const roster = await ctx.db
      .query("roster_slots")
      .withIndex("by_leagueId_playerId", (q) => q.eq("leagueId", leagueId))
      .collect();

    const players: Record<string, SnapshotPlayer> = {};
    for (const row of roster) {
      const player = (await ctx.db.get("players", row.playerId))!;
      const projection = await ctx.db
        .query("player_projection_latest")
        .withIndex("by_playerId_season_week_source", (q) =>
          q
            .eq("playerId", row.playerId)
            .eq("season", 2026)
            .eq("week", 1)
            .eq("source", "sleeper_rotowire"),
        )
        .unique();
      players[row.playerId] = {
        id: row.playerId,
        sleeperId: player.sleeperId,
        fullName: player.fullName,
        position: player.position,
        nflTeam: player.nflTeam ?? null,
        status: null,
        injuryStatus: null,
        injuryNotes: null,
        byeWeek: null,
        projection: projection
          ? {
              ppr: projection.projectedPointsPpr,
              half: projection.projectedPointsHalf,
              std: projection.projectedPointsStd,
              source: "sleeper_rotowire",
              effectiveAt: new Date(NOW).toISOString(),
            }
          : null,
        rosProjection: null,
        lastWeekPoints: null,
        seasonPoints: null,
        ownerTeamId: row.teamId,
        opponent: null,
        gameId: null,
        kickoffAt: null,
        ownedPct: null,
        startedPct: null,
      };
    }

    const payload: SnapshotPayload = {
      version: 1,
      leagueId,
      leagueName: "Draft",
      season: 2026,
      weekNo: 1,
      takenAt: new Date(NOW).toISOString(),
      rules: RULES,
      teams: teams.map((team) => ({
        id: team._id,
        name: team.name,
        abbreviation: team.abbreviation,
        ownerUserId: null,
        faabRemaining: team.faabRemaining,
        waiverPriority: team.waiverPriority,
        karma: 0,
        record: { wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0 },
        rosterPlayerIds: roster.filter((r) => r.teamId === team._id).map((r) => r.playerId),
        lineup: [],
        modelId: null,
      })),
      players,
      freeAgentIds: [],
      games: [],
      matchups: [],
      standings: [],
      news: [],
      injuries: [],
      liveScores: {},
    };

    const snapshotId = await ctx.db.insert("snapshots", {
      leagueId,
      season: 2026,
      weekNo: 1,
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
    return snapshotId;
  });
}

describe("draft_pure", () => {
  test("the seeded order is deterministic and a permutation of its input", () => {
    const ids = ["a", "b", "c", "d", "e"];
    expect(seededShuffle(ids, 42)).toEqual(seededShuffle(ids, 42));
    expect([...seededShuffle(ids, 42)].sort()).toEqual([...ids].sort());
    expect(seededShuffle(ids, 42)).not.toEqual(seededShuffle(ids, 43));
  });

  test("the snake board reverses every even round", () => {
    const board = snakeBoard(3, 2);
    expect(board.map((s) => s.teamIndex)).toEqual([0, 1, 2, 2, 1, 0]);
    expect(board.map((s) => s.overallNo)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(rosterCapacity({ QB: 1, RB: 2, BENCH: 3 })).toBe(6);
  });

  test("position sanity caps streamers and protects mandatory slots", () => {
    const shape = { QB: 1, RB: 2, K: 1, DEF: 1, BENCH: 2 };
    expect(
      validatePickPosition({
        position: "K",
        currentPositions: ["K", "K"],
        rosterShape: shape,
        picksRemainingAfter: 3,
        superflex: false,
      }),
    ).toContain("wastes a roster spot");
    expect(
      validatePickPosition({
        position: "RB",
        currentPositions: ["RB", "RB", "QB"],
        rosterShape: shape,
        picksRemainingAfter: 1,
        superflex: false,
      }),
    ).toContain("unable to fill");
    expect(
      validatePickPosition({
        position: "RB",
        currentPositions: ["QB"],
        rosterShape: shape,
        picksRemainingAfter: 4,
        superflex: false,
      }),
    ).toBeNull();
  });

  test("sealed bids break ties on roster size, then on a recorded seeded random", () => {
    const bySize = resolveSealedBids({
      bids: [
        { teamId: "a", amount: 10 },
        { teamId: "b", amount: 10 },
      ],
      lotNo: 1,
      rosterSizeByTeam: { a: 5, b: 2 },
    });
    expect(bySize.winner?.teamId).toBe("b");
    expect(bySize.tiebreak.rule).toBe("lowest_roster_value");

    const random = resolveSealedBids({
      bids: [
        { teamId: "a", amount: 10 },
        { teamId: "b", amount: 10 },
      ],
      lotNo: 1,
      rosterSizeByTeam: { a: 3, b: 3 },
    });
    expect(random.tiebreak.rule).toBe("seeded_random");
    expect(random.tiebreak.seed).toBe(1 * 7919 + 10);
    // Deterministic: the same lot resolves the same way every time.
    expect(
      resolveSealedBids({
        bids: [
          { teamId: "a", amount: 10 },
          { teamId: "b", amount: 10 },
        ],
        lotNo: 1,
        rosterSizeByTeam: { a: 3, b: 3 },
      }).winner?.teamId,
    ).toBe(random.winner?.teamId);
  });
});

describe("draft.start", () => {
  test("materialises a snake board, locks the rules and is idempotent", async () => {
    const t = convexTest(schema, modules);
    const f = await fixture(t);

    const started = await t.mutation(internal.draft.start, { leagueId: f.leagueId, seed: 7 });
    expect(started.rounds).toBe(3);
    expect(started.picks).toBe(12);
    expect(started.seed).toBe(7);
    expect([...started.order].sort()).toEqual([...f.teamIds].sort());

    const board = await t.run(async (ctx) => ({
      league: await ctx.db.get("leagues", f.leagueId),
      rules: await ctx.db
        .query("league_rules")
        .withIndex("by_leagueId", (q) => q.eq("leagueId", f.leagueId))
        .unique(),
      picks: await ctx.db
        .query("draft_picks")
        .withIndex("by_leagueId_overallNo", (q) => q.eq("leagueId", f.leagueId))
        .collect(),
    }));
    expect(board.league?.status).toBe("drafting");
    expect(board.rules?.rulesLockedAt).toBeGreaterThan(0);
    // Round 2 is the reverse of round 1.
    const r1 = board.picks.filter((p) => p.round === 1).sort((a, b) => a.pickNo - b.pickNo);
    const r2 = board.picks.filter((p) => p.round === 2).sort((a, b) => a.pickNo - b.pickNo);
    expect(r2.map((p) => p.teamId)).toEqual([...r1.map((p) => p.teamId)].reverse());

    const again = await t.mutation(internal.draft.start, { leagueId: f.leagueId, seed: 7 });
    expect(again.picks).toBe(0);
    const total = await t.run(async (ctx) =>
      ctx.db
        .query("draft_picks")
        .withIndex("by_leagueId_overallNo", (q) => q.eq("leagueId", f.leagueId))
        .collect(),
    );
    expect(total).toHaveLength(12);
  });
});

describe("draft.recordPick", () => {
  test("refuses a team that is not on the clock and a player already taken", async () => {
    const t = convexTest(schema, modules);
    const f = await fixture(t);
    await t.mutation(internal.draft.start, { leagueId: f.leagueId, seed: 3 });
    const onTheClock = (await t.query(internal.draft.nextPick, { leagueId: f.leagueId }))!;
    const other = f.teamIds.find((id) => id !== onTheClock.teamId)!;

    expect(
      await t.mutation(internal.draft.recordPick, {
        leagueId: f.leagueId,
        teamId: other,
        playerId: f.idOf.qb0,
      }),
    ).toMatchObject({ ok: false, errors: ["You are not on the clock."] });

    expect(
      await t.mutation(internal.draft.recordPick, {
        leagueId: f.leagueId,
        teamId: onTheClock.teamId,
        playerId: f.idOf.qb0,
        now: NOW,
      }),
    ).toMatchObject({ ok: true, overallNo: 1, round: 1, pickNo: 1 });

    const next = (await t.query(internal.draft.nextPick, { leagueId: f.leagueId }))!;
    expect(next.overallNo).toBe(2);
    expect(
      await t.mutation(internal.draft.recordPick, {
        leagueId: f.leagueId,
        teamId: next.teamId,
        playerId: f.idOf.qb0,
      }),
    ).toMatchObject({ ok: false, errors: ["That player is already drafted."] });
  });
});

describe("a whole snake draft", () => {
  test("auto-picks to completion, then finalize writes lineups and a schedule", async () => {
    const t = convexTest(schema, modules);
    const f = await fixture(t);
    await t.mutation(internal.draft.start, { leagueId: f.leagueId, seed: 11 });

    let guard = 0;
    for (;;) {
      const pick = await t.query(internal.draft.nextPick, { leagueId: f.leagueId });
      if (!pick) break;
      if (guard++ > 30) throw new Error("draft did not terminate");
      const best = await t.query(internal.draft.bestAvailable, {
        leagueId: f.leagueId,
        teamId: pick.teamId,
      });
      expect(best).not.toBeNull();
      const result = await t.mutation(internal.draft.recordPick, {
        leagueId: f.leagueId,
        teamId: pick.teamId,
        playerId: best!.playerId,
        auto: true,
        rationale: "Auto-pick: best available by projection.",
        now: NOW,
      });
      expect(result.ok).toBe(true);
    }

    const rosters = await t.run(async (ctx) => {
      const out: Record<string, string[]> = {};
      for (const teamId of f.teamIds) {
        const rows = await ctx.db
          .query("roster_slots")
          .withIndex("by_teamId", (q) => q.eq("teamId", teamId))
          .collect();
        out[teamId] = [];
        for (const row of rows) {
          out[teamId].push((await ctx.db.get("players", row.playerId))!.position);
        }
      }
      return out;
    });
    // Every team ends with a full, legal roster: 3 players including a QB and an RB.
    for (const positions of Object.values(rosters)) {
      expect(positions).toHaveLength(3);
      expect(positions).toContain("QB");
      expect(positions).toContain("RB");
    }
    // Nobody was drafted twice.
    const drafted = await t.run(async (ctx) =>
      ctx.db
        .query("draft_picks")
        .withIndex("by_leagueId_overallNo", (q) => q.eq("leagueId", f.leagueId))
        .collect(),
    );
    expect(new Set(drafted.map((p) => p.playerId)).size).toBe(12);
    expect(drafted.every((p) => p.auto && p.madeAt === NOW)).toBe(true);

    const snapshotId = await snapshotFromRosters(t, f.leagueId);
    const finalized = await t.mutation(internal.draft.finalize, {
      leagueId: f.leagueId,
      snapshotId,
    });
    expect(finalized.lineups).toBe(4);
    expect(finalized.weeks).toBe(RULES.regularSeasonWeeks);
    expect(finalized.matchups).toBe(RULES.regularSeasonWeeks * 2);

    const after = await t.run(async (ctx) => ({
      league: await ctx.db.get("leagues", f.leagueId),
      matchups: await ctx.db
        .query("matchups")
        .withIndex("by_leagueId_weekNo", (q) => q.eq("leagueId", f.leagueId).eq("weekNo", 1))
        .collect(),
    }));
    expect(after.league?.status).toBe("in_season");
    expect(after.matchups).toHaveLength(2);
    // Every team plays exactly once in week 1.
    expect(
      new Set(after.matchups.flatMap((m) => [m.homeTeamId, m.awayTeamId])).size,
    ).toBe(4);

    for (const teamId of f.teamIds) {
      const lineup = await t.query(internal.lineups.current, { teamId, weekNo: 1 });
      expect(lineup?.source).toBe("draft_default");
      const starters = lineup!.slots.filter((s) => s.slot !== "BENCH");
      expect(starters.map((s) => s.slot).sort()).toEqual(["QB", "RB"]);
      expect(starters.every((s) => s.playerId !== null)).toBe(true);
    }

    // A second finalize is harmless: no duplicate matchups.
    const again = await t.mutation(internal.draft.finalize, { leagueId: f.leagueId, snapshotId });
    expect(again.matchups).toBe(0);
  });
});

describe("the auction", () => {
  test("nominates, takes sealed bids and resolves the lot to the smaller roster", async () => {
    const t = convexTest(schema, modules);
    const f = await fixture(t, { draftType: "auction" });
    const started = await t.mutation(internal.draft.start, {
      leagueId: f.leagueId,
      type: "auction",
      seed: 5,
    });
    expect(started.picks).toBe(0);

    const budgets = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("teams")
          .withIndex("by_leagueId", (q) => q.eq("leagueId", f.leagueId))
          .collect()
      ).map((team) => team.draftBudgetRemaining),
    );
    expect(budgets).toEqual([200, 200, 200, 200]);

    const nominator = started.order[0];
    const other = started.order[1];
    // Give the nominator a body so the roster-size tie-break has something to say.
    await t.run(async (ctx) => {
      await ctx.db.insert("roster_slots", {
        leagueId: f.leagueId,
        teamId: nominator,
        playerId: f.idOf.wr5,
        acquiredAt: NOW,
        acquiredVia: "draft",
      });
    });

    const nominated = await t.mutation(internal.draft.nominate, {
      leagueId: f.leagueId,
      teamId: nominator,
      playerId: f.idOf.qb0,
      openingBid: 15,
    });
    expect(nominated.ok).toBe(true);

    expect(
      await t.mutation(internal.draft.bid, {
        leagueId: f.leagueId,
        teamId: other,
        playerId: f.idOf.qb0,
        amount: 15,
      }),
    ).toMatchObject({ ok: true, amount: 15 });
    expect(
      await t.mutation(internal.draft.bid, {
        leagueId: f.leagueId,
        teamId: started.order[2],
        playerId: f.idOf.qb0,
        amount: 400,
      }),
    ).toMatchObject({ ok: false });

    const nominationId = (nominated as { nominationId: Id<"auction_nominations"> }).nominationId;
    const resolved = await t.mutation(internal.draft.resolveLot, { nominationId, now: NOW });
    // Tied at $15; `other` has an empty roster, so it wins on roster size.
    expect(resolved.winnerTeamId).toBe(other);
    expect(resolved.price).toBe(15);
    expect(resolved.nextLotNo).toBe(2);

    const state = await t.run(async (ctx) => ({
      lot: await ctx.db.get("auction_nominations", nominationId),
      winner: await ctx.db.get("teams", other),
      picks: await ctx.db
        .query("draft_picks")
        .withIndex("by_leagueId_overallNo", (q) => q.eq("leagueId", f.leagueId))
        .collect(),
      roster: await ctx.db
        .query("roster_slots")
        .withIndex("by_teamId", (q) => q.eq("teamId", other))
        .collect(),
      nextLot: await ctx.db
        .query("auction_nominations")
        .withIndex("by_leagueId_lotNo", (q) => q.eq("leagueId", f.leagueId).eq("lotNo", 2))
        .unique(),
    }));
    expect(state.lot?.status).toBe("resolved");
    expect(state.lot?.tiebreak?.rule).toBe("lowest_roster_value");
    expect(state.winner?.draftBudgetRemaining).toBe(185);
    expect(state.picks).toHaveLength(1);
    expect(state.picks[0].price).toBe(15);
    expect(state.roster.map((r) => r.playerId)).toContain(f.idOf.qb0);
    expect(state.nextLot?.status).toBe("pending");
    expect(state.nextLot?.nominatingTeamId).toBeDefined();
  });

  test("abandons a lot nobody bid on", async () => {
    const t = convexTest(schema, modules);
    const f = await fixture(t, { draftType: "auction" });
    await t.mutation(internal.draft.start, { leagueId: f.leagueId, type: "auction", seed: 5 });
    const lotId = await t.run(async (ctx) => {
      const lot = await ctx.db
        .query("auction_nominations")
        .withIndex("by_leagueId_lotNo", (q) => q.eq("leagueId", f.leagueId).eq("lotNo", 1))
        .unique();
      // Straight to `bidding` with a player but no bids, as an abandoned
      // nomination window leaves it.
      await ctx.db.patch("auction_nominations", lot!._id, {
        status: "bidding",
        playerId: f.idOf.qb1,
      });
      return lot!._id;
    });
    const resolved = await t.mutation(internal.draft.resolveLot, { nominationId: lotId, now: NOW });
    expect(resolved).toMatchObject({ winnerTeamId: null, price: null });
    const lot = await t.run(async (ctx) => ctx.db.get("auction_nominations", lotId));
    expect(lot?.status).toBe("abandoned");
  });
});
