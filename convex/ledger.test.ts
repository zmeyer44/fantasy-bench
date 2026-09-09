/**
 * The cost dashboards.
 *
 * Every figure used to be a `SUM` over `usage_events`; the contract now is that
 * the dashboards equal the sums of the rollup rows and nothing else reads the
 * event table, so the tests seed rollups and assert the arithmetic.
 */
import fs from "node:fs";
import path from "node:path";

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const newTest = () => convexTest(schema, modules);
type T = ReturnType<typeof newTest>;

const NOW = Date.now();
const SEASON = 2026;
const SONNET = "openai/gpt-5.6-terra";
const HAIKU = "google/gemini-3.8-flash";

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
      [HAIKU, 4, "Gemini 3.8 Flash"],
      [SONNET, 3, "GPT-5.6 Terra"],
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
    expect(sonnet.inputPerM).toBe(2);
    expect(sonnet.effectiveFrom).toBeNull();

    await t.run(async (ctx) => {
      await ctx.db.insert("model_prices", {
        modelId: SONNET,
        provider: "openai",
        displayName: "GPT-5.6 Terra",
        inputPerM: 4,
        outputPerM: 20,
        supportsReasoning: true,
        effectiveFrom: NOW - 1000,
      });
      await ctx.db.insert("model_prices", {
        modelId: SONNET,
        provider: "openai",
        displayName: "GPT-5.6 Terra",
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

// ===========================================================================
// Phase 4 — the write half
// ===========================================================================

const MOCK = "mock/scripted";

/**
 * A league with two teams, an effective mock price, and a window to hang runs on.
 *
 * The dashboard fixture above seeds rollups directly; these tests need the
 * opposite — an empty ledger that `recordStep` fills — so they build their own.
 */
async function seedRuntime(t: T) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      email: "commish@runtime.dev",
    });
    const sessionId = await ctx.db.insert("authSessions", {
      userId,
      expirationTime: NOW + 86_400_000,
    });
    const leagueId = await ctx.db.insert("leagues", {
      name: "Runtime",
      slug: `r-${Math.random()}`,
      commissionerUserId: userId,
      season: SEASON,
      teamCount: 2,
      isPublic: true,
      status: "in_season",
      draftType: "snake",
      updatedAt: NOW,
    });
    await ctx.db.insert("league_rules", { leagueId, ...RULES });
    await ctx.db.insert("league_members", {
      leagueId,
      userId,
      role: "commissioner",
    });

    // The price book the old runtime suite used: $3/$15 with a $0.30 cached rate.
    await ctx.db.insert("model_prices", {
      modelId: MOCK,
      provider: "mock",
      displayName: "Scripted mock",
      inputPerM: 3,
      outputPerM: 15,
      cachedInputPerM: 0.3,
      supportsReasoning: false,
      effectiveFrom: NOW - 86_400_000,
    });

    const mkTeam = async (name: string) =>
      ctx.db.insert("teams", {
        leagueId,
        ownerUserId: userId,
        name,
        abbreviation: name.slice(0, 3).toUpperCase(),
        faabRemaining: 100,
        waiverPriority: 1,
        karma: 0,
        draftBudgetRemaining: 200,
      });
    const teamA = await mkTeam("Alpha");
    const teamB = await mkTeam("Bravo");

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
      runCount: 0,
      terminalRunCount: 0,
    });

    const mkRun = (teamId: Id<"teams"> | undefined, modelId: string) =>
      ctx.db.insert("runs", {
        leagueId,
        windowId,
        teamId,
        modelId,
        kind: teamId ? "team" : "commissioner",
        status: "succeeded",
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

    return {
      userId,
      sessionId,
      leagueId,
      teamA,
      teamB,
      windowId,
      runA1: await mkRun(teamA, MOCK),
      runA2: await mkRun(teamA, SONNET),
      runB1: await mkRun(teamB, MOCK),
    };
  });
}

const usage = (inputTokens: number, outputTokens: number, cached = 0, reasoning = 0) => ({
  inputTokens,
  outputTokens,
  cachedInputTokens: cached,
  reasoningTokens: reasoning,
});

async function rollups(t: T, leagueId: Id<"leagues">) {
  return t.run(async (ctx) => ({
    teams: await ctx.db
      .query("team_week_rollups")
      .withIndex("by_leagueId_season_weekNo", (q) =>
        q.eq("leagueId", leagueId).eq("season", SEASON).eq("weekNo", 1),
      )
      .collect(),
    models: await ctx.db.query("model_week_rollups").collect(),
    league: await ctx.db
      .query("league_week_rollups")
      .withIndex("by_leagueId_season_weekNo", (q) =>
        q.eq("leagueId", leagueId).eq("season", SEASON).eq("weekNo", 1),
      )
      .unique(),
    events: await ctx.db.query("usage_events").collect(),
  }));
}

describe("ledger.recordStep", () => {
  test("prices cached input at the cached rate and keeps reasoning inside output", async () => {
    const t = convexTest(schema, modules);
    const s = await seedRuntime(t);

    const result = await t.mutation(internal.ledger.recordStep, {
      runId: s.runA1,
      stepIndex: 0,
      modelId: MOCK,
      usage: usage(1200, 150, 200, 50),
    });
    // 1000 uncached @ $3/M + 200 cached @ $0.30/M + 150 out @ $15/M.
    // Reasoning tokens are inside the output tokens: no separate charge, because
    // the price book carries no `reasoningPerM`.
    expect(result.computedCostUsd).toBeCloseTo(1000 * 3e-6 + 200 * 0.3e-6 + 150 * 15e-6, 10);
    expect(result.costUsd).toBe(result.computedCostUsd);

    const { events } = await rollups(t, s.leagueId);
    expect(events).toHaveLength(1);
    expect(events[0].provider).toBe("mock");
    expect(events[0].cachedInputTokens).toBe(200);
    expect(events[0].reasoningTokens).toBe(50);
    expect(events[0].season).toBe(SEASON);
    expect(events[0].weekNo).toBe(1);
    expect(events[0].teamId).toBe(s.teamA);
  });

  test("bills reasoning tokens separately when the price book prices them", async () => {
    const t = convexTest(schema, modules);
    const s = await seedRuntime(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("model_prices", {
        modelId: MOCK,
        provider: "mock",
        displayName: "Scripted mock",
        inputPerM: 3,
        outputPerM: 15,
        cachedInputPerM: 0.3,
        reasoningPerM: 60,
        supportsReasoning: true,
        effectiveFrom: NOW - 1000,
      });
    });

    const result = await t.mutation(internal.ledger.recordStep, {
      runId: s.runA1,
      stepIndex: 0,
      modelId: MOCK,
      usage: usage(0, 150, 0, 50),
    });
    // 100 non-reasoning out @ $15/M + 50 reasoning out @ $60/M.
    expect(result.computedCostUsd).toBeCloseTo(100 * 15e-6 + 50 * 60e-6, 10);
  });

  test("prefers the gateway figure but keeps the computed one", async () => {
    const t = convexTest(schema, modules);
    const s = await seedRuntime(t);

    const result = await t.mutation(internal.ledger.recordStep, {
      runId: s.runA1,
      stepIndex: 0,
      modelId: MOCK,
      usage: usage(1200, 150, 200),
      gatewayCostUsd: 0.009,
    });
    expect(result.costUsd).toBe(0.009);
    expect(result.computedCostUsd).toBeGreaterThan(0);
    expect(result.computedCostUsd).not.toBe(0.009);

    const { events, league } = await rollups(t, s.leagueId);
    expect(events[0].costUsd).toBe(0.009);
    expect(events[0].gatewayCostUsd).toBe(0.009);
    expect(events[0].computedCostUsd).toBe(result.computedCostUsd);
    // The rollup sums the preferred figure and keeps both raw columns.
    expect(league!.costUsd).toBe(0.009);
    expect(league!.gatewayCostUsd).toBe(0.009);
    expect(league!.computedCostUsd).toBe(result.computedCostUsd);
  });

  test("falls back to the catalog, then to a zero price, without aborting", async () => {
    const t = convexTest(schema, modules);
    const s = await seedRuntime(t);

    // SONNET has no `model_prices` row here: the catalog ($2/$12) is used.
    const catalog = await t.mutation(internal.ledger.recordStep, {
      runId: s.runA2,
      stepIndex: 0,
      modelId: SONNET,
      usage: usage(1_000_000, 0),
    });
    expect(catalog.computedCostUsd).toBeCloseTo(2, 6);

    // A model in neither place prices at zero rather than throwing.
    const unknown = await t.mutation(internal.ledger.recordStep, {
      runId: s.runB1,
      stepIndex: 0,
      modelId: "acme/does-not-exist",
      usage: usage(1_000_000, 1_000_000),
    });
    expect(unknown.computedCostUsd).toBe(0);
    const { events } = await rollups(t, s.leagueId);
    expect(events.find((e) => e.modelId === "acme/does-not-exist")!.provider).toBe("acme");
  });

  test("is idempotent on (runId, stepIndex): a replay writes nothing twice", async () => {
    const t = convexTest(schema, modules);
    const s = await seedRuntime(t);
    const args = {
      runId: s.runA1,
      stepIndex: 0,
      modelId: MOCK,
      usage: usage(1000, 100),
    };
    const first = await t.mutation(internal.ledger.recordStep, args);
    const replay = await t.mutation(internal.ledger.recordStep, args);
    expect(replay.eventId).toBe(first.eventId);
    expect(replay.costUsd).toBe(first.costUsd);

    const after = await rollups(t, s.leagueId);
    expect(after.events).toHaveLength(1);
    expect(after.league!.stepCount).toBe(1);
    expect(after.league!.runCount).toBe(1);
    expect(after.teams[0].inputTokens).toBe(1000);
  });

  test("rollups equal the event sums across 3 runs and 2 models", async () => {
    const t = convexTest(schema, modules);
    const s = await seedRuntime(t);

    const plan = [
      { runId: s.runA1, modelId: MOCK, steps: 3 },
      { runId: s.runA2, modelId: SONNET, steps: 2 },
      { runId: s.runB1, modelId: MOCK, steps: 4 },
    ];
    for (const entry of plan) {
      for (let step = 0; step < entry.steps; step++) {
        await t.mutation(internal.ledger.recordStep, {
          runId: entry.runId,
          stepIndex: step,
          modelId: entry.modelId,
          usage: usage(1000 + step, 100 + step, 10, 5),
          invalidActionCount: step === 0 ? 1 : 0,
        });
      }
    }

    const { events, teams, models, league } = await rollups(t, s.leagueId);
    expect(events).toHaveLength(9);

    const sum = (rows: typeof events, field: "inputTokens" | "outputTokens" | "costUsd") =>
      rows.reduce((total, row) => total + row[field], 0);

    // ---- league row = every event
    expect(league!.inputTokens).toBe(sum(events, "inputTokens"));
    expect(league!.outputTokens).toBe(sum(events, "outputTokens"));
    expect(league!.costUsd).toBeCloseTo(sum(events, "costUsd"), 8);
    expect(league!.stepCount).toBe(9);
    expect(league!.runCount).toBe(3);
    expect(league!.cachedInputTokens).toBe(90);
    expect(league!.reasoningTokens).toBe(45);
    expect(league!.invalidActionCount).toBe(3);

    // ---- team rows = that team's events
    const teamA = teams.find((row) => row.teamId === s.teamA)!;
    const teamB = teams.find((row) => row.teamId === s.teamB)!;
    const eventsA = events.filter((row) => row.teamId === s.teamA);
    expect(teamA.inputTokens).toBe(sum(eventsA, "inputTokens"));
    expect(teamA.stepCount).toBe(5);
    expect(teamA.runCount).toBe(2);
    expect(teamB.stepCount).toBe(4);
    expect(teamB.runCount).toBe(1);
    expect(teamA.inputTokens + teamB.inputTokens).toBe(league!.inputTokens);

    // ---- model rows: one per (league, model) plus the cross-league global row
    const perLeague = models.filter((row) => row.leagueId === s.leagueId);
    const global = models.filter((row) => row.leagueId === undefined);
    expect(perLeague).toHaveLength(2);
    expect(global).toHaveLength(2);
    for (const set of [perLeague, global]) {
      const mock = set.find((row) => row.modelId === MOCK)!;
      const sonnet = set.find((row) => row.modelId === SONNET)!;
      expect(mock.stepCount).toBe(7);
      expect(mock.runCount).toBe(2);
      expect(sonnet.stepCount).toBe(2);
      expect(sonnet.runCount).toBe(1);
      expect(mock.inputTokens + sonnet.inputTokens).toBe(league!.inputTokens);
      expect(mock.costUsd + sonnet.costUsd).toBeCloseTo(league!.costUsd, 8);
    }
    expect(global[0].provider).toBeDefined();
  });

  test("counts a run once, on its first step", async () => {
    const t = convexTest(schema, modules);
    const s = await seedRuntime(t);
    for (let step = 0; step < 5; step++) {
      await t.mutation(internal.ledger.recordStep, {
        runId: s.runA1,
        stepIndex: step,
        modelId: MOCK,
        usage: usage(10, 10),
      });
    }
    const { league, teams } = await rollups(t, s.leagueId);
    expect(league!.runCount).toBe(1);
    expect(league!.stepCount).toBe(5);
    expect(teams[0].runCount).toBe(1);
  });

  test("skips the team rollup for a commissioner run but still counts the league", async () => {
    const t = convexTest(schema, modules);
    const s = await seedRuntime(t);
    const commishRun = await t.run(async (ctx) =>
      ctx.db.insert("runs", {
        leagueId: s.leagueId,
        windowId: s.windowId,
        modelId: MOCK,
        kind: "commissioner",
        status: "succeeded",
        windowType: "commissioner",
        windowLabel: "commissioner",
        weekNo: 1,
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
    await t.mutation(internal.ledger.recordStep, {
      runId: commishRun,
      stepIndex: 0,
      modelId: MOCK,
      usage: usage(500, 50),
    });
    const { teams, league } = await rollups(t, s.leagueId);
    expect(teams).toHaveLength(0);
    expect(league!.stepCount).toBe(1);
    expect(league!.runCount).toBe(1);
  });
});

describe("ledger.recordRunOutcome", () => {
  test("counts a fallback run that never took a fallback step, once", async () => {
    const t = convexTest(schema, modules);
    const s = await seedRuntime(t);

    const first = await t.mutation(internal.ledger.recordRunOutcome, {
      runId: s.runA1,
      status: "fallback",
    });
    expect(first.counted).toBe(true);
    const second = await t.mutation(internal.ledger.recordRunOutcome, {
      runId: s.runA1,
      status: "fallback",
    });
    expect(second.counted).toBe(false);

    const { league, teams } = await rollups(t, s.leagueId);
    expect(league!.fallbackCount).toBe(1);
    expect(teams[0].fallbackCount).toBe(1);
    expect(league!.stepCount).toBe(0);
  });

  test("does not double-count a run whose step was already flagged as a fallback", async () => {
    const t = convexTest(schema, modules);
    const s = await seedRuntime(t);
    await t.mutation(internal.ledger.recordStep, {
      runId: s.runA1,
      stepIndex: 0,
      modelId: MOCK,
      usage: usage(100, 10),
      isFallbackStep: true,
    });
    await t.mutation(internal.ledger.recordStep, {
      runId: s.runA1,
      stepIndex: 1,
      modelId: MOCK,
      usage: usage(100, 10),
      isFallbackStep: true,
    });
    const outcome = await t.mutation(internal.ledger.recordRunOutcome, {
      runId: s.runA1,
      status: "fallback",
    });
    expect(outcome.counted).toBe(false);

    const { league } = await rollups(t, s.leagueId);
    expect(league!.fallbackCount).toBe(1);
    expect(league!.stepCount).toBe(2);
  });

  test("a non-fallback outcome records nothing", async () => {
    const t = convexTest(schema, modules);
    const s = await seedRuntime(t);
    const result = await t.mutation(internal.ledger.recordRunOutcome, {
      runId: s.runA1,
      status: "succeeded",
    });
    expect(result.counted).toBe(false);
    const { league } = await rollups(t, s.leagueId);
    expect(league).toBeNull();
  });
});

describe("ledger.remainingBudget", () => {
  test("reports caps, usage and the league-wide cap flag", async () => {
    const t = convexTest(schema, modules);
    const s = await seedRuntime(t);

    const before = await t.query(internal.ledger.remainingBudget, {
      leagueId: s.leagueId,
      teamId: s.teamA,
      weekNo: 1,
    });
    expect(before.teamTokenCap).toBe(5000);
    expect(before.teamTokensRemaining).toBe(5000);
    expect(before.leagueUsdCap).toBe(10);
    expect(before.leagueCapReached).toBe(false);

    await t.mutation(internal.ledger.recordStep, {
      runId: s.runA1,
      stepIndex: 0,
      modelId: MOCK,
      usage: usage(1000, 500),
    });
    const after = await t.query(internal.ledger.remainingBudget, {
      leagueId: s.leagueId,
      teamId: s.teamA,
      weekNo: 1,
    });
    expect(after.teamTokensUsed).toBe(1500);
    expect(after.teamTokensRemaining).toBe(3500);
    expect(after.leagueUsdUsed).toBeGreaterThan(0);
    expect(after.leagueCapReached).toBe(false);

    // Another team's spend does not eat this team's token cap, but does eat the
    // league's USD cap.
    await t.mutation(internal.ledger.recordStep, {
      runId: s.runB1,
      stepIndex: 0,
      modelId: MOCK,
      usage: usage(9_000_000, 0),
    });
    const capped = await t.query(internal.ledger.remainingBudget, {
      leagueId: s.leagueId,
      teamId: s.teamA,
      weekNo: 1,
    });
    expect(capped.teamTokensUsed).toBe(1500);
    expect(capped.leagueUsdUsed).toBeGreaterThan(10);
    expect(capped.leagueUsdRemaining).toBeLessThan(0);
    expect(capped.leagueCapReached).toBe(true);
  });

  test("nulls both caps when the league sets none", async () => {
    const t = convexTest(schema, modules);
    const s = await seedRuntime(t);
    await t.run(async (ctx) => {
      const rules = await ctx.db
        .query("league_rules")
        .withIndex("by_leagueId", (q) => q.eq("leagueId", s.leagueId))
        .unique();
      await ctx.db.patch("league_rules", rules!._id, {
        weeklyTokenCapPerTeam: undefined,
        leagueUsdHardCap: undefined,
      });
    });
    const budget = await t.query(internal.ledger.remainingBudget, {
      leagueId: s.leagueId,
      teamId: s.teamA,
      weekNo: 1,
    });
    expect(budget.teamTokenCap).toBeNull();
    expect(budget.teamTokensRemaining).toBeNull();
    expect(budget.leagueUsdCap).toBeNull();
    expect(budget.leagueUsdRemaining).toBeNull();
    expect(budget.leagueCapReached).toBe(false);
  });
});

describe("ledger.notifyCommissionerOfCap", () => {
  test("posts one announcement per league-week and never a second", async () => {
    const t = convexTest(schema, modules);
    const s = await seedRuntime(t);

    const first = await t.mutation(internal.ledger.notifyCommissionerOfCap, {
      leagueId: s.leagueId,
      weekNo: 1,
    });
    expect(first.notified).toBe(true);
    const second = await t.mutation(internal.ledger.notifyCommissionerOfCap, {
      leagueId: s.leagueId,
      weekNo: 1,
    });
    expect(second.notified).toBe(false);

    const posts = await t.run(async (ctx) => ctx.db.query("forum_posts").collect());
    expect(posts).toHaveLength(1);
    expect(posts[0].flair).toBe("announcement");
    expect(posts[0].teamId).toBeUndefined();
    expect(posts[0].score).toBe(0);
    expect(posts[0].hidden).toBe(false);
    expect(posts[0].body).toContain("$10.00");

    // A different week gets its own notice.
    const nextWeek = await t.mutation(internal.ledger.notifyCommissionerOfCap, {
      leagueId: s.leagueId,
      weekNo: 2,
    });
    expect(nextWeek.notified).toBe(true);
    expect(await t.run(async (ctx) => ctx.db.query("forum_posts").collect())).toHaveLength(2);
  });
});

describe("ledger.verify", () => {
  async function spend(t: T, s: Awaited<ReturnType<typeof seedRuntime>>) {
    for (const [runId, modelId, steps] of [
      [s.runA1, MOCK, 3],
      [s.runA2, SONNET, 2],
      [s.runB1, MOCK, 2],
    ] as const) {
      for (let step = 0; step < steps; step++) {
        await t.mutation(internal.ledger.recordStep, {
          runId,
          stepIndex: step,
          modelId,
          usage: usage(1000 + step, 100, 10, 5),
          gatewayCostUsd: step === 0 ? 0.0125 : undefined,
        });
      }
    }
  }

  test("verifyTeamWeek reports ok on consistent data and the diff after a patch", async () => {
    const t = convexTest(schema, modules);
    const s = await seedRuntime(t);
    await spend(t, s);

    const clean = await t.action(internal.ledger.verifyTeamWeek, {
      teamId: s.teamA,
      season: SEASON,
      weekNo: 1,
    });
    expect(clean).toEqual({ ok: true, diffs: [] });

    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("team_week_rollups")
        .withIndex("by_teamId_season_weekNo", (q) =>
          q.eq("teamId", s.teamA).eq("season", SEASON).eq("weekNo", 1),
        )
        .unique();
      await ctx.db.patch("team_week_rollups", row!._id, {
        inputTokens: row!.inputTokens + 7,
        costUsd: row!.costUsd + 0.5,
      });
    });

    const drifted = await t.action(internal.ledger.verifyTeamWeek, {
      teamId: s.teamA,
      season: SEASON,
      weekNo: 1,
    });
    expect(drifted.ok).toBe(false);
    const fields = drifted.diffs.map((d) => d.field).sort();
    expect(fields).toEqual(["costUsd", "inputTokens"]);
    const inputDiff = drifted.diffs.find((d) => d.field === "inputTokens")!;
    expect(inputDiff.rollup - inputDiff.events).toBe(7);
  });

  test("verifyLeagueWeek checks the league row and every per-league model row", async () => {
    const t = convexTest(schema, modules);
    const s = await seedRuntime(t);
    await spend(t, s);

    const clean = await t.action(internal.ledger.verifyLeagueWeek, {
      leagueId: s.leagueId,
      season: SEASON,
      weekNo: 1,
    });
    expect(clean).toEqual({ ok: true, diffs: [] });

    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("model_week_rollups")
        .withIndex("by_leagueId_modelId_season_weekNo", (q) =>
          q.eq("leagueId", s.leagueId).eq("modelId", SONNET).eq("season", SEASON).eq("weekNo", 1),
        )
        .unique();
      await ctx.db.patch("model_week_rollups", row!._id, { stepCount: 99 });
    });

    const drifted = await t.action(internal.ledger.verifyLeagueWeek, {
      leagueId: s.leagueId,
      season: SEASON,
      weekNo: 1,
    });
    expect(drifted.ok).toBe(false);
    expect(drifted.diffs).toEqual([{ field: `model[${SONNET}].stepCount`, rollup: 99, events: 2 }]);
  });

  test("the public verify action is commissioner-only and reports every team", async () => {
    const t = convexTest(schema, modules);
    const s = await seedRuntime(t);
    await spend(t, s);

    await expect(
      t.action(api.ledger.verify, { leagueId: s.leagueId, weekNo: 1 }),
    ).rejects.toThrow();

    const asCommish = t.withIdentity({ subject: `${s.userId}|${s.sessionId}` });
    const report = await asCommish.action(api.ledger.verify, {
      leagueId: s.leagueId,
      weekNo: 1,
    });
    expect(report.ok).toBe(true);
    expect(report.season).toBe(SEASON);
    expect(report.teams).toHaveLength(2);
    expect(report.teams.every((team) => team.ok)).toBe(true);
    expect(report.league.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Golden equivalence
// ---------------------------------------------------------------------------

/**
 * Replaying the golden ledger through `recordStep` must land on exactly the
 * numbers `scripts/seed-convex.ts` imported.
 *
 * The seed built the three rollup tables by folding `tests/golden/postgres-week1/usage_events.json`
 * in one pass; Phase 4 builds them one `recordStep` at a time. Those two have to
 * agree or the dashboards change meaning at cutover, so this test folds the JSON
 * the importer's way and compares, row for row and counter for counter.
 */
const GOLDEN_DIR = path.join(process.cwd(), "tests", "golden", "postgres-week1");
type GoldenRow = Record<string, unknown>;
const readGolden = (name: string): GoldenRow[] =>
  JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, `${name}.json`), "utf8")) as GoldenRow[];

const numOr = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

type GoldenCounters = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  costUsd: number;
  computedCostUsd: number;
  gatewayCostUsd: number;
  stepCount: number;
  fallbackCount: number;
  invalidActionCount: number;
  runIds: Set<string>;
};

const zeroGolden = (): GoldenCounters => ({
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  reasoningTokens: 0,
  costUsd: 0,
  computedCostUsd: 0,
  gatewayCostUsd: 0,
  stepCount: 0,
  fallbackCount: 0,
  invalidActionCount: 0,
  runIds: new Set<string>(),
});

describe("ledger.recordStep — golden equivalence", () => {
  test("replaying the 194 golden usage events reproduces the importer's rollups", async () => {
    const t = newTest();

    const goldenLeague = readGolden("leagues")[0];
    const goldenSeason = numOr(goldenLeague.season, 2026);
    const goldenWindows = readGolden("windows");
    const goldenRuns = readGolden("runs");
    const goldenEvents = readGolden("usage_events");
    expect(goldenEvents).toHaveLength(194);

    // ---- map the golden rows onto Convex documents (the mapping seed-convex.ts uses)
    const ids = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { email: "golden@x.dev" });
      const leagueId = await ctx.db.insert("leagues", {
        name: String(goldenLeague.name ?? "Golden"),
        slug: `g-${Math.random()}`,
        commissionerUserId: userId,
        season: goldenSeason,
        teamCount: 12,
        isPublic: true,
        status: "in_season",
        draftType: "snake",
        updatedAt: NOW,
      });

      const teams: Record<string, Id<"teams">> = {};
      for (const row of readGolden("teams")) {
        teams[String(row.id)] = await ctx.db.insert("teams", {
          leagueId,
          name: String(row.name),
          abbreviation: String(row.abbreviation ?? "TM"),
          faabRemaining: 100,
          waiverPriority: numOr(row.waiver_priority, 1),
          karma: 0,
          draftBudgetRemaining: 200,
        });
      }

      const windows: Record<string, { id: Id<"windows">; weekNo: number }> = {};
      for (const row of goldenWindows) {
        const weekNo = numOr(row.week_no, 0);
        windows[String(row.id)] = {
          weekNo,
          id: await ctx.db.insert("windows", {
            leagueId,
            type: String(row.type) as "lineup",
            label: String(row.label),
            weekNo,
            roundNo: numOr(row.round_no, 1),
            opensAt: NOW - 86_400_000,
            submissionDeadlineAt: NOW - 43_200_000,
            closesAt: NOW - 3_600_000,
            status: "closed",
            scope: {},
            runCount: 0,
            terminalRunCount: 0,
          }),
        };
      }

      const runs: Record<string, Id<"runs">> = {};
      for (const row of goldenRuns) {
        const window = windows[String(row.window_id)];
        const legacyTeamId = row.team_id == null ? null : String(row.team_id);
        runs[String(row.id)] = await ctx.db.insert("runs", {
          leagueId,
          windowId: window.id,
          teamId: legacyTeamId ? teams[legacyTeamId] : undefined,
          modelId: String(row.model_id),
          kind: String(row.kind) as "team",
          status: "succeeded",
          windowType: String(
            goldenWindows.find((w) => String(w.id) === String(row.window_id))!.type,
          ) as "lineup",
          windowLabel: String(
            goldenWindows.find((w) => String(w.id) === String(row.window_id))!.label,
          ),
          weekNo: window.weekNo,
          attempt: 1,
          lastPersistedStep: -1,
          totalCostUsd: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          stepCount: numOr(row.step_count, 0),
          committedActionCount: 0,
          rejectedActionCount: 0,
        });
      }
      return { leagueId, teams, windows, runs };
    });

    // ---- replay every event through the one function allowed to write them
    const ordered = [...goldenEvents].sort(
      (a, b) =>
        String(a.run_id).localeCompare(String(b.run_id)) ||
        numOr(a.step_index, 0) - numOr(b.step_index, 0),
    );
    for (const row of ordered) {
      await t.mutation(internal.ledger.recordStep, {
        runId: ids.runs[String(row.run_id)],
        stepIndex: numOr(row.step_index, 0),
        modelId: String(row.model_id),
        provider: String(row.provider),
        usage: usage(
          numOr(row.input_tokens, 0),
          numOr(row.output_tokens, 0),
          numOr(row.cached_input_tokens, 0),
          numOr(row.reasoning_tokens, 0),
        ),
        latencyMs: numOr(row.latency_ms, 0),
        gatewayCostUsd: row.gateway_cost_usd == null ? undefined : numOr(row.gateway_cost_usd, 0),
        createdAt: Date.parse(String(row.created_at)),
      });
    }

    // ---- fold the JSON exactly as scripts/seed-convex.ts does
    const teamWeek = new Map<string, GoldenCounters>();
    const modelWeek = new Map<string, GoldenCounters>();
    const leagueWeek = new Map<string, GoldenCounters>();
    const runById = new Map(goldenRuns.map((row) => [String(row.id), row]));
    const windowById = new Map(goldenWindows.map((row) => [String(row.id), row]));
    const bump = (map: Map<string, GoldenCounters>, key: string, row: GoldenRow, runId: string) => {
      const c = map.get(key) ?? zeroGolden();
      c.inputTokens += numOr(row.input_tokens, 0);
      c.outputTokens += numOr(row.output_tokens, 0);
      c.cachedInputTokens += numOr(row.cached_input_tokens, 0);
      c.reasoningTokens += numOr(row.reasoning_tokens, 0);
      c.costUsd += numOr(row.cost_usd, 0);
      c.computedCostUsd += numOr(row.computed_cost_usd ?? row.cost_usd, 0);
      c.gatewayCostUsd += numOr(row.gateway_cost_usd, 0);
      c.stepCount += 1;
      c.runIds.add(runId);
      map.set(key, c);
    };
    for (const row of goldenEvents) {
      const run = runById.get(String(row.run_id))!;
      const weekNo = numOr(windowById.get(String(run.window_id))!.week_no, 0);
      const runId = String(row.run_id);
      if (row.team_id) bump(teamWeek, `${String(row.team_id)}|${weekNo}`, row, runId);
      bump(modelWeek, `${String(row.model_id)}|${weekNo}`, row, runId);
      bump(leagueWeek, `${weekNo}`, row, runId);
    }
    // The golden ledger has no fallback runs and no gateway figures; the sums
    // below therefore also assert that neither was invented on the way through.
    expect(goldenRuns.filter((row) => row.fallback_applied)).toHaveLength(0);

    const expectCounters = (
      actual: Doc<"team_week_rollups" | "model_week_rollups" | "league_week_rollups">,
      expected: GoldenCounters,
      label: string,
    ) => {
      expect({ label, ...actual }).toMatchObject({
        label,
        inputTokens: expected.inputTokens,
        outputTokens: expected.outputTokens,
        cachedInputTokens: expected.cachedInputTokens,
        reasoningTokens: expected.reasoningTokens,
        stepCount: expected.stepCount,
        runCount: expected.runIds.size,
        fallbackCount: 0,
        invalidActionCount: 0,
      });
      expect(actual.costUsd).toBeCloseTo(expected.costUsd, 8);
      expect(actual.computedCostUsd).toBeCloseTo(expected.computedCostUsd, 8);
      expect(actual.gatewayCostUsd).toBeCloseTo(expected.gatewayCostUsd, 8);
    };

    const stored = await t.run(async (ctx) => ({
      teams: await ctx.db.query("team_week_rollups").collect(),
      models: await ctx.db.query("model_week_rollups").collect(),
      leagues: await ctx.db.query("league_week_rollups").collect(),
      events: await ctx.db.query("usage_events").collect(),
    }));
    expect(stored.events).toHaveLength(194);

    // ---- team rollups
    expect(stored.teams).toHaveLength(teamWeek.size);
    for (const [key, expected] of teamWeek) {
      const [legacyTeamId, weekNo] = key.split("|");
      const teamId = ids.teams[legacyTeamId];
      const row = stored.teams.find(
        (candidate) => candidate.teamId === teamId && candidate.weekNo === Number(weekNo),
      )!;
      expect(row).toBeDefined();
      expect(row.season).toBe(goldenSeason);
      expectCounters(row, expected, `team ${legacyTeamId} wk${weekNo}`);
    }

    // ---- model rollups: the per-league row and the cross-league row carry the same sums
    expect(stored.models).toHaveLength(modelWeek.size * 2);
    for (const [key, expected] of modelWeek) {
      const [modelId, weekNo] = key.split("|");
      for (const leagueId of [ids.leagueId, undefined]) {
        const row = stored.models.find(
          (candidate) =>
            candidate.leagueId === leagueId &&
            candidate.modelId === modelId &&
            candidate.weekNo === Number(weekNo),
        )!;
        expect(row).toBeDefined();
        expect(row.provider).toBe("mock");
        expectCounters(row, expected, `model ${modelId} wk${weekNo} ${leagueId ?? "global"}`);
      }
    }

    // ---- league rollups
    expect(stored.leagues).toHaveLength(leagueWeek.size);
    for (const [weekNo, expected] of leagueWeek) {
      const row = stored.leagues.find((candidate) => candidate.weekNo === Number(weekNo))!;
      expect(row).toBeDefined();
      expectCounters(row, expected, `league wk${weekNo}`);
    }

    // The headline: every counter in the league rows equals the whole event file.
    const totalSteps = [...leagueWeek.values()].reduce((sum, c) => sum + c.stepCount, 0);
    expect(totalSteps).toBe(194);
    expect(stored.leagues.reduce((sum, row) => sum + row.stepCount, 0)).toBe(194);
    expect(stored.leagues.reduce((sum, row) => sum + row.cachedInputTokens, 0)).toBe(
      goldenEvents.reduce((sum, row) => sum + numOr(row.cached_input_tokens, 0), 0),
    );
    expect(stored.leagues.reduce((sum, row) => sum + row.runCount, 0)).toBe(
      new Set(goldenEvents.map((row) => String(row.run_id))).size,
    );
  });
});
