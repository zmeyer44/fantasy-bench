/**
 * `internal.runtime.execute.executeRun` end to end — the port of
 * `tests/runtime/execute.test.ts`, plus the two things the Convex design added:
 * **resume** after a crash, and the hand-off to `internal.runs.onComplete`.
 *
 * The Workpool is not in the loop here: the action is called directly with
 * `t.action` and the completion mutation with `t.mutation`, which is exactly the
 * contract the pool implements (`enqueueAction(executeRun) → onComplete`).
 * `convex/runs_write.test.ts` exercises the completion mutation's own branches,
 * and the enqueue/cancel round trip is checked against the dev deployment.
 */
import { beforeEach, describe, expect, test } from "vitest";

import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { resetMockModelState } from "./mock_model";

import {
  NOW,
  WEEK_NO,
  currentLineupOf,
  makeTest,
  seedFixture,
  type Fixture,
} from "./fixtures.test";

type T = ReturnType<typeof makeTest>;

const stepsOf = (t: T, runId: Id<"runs">) =>
  t.run(async (ctx) =>
    ctx.db
      .query("run_steps")
      .withIndex("by_runId_stepIndex", (q) => q.eq("runId", runId))
      .collect(),
  );

const actionsOf = (t: T, runId: Id<"runs">) =>
  t.run(async (ctx) =>
    ctx.db
      .query("run_actions")
      .withIndex("by_runId_stepIndex", (q) => q.eq("runId", runId))
      .collect(),
  );

const usageOf = (t: T, runId: Id<"runs">) =>
  t.run(async (ctx) =>
    ctx.db
      .query("usage_events")
      .withIndex("by_runId_stepIndex", (q) => q.eq("runId", runId))
      .collect(),
  );

const runDoc = (t: T, runId: Id<"runs">) => t.run(async (ctx) => ctx.db.get("runs", runId));

/** Deliver the action's summary to the completion mutation, as the pool would. */
async function completeSuccess(t: T, fx: Fixture, returnValue: unknown) {
  await t.mutation(internal.runs.onComplete, {
    workId: "test-work-id" as never,
    context: { runId: fx.runId },
    result: { kind: "success", returnValue },
  });
  // `onComplete` schedules the ledger outcome, the search doc and (for a lineup
  // window that produced none) the safety autopilot with `runAfter(0)`.
  await t.finishAllScheduledFunctions(() => {});
}

beforeEach(() => {
  resetMockModelState();
});

describe("executeRun — lineup window with mock/scripted", () => {
  test("runs the loop, writes steps and usage, commits a lineup and a rationale", async () => {
    const t = makeTest();
    const fx = await seedFixture(t);

    const result = await t.action(internal.runtime.execute.executeRun, {
      runId: fx.runId,
      now: NOW,
    });

    expect(result.status).toBe("succeeded");
    expect(result.outcome).toContain("lineup_set");
    expect(result.executed).toBe(true);
    expect(result.stepCount).toBeGreaterThanOrEqual(3);
    expect(result.totalInputTokens).toBe(result.stepCount * 1200);
    expect(result.totalOutputTokens).toBe(result.stepCount * 150);
    expect(result.totalCostUsd).toBeGreaterThan(0);
    // The action never writes a terminal status; that is `onComplete`'s job.
    expect((await runDoc(t, fx.runId))!.status).toBe("running");

    // The agent set the highest-projected legal lineup.
    const lineup = await currentLineupOf(t, fx.teamAId);
    expect(lineup!.source).toBe("agent");
    expect(lineup!.slots.find((s) => s.slot === "TE")!.playerId).toBe(fx.ids.te1);
    expect(lineup!.slots.find((s) => s.slot === "FLEX")!.playerId).toBe(fx.ids.wr3);

    // One run_steps row per model call, in order, each with usage and a cost.
    const steps = await stepsOf(t, fx.runId);
    expect(steps).toHaveLength(result.stepCount);
    expect(steps.map((s) => s.stepIndex)).toEqual(steps.map((_, i) => i));
    expect(steps.every((s) => s.usage.inputTokens === 1200)).toBe(true);
    expect(steps.every((s) => s.costUsd > 0)).toBe(true);
    expect(steps.every((s) => Array.isArray(s.responseMessages))).toBe(true);

    // One usage_event per step (written by the ledger), first step uncached.
    const usage = await usageOf(t, fx.runId);
    expect(usage).toHaveLength(result.stepCount);
    expect(usage.sort((a, b) => a.stepIndex - b.stepIndex)[0]!.cachedInputTokens).toBe(0);
    expect(usage.sort((a, b) => a.stepIndex - b.stepIndex)[1]!.cachedInputTokens).toBe(200);

    // Resume bookkeeping and the published rationale.
    const run = await runDoc(t, fx.runId);
    expect(run!.lastPersistedStep).toBe(result.stepCount - 1);
    expect(run!.rationale).toMatch(/lineup/i);
    expect(run!.promptSections!.map((s) => s.id)).toEqual([
      "platform",
      "owner_context",
      "snapshot",
      "inbox",
      "forum",
    ]);
    expect(run!.attempt).toBe(1);

    // The write went through the idempotency ledger exactly once.
    const setLineup = (await actionsOf(t, fx.runId)).filter((a) => a.actionType === "set_lineup");
    expect(setLineup).toHaveLength(1);
    expect(setLineup[0]!.committedAt).toBeDefined();

    // onComplete turns the summary into the terminal status.
    await completeSuccess(t, fx, result);
    const finished = await runDoc(t, fx.runId);
    expect(finished!.status).toBe("succeeded");
    expect(finished!.outcome).toContain("lineup_set");
    expect(finished!.finishedAt).toBeDefined();
    const window = await t.run(async (ctx) => ctx.db.get("windows", fx.windowId));
    expect(window!.terminalRunCount).toBe(1);
  });

  test("is idempotent: a terminal run replays its summary and does no work", async () => {
    const t = makeTest();
    const fx = await seedFixture(t);
    const first = await t.action(internal.runtime.execute.executeRun, {
      runId: fx.runId,
      now: NOW,
    });
    await completeSuccess(t, fx, first);

    const second = await t.action(internal.runtime.execute.executeRun, {
      runId: fx.runId,
      now: NOW,
    });
    expect(second.executed).toBe(false);
    expect(second.status).toBe("succeeded");
    expect(await stepsOf(t, fx.runId)).toHaveLength(first.stepCount);
    expect((await currentLineupOf(t, fx.teamAId))!.version).toBe(1);
  });

  test("skips commissioner runs without throwing", async () => {
    const t = makeTest();
    const fx = await seedFixture(t, { windowType: "commissioner" });
    await t.run(async (ctx) => ctx.db.patch("runs", fx.runId, { kind: "commissioner" }));
    const result = await t.action(internal.runtime.execute.executeRun, {
      runId: fx.runId,
      now: NOW,
    });
    expect(result.status).toBe("skipped");
    expect(result.outcome).toBe("skipped_commissioner_run");
    expect(await stepsOf(t, fx.runId)).toHaveLength(0);
  });
});

describe("executeRun — resume after a crash", () => {
  test("re-executes nothing below lastPersistedStep and finishes the run", async () => {
    const t = makeTest();
    const fx = await seedFixture(t, { modelId: "mock/crash-after-3" });

    // Attempt 1: the model dies on its fourth call, after three persisted steps.
    await expect(
      t.action(internal.runtime.execute.executeRun, { runId: fx.runId, now: NOW }),
    ).rejects.toThrow(/crash-after-3/);

    const afterCrash = await stepsOf(t, fx.runId);
    expect(afterCrash.map((s) => s.stepIndex).sort()).toEqual([0, 1, 2]);
    const crashedRun = await runDoc(t, fx.runId);
    expect(crashedRun!.lastPersistedStep).toBe(2);
    expect(crashedRun!.status).toBe("running");
    // Partial commits stand: the lineup written in step 1 survives the crash.
    expect((await currentLineupOf(t, fx.teamAId))!.source).toBe("agent");
    const actionsBefore = await actionsOf(t, fx.runId);
    const usageBefore = await usageOf(t, fx.runId);
    expect(usageBefore).toHaveLength(3);

    // Attempt 2: the Workpool retry. Steps 0-2 are replayed into the prompt.
    const result = await t.action(internal.runtime.execute.executeRun, {
      runId: fx.runId,
      now: NOW,
    });
    expect(result.status).toBe("succeeded");
    expect(result.outcome).toContain("lineup_set");
    expect(result.executed).toBe(true);

    const steps = await stepsOf(t, fx.runId);
    // No duplicate steps: 0-2 kept, the run continued from 3.
    expect(steps.map((s) => s.stepIndex).sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    expect(steps.filter((s) => s.stepIndex === 1)).toHaveLength(1);

    // No duplicate actions, no duplicate usage events, no second lineup version.
    const actionsAfter = await actionsOf(t, fx.runId);
    expect(actionsAfter.map((a) => a.toolCallId).sort()).toEqual(
      actionsBefore.map((a) => a.toolCallId).sort(),
    );
    expect(actionsAfter.filter((a) => a.actionType === "set_lineup")).toHaveLength(1);
    const usageAfter = await usageOf(t, fx.runId);
    expect(usageAfter).toHaveLength(4);
    expect(new Set(usageAfter.map((u) => u.stepIndex)).size).toBe(4);
    expect((await currentLineupOf(t, fx.teamAId))!.version).toBe(1);

    // The run's totals cover every step, counted once each.
    const run = await runDoc(t, fx.runId);
    expect(run!.stepCount).toBe(4);
    expect(run!.lastPersistedStep).toBe(3);
    expect(run!.totalInputTokens).toBe(4 * 1200);
    expect(run!.attempt).toBe(2);
  });
});

describe("executeRun — budgets", () => {
  test("a tiny per-run token budget stops before the first model call", async () => {
    const t = makeTest();
    const fx = await seedFixture(t, { harness: { tokenBudget: 500 } });
    const result = await t.action(internal.runtime.execute.executeRun, {
      runId: fx.runId,
      now: NOW,
    });
    expect(result.status).toBe("fallback");
    expect(result.outcome).toBe("budget_exhausted");
    expect(result.error).toMatch(/token budget/);
    expect(result.fallbackApplied?.kind).toBe("budget_exhausted");
    // The abort is the real stop; a provider that had already started its call
    // winds down through `toolChoice: 'none'`, which is at most one more step.
    expect(result.stepCount).toBeLessThanOrEqual(1);
    expect(await stepsOf(t, fx.runId)).toHaveLength(result.stepCount);
  });

  test("stops on the team's weekly token cap and reports it", async () => {
    const t = makeTest();
    const fx = await seedFixture(t, { weeklyTokenCapPerTeam: 3000 });
    const result = await t.action(internal.runtime.execute.executeRun, {
      runId: fx.runId,
      now: NOW,
    });
    expect(result.status).toBe("fallback");
    expect(result.outcome).toBe("budget_exhausted");
    expect(result.error).toMatch(/weekly token cap/);
    expect(result.fallbackApplied?.kind).toBe("budget_exhausted");
    expect(await stepsOf(t, fx.runId)).toHaveLength(result.stepCount);
  });

  test("stops before spending a cent when the league USD cap is already reached", async () => {
    const t = makeTest();
    const fx = await seedFixture(t, { leagueUsdHardCap: 0 });
    const result = await t.action(internal.runtime.execute.executeRun, {
      runId: fx.runId,
      now: NOW,
    });
    expect(result.status).toBe("fallback");
    expect(result.outcome).toBe("budget_exhausted");
    expect(result.stepCount).toBe(0);
    expect(await stepsOf(t, fx.runId)).toHaveLength(0);

    // The commissioner is told, exactly once.
    const posts = await t.run(async (ctx) =>
      ctx.db
        .query("forum_posts")
        .withIndex("by_leagueId_createdAt", (q) => q.eq("leagueId", fx.leagueId))
        .collect(),
    );
    expect(posts).toHaveLength(1);
    expect(posts[0]!.title).toMatch(/spend cap reached/i);

    // A lineup window with no lineup gets the safety autopilot from onComplete.
    await completeSuccess(t, fx, result);
    const run = await runDoc(t, fx.runId);
    expect(run!.status).toBe("fallback");
    expect(await currentLineupOf(t, fx.teamAId)).not.toBeNull();
  });
});

describe("executeRun — team spend cap and bring-your-own-key", () => {
  test("stops before spending when the team's weekly spend cap is already reached", async () => {
    const t = makeTest();
    const fx = await seedFixture(t, { weeklyUsdCapPerTeam: 0 });
    const result = await t.action(internal.runtime.execute.executeRun, {
      runId: fx.runId,
      now: NOW,
    });
    expect(result.status).toBe("fallback");
    expect(result.outcome).toBe("budget_exhausted");
    expect(result.error).toMatch(/team weekly spend cap/);
    expect(result.fallbackApplied?.detail).toMatch(/\$0\.0000 of \$0\.00/);
    expect(result.stepCount).toBe(0);
    expect(await stepsOf(t, fx.runId)).toHaveLength(0);
  });

  test("the platform default cap is $2.00 when the commissioner set none", async () => {
    const t = makeTest();
    const fx = await seedFixture(t);
    const budget = await t.query(internal.ledger.remainingBudget, {
      leagueId: fx.leagueId,
      teamId: fx.teamAId,
      weekNo: WEEK_NO,
    });
    expect(budget.teamUsdCap).toBe(2);
    expect(budget.teamUsdRemaining).toBe(2);
    expect(budget.teamCapReached).toBe(false);
  });

  test("a team on its own gateway key bypasses every cap and is still metered", async () => {
    const t = makeTest();
    // League cap already blown and a zero team cap: without a key nothing would run.
    const fx = await seedFixture(t, {
      leagueUsdHardCap: 0,
      weeklyUsdCapPerTeam: 0,
      weeklyTokenCapPerTeam: 1,
      teamKey: "vck_test_key_0123456789abcdef",
    });
    const result = await t.action(internal.runtime.execute.executeRun, {
      runId: fx.runId,
      now: NOW,
    });
    expect(result.status).toBe("succeeded");
    expect(result.outcome).toBe("lineup_set");
    expect(result.stepCount).toBeGreaterThan(0);

    const run = await runDoc(t, fx.runId);
    expect(run!.keySource).toBe("team");
    // Spend is recorded exactly as for a league-key run.
    expect((await usageOf(t, fx.runId)).length).toBe(result.stepCount);
    expect(run!.totalInputTokens).toBeGreaterThan(0);
    const keyRow = await t.run(async (ctx) =>
      ctx.db
        .query("team_gateway_keys")
        .withIndex("by_teamId", (q) => q.eq("teamId", fx.teamAId))
        .unique(),
    );
    expect(keyRow?.lastUsedAt).toBeDefined();
    // The prompt told the agent so.
    const platform = run!.promptSections?.find((s) => s.id === "platform")?.text ?? "";
    expect(platform).toMatch(/own gateway key/);
    expect(platform).toMatch(/weekly spend cap: \$0\.00/);
  });

  test("a league-key run records keySource=league", async () => {
    const t = makeTest();
    const fx = await seedFixture(t);
    await t.action(internal.runtime.execute.executeRun, { runId: fx.runId, now: NOW });
    expect((await runDoc(t, fx.runId))!.keySource).toBe("league");
  });
});

describe("executeRun — failure paths", () => {
  test("retries a provider error inside the SDK and then succeeds", async () => {
    const t = makeTest();
    const fx = await seedFixture(t, { modelId: "mock/failing" });
    const result = await t.action(internal.runtime.execute.executeRun, {
      runId: fx.runId,
      now: NOW,
    });
    expect(result.status).toBe("succeeded");
    expect(result.outcome).toContain("lineup_set");
    expect(result.modelId).toBe("mock/failing");
    // The retry happened inside the AI SDK, so the run never reached the pool's.
    expect(result.fallbackApplied).toBeNull();
  }, 30_000);

  test("times out on the wall clock, keeps what it persisted, and gets the autopilot", async () => {
    const t = makeTest();
    const fx = await seedFixture(t, { modelId: "mock/timeout" });
    const result = await t.action(internal.runtime.execute.executeRun, {
      runId: fx.runId,
      now: NOW,
      wallClockMs: 150,
    });
    expect(result.status).toBe("timed_out");
    expect(result.fallbackApplied?.kind).toBe("safety_autopilot");
    // Nothing was lost: the model never produced a step, so none were persisted.
    const run = await runDoc(t, fx.runId);
    expect(run!.lastPersistedStep).toBe(-1);
    expect(await stepsOf(t, fx.runId)).toHaveLength(0);

    await completeSuccess(t, fx, result);
    expect((await runDoc(t, fx.runId))!.status).toBe("timed_out");
    // The safety autopilot guaranteed a stored lineup for the week.
    const lineup = await currentLineupOf(t, fx.teamAId);
    expect(lineup).not.toBeNull();
    expect(lineup!.weekNo).toBe(WEEK_NO);
  }, 20_000);

  test("a window with no snapshot fails fast instead of burning retries", async () => {
    const t = makeTest();
    const fx = await seedFixture(t);
    await t.run(async (ctx) => ctx.db.patch("windows", fx.windowId, { snapshotId: undefined }));
    await expect(
      t.action(internal.runtime.execute.executeRun, { runId: fx.runId, now: NOW }),
    ).rejects.toThrow(/no ready snapshot/);
  });
});
