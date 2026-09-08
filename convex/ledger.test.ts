/**
 * The cost dashboards.
 *
 * Every figure used to be a `SUM` over `usage_events`; the contract now is that
 * the dashboards equal the sums of the rollup rows and nothing else reads the
 * event table, so the tests seed rollups and assert the arithmetic.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const NOW = Date.now();
const SEASON = 2026;
const SONNET = "anthropic/claude-sonnet-4.5";
const HAIKU = "anthropic/claude-haiku-4.5";

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
  weeklyTokenCapPerTeam: 5_000,
  leagueUsdHardCap: 10,
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

const COUNTERS = {
  cachedInputTokens: 0,
  reasoningTokens: 0,
  computedCostUsd: 0,
  gatewayCostUsd: 0,
  fallbackCount: 0,
  invalidActionCount: 0,
  updatedAt: NOW,
};

/** Two teams, two weeks of spend, matching model and league rollups. */
async function seed(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: "commish@x.dev" });
    const leagueId = await ctx.db.insert("leagues", {
      name: "Ledger",
      slug: `l-${Math.random()}`,
      commissionerUserId: userId,
      season: SEASON,
      teamCount: 2,
      isPublic: true,
      status: "in_season",
      draftType: "snake",
      updatedAt: NOW,
    });
    await ctx.db.insert("league_rules", { leagueId, ...RULES });
    await ctx.db.insert("league_members", { leagueId, userId, role: "commissioner" });

    const mkTeam = async (name: string, wins: number, pointsFor: number) => {
      const teamId = await ctx.db.insert("teams", {
        leagueId,
        name,
        abbreviation: name.slice(0, 3).toUpperCase(),
        faabRemaining: 100,
        waiverPriority: 1,
        karma: 0,
        draftBudgetRemaining: 200,
      });
      await ctx.db.insert("team_standings", {
        leagueId,
        teamId,
        season: SEASON,
        wins,
        losses: 2 - wins,
        ties: 0,
        pointsFor,
        pointsAgainst: 100,
        streak: "W1",
        updatedAt: NOW,
      });
      const config = await ctx.db.insert("agent_configs", { teamId, leagueId });
      const version = await ctx.db.insert("config_versions", {
        configId: config,
        teamId,
        leagueId,
        versionNo: 1,
        contextMd: "ctx",
        modelId: name === "Alpha" ? SONNET : HAIKU,
        harness: { maxSteps: 8, tokenBudget: 40_000, temperature: 0.2, deliberateMode: false },
        skillIds: [],
      });
      await ctx.db.patch("agent_configs", config, { currentVersionId: version });
      return teamId;
    };
    const alpha = await mkTeam("Alpha", 2, 300);
    const bravo = await mkTeam("Bravo", 0, 150);

    const teamWeek = (teamId: Id<"teams">, weekNo: number, costUsd: number, tokens: number) =>
      ctx.db.insert("team_week_rollups", {
        ...COUNTERS,
        leagueId,
        teamId,
        season: SEASON,
        weekNo,
        costUsd,
        inputTokens: tokens,
        outputTokens: tokens / 2,
        runCount: 2,
        stepCount: 5,
      });
    await teamWeek(alpha, 1, 2, 1000);
    await teamWeek(alpha, 2, 1, 400);
    await teamWeek(bravo, 1, 4, 2000);

    const modelWeek = (modelId: string, weekNo: number, costUsd: number) =>
      ctx.db.insert("model_week_rollups", {
        ...COUNTERS,
        leagueId,
        modelId,
        provider: "anthropic",
        season: SEASON,
        weekNo,
        costUsd,
        inputTokens: 500,
        outputTokens: 100,
        runCount: 2,
        stepCount: 5,
      });
    await modelWeek(SONNET, 1, 2);
    await modelWeek(SONNET, 2, 1);
    await modelWeek(HAIKU, 1, 4);

    const leagueWeek = (weekNo: number, costUsd: number) =>
      ctx.db.insert("league_week_rollups", {
        ...COUNTERS,
        leagueId,
        season: SEASON,
        weekNo,
        costUsd,
        inputTokens: 3000,
        outputTokens: 1500,
        runCount: 4,
        stepCount: 10,
      });
    await leagueWeek(0, 0.5); // draft spend: counted in totals, excluded from the trend
    await leagueWeek(1, 6);
    await leagueWeek(2, 1);

    const windowId = await ctx.db.insert("windows", {
      leagueId,
      type: "lineup",
      label: "lineup_sun_early",
      weekNo: 1,
      roundNo: 1,
      opensAt: NOW - 7_200_000,
      submissionDeadlineAt: NOW - 3_600_000,
      closesAt: NOW - 3_000_000,
      status: "closed",
      scope: {},
      runCount: 2,
      terminalRunCount: 2,
    });
    const mkRun = (teamId: Id<"teams">, modelId: string, totalCostUsd: number) =>
      ctx.db.insert("runs", {
        leagueId,
        windowId,
        teamId,
        modelId,
        kind: "team",
        status: "succeeded",
        windowType: "lineup",
        windowLabel: "lineup_sun_early",
        weekNo: 1,
        attempt: 1,
        lastPersistedStep: 1,
        totalCostUsd,
        totalInputTokens: 100,
        totalOutputTokens: 50,
        stepCount: 2,
        committedActionCount: 1,
        rejectedActionCount: 0,
      });
    await mkRun(alpha, SONNET, 0.4);
    await mkRun(bravo, HAIKU, 1.9);
    await mkRun(alpha, SONNET, 1.1);

    return { leagueId, alpha, bravo, userId };
  });
}

describe("ledger.leagueDashboard", () => {
  test("equals the sums of the seeded rollup rows", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const dash = await t.query(api.ledger.leagueDashboard, { leagueId: s.leagueId, limit: 2 });

    // Totals come from league_week_rollups, including week 0 (draft).
    expect(dash.totals).toEqual({
      usd: 7.5,
      tokens: 13_500,
      inputTokens: 9000,
      outputTokens: 4500,
      runCount: 12,
      stepCount: 30,
    });

    expect(dash.byTeam.map((row) => [row.teamName, row.usd, row.tokens, row.runCount])).toEqual([
      ["Bravo", 4, 3000, 2],
      ["Alpha", 3, 2100, 4],
    ]);
    expect(dash.byTeam[1].modelId).toBe(SONNET);

    expect(dash.byModel.map((row) => [row.modelId, row.usd, row.displayName])).toEqual([
      [HAIKU, 4, "Claude Haiku 4.5"],
      [SONNET, 3, "Claude Sonnet 4.5"],
    ]);

    // Trend excludes week 0, and is week-ordered.
    expect(dash.trend.map((row) => [row.weekNo, row.usd])).toEqual([
      [1, 6],
      [2, 1],
    ]);

    // Most expensive runs, capped by `limit`.
    expect(dash.expensive.map((run) => run.costUsd)).toEqual([1.9, 1.1]);
    expect(dash.expensive[0].teamName).toBe("Bravo");
    expect(dash.expensive[0].windowLabel).toBe("lineup_sun_early");
  });
});

describe("ledger.teamDashboard", () => {
  test("reports week and season spend, efficiency and the budget status", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const dash = await t.query(api.ledger.teamDashboard, {
      leagueId: s.leagueId,
      teamId: s.alpha,
      weekNo: 1,
    });

    expect(dash.week).toMatchObject({ usd: 2, tokens: 1500, runCount: 2, weekNo: 1 });
    expect(dash.season.usd).toBe(3);
    expect(dash.season.byWeek.map((row) => [row.weekNo, row.usd])).toEqual([
      [1, 2],
      [2, 1],
    ]);
    expect(dash.costPerPoint).toMatchObject({ usd: 3, points: 300, costPerPoint: 0.01 });
    expect(dash.costPerWin).toMatchObject({ wins: 2, costPerWin: 1.5 });

    // Caps come from league_rules; league USD is the sum of league_week_rollups.
    expect(dash.budget).toMatchObject({
      tokensUsed: 1500,
      tokenCap: 5000,
      tokensRemaining: 3500,
      overTokenCap: false,
      teamWeekUsd: 2,
      leagueUsdUsed: 7.5,
      leagueUsdCap: 10,
      overUsdCap: false,
    });
    expect(dash.budget.rollup).toEqual({ tokensUsed: 1500, usdUsed: 2, runCount: 2 });
  });

  test("a per-team budget row overrides the league rule, and caps can be breached", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("budgets", {
        leagueId: s.leagueId,
        teamId: s.alpha,
        period: "week",
        tokenCap: 1000,
      });
      await ctx.db.insert("budgets", { leagueId: s.leagueId, period: "season", usdCap: 5 });
    });

    const dash = await t.query(api.ledger.teamDashboard, {
      leagueId: s.leagueId,
      teamId: s.alpha,
      weekNo: 1,
    });
    expect(dash.budget).toMatchObject({
      tokenCap: 1000,
      tokensRemaining: 0,
      overTokenCap: true,
      leagueUsdCap: 5,
      leagueUsdRemaining: 0,
      overUsdCap: true,
    });
  });

  test("a winless, pointless team has null efficiency instead of a division by zero", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run(async (ctx) => {
      const standing = await ctx.db
        .query("team_standings")
        .withIndex("by_teamId_season", (q) => q.eq("teamId", s.bravo).eq("season", SEASON))
        .unique();
      await ctx.db.patch("team_standings", standing!._id, { pointsFor: 0, wins: 0 });
    });
    const dash = await t.query(api.ledger.teamDashboard, {
      leagueId: s.leagueId,
      teamId: s.bravo,
      weekNo: 1,
    });
    expect(dash.costPerPoint.costPerPoint).toBeNull();
    expect(dash.costPerWin.costPerWin).toBeNull();
  });
});

describe("ledger.benchmark / ledger.modelPrices", () => {
  test("buckets teams by their configured model with points per dollar", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const rows = await t.query(api.ledger.benchmark, { leagueId: s.leagueId });
    expect(rows.map((row) => [row.modelId, row.teamCount, row.usd, row.points])).toEqual([
      [SONNET, 1, 3, 300],
      [HAIKU, 1, 4, 150],
    ]);
    expect(rows[0].pointsPerUsd).toBe(100);
    expect(rows[0].costPerWin).toBe(1.5);
    expect(rows[1].costPerWin).toBeNull();
  });

  test("prices fall back to the catalog until a model_prices row exists", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const before = await t.query(api.ledger.modelPrices, {});
    const sonnet = before.find((row) => row.modelId === SONNET)!;
    expect(sonnet.inputPerM).toBe(3);
    expect(sonnet.effectiveFrom).toBeNull();

    await t.run(async (ctx) => {
      await ctx.db.insert("model_prices", {
        modelId: SONNET,
        provider: "anthropic",
        displayName: "Claude Sonnet 4.5",
        inputPerM: 4,
        outputPerM: 20,
        supportsReasoning: true,
        effectiveFrom: NOW - 1000,
      });
      await ctx.db.insert("model_prices", {
        modelId: SONNET,
        provider: "anthropic",
        displayName: "Claude Sonnet 4.5",
        inputPerM: 99,
        outputPerM: 99,
        supportsReasoning: true,
        effectiveFrom: NOW + 86_400_000, // a future price must not win
      });
    });
    const after = await t.query(api.ledger.modelPrices, {});
    expect(after.find((row) => row.modelId === SONNET)!.inputPerM).toBe(4);
  });
});
