import { and, asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import { leagueRules, runActions, runSteps, runs, usageEvents } from "@/lib/db/schema";
import { claimRun, executeRun, readGatewayCostUsd } from "@/lib/agent/execute";
import { resetMockModelState } from "@/lib/agent/mock-model";
import { getCurrentLineup } from "@/lib/services/lineup";

import { truncateAll } from "../setup";
import { EXPECTED_OPTIMAL, NOW, WEEK_NO, seedFixture, seedMockModelPrice } from "./fixtures";

describe("executeRun — lineup window with mock/scripted", () => {
  beforeEach(async () => {
    await truncateAll();
    resetMockModelState();
    await seedMockModelPrice();
  });

  it("runs the loop, writes steps and usage, commits a lineup and a rationale", async () => {
    const fx = await seedFixture();
    const result = await executeRun(fx.runId, { now: NOW });

    expect(result.status).toBe("succeeded");
    expect(result.outcome).toContain("lineup_set");
    expect(result.executed).toBe(true);
    expect(result.stepCount).toBeGreaterThanOrEqual(3);
    expect(result.totalInputTokens).toBe(result.stepCount * 1200);
    expect(result.totalOutputTokens).toBe(result.stepCount * 150);
    expect(result.totalCostUsd).toBeGreaterThan(0);

    // The agent set the highest-projected legal lineup.
    const lineup = await getCurrentLineup({ teamId: fx.teamAId, weekNo: WEEK_NO });
    expect(lineup?.source).toBe("agent");
    const starters = lineup!.slots.filter((s) => s.slot !== "BENCH");
    expect(starters).toEqual(
      EXPECTED_OPTIMAL.map((e) => ({ slot: e.slot, playerId: fx.ids[e.key]! })),
    );

    // One run_steps row per model call, in order, each with usage.
    const steps = await db
      .select()
      .from(runSteps)
      .where(eq(runSteps.runId, fx.runId))
      .orderBy(asc(runSteps.stepIndex));
    expect(steps).toHaveLength(result.stepCount);
    expect(steps.map((s) => s.stepIndex)).toEqual(steps.map((_, i) => i));
    expect(steps.every((s) => s.usage.inputTokens === 1200)).toBe(true);
    expect(steps.every((s) => s.costUsd > 0)).toBe(true);

    // One usage_events row per step, and the first step has no cache read.
    const usage = await db
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.runId, fx.runId))
      .orderBy(asc(usageEvents.stepIndex));
    expect(usage).toHaveLength(result.stepCount);
    expect(usage[0]!.cachedInputTokens).toBe(0);
    expect(usage[1]!.cachedInputTokens).toBe(200);

    // Rationale published on the run.
    const [run] = await db.select().from(runs).where(eq(runs.id, fx.runId));
    expect(run!.rationale).toBeTruthy();
    expect(run!.rationale).toMatch(/lineup/i);
    expect(run!.finishedAt).not.toBeNull();
    expect(run!.promptSections!.map((s) => s.id)).toEqual([
      "platform",
      "owner_context",
      "snapshot",
      "inbox",
      "forum",
    ]);
    expect(run!.messages!.length).toBeGreaterThan(2);

    // The write went through the idempotency ledger.
    const actions = await db
      .select()
      .from(runActions)
      .where(and(eq(runActions.runId, fx.runId), eq(runActions.actionType, "set_lineup")));
    expect(actions).toHaveLength(1);
    expect(actions[0]!.committedAt).not.toBeNull();
  });

  it("is idempotent: a second execute does not re-run or double-commit", async () => {
    const fx = await seedFixture();
    const first = await executeRun(fx.runId, { now: NOW });
    const second = await executeRun(fx.runId, { now: NOW });

    expect(second.executed).toBe(false);
    expect(second.status).toBe(first.status);

    const steps = await db.select().from(runSteps).where(eq(runSteps.runId, fx.runId));
    expect(steps).toHaveLength(first.stepCount);
    const lineup = await getCurrentLineup({ teamId: fx.teamAId, weekNo: WEEK_NO });
    expect(lineup!.version).toBe(1);
  });

  it("skips commissioner runs without throwing", async () => {
    const fx = await seedFixture({ windowType: "commissioner" });
    await db.update(runs).set({ kind: "commissioner" }).where(eq(runs.id, fx.runId));
    const result = await executeRun(fx.runId, { now: NOW });
    expect(result.status).toBe("skipped");
    expect(result.outcome).toBe("skipped_commissioner_run");
    const steps = await db.select().from(runSteps).where(eq(runSteps.runId, fx.runId));
    expect(steps).toHaveLength(0);
  });
});

describe("executeRun — failure paths", () => {
  beforeEach(async () => {
    await truncateAll();
    resetMockModelState();
    await seedMockModelPrice();
  });

  it("retries a provider error and then succeeds", async () => {
    const fx = await seedFixture({ modelId: "mock/failing" });
    const result = await executeRun(fx.runId, { now: NOW });
    expect(result.status).toBe("succeeded");
    expect(result.outcome).toContain("lineup_set");
    // The retry happened inside the SDK, so no fallback model was needed.
    expect(result.fallbackApplied).toBeNull();
    expect(result.modelId).toBe("mock/failing");
  });

  it("times out, marks timed_out and applies the safety autopilot", async () => {
    const fx = await seedFixture({ modelId: "mock/timeout" });
    // Squeeze the wall clock so the test does not wait five minutes.
    const executeModule = await import("@/lib/agent/execute");
    const original = executeModule.PER_RUN_WALL_CLOCK_MS.lineup;
    executeModule.PER_RUN_WALL_CLOCK_MS.lineup = 150;
    try {
      const result = await executeRun(fx.runId, { now: NOW });
      expect(result.status).toBe("timed_out");
      expect(result.fallbackApplied?.kind).toBe("safety_autopilot");
      // Default fixture lineup starts te2 and rb3; nothing is unavailable, so the
      // autopilot has nothing to fill but still guarantees a stored lineup.
      const lineup = await getCurrentLineup({ teamId: fx.teamAId, weekNo: WEEK_NO });
      expect(lineup).not.toBeNull();
    } finally {
      executeModule.PER_RUN_WALL_CLOCK_MS.lineup = original;
    }
  }, 20_000);

  it("falls back to the commissioner's fallback model when the primary keeps failing", async () => {
    const fx = await seedFixture({ modelId: "mock/broken" });
    await db
      .update(leagueRules)
      .set({ fallbackModelId: "mock/scripted" })
      .where(eq(leagueRules.leagueId, fx.leagueId));
    const result = await executeRun(fx.runId, { now: NOW });
    expect(result.status).toBe("succeeded");
    expect(result.modelId).toBe("mock/scripted");
    expect(result.fallbackApplied?.kind).toBe("fallback_model");
    expect(result.fallbackApplied?.fromModelId).toBe("mock/broken");
  });
});

describe("executeRun — budgets", () => {
  beforeEach(async () => {
    await truncateAll();
    resetMockModelState();
    await seedMockModelPrice();
  });

  it("stops before the first model call when the league USD cap is already reached", async () => {
    const fx = await seedFixture();
    await db
      .update(leagueRules)
      .set({ leagueUsdHardCap: 0.000001 })
      .where(eq(leagueRules.leagueId, fx.leagueId));
    // Burn the cap.
    const { recordUsage } = await import("@/lib/services/ledger");
    await recordUsage({
      runId: fx.runId,
      stepIndex: 0,
      teamId: fx.teamAId,
      leagueId: fx.leagueId,
      modelId: "mock/scripted",
      inputTokens: 10_000,
      outputTokens: 1_000,
      weekNo: WEEK_NO,
    });

    const result = await executeRun(fx.runId, { now: NOW });
    expect(result.status).toBe("fallback");
    expect(result.outcome).toBe("budget_exhausted");
    expect(result.fallbackApplied?.kind).toBe("budget_exhausted");
    expect(result.stepCount).toBe(0);
    const steps = await db.select().from(runSteps).where(eq(runSteps.runId, fx.runId));
    expect(steps).toHaveLength(0);
  });

  it("stops mid-run when the next step would breach the team's weekly token cap", async () => {
    const fx = await seedFixture();
    // One mock step is 1350 tokens; the pre-step check projects ~2700 for the next
    // one, so a 3000-token cap allows the first step and stops before the second.
    await db
      .update(leagueRules)
      .set({ weeklyTokenCapPerTeam: 3000 })
      .where(eq(leagueRules.leagueId, fx.leagueId));

    const result = await executeRun(fx.runId, { now: NOW });
    expect(result.status).toBe("fallback");
    expect(result.outcome).toBe("budget_exhausted");
    expect(result.error).toMatch(/weekly token cap/);
    expect(result.stepCount).toBeGreaterThan(0);
    expect(result.stepCount).toBeLessThan(4);
    expect(result.fallbackApplied?.kind).toBe("budget_exhausted");

    const steps = await db.select().from(runSteps).where(eq(runSteps.runId, fx.runId));
    expect(steps.length).toBe(result.stepCount);
  });
});

describe("claimRun", () => {
  beforeEach(async () => {
    await truncateAll();
    resetMockModelState();
  });

  it("claims a pending run once", async () => {
    const fx = await seedFixture();
    const first = await claimRun(fx.runId, { now: NOW });
    expect(first.claimed).toBe(true);
    expect(first.leaseExpiresAt!.getTime()).toBe(NOW.getTime() + 5 * 60_000 + 60_000);

    const second = await claimRun(fx.runId, { now: NOW });
    expect(second.claimed).toBe(false);

    const [run] = await db.select().from(runs).where(eq(runs.id, fx.runId));
    expect(run!.status).toBe("running");
    expect(run!.claimedAt).not.toBeNull();
  });
});

describe("readGatewayCostUsd", () => {
  it("reads whichever spelling the gateway used, and ignores junk", () => {
    expect(readGatewayCostUsd({ gateway: { cost: 0.5 } })).toBe(0.5);
    expect(readGatewayCostUsd({ gateway: { costUSD: "0.25" } })).toBe(0.25);
    expect(readGatewayCostUsd({ gateway: { cost: "not a number" } })).toBeNull();
    expect(readGatewayCostUsd({ anthropic: { cost: 1 } })).toBeNull();
    expect(readGatewayCostUsd(undefined)).toBeNull();
  });
});
