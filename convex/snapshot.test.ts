/**
 * The snapshot builder: the frozen payload every agent in a window reads.
 *
 * Covers the parts the old `tests/scheduler/snapshot.test.ts` covered — payload
 * contract, the ranked free-agent pool, day buckets and lock times — plus the
 * two things that are new in Convex: chunking (sizes, part numbering,
 * reassembly) and the digest diff against the previous snapshot.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import type { SnapshotPayload } from "../lib/snapshot/types";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const NOW = Date.parse("2026-09-08T14:00:00Z");
const SEASON = 2026;
/** Sunday 13:00 ET and Thursday 20:15 ET of week 1. */
const SUNDAY_KICKOFF = Date.parse("2026-09-13T17:00:00Z");
const THURSDAY_KICKOFF = Date.parse("2026-09-11T00:15:00Z");

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

const POSITIONS = ["QB", "RB", "WR"] as const;

async function seed(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: "commish@x.dev" });
    const leagueId = await ctx.db.insert("leagues", {
      name: "Snapshot League",
      slug: `s-${Math.random()}`,
      commissionerUserId: userId,
      season: SEASON,
      teamCount: 3,
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
      startsAt: Date.parse("2026-09-08T10:00:00Z"),
      endsAt: Date.parse("2026-09-15T10:00:00Z"),
      isPlayoff: false,
      status: "active",
    });

    // Two games: a Thursday nighter (KC) and a Sunday early game (SF/SEA).
    await ctx.db.insert("nfl_games", {
      season: SEASON,
      week: 1,
      gameId: "2026-01-KC-DEN",
      homeTeam: "KC",
      awayTeam: "DEN",
      kickoffAt: THURSDAY_KICKOFF,
      status: "scheduled",
    });
    await ctx.db.insert("nfl_games", {
      season: SEASON,
      week: 1,
      gameId: "2026-01-SF-SEA",
      homeTeam: "SF",
      awayTeam: "SEA",
      kickoffAt: SUNDAY_KICKOFF,
      status: "scheduled",
    });

    const players: Id<"players">[] = [];
    const nflTeams = ["KC", "SF", "SEA", "DEN"];
    for (let i = 0; i < 15; i++) {
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
      // Descending projections so the free-agent ranking is deterministic.
      await ctx.db.insert("player_projection_latest", {
        playerId,
        season: SEASON,
        week: 1,
        source: "sleeper_rotowire",
        position,
        projectedPointsPpr: 30 - i,
        projectedPointsHalf: 28 - i,
        projectedPointsStd: 26 - i,
        stats: { rec: 4 },
        effectiveAt: NOW - 3_600_000,
      });
      await ctx.db.insert("player_ownership", {
        playerId,
        season: SEASON,
        week: 1,
        ownedPct: 50 + i,
        startedPct: 10 + i,
        effectiveAt: NOW - 3_600_000,
      });
    }

    // Three teams, three rostered players each (QB/RB/WR), players 0..8.
    const teamIds: Id<"teams">[] = [];
    for (let i = 0; i < 3; i++) {
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
      const roster = [players[i], players[i + 3], players[i + 6]];
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
          { slot: "RB", playerId: roster[1] },
          { slot: "WR", playerId: roster[2] },
        ],
      });
      await ctx.db.insert("team_standings", {
        leagueId,
        teamId,
        season: SEASON,
        wins: 3 - i,
        losses: i,
        ties: 0,
        pointsFor: 300 - i * 10,
        pointsAgainst: 250,
        streak: "W1",
        updatedAt: NOW,
      });
    }

    await ctx.db.insert("matchups", {
      leagueId,
      weekNo: 1,
      homeTeamId: teamIds[0],
      awayTeamId: teamIds[1],
      isFinal: false,
    });

    // A stat line for one rostered player, so `liveScores` is non-empty.
    await ctx.db.insert("player_stats_weekly", {
      playerId: players[0],
      season: SEASON,
      week: 1,
      source: "sleeper",
      stats: { rec: 5 },
      fantasyPointsPpr: 21.5,
      fantasyPointsHalf: 19,
      fantasyPointsStd: 16.5,
      effectiveAt: NOW - 600_000,
    });

    await ctx.db.insert("news_items", {
      source: "espn",
      headline: "Player 00 is questionable",
      playerId: players[0],
      publishedAt: NOW - 7_200_000,
      effectiveAt: NOW - 7_200_000,
      dedupeKey: "news-1",
    });

    return { leagueId, teamIds, players, userId };
  });
}

async function build(t: ReturnType<typeof convexTest>, leagueId: Id<"leagues">, now = NOW) {
  return t.action(internal.snapshot.build, { leagueId, weekNo: 1, now });
}

async function payloadOf(
  t: ReturnType<typeof convexTest>,
  snapshotId: Id<"snapshots">,
): Promise<SnapshotPayload> {
  const loaded = await t.query(internal.snapshot.load, { snapshotId });
  if (!loaded?.payload) throw new Error("snapshot has no payload");
  return loaded.payload as SnapshotPayload;
}

describe("snapshot.build", () => {
  test("writes a chunked, ready snapshot matching the payload contract", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);

    const result = await build(t, s.leagueId);
    expect(result.playerCount).toBe(15);
    expect(result.chunkCount).toBe(2); // meta + one players part (< 100 players)

    const row = await t.run(async (ctx) => ctx.db.get("snapshots", result.snapshotId));
    expect(row?.status).toBe("ready");
    expect(row?.weekNo).toBe(1);
    expect(row?.takenAt).toBe(NOW);
    expect(row?.projectionEffectiveAt).toBe(NOW - 3_600_000);

    const chunks = await t.run(async (ctx) =>
      ctx.db
        .query("snapshot_chunks")
        .withIndex("by_snapshotId_kind_part", (q) => q.eq("snapshotId", result.snapshotId))
        .collect(),
    );
    expect(chunks.map((c) => `${c.kind}:${c.part}`).sort()).toEqual(["meta:0", "players:0"]);
    for (const chunk of chunks) {
      expect(chunk.bytes).toBeGreaterThan(0);
      // Well inside the 1 MiB document limit — the whole point of chunking.
      expect(chunk.bytes).toBeLessThan(500_000);
    }

    const payload = await payloadOf(t, result.snapshotId);
    expect(payload.version).toBe(1);
    expect(payload.leagueId).toBe(s.leagueId);
    expect(payload.takenAt).toBe(new Date(NOW).toISOString());
    expect(payload.rules.scoringPreset).toBe("ppr");
    expect(payload.teams).toHaveLength(3);
    expect(payload.teams[0].rosterPlayerIds).toHaveLength(3);
    expect(payload.teams[0].lineup.map((slot) => slot.slot)).toEqual(["QB", "RB", "WR"]);
    expect(payload.matchups).toHaveLength(1);
    expect(payload.news).toHaveLength(1);
    expect(Object.keys(payload.players)).toHaveLength(15);
  });

  test("buckets games by Eastern day and gives every player their lock time", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const payload = await payloadOf(t, (await build(t, s.leagueId)).snapshotId);

    const byGame = Object.fromEntries(payload.games.map((g) => [g.gameId, g]));
    expect(byGame["2026-01-KC-DEN"].dayBucket).toBe("thu");
    expect(byGame["2026-01-SF-SEA"].dayBucket).toBe("sun_early");
    // Games come back in kickoff order.
    expect(payload.games.map((g) => g.gameId)).toEqual([
      "2026-01-KC-DEN",
      "2026-01-SF-SEA",
    ]);

    const kc = Object.values(payload.players).find((p) => p.nflTeam === "KC")!;
    expect(kc.kickoffAt).toBe(new Date(THURSDAY_KICKOFF).toISOString());
    expect(kc.opponent).toBe("DEN");
    expect(kc.gameId).toBe("2026-01-KC-DEN");
    const sf = Object.values(payload.players).find((p) => p.nflTeam === "SF")!;
    expect(sf.kickoffAt).toBe(new Date(SUNDAY_KICKOFF).toISOString());
    expect(sf.opponent).toBe("SEA");
  });

  test("carries every rostered player plus free agents ranked by projection", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const payload = await payloadOf(t, (await build(t, s.leagueId)).snapshotId);

    const rostered = payload.teams.flatMap((team) => team.rosterPlayerIds);
    for (const playerId of rostered) {
      expect(payload.players[playerId]).toBeDefined();
      expect(payload.players[playerId].ownerTeamId).not.toBeNull();
    }
    expect(payload.freeAgentIds).toHaveLength(6);
    for (const id of payload.freeAgentIds) {
      expect(rostered).not.toContain(id);
      expect(payload.players[id].ownerTeamId).toBeNull();
    }
    const projections = payload.freeAgentIds.map((id) => payload.players[id].projection!.ppr);
    expect(projections).toEqual([...projections].sort((a, b) => b - a));

    // Ownership percentages and this-week points come off their own tables.
    expect(payload.players[rostered[0]].ownedPct).not.toBeNull();
    expect(payload.liveScores[s.players[0]]).toBe(21.5);
    // No future-week projections are ingested, so rest-of-season stays null.
    expect(payload.players[rostered[0]].rosProjection).toBeNull();
  });

  test("ranks standings and reports them in the payload", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const payload = await payloadOf(t, (await build(t, s.leagueId)).snapshotId);
    expect(payload.standings.map((row) => row.rank)).toEqual([1, 2, 3]);
    expect(payload.standings[0].teamId).toBe(s.teamIds[0]);
    expect(payload.standings[0].wins).toBe(3);
  });

  test("digests the diff against the previous snapshot", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const first = await build(t, s.leagueId);
    expect(first.headline).toContain("Week 1");

    // A projection swing and a new injury designation for a rostered player.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("player_projection_latest")
        .withIndex("by_playerId_season_week_source", (q) =>
          q
            .eq("playerId", s.players[0])
            .eq("season", SEASON)
            .eq("week", 1)
            .eq("source", "sleeper_rotowire"),
        )
        .unique();
      await ctx.db.patch("player_projection_latest", row!._id, { projectedPointsPpr: 12 });
      await ctx.db.insert("injury_designations", {
        playerId: s.players[0],
        season: SEASON,
        week: 1,
        designation: "questionable",
        source: "espn",
        effectiveAt: NOW,
      });
    });

    const second = await build(t, s.leagueId, NOW + 60_000);
    const digest = await t.run(async (ctx) =>
      ctx.db
        .query("snapshot_digests")
        .withIndex("by_snapshotId", (q) => q.eq("snapshotId", second.snapshotId))
        .unique(),
    );
    expect(digest).not.toBeNull();
    expect(digest!.injuryChanges.map((c) => c.to)).toContain("questionable");
    expect(digest!.projectionMovers[0].playerId).toBe(s.players[0]);
    expect(digest!.projectionMovers[0].delta).toBe(-18);
    expect(digest!.headline).toContain("injury change");
    expect(digest!.standingsSummary).toContain("Team 0");

    // The designation overrides the player's own injury status in the payload.
    const payload = await payloadOf(t, second.snapshotId);
    expect(payload.players[s.players[0]].injuryStatus).toBe("questionable");
    expect(payload.injuries).toHaveLength(1);
  });

  test("marks the snapshot failed when the league has no rules", async () => {
    const t = convexTest(schema, modules);
    const leagueId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { email: "x@x.dev" });
      return ctx.db.insert("leagues", {
        name: "Ruleless",
        slug: `r-${Math.random()}`,
        commissionerUserId: userId,
        season: SEASON,
        teamCount: 0,
        isPublic: true,
        status: "setup",
        draftType: "snake",
        updatedAt: NOW,
      });
    });
    await expect(build(t, leagueId)).rejects.toThrow();
  });
});

describe("snapshot.load / latestForLeague", () => {
  test("reassembles the payload from its chunks and finds the newest ready row", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const first = await build(t, s.leagueId);
    const second = await build(t, s.leagueId, NOW + 120_000);

    const latest = await t.query(internal.snapshot.latestForLeague, { leagueId: s.leagueId });
    expect(latest?._id).toBe(second.snapshotId);

    const loaded = await t.query(internal.snapshot.load, { snapshotId: first.snapshotId });
    expect(loaded?.snapshot.status).toBe("ready");
    expect(Object.keys(loaded!.payload!.players)).toHaveLength(15);
    expect(loaded?.digest?.headline).toContain("Week 1");
  });
});
