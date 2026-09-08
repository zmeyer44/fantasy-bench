/**
 * The scripted mock is only useful if it behaves like a competent agent in every
 * window type. These tests drive whole runs and assert on what the agent
 * attempted — not on whether another package's service accepted it — so they
 * stay green while the scheduler and social packages are still in flight.
 */
import { asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import { agentConfigs, configVersions, runActions, runSteps } from "@/lib/db/schema";
import { executeRun } from "@/lib/agent/execute";
import { resetMockModelState } from "@/lib/agent/mock-model";

import { truncateAll } from "../setup";
import { NOW, seedFixture, seedMockModelPrice, type Fixture } from "./fixtures";

async function actionTypes(runId: string): Promise<string[]> {
  const rows = await db
    .select({ actionType: runActions.actionType })
    .from(runActions)
    .where(eq(runActions.runId, runId))
    .orderBy(asc(runActions.stepIndex));
  return rows.map((r) => r.actionType);
}

async function setHarness(fx: Fixture, patch: Record<string, unknown>): Promise<void> {
  const [config] = await db
    .select({ versionId: agentConfigs.currentVersionId })
    .from(agentConfigs)
    .where(eq(agentConfigs.teamId, fx.teamAId))
    .limit(1);
  const [version] = await db
    .select({ harness: configVersions.harness })
    .from(configVersions)
    .where(eq(configVersions.id, config!.versionId!))
    .limit(1);
  await db
    .update(configVersions)
    .set({ harness: { ...version!.harness, ...patch } as typeof version.harness })
    .where(eq(configVersions.id, config!.versionId!));
}

describe("scripted mock across window types", () => {
  beforeEach(async () => {
    await truncateAll();
    resetMockModelState();
    await seedMockModelPrice();
  });

  it("reads the roster, searches free agents and attempts waiver claims", async () => {
    const fx = await seedFixture({ windowType: "waiver" });
    await executeRun(fx.runId, { now: NOW });

    const steps = await db
      .select()
      .from(runSteps)
      .where(eq(runSteps.runId, fx.runId))
      .orderBy(asc(runSteps.stepIndex));
    const calls = steps.flatMap((s) =>
      (s.toolCalls as Array<{ toolName?: string }>).map((c) => c.toolName ?? ""),
    );
    expect(calls[0]).toBe("get_my_team");
    expect(calls).toContain("search_players");
    expect(calls).toContain("submit_waiver_claims");
    expect(calls).toContain("set_rationale");
    expect(calls).not.toContain("set_lineup");
    expect(await actionTypes(fx.runId)).toContain("submit_waiver_claims");
  });

  it("reads its inbox and the matchup, then attempts a trade in a trade window", async () => {
    const fx = await seedFixture({ windowType: "trade" });
    await executeRun(fx.runId, { now: NOW });

    const steps = await db
      .select()
      .from(runSteps)
      .where(eq(runSteps.runId, fx.runId))
      .orderBy(asc(runSteps.stepIndex));
    const calls = steps.flatMap((s) =>
      (s.toolCalls as Array<{ toolName?: string }>).map((c) => c.toolName ?? ""),
    );
    expect(calls[0]).toBe("get_my_team");
    expect(calls[1]).toBe("get_inbox");
    expect(calls).toContain("get_matchup");
    expect(calls.some((c) => c === "propose_trade" || c === "send_message")).toBe(true);
    expect(calls).not.toContain("set_lineup");
  });

  it("takes the best player available in a snake draft window", async () => {
    const fx = await seedFixture({
      windowType: "draft",
      windowScope: { draftType: "snake", pickNo: 1 },
    });
    await executeRun(fx.runId, { now: NOW });

    const steps = await db
      .select()
      .from(runSteps)
      .where(eq(runSteps.runId, fx.runId))
      .orderBy(asc(runSteps.stepIndex));
    const calls = steps.flatMap((s) =>
      (s.toolCalls as Array<{ toolName?: string }>).map((c) => c.toolName ?? ""),
    );
    expect(calls).toContain("search_players");
    expect(calls).toContain("make_draft_pick");
    expect(calls).not.toContain("submit_bid");
  });

  it("deliberate mode forces a text-only plan as step 0", async () => {
    const fx = await seedFixture();
    await setHarness(fx, { deliberateMode: true });
    const result = await executeRun(fx.runId, { now: NOW });

    const steps = await db
      .select()
      .from(runSteps)
      .where(eq(runSteps.runId, fx.runId))
      .orderBy(asc(runSteps.stepIndex));
    expect((steps[0]!.toolCalls as unknown[]).length).toBe(0);
    expect(steps[0]!.text).toBeTruthy();
    expect((steps[1]!.toolCalls as Array<{ toolName?: string }>)[0]?.toolName).toBe("get_my_team");
    expect(result.status).toBe("succeeded");
  });

  it("respects the harness max-step cap", async () => {
    const fx = await seedFixture();
    await setHarness(fx, { maxSteps: 1 });
    const result = await executeRun(fx.runId, { now: NOW });
    expect(result.stepCount).toBe(1);
    // One step only gets as far as get_my_team, so the lineup window is partial
    // and the autopilot backstops it.
    expect(result.status).toBe("partial");
    expect(result.outcome).toBe("no_lineup_set");
    expect(result.fallbackApplied?.kind).toBe("safety_autopilot");
  });
});
