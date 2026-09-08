/**
 * Run/step/usage plumbing for the Commissioner Agent.
 *
 * The commissioner is an agent like any other, so it must leave a trace: a
 * `runs` row (`kind = 'commissioner'`, `team_id = null`), one `run_steps` row
 * per model call, and one `usage_events` row per call priced through the shared
 * ledger (`recordUsage` in lib/services/ledger).
 */
import { and, eq } from "drizzle-orm";

import { db, type DbOrTx } from "@/lib/db";
import { runSteps, runs, windows } from "@/lib/db/schema";
import { recordUsage } from "@/lib/services/ledger";
import type { StepUsage } from "@/lib/db/schema";

export type CommissionerUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
};

export const EMPTY_USAGE: CommissionerUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  reasoningTokens: 0,
};

/** Normalize an AI SDK 7 usage object into the ledger's four counters. */
export function normalizeUsage(usage: unknown): CommissionerUsage {
  const u = (usage ?? {}) as {
    inputTokens?: number;
    outputTokens?: number;
    inputTokenDetails?: { cacheReadTokens?: number };
    outputTokenDetails?: { reasoningTokens?: number };
  };
  return {
    inputTokens: u.inputTokens ?? 0,
    outputTokens: u.outputTokens ?? 0,
    cachedInputTokens: u.inputTokenDetails?.cacheReadTokens ?? 0,
    reasoningTokens: u.outputTokenDetails?.reasoningTokens ?? 0,
  };
}


/**
 * The window a commissioner run hangs off. `runs.window_id` is NOT NULL, so
 * commissioner tasks get their own `type = 'commissioner'` window, reused per
 * (league, label, week).
 */
export async function ensureCommissionerWindow(
  args: { leagueId: string; weekNo: number | null; label: string; now?: Date },
  executor: DbOrTx = db,
): Promise<string> {
  const now = args.now ?? new Date();
  const existing = await executor
    .select({ id: windows.id })
    .from(windows)
    .where(
      and(
        eq(windows.leagueId, args.leagueId),
        eq(windows.type, "commissioner"),
        eq(windows.label, args.label),
        args.weekNo === null ? undefined : eq(windows.weekNo, args.weekNo),
      ),
    )
    .limit(1);
  if (existing[0]) return existing[0].id;

  const [created] = await executor
    .insert(windows)
    .values({
      leagueId: args.leagueId,
      type: "commissioner",
      label: args.label,
      weekNo: args.weekNo,
      opensAt: now,
      submissionDeadlineAt: now,
      closesAt: now,
      status: "closed",
    })
    .returning({ id: windows.id });
  return created.id;
}

export type CommissionerRun = {
  runId: string;
  windowId: string;
  startedAt: Date;
};

export async function startCommissionerRun(
  args: { leagueId: string; weekNo: number | null; label: string; modelId: string; now?: Date },
  executor: DbOrTx = db,
): Promise<CommissionerRun> {
  const now = args.now ?? new Date();
  const windowId = await ensureCommissionerWindow(args, executor);
  const [run] = await executor
    .insert(runs)
    .values({
      windowId,
      teamId: null,
      leagueId: args.leagueId,
      modelId: args.modelId,
      kind: "commissioner",
      status: "running",
      startedAt: now,
      claimedAt: now,
    })
    .returning({ id: runs.id });
  return { runId: run.id, windowId, startedAt: now };
}

/** Append one model call to the trace and price it. */
export async function recordCommissionerStep(
  args: {
    run: CommissionerRun;
    leagueId: string;
    stepIndex: number;
    modelId: string;
    system: string;
    prompt: string;
    text: string;
    usage: CommissionerUsage;
    finishReason?: string;
    latencyMs?: number;
  },
  executor: DbOrTx = db,
): Promise<{ costUsd: number }> {
  // The shared ledger (PRD 5.9) prices the step from `model_prices` and keeps the
  // league/week rollups in sync; commissioner spend is league-level (team null).
  const { costUsd } = await recordUsage(
    {
      runId: args.run.runId,
      stepIndex: args.stepIndex,
      teamId: null,
      leagueId: args.leagueId,
      modelId: args.modelId,
      inputTokens: args.usage.inputTokens,
      outputTokens: args.usage.outputTokens,
      cachedInputTokens: args.usage.cachedInputTokens,
      reasoningTokens: args.usage.reasoningTokens,
      latencyMs: args.latencyMs,
    },
    executor,
  );

  const usageJson: StepUsage = {
    inputTokens: args.usage.inputTokens,
    outputTokens: args.usage.outputTokens,
    totalTokens: args.usage.inputTokens + args.usage.outputTokens,
    cachedInputTokens: args.usage.cachedInputTokens,
    reasoningTokens: args.usage.reasoningTokens,
  };

  await executor.insert(runSteps).values({
    runId: args.run.runId,
    stepIndex: args.stepIndex,
    modelId: args.modelId,
    text: args.text,
    messages: [
      { role: "system", content: args.system },
      { role: "user", content: args.prompt },
    ],
    toolCalls: [],
    toolResults: [],
    usage: usageJson,
    finishReason: args.finishReason ?? "stop",
    latencyMs: args.latencyMs ?? null,
    costUsd,
  });

  return { costUsd };
}

export async function finishCommissionerRun(
  args: {
    runId: string;
    status: "succeeded" | "failed" | "fallback";
    outcome: string;
    usage: CommissionerUsage;
    costUsd: number;
    stepCount: number;
    error?: string | null;
    rationale?: string | null;
  },
  executor: DbOrTx = db,
): Promise<void> {
  await executor
    .update(runs)
    .set({
      status: args.status,
      finishedAt: new Date(),
      outcome: args.outcome,
      rationale: args.rationale ?? null,
      totalCostUsd: args.costUsd,
      totalInputTokens: args.usage.inputTokens,
      totalOutputTokens: args.usage.outputTokens,
      stepCount: args.stepCount,
      error: args.error ?? null,
    })
    .where(eq(runs.id, args.runId));
}
