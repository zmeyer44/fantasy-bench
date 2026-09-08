/**
 * The Phase 5a write half of `convex/runs.ts`: `persistStep`, `markRunning`,
 * `actionResult`, `recordRejectedAction`, `onComplete`, `enqueueRun` and
 * `cancelForWindow`.
 *
 * The Workpool component is registered with `convex-test` (see `makePoolTest`
 * below), so `enqueueRun`, `cancelForWindow` and the fallback-model enqueue run
 * against the real component rather than a stub: the enqueue lands a work id on
 * the run, the pool picks the work up and executes it, and the cancel goes
 * through the pool.
 */
import { describe, expect, test } from "vitest";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

import { NOW, makeTest, seedFixture, type Fixture } from "./runtime/fixtures.test";

type T = ReturnType<typeof makeTest>;

/**
 * A convex-test instance with the `runPool` Workpool component registered.
 *
 * The registration helper is loaded through a non-literal specifier on purpose:
 * `@convex-dev/workpool/test` is published as raw TypeScript (`src/test.ts`), and
 * a static import drags the component's sources into this project's `tsc`
 * program, where they do not compile (they need `vite/client` types and an ES2020
 * target). At runtime the module loads normally.
 */
const WORKPOOL_TEST_MODULE = "@convex-dev/workpool/test" as string;

type WorkpoolTestModule = { default: { register: (t: unknown, name: string) => void } };

async function makePoolTest(): Promise<T> {
  const t = makeTest();
  const mod = (await import(WORKPOOL_TEST_MODULE)) as unknown as WorkpoolTestModule;
  mod.default.register(t, "runPool");
  return t;
}

const STEP_USAGE = {
  inputTokens: 1200,
  outputTokens: 150,
  cachedInputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 1350,
};

async function persist(t: T, fx: Fixture, stepIndex: number, over: Record<string, unknown> = {}) {
  return t.mutation(internal.runs.persistStep, {
    runId: fx.runId,
    stepIndex,
    modelId: fx.modelId,
    text: `step ${stepIndex}`,
    responseMessages: [{ role: "assistant", content: [{ type: "text", text: "hi" }] }],
    toolCalls: [],
    toolResults: [],
    usage: STEP_USAGE,
    finishReason: "stop",
    latencyMs: 42,
    ...over,
  });
}

describe("persistStep", () => {
  test("writes the step, advances the run's totals and is idempotent", async () => {
    const t = makeTest();
    const fx = await seedFixture(t);

    const first = await persist(t, fx, 0);
    expect(first.persisted).toBe(true);
    expect(first.lastPersistedStep).toBe(0);
    expect(first.stepCount).toBe(1);

    const replay = await persist(t, fx, 0);
    expect(replay.persisted).toBe(false);

    await persist(t, fx, 1, { rationale: "Because the flex was wrong." });

    const run = await t.run(async (ctx) => ctx.db.get("runs", fx.runId));
    expect(run!.stepCount).toBe(2);
    expect(run!.lastPersistedStep).toBe(1);
    expect(run!.totalInputTokens).toBe(2400);
    expect(run!.totalOutputTokens).toBe(300);
    expect(run!.rationale).toBe("Because the flex was wrong.");

    // The ledger write happens inside persistStep's transaction: one usage event
    // per persisted step, and the run's total equals their sum.
    const events = await t.run(async (ctx) =>
      ctx.db
        .query("usage_events")
        .withIndex("by_runId_stepIndex", (q) => q.eq("runId", fx.runId))
        .collect(),
    );
    expect(events.map((e) => e.stepIndex)).toEqual([0, 1]);
    expect(run!.totalCostUsd).toBeCloseTo(
      events.reduce((sum, e) => sum + e.costUsd, 0),
      8,
    );

    const steps = await t.run(async (ctx) =>
      ctx.db
        .query("run_steps")
        .withIndex("by_runId_stepIndex", (q) => q.eq("runId", fx.runId))
        .collect(),
    );
    expect(steps).toHaveLength(2);
    expect(steps.every((s) => s.bytes > 0)).toBe(true);
  });

  test("moves a tool result over the inline limit into run_step_payloads", async () => {
    const t = makeTest();
    const fx = await seedFixture(t);
    const big = {
      type: "tool-result",
      toolCallId: "call-big",
      toolName: "search_players",
      output: { blob: "x".repeat(80 * 1024) },
    };
    const small = { type: "tool-result", toolCallId: "call-small", toolName: "get_my_team", output: { ok: true } };

    const result = await persist(t, fx, 0, { toolResults: [big, small] });
    expect(result.offloadedPayloads).toBe(1);

    const step = await t.run(async (ctx) =>
      ctx.db
        .query("run_steps")
        .withIndex("by_runId_stepIndex", (q) => q.eq("runId", fx.runId).eq("stepIndex", 0))
        .first(),
    );
    const stored = step!.toolResults as Array<Record<string, unknown>>;
    expect(stored).toHaveLength(2);
    expect(stored[0]!.truncated).toBe(true);
    expect(stored[0]!.payloadRef).toBeDefined();
    expect(stored[1]!.toolCallId).toBe("call-small");

    const payloads = await t.run(async (ctx) =>
      ctx.db
        .query("run_step_payloads")
        .withIndex("by_runId_stepIndex_toolCallId", (q) => q.eq("runId", fx.runId).eq("stepIndex", 0))
        .collect(),
    );
    expect(payloads).toHaveLength(1);
    expect(payloads[0]!.toolCallId).toBe("call-big");
    expect(payloads[0]!.bytes).toBeGreaterThan(64 * 1024);
    // The step document itself stayed small.
    expect(step!.bytes).toBeLessThan(64 * 1024);
  });
});

describe("markRunning / actionResult / recordRejectedAction", () => {
  test("markRunning stamps the model and bumps the attempt, once per attempt", async () => {
    const t = makeTest();
    const fx = await seedFixture(t);
    const first = await t.mutation(internal.runs.markRunning, {
      runId: fx.runId,
      modelId: "mock/scripted",
      configVersionId: fx.configVersionId,
      now: NOW,
    });
    expect(first).toEqual({ attempt: 1, running: true });
    const second = await t.mutation(internal.runs.markRunning, {
      runId: fx.runId,
      modelId: "mock/scripted",
      now: NOW + 1000,
    });
    expect(second.attempt).toBe(2);

    const run = await t.run(async (ctx) => ctx.db.get("runs", fx.runId));
    expect(run!.status).toBe("running");
    expect(run!.startedAt).toBe(NOW);
    expect(run!.configVersionId).toBe(fx.configVersionId);
  });

  test("markRunning refuses to reopen a terminal run", async () => {
    const t = makeTest();
    const fx = await seedFixture(t);
    await t.run(async (ctx) => ctx.db.patch("runs", fx.runId, { status: "succeeded" }));
    const result = await t.mutation(internal.runs.markRunning, {
      runId: fx.runId,
      modelId: "mock/scripted",
    });
    expect(result.running).toBe(false);
    expect((await t.run(async (ctx) => ctx.db.get("runs", fx.runId)))!.status).toBe("succeeded");
  });

  test("recordRejectedAction is idempotent and counts against the run", async () => {
    const t = makeTest();
    const fx = await seedFixture(t);
    expect(await t.query(internal.runs.actionResult, { runId: fx.runId, toolCallId: "c1" })).toEqual({
      found: false,
      committed: false,
    });

    const first = await t.mutation(internal.runs.recordRejectedAction, {
      runId: fx.runId,
      toolCallId: "c1",
      stepIndex: 2,
      actionType: "set_lineup",
      payload: { slots: [] },
      errors: ["nope"],
    });
    expect(first.recorded).toBe(true);
    const again = await t.mutation(internal.runs.recordRejectedAction, {
      runId: fx.runId,
      toolCallId: "c1",
      stepIndex: 2,
      actionType: "set_lineup",
      payload: { slots: [] },
      errors: ["nope"],
    });
    expect(again.recorded).toBe(false);

    const stored = await t.query(internal.runs.actionResult, { runId: fx.runId, toolCallId: "c1" });
    expect(stored.found).toBe(true);
    expect(stored.committed).toBe(false);
    expect(stored.result).toEqual({ ok: false, errors: ["nope"] });

    const run = await t.run(async (ctx) => ctx.db.get("runs", fx.runId));
    expect(run!.rejectedActionCount).toBe(1);
  });
});

describe("onComplete", () => {
  const call = (t: T, runId: Id<"runs">, result: Record<string, unknown>) =>
    t.mutation(internal.runs.onComplete, {
      workId: "w1" as never,
      context: { runId },
      result: result as never,
    });

  test("success writes the action's status and finishes the run once", async () => {
    const t = makeTest();
    const fx = await seedFixture(t, { runStatus: "running" });
    await call(t, fx.runId, {
      kind: "success",
      returnValue: {
        runId: fx.runId,
        status: "succeeded",
        outcome: "lineup_set",
        error: null,
        modelId: "mock/scripted",
        stepCount: 3,
        totalCostUsd: 0.01,
        totalInputTokens: 3600,
        totalOutputTokens: 450,
        rationale: "done",
        fallbackApplied: null,
        executed: true,
      },
    });
    await t.finishAllScheduledFunctions(() => {});

    const run = await t.run(async (ctx) => ctx.db.get("runs", fx.runId));
    expect(run!.status).toBe("succeeded");
    expect(run!.outcome).toBe("lineup_set");
    expect(run!.finishedAt).toBeDefined();
    const window = await t.run(async (ctx) => ctx.db.get("windows", fx.windowId));
    expect(window!.terminalRunCount).toBe(1);

    // The search document is refreshed for the trace search index.
    const searchDoc = await t.run(async (ctx) =>
      ctx.db
        .query("run_search_docs")
        .withIndex("by_runId", (q) => q.eq("runId", fx.runId))
        .first(),
    );
    expect(searchDoc).not.toBeNull();
    expect(searchDoc!.status).toBe("succeeded");

    // A second delivery for an already-terminal run changes nothing.
    await call(t, fx.runId, { kind: "canceled" });
    await t.finishAllScheduledFunctions(() => {});
    const after = await t.run(async (ctx) => ctx.db.get("windows", fx.windowId));
    expect(after!.terminalRunCount).toBe(1);
    expect((await t.run(async (ctx) => ctx.db.get("runs", fx.runId)))!.status).toBe("succeeded");
  });

  test("a partial lineup run gets the safety autopilot", async () => {
    const t = makeTest();
    const fx = await seedFixture(t, { runStatus: "running" });
    await call(t, fx.runId, {
      kind: "success",
      returnValue: {
        runId: fx.runId,
        status: "partial",
        outcome: "no_lineup_set",
        error: null,
        modelId: "mock/scripted",
        stepCount: 1,
        totalCostUsd: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        rationale: null,
        fallbackApplied: { kind: "safety_autopilot", detail: "agent set no lineup" },
        executed: true,
      },
    });
    await t.finishAllScheduledFunctions(() => {});

    const run = await t.run(async (ctx) => ctx.db.get("runs", fx.runId));
    expect(run!.status).toBe("partial");
    expect(run!.fallbackApplied?.kind).toBe("safety_autopilot");
    const lineup = await t.run(async (ctx) =>
      ctx.db
        .query("lineups")
        .withIndex("by_teamId_weekNo_version", (q) => q.eq("teamId", fx.teamAId).eq("weekNo", 5))
        .order("desc")
        .first(),
    );
    expect(lineup).not.toBeNull();
    expect(lineup!.setByRunId).toBe(fx.runId);
  });

  test("cancellation is a timeout: the window closed under the run", async () => {
    const t = makeTest();
    const fx = await seedFixture(t, { runStatus: "running" });
    await call(t, fx.runId, { kind: "canceled" });
    await t.finishAllScheduledFunctions(() => {});
    const run = await t.run(async (ctx) => ctx.db.get("runs", fx.runId));
    expect(run!.status).toBe("timed_out");
    expect(run!.outcome).toBe("window_closed");
  });

  test("failure marks the run failed and enqueues the league's fallback model", async () => {
    const t = await makePoolTest();
    const fx = await seedFixture(t, {
      runStatus: "running",
      fallbackModelId: "mock/scripted",
      modelId: "mock/broken",
    });
    await call(t, fx.runId, { kind: "failed", error: "provider exploded" });
    await t.finishAllScheduledFunctions(() => {});

    const run = await t.run(async (ctx) => ctx.db.get("runs", fx.runId));
    expect(run!.status).toBe("failed");
    expect(run!.error).toBe("provider exploded");

    const runs = await t.run(async (ctx) =>
      ctx.db
        .query("runs")
        .withIndex("by_windowId_status", (q) => q.eq("windowId", fx.windowId))
        .collect(),
    );
    const fallback = runs.find((r) => r._id !== fx.runId);
    expect(fallback).toBeDefined();
    expect(fallback!.modelId).toBe("mock/scripted");
    expect(fallback!.fallbackOfRunId).toBe(fx.runId);
    expect(fallback!.fallbackApplied).toMatchObject({
      kind: "fallback_model",
      fromModelId: "mock/broken",
      toModelId: "mock/scripted",
    });
    expect(fallback!.workId).toBeDefined();
    // The pool picked the new run up and ran it on the fallback model, from step 0.
    expect(fallback!.lastPersistedStep).toBeGreaterThanOrEqual(0);
    expect(fallback!.stepCount).toBeGreaterThan(0);

    const window = await t.run(async (ctx) => ctx.db.get("windows", fx.windowId));
    expect(window!.runCount).toBe(2);
  });

  test("a fallback run that fails does not spawn another fallback", async () => {
    const t = await makePoolTest();
    const fx = await seedFixture(t, {
      runStatus: "running",
      fallbackModelId: "mock/scripted",
      modelId: "mock/broken",
    });
    await t.run(async (ctx) => ctx.db.patch("runs", fx.runId, { fallbackOfRunId: fx.runId }));
    await call(t, fx.runId, { kind: "failed", error: "still broken" });
    await t.finishAllScheduledFunctions(() => {});
    const runs = await t.run(async (ctx) =>
      ctx.db
        .query("runs")
        .withIndex("by_windowId_status", (q) => q.eq("windowId", fx.windowId))
        .collect(),
    );
    expect(runs).toHaveLength(1);
  });
});

describe("enqueueRun / cancelForWindow", () => {
  test("enqueue stores a work id and close cancels and times the run out", async () => {
    const t = await makePoolTest();
    const fx = await seedFixture(t);

    const workId = await t.mutation(internal.runs.enqueue, { runId: fx.runId });
    expect(typeof workId).toBe("string");
    const queued = await t.run(async (ctx) => ctx.db.get("runs", fx.runId));
    expect(queued!.workId).toBe(workId);

    const { cancelled } = await t.mutation(internal.runs.cancelForWindow, {
      windowId: fx.windowId,
      now: NOW,
    });
    expect(cancelled).toBe(1);

    const run = await t.run(async (ctx) => ctx.db.get("runs", fx.runId));
    expect(run!.status).toBe("timed_out");
    expect(run!.outcome).toBe("window_closed");
    expect(run!.finishedAt).toBe(NOW);

    const window = await t.run(async (ctx) => ctx.db.get("windows", fx.windowId));
    expect(window!.terminalRunCount).toBe(1);

    // A late completion for a run the close already finalised is a no-op.
    await t.mutation(internal.runs.onComplete, {
      workId: workId as never,
      context: { runId: fx.runId },
      result: { kind: "canceled" } as never,
    });
    await t.finishAllScheduledFunctions(() => {});
    const after = await t.run(async (ctx) => ctx.db.get("windows", fx.windowId));
    expect(after!.terminalRunCount).toBe(1);
  });
});
