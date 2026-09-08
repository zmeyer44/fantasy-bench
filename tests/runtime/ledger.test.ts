import { and, eq, isNull } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import { budgetRollups, leagueRules, usageEvents } from "@/lib/db/schema";
import { getModelPrice } from "@/lib/agent/model";
import {
  computeCostUsd,
  estimateStepCostUsd,
  getRemainingBudget,
  recordUsage,
} from "@/lib/services/ledger";

import { truncateAll } from "../setup";
import { WEEK_NO, seedFixture, seedMockModelPrice, type Fixture } from "./fixtures";

describe("ledger", () => {
  let fx: Fixture;
  beforeEach(async () => {
    await truncateAll();
    await seedMockModelPrice();
    fx = await seedFixture();
  });

  it("prices cached input at the cached rate", async () => {
    const price = await getModelPrice("mock/scripted");
    expect(price.source).toBe("model_prices");
    // 1000 uncached @ $3/M + 200 cached @ $0.30/M + 150 out @ $15/M
    const cost = computeCostUsd({
      price,
      inputTokens: 1200,
      outputTokens: 150,
      cachedInputTokens: 200,
    });
    expect(cost).toBeCloseTo(1000 * 3e-6 + 200 * 0.3e-6 + 150 * 15e-6, 10);
    // Without the cache discount the same call costs more.
    const uncached = computeCostUsd({ price, inputTokens: 1200, outputTokens: 150 });
    expect(uncached).toBeGreaterThan(cost);
  });

  it("falls back to the model catalog when the price book has no row", async () => {
    const price = await getModelPrice("anthropic/claude-sonnet-4.5");
    expect(price.source).toBe("catalog");
    expect(price.inputPerM).toBe(3);
    const estimate = await estimateStepCostUsd("anthropic/claude-sonnet-4.5", 1_000_000, 0);
    expect(estimate).toBeCloseTo(3, 6);
  });

  it("records an event, prefers the gateway cost, and keeps the computed one", async () => {
    const result = await recordUsage({
      runId: fx.runId,
      stepIndex: 0,
      teamId: fx.teamAId,
      leagueId: fx.leagueId,
      modelId: "mock/scripted",
      inputTokens: 1200,
      outputTokens: 150,
      cachedInputTokens: 200,
      gatewayCostUsd: 0.009,
      weekNo: WEEK_NO,
    });
    expect(result.costUsd).toBe(0.009);
    expect(result.gatewayCostUsd).toBe(0.009);
    expect(result.computedCostUsd).toBeGreaterThan(0);
    expect(result.computedCostUsd).not.toBe(0.009);

    const [row] = await db.select().from(usageEvents).where(eq(usageEvents.runId, fx.runId));
    expect(row!.costUsd).toBe(0.009);
    expect(row!.computedCostUsd).toBe(result.computedCostUsd);
    expect(row!.provider).toBe("mock");
    expect(row!.cachedInputTokens).toBe(200);
  });

  it("upserts both the team and the league rollup, accumulating across steps", async () => {
    for (let step = 0; step < 3; step++) {
      await recordUsage({
        runId: fx.runId,
        stepIndex: step,
        teamId: fx.teamAId,
        leagueId: fx.leagueId,
        modelId: "mock/scripted",
        inputTokens: 1000,
        outputTokens: 100,
        weekNo: WEEK_NO,
      });
    }
    const [team] = await db
      .select()
      .from(budgetRollups)
      .where(and(eq(budgetRollups.leagueId, fx.leagueId), eq(budgetRollups.teamId, fx.teamAId)));
    const [league] = await db
      .select()
      .from(budgetRollups)
      .where(and(eq(budgetRollups.leagueId, fx.leagueId), isNull(budgetRollups.teamId)));

    expect(team!.tokensUsed).toBe(3300);
    expect(league!.tokensUsed).toBe(3300);
    expect(team!.weekNo).toBe(WEEK_NO);
    expect(league!.usdUsed).toBeCloseTo(team!.usdUsed, 8);
  });

  it("reports remaining budget against the league's caps", async () => {
    await db
      .update(leagueRules)
      .set({ weeklyTokenCapPerTeam: 5000, leagueUsdHardCap: 0.05 })
      .where(eq(leagueRules.leagueId, fx.leagueId));

    const before = await getRemainingBudget({
      leagueId: fx.leagueId,
      teamId: fx.teamAId,
      weekNo: WEEK_NO,
    });
    expect(before.teamTokensRemaining).toBe(5000);
    expect(before.leagueCapReached).toBe(false);

    await recordUsage({
      runId: fx.runId,
      stepIndex: 0,
      teamId: fx.teamAId,
      leagueId: fx.leagueId,
      modelId: "mock/scripted",
      inputTokens: 4000,
      outputTokens: 500,
      weekNo: WEEK_NO,
    });

    const after = await getRemainingBudget({
      leagueId: fx.leagueId,
      teamId: fx.teamAId,
      weekNo: WEEK_NO,
    });
    expect(after.teamTokensRemaining).toBe(500);
    expect(after.leagueUsdUsed).toBeGreaterThan(0);
    expect(after.leagueCapReached).toBe(false);

    // Blow past the USD cap.
    await recordUsage({
      runId: fx.runId,
      stepIndex: 1,
      teamId: fx.teamAId,
      leagueId: fx.leagueId,
      modelId: "mock/scripted",
      inputTokens: 20_000,
      outputTokens: 5_000,
      weekNo: WEEK_NO,
    });
    const exhausted = await getRemainingBudget({
      leagueId: fx.leagueId,
      teamId: fx.teamAId,
      weekNo: WEEK_NO,
    });
    expect(exhausted.leagueCapReached).toBe(true);
    expect(exhausted.teamTokensRemaining).toBe(0);
  });
});
