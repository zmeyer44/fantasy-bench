import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { DEFAULT_LEAGUE_RULES } from "./lib/defaults";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

async function fixture() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const userId = await ctx.db.insert("users", { name: "Quality audit" });
    const leagueId = await ctx.db.insert("leagues", {
      name: "Isolated quality audit", slug: "isolated-quality", commissionerUserId: userId,
      season: 2026, teamCount: 2, isPublic: true, status: "in_season", draftType: "snake", updatedAt: now,
    });
    const teams = [];
    for (const name of ["Alpha", "Bravo"]) {
      teams.push(await ctx.db.insert("teams", {
        leagueId, name, abbreviation: name.slice(0, 3), faabRemaining: 100,
        waiverPriority: 1, karma: 0, draftBudgetRemaining: 200,
      }));
    }
    const playerId = await ctx.db.insert("players", {
      sleeperId: "quality-audit-qb", fullName: "Quality Quarterback", position: "QB",
      nflTeam: "KC", fantasyPositions: ["QB"], externalIds: {}, updatedAt: now,
    });
    await ctx.db.insert("lineups", {
      leagueId, teamId: teams[0], weekNo: 1, version: 1, source: "agent", slots: [{ slot: "QB", playerId }],
    });
    await ctx.db.insert("matchups", {
      leagueId, weekNo: 1, homeTeamId: teams[0], awayTeamId: teams[1], homeScore: 0, awayScore: 0, isFinal: false,
    });
    return { leagueId, playerId };
  });
  return { t, ...ids };
}

test("QA-SCORE-1: an empty scoring snapshot must not label an upcoming matchup live", async () => {
  const { t, leagueId } = await fixture();
  await t.run(async (ctx) => {
    const snapshotId = await ctx.db.insert("snapshots", {
      leagueId, season: 2026, weekNo: 1, takenAt: Date.now(), status: "ready", chunkCount: 1, playerCount: 0,
    });
    await ctx.db.insert("snapshot_chunks", { snapshotId, kind: "meta", part: 0, bytes: 10, data: { liveScores: {} } });
  });
  const cards = await t.query(api.views.matchups, { leagueId, weekNo: 1 });
  expect(cards[0].home.live).toBe(false);
});

test("QA-SCORE-2: week-one cards must not use scores from a week-two snapshot", async () => {
  const { t, leagueId, playerId } = await fixture();
  await t.run(async (ctx) => {
    await ctx.db.insert("league_rules", { leagueId, ...DEFAULT_LEAGUE_RULES, modelAllowlist: ["mock/scripted"] });
    for (const [weekNo, points] of [[1, 12], [2, 36]]) {
      await ctx.db.insert("player_stats_weekly", {
        playerId, season: 2026, week: weekNo, source: "test", stats: {},
        fantasyPointsPpr: points, fantasyPointsHalf: points, fantasyPointsStd: points, effectiveAt: Date.now(),
      });
      const snapshotId = await ctx.db.insert("snapshots", {
        leagueId, season: 2026, weekNo, takenAt: Date.now() + weekNo, status: "ready", chunkCount: 1, playerCount: 1,
      });
      await ctx.db.insert("snapshot_chunks", { snapshotId, kind: "meta", part: 0, bytes: 10, data: { liveScores: { [playerId]: points } } });
    }
  });
  const cards = await t.query(api.views.matchups, { leagueId, weekNo: 1 });
  expect(cards[0].home.score).toBe(12);
});

test("zero points is real scoring data, while a final official score remains authoritative", async () => {
  const { t, leagueId, playerId } = await fixture();
  await t.run(async (ctx) => {
    await ctx.db.insert("league_rules", { leagueId, ...DEFAULT_LEAGUE_RULES, modelAllowlist: ["mock/scripted"] });
    await ctx.db.insert("player_stats_weekly", {
      playerId, season: 2026, week: 1, source: "test", stats: {},
      fantasyPointsPpr: 0, fantasyPointsHalf: 0, fantasyPointsStd: 0, effectiveAt: Date.now(),
    });
    const snapshotId = await ctx.db.insert("snapshots", {
      leagueId, season: 2026, weekNo: 1, takenAt: Date.now(), status: "ready", chunkCount: 1, playerCount: 1,
    });
    await ctx.db.insert("snapshot_chunks", { snapshotId, kind: "meta", part: 0, bytes: 10, data: { liveScores: { [playerId]: 0 } } });
  });
  const live = await t.query(api.views.matchups, { leagueId, weekNo: 1 });
  expect(live[0].home).toMatchObject({ score: 0, live: true });
  await t.run(async (ctx) => {
    const matchup = await ctx.db.query("matchups").withIndex("by_leagueId_weekNo", (q) => q.eq("leagueId", leagueId).eq("weekNo", 1)).first();
    await ctx.db.patch("matchups", matchup!._id, { homeScore: 100, isFinal: true });
  });
  const final = await t.query(api.views.matchups, { leagueId, weekNo: 1 });
  expect(final[0].home).toMatchObject({ score: 100, live: false });
});

test("QA-RECAP-1: a tied final matchup must not declare the home team the winner", async () => {
  vi.stubEnv("COMMISSIONER_MODEL_ID", "mock/scripted");
  try {
    const { t, leagueId } = await fixture();
    await t.run(async (ctx) => {
      await ctx.db.insert("league_rules", { leagueId, ...DEFAULT_LEAGUE_RULES, modelAllowlist: ["mock/scripted"] });
      const matchup = await ctx.db.query("matchups").withIndex("by_leagueId_weekNo", (q) => q.eq("leagueId", leagueId).eq("weekNo", 1)).first();
      await ctx.db.patch("matchups", matchup!._id, { homeScore: 100, awayScore: 100, isFinal: true });
    });
    const recap = await t.action(internal.commissioner_agent.weeklyRecap, { leagueId, weekNo: 1 });
    expect(recap.text).toContain("Alpha 100 — 100 Bravo");
    expect(recap.text).not.toContain("Alpha takes it");
  } finally {
    vi.unstubAllEnvs();
  }
});
