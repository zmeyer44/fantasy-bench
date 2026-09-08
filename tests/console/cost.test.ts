import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { budgets, teamResults } from "@/lib/db/schema";
import {
  benchmarkByModel,
  budgetStatus,
  costPerPoint,
  costPerWin,
  costTrendByWeek,
  leagueSpendByModel,
  leagueSpendByTeam,
  leagueSpendTotals,
  mostExpensiveRuns,
  teamSeasonSpend,
  teamWeekSpend,
} from "@/lib/services/cost";

import { db, truncateAll } from "../setup";
import { makeLeague, makeRunWithUsage, makeWindow } from "./helpers";

const SONNET = "anthropic/claude-sonnet-4.5";
const HAIKU = "anthropic/claude-haiku-4.5";

beforeAll(async () => {
  await truncateAll();
});

/**
 * One league, two teams, two weeks.
 *
 *   team A (sonnet): wk1 3 steps x $0.10 = $0.30, wk2 2 steps x $0.25 = $0.50 -> $0.80
 *   team B (haiku):  wk1 4 steps x $0.05 = $0.20                             -> $0.20
 */
async function seedSpend() {
  const f = await makeLeague();
  const w1 = await makeWindow(f.league.id, 1);
  const w2 = await makeWindow(f.league.id, 2);

  await makeRunWithUsage({
    leagueId: f.league.id,
    teamId: f.team.id,
    windowId: w1.window.id,
    modelId: SONNET,
    steps: 3,
    costPerStepUsd: 0.1,
    inputTokensPerStep: 1_000,
    outputTokensPerStep: 200,
  });
  const expensive = await makeRunWithUsage({
    leagueId: f.league.id,
    teamId: f.team.id,
    windowId: w2.window.id,
    modelId: SONNET,
    steps: 2,
    costPerStepUsd: 0.25,
    inputTokensPerStep: 2_000,
    outputTokensPerStep: 500,
  });
  await makeRunWithUsage({
    leagueId: f.league.id,
    teamId: f.otherTeam.id,
    windowId: w1.window.id,
    modelId: HAIKU,
    steps: 4,
    costPerStepUsd: 0.05,
    inputTokensPerStep: 500,
    outputTokensPerStep: 100,
  });

  return { ...f, expensiveRunId: expensive.id };
}

describe("spend rollups", () => {
  it("sums a team-week from usage events by the run's window week", async () => {
    const f = await seedSpend();

    const wk1 = await teamWeekSpend(f.team.id, 1);
    expect(wk1.usd).toBeCloseTo(0.3, 8);
    expect(wk1.tokens).toBe(3 * 1_200);
    expect(wk1.inputTokens).toBe(3_000);
    expect(wk1.outputTokens).toBe(600);
    expect(wk1.runCount).toBe(1);
    expect(wk1.stepCount).toBe(3);

    const wk2 = await teamWeekSpend(f.team.id, 2);
    expect(wk2.usd).toBeCloseTo(0.5, 8);

    const wk3 = await teamWeekSpend(f.team.id, 3);
    expect(wk3.usd).toBe(0);
    expect(wk3.runCount).toBe(0);
  });

  it("rolls a team season up with a per-week breakdown", async () => {
    const f = await seedSpend();
    const season = await teamSeasonSpend(f.team.id);
    expect(season.usd).toBeCloseTo(0.8, 8);
    expect(season.byWeek.map((w) => w.weekNo)).toEqual([1, 2]);
    expect(season.byWeek[0].usd).toBeCloseTo(0.3, 8);
    expect(season.byWeek[1].usd).toBeCloseTo(0.5, 8);
  });

  it("ranks league spend by team, including zero-spend teams", async () => {
    const f = await seedSpend();
    const rows = await leagueSpendByTeam(f.league.id);

    expect(rows).toHaveLength(f.teams.length);
    expect(rows[0].teamId).toBe(f.team.id);
    expect(rows[0].usd).toBeCloseTo(0.8, 8);
    expect(rows[1].teamId).toBe(f.otherTeam.id);
    expect(rows[1].usd).toBeCloseTo(0.2, 8);
    expect(rows.at(-1)!.usd).toBe(0);
    // Each row carries the model the team currently runs.
    expect(rows[0].modelId).toBeTruthy();
  });

  it("groups league spend by model with display names", async () => {
    const f = await seedSpend();
    const rows = await leagueSpendByModel(f.league.id);
    const byId = Object.fromEntries(rows.map((r) => [r.modelId, r]));
    expect(byId[SONNET].usd).toBeCloseTo(0.8, 8);
    expect(byId[SONNET].displayName).toBe("Claude Sonnet 4.5");
    expect(byId[HAIKU].usd).toBeCloseTo(0.2, 8);
    expect(rows[0].modelId).toBe(SONNET);
  });

  it("lists the most expensive runs first", async () => {
    const f = await seedSpend();
    const rows = await mostExpensiveRuns(f.league.id, 5);
    expect(rows[0].runId).toBe(f.expensiveRunId);
    expect(rows[0].costUsd).toBeCloseTo(0.5, 8);
    expect(rows[0].teamName).toBe("Team 1");
    expect(rows[0].weekNo).toBe(2);
    expect(rows.length).toBe(3);
  });

  it("trends cost by league week", async () => {
    const f = await seedSpend();
    const trend = await costTrendByWeek(f.league.id);
    expect(trend.map((t) => t.weekNo)).toEqual([1, 2]);
    expect(trend[0].usd).toBeCloseTo(0.5, 8); // 0.30 + 0.20
    expect(trend[1].usd).toBeCloseTo(0.5, 8);

    const totals = await leagueSpendTotals(f.league.id);
    expect(totals.usd).toBeCloseTo(1.0, 8);
    expect(totals.runCount).toBe(3);
  });

  it("prefers the gateway-reported cost over the computed one", async () => {
    const f = await makeLeague();
    const w = await makeWindow(f.league.id, 1);
    await makeRunWithUsage({
      leagueId: f.league.id,
      teamId: f.team.id,
      windowId: w.window.id,
      modelId: SONNET,
      steps: 2,
      costPerStepUsd: 1,
      gatewayCostPerStepUsd: 0.4,
    });
    const spend = await teamWeekSpend(f.team.id, 1);
    expect(spend.usd).toBeCloseTo(0.8, 8);
  });
});

describe("cost per point and per win", () => {
  it("divides season spend by points scored and by wins", async () => {
    const f = await seedSpend();

    await db.insert(teamResults).values([
      { teamId: f.team.id, weekNo: 1, pointsFor: 100, pointsAgainst: 90, won: true },
      { teamId: f.team.id, weekNo: 2, pointsFor: 60, pointsAgainst: 80, lost: true },
    ]);

    const perPoint = await costPerPoint(f.team.id);
    expect(perPoint.usd).toBeCloseTo(0.8, 8);
    expect(perPoint.points).toBeCloseTo(160, 6);
    expect(perPoint.costPerPoint).toBeCloseTo(0.8 / 160, 8);

    const perWin = await costPerWin(f.team.id);
    expect(perWin.wins).toBe(1);
    expect(perWin.losses).toBe(1);
    expect(perWin.costPerWin).toBeCloseTo(0.8, 8);
  });

  it("returns null rather than dividing by zero", async () => {
    const f = await seedSpend();
    const perPoint = await costPerPoint(f.otherTeam.id);
    expect(perPoint.points).toBe(0);
    expect(perPoint.costPerPoint).toBeNull();

    const perWin = await costPerWin(f.otherTeam.id);
    expect(perWin.wins).toBe(0);
    expect(perWin.costPerWin).toBeNull();
  });
});

describe("benchmarkByModel", () => {
  it("attributes each team to its modal model and ranks by points per dollar", async () => {
    const f = await seedSpend();
    await db.insert(teamResults).values([
      { teamId: f.team.id, weekNo: 1, pointsFor: 160, won: true },
      { teamId: f.otherTeam.id, weekNo: 1, pointsFor: 100, lost: true },
    ]);

    const rows = await benchmarkByModel(f.league.id);
    const byId = Object.fromEntries(rows.map((r) => [r.modelId, r]));

    // Team 1 ran sonnet; the six teams that never ran fall back to the model on
    // their current config version, which is the allowlist default (sonnet too).
    expect(byId[SONNET].teamIds).toContain(f.team.id);
    expect(byId[SONNET].teamCount).toBe(f.teams.length - 1);
    expect(byId[HAIKU].teamIds).toEqual([f.otherTeam.id]);
    expect(byId[SONNET].usd).toBeCloseTo(0.8, 8);
    expect(byId[SONNET].points).toBeCloseTo(160, 6);
    expect(byId[SONNET].pointsPerUsd).toBeCloseTo(200, 4);

    expect(byId[HAIKU].pointsPerUsd).toBeCloseTo(500, 4);
    // Cheaper model, same-ish points -> better points per dollar, so it sorts first.
    expect(rows[0].modelId).toBe(HAIKU);

    // Teams that never ran fall back to the model on their current config version.
    const attributed = rows.reduce((n, r) => n + r.teamCount, 0);
    expect(attributed).toBe(f.teams.length);
  });
});

describe("budgetStatus", () => {
  it("reports tokens against the league weekly cap and USD against the hard cap", async () => {
    const f = await makeLeague({ weeklyTokenCapPerTeam: 10_000, leagueUsdHardCap: 1 });
    const w = await makeWindow(f.league.id, 1);
    await makeRunWithUsage({
      leagueId: f.league.id,
      teamId: f.team.id,
      windowId: w.window.id,
      modelId: SONNET,
      steps: 2,
      costPerStepUsd: 0.25,
      inputTokensPerStep: 2_000,
      outputTokensPerStep: 500,
    });

    const status = await budgetStatus(f.team.id, 1);
    expect(status.tokensUsed).toBe(5_000);
    expect(status.tokenCap).toBe(10_000);
    expect(status.tokensRemaining).toBe(5_000);
    expect(status.tokensPct).toBeCloseTo(0.5, 8);
    expect(status.overTokenCap).toBe(false);

    expect(status.teamWeekUsd).toBeCloseTo(0.5, 8);
    expect(status.leagueUsdUsed).toBeCloseTo(0.5, 8);
    expect(status.leagueUsdCap).toBe(1);
    expect(status.leagueUsdPct).toBeCloseTo(0.5, 8);
    expect(status.overUsdCap).toBe(false);
  });

  it("flags going over both caps", async () => {
    const f = await makeLeague({ weeklyTokenCapPerTeam: 1_000, leagueUsdHardCap: 0.1 });
    const w = await makeWindow(f.league.id, 1);
    await makeRunWithUsage({
      leagueId: f.league.id,
      teamId: f.team.id,
      windowId: w.window.id,
      modelId: SONNET,
      steps: 2,
      costPerStepUsd: 0.25,
    });

    const status = await budgetStatus(f.team.id, 1);
    expect(status.overTokenCap).toBe(true);
    expect(status.tokensRemaining).toBe(0);
    expect(status.overUsdCap).toBe(true);
    expect(status.leagueUsdRemaining).toBe(0);
  });

  it("prefers a team-specific budgets row over the league rule", async () => {
    const f = await makeLeague({ weeklyTokenCapPerTeam: 1_000 });
    await db.insert(budgets).values({
      leagueId: f.league.id,
      teamId: f.team.id,
      period: "week",
      tokenCap: 99_000,
    });
    const status = await budgetStatus(f.team.id, 1);
    expect(status.tokenCap).toBe(99_000);
  });

  it("reports null caps when the commissioner set none", async () => {
    const f = await makeLeague();
    const status = await budgetStatus(f.team.id, 1);
    expect(status.tokenCap).toBeNull();
    expect(status.tokensRemaining).toBeNull();
    expect(status.leagueUsdCap).toBeNull();
    expect(status.overUsdCap).toBe(false);
    expect(
      (await db.select().from(teamResults).where(eq(teamResults.teamId, f.team.id))).length,
    ).toBe(0);
  });
});
