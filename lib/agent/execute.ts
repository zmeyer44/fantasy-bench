/**
 * The executor: one run = one function invocation (PRD 5.4, 6.3).
 *
 * Shape of a run:
 *   claim → load window/snapshot/config → league cap check → build tools + prompt
 *   → generateText with a bounded multi-step tool loop → per-step ledger writes
 *   → finalize → window-type fallback if the primary action never landed.
 *
 * Three things are load-bearing and easy to get wrong, so they are spelled out:
 *
 * 1. **Per-step ledger writes** happen in `onStepEnd`, awaited, so the spend is
 *    recorded before the next model call starts. A run that dies mid-loop has
 *    already paid for what it burned.
 * 2. **The pre-step budget check** lives in `prepareStep`. When the projected cost
 *    of the next step would breach the run's token budget, the team's weekly cap
 *    or the league's USD cap, we abort the shared `AbortController` with a
 *    `BudgetExceededError` *and* return `toolChoice: 'none'`. The abort is the
 *    real stop (it ends the loop immediately, exactly as PRD 5.9 asks); the
 *    `toolChoice` is a belt-and-braces fallback for a provider that has already
 *    started the call, which then produces a final text step and stops.
 * 3. **Partial commits stand** (PRD 5.4 step 5). Nothing here rolls back a tool
 *    that already committed, including on timeout or budget stop.
 */
import { generateText, stepCountIs, type ModelMessage, type StepResult, type ToolSet } from "ai";
import { and, asc, eq, isNull, or } from "drizzle-orm";

import { db, type DbOrTx } from "@/lib/db";
import {
  agentConfigs,
  configVersionSkills,
  configVersions,
  customProviders,
  leagueRules,
  runSteps,
  runs,
  skills as skillsTable,
  teams,
  windows,
  type FallbackApplied,
  type PromptSection,
} from "@/lib/db/schema";
import type { CustomProvider, RunStatus, WindowType } from "@/lib/db/types";
import { DEFAULT_HARNESS } from "@/lib/db/schema";
import type { HarnessSettings } from "@/lib/services/config";
import { getCurrentConfigVersion } from "@/lib/services/config";
import { getForum } from "@/lib/services/forum";
import {
  estimateStepCostUsd,
  getRemainingBudget,
  notifyCommissionerOfCap,
  recordUsage,
  type RemainingBudget,
} from "@/lib/services/ledger";
import { applySafetyAutopilot } from "@/lib/services/lineup";
import { getInboxForTeam, type InboxThread } from "@/lib/services/messaging";
import { loadSnapshot } from "@/lib/services/snapshot";
import type { ForumPostView } from "@/lib/services/forum";
import { emptyDigest, type SnapshotDigest, type SnapshotPayload } from "@/lib/snapshot/types";
import { modelSupportsReasoning, resolveModel } from "@/lib/agent/model";

import { buildPrompt, estimateTokens, type PromptWindow } from "./prompt";
import { buildTools, emptyRunToolState, toolsForWindow, type ToolContext } from "./tools";

/**
 * Wall-clock budget per run, by window type (PRD 6.3 defaults). `league_rules`
 * has no column for this yet; when the scheduler package adds one, read it here
 * and keep these as the fallback.
 */
export const PER_RUN_WALL_CLOCK_MS: Record<WindowType, number> = {
  lineup: 5 * 60_000,
  waiver: 5 * 60_000,
  forum: 5 * 60_000,
  trade: 8 * 60_000,
  draft: 8 * 60_000,
  commissioner: 8 * 60_000,
};

/** Conservative output-token allowance used when projecting the next step's cost. */
const PROJECTED_OUTPUT_TOKENS = 1500;

class BudgetExceededError extends Error {
  constructor(readonly reason: string) {
    super(`budget exceeded: ${reason}`);
    this.name = "BudgetExceededError";
  }
}

class WallClockTimeoutError extends Error {
  constructor(readonly limitMs: number) {
    super(`run exceeded its ${Math.round(limitMs / 1000)}s wall-clock budget`);
    this.name = "WallClockTimeoutError";
  }
}

export type ExecuteRunResult = {
  runId: string;
  status: RunStatus;
  outcome: string | null;
  modelId: string;
  stepCount: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  rationale: string | null;
  fallbackApplied: FallbackApplied | null;
  error: string | null;
  /** True when this call did the work; false when the run was already terminal. */
  executed: boolean;
};

type LoadedConfig = {
  configVersionId: string | null;
  modelId: string;
  contextMd: string;
  harness: HarnessSettings;
  skills: Array<{ name: string; bodyMd: string; description?: string }>;
  noteToAgent: string | null;
};

const TERMINAL_STATUSES: RunStatus[] = [
  "succeeded",
  "partial",
  "failed",
  "timed_out",
  "fallback",
  "skipped",
];

/**
 * Claim a pending run for execution (PRD 6.2).
 *
 * `UPDATE … WHERE id = ? AND status = 'pending'` — zero rows means another tick
 * already took it. The lease is the run's wall-clock budget plus a minute of
 * headroom so the reaper does not steal a run that is still working.
 */
export async function claimRun(
  runId: string,
  options?: { now?: Date; leaseMs?: number; executor?: DbOrTx },
): Promise<{ claimed: boolean; leaseExpiresAt: Date | null }> {
  const executor = options?.executor ?? db;
  const now = options?.now ?? new Date();
  const [row] = await executor
    .select({ type: windows.type })
    .from(runs)
    .innerJoin(windows, eq(runs.windowId, windows.id))
    .where(eq(runs.id, runId))
    .limit(1);
  const leaseMs = options?.leaseMs ?? (PER_RUN_WALL_CLOCK_MS[row?.type ?? "lineup"] + 60_000);
  const leaseExpiresAt = new Date(now.getTime() + leaseMs);

  const claimed = await executor
    .update(runs)
    .set({ status: "running", claimedAt: now, leaseExpiresAt, startedAt: now })
    .where(and(eq(runs.id, runId), eq(runs.status, "pending")))
    .returning({ id: runs.id });

  return { claimed: claimed.length > 0, leaseExpiresAt: claimed.length > 0 ? leaseExpiresAt : null };
}

async function loadConfig(
  args: { teamId: string | null; configVersionId: string | null; fallbackModelId: string },
  executor: DbOrTx,
): Promise<LoadedConfig> {
  const noteToAgent = args.teamId
    ? ((
        await executor
          .select({ note: agentConfigs.noteToAgent })
          .from(agentConfigs)
          .where(eq(agentConfigs.teamId, args.teamId))
          .limit(1)
      )[0]?.note ?? null)
    : null;

  if (args.configVersionId) {
    const [version] = await executor
      .select()
      .from(configVersions)
      .where(eq(configVersions.id, args.configVersionId))
      .limit(1);
    if (version) {
      const attached = await executor
        .select({
          name: skillsTable.name,
          bodyMd: skillsTable.bodyMd,
          description: skillsTable.description,
        })
        .from(configVersionSkills)
        .innerJoin(skillsTable, eq(configVersionSkills.skillId, skillsTable.id))
        .where(eq(configVersionSkills.configVersionId, version.id))
        .orderBy(asc(configVersionSkills.position));
      return {
        configVersionId: version.id,
        modelId: version.modelId,
        contextMd: version.contextMd,
        harness: { ...DEFAULT_HARNESS, ...version.harness },
        skills: attached,
        noteToAgent,
      };
    }
  }

  if (args.teamId) {
    const current = await getCurrentConfigVersion(args.teamId, executor).catch(() => null);
    if (current) {
      return {
        configVersionId: current.id,
        modelId: current.modelId,
        contextMd: current.contextMd,
        harness: { ...DEFAULT_HARNESS, ...current.harness },
        skills: current.skills.map((s) => ({
          name: s.name,
          bodyMd: s.bodyMd,
          description: s.description,
        })),
        noteToAgent,
      };
    }
  }

  return {
    configVersionId: args.configVersionId,
    modelId: args.fallbackModelId,
    contextMd: "",
    harness: { ...DEFAULT_HARNESS },
    skills: [],
    noteToAgent,
  };
}

/**
 * Gateway cost, when the provider metadata carries one.
 *
 * `GatewayProviderMetadata` is deliberately open (`[key: string]: JSONValue`) so
 * the service can add fields without an SDK release, which means the cost field
 * is not statically typed. Read it defensively across the spellings the gateway
 * has used and ignore anything that is not a finite number.
 */
export function readGatewayCostUsd(providerMetadata: unknown): number | null {
  if (!providerMetadata || typeof providerMetadata !== "object") return null;
  const gateway = (providerMetadata as Record<string, unknown>).gateway;
  if (!gateway || typeof gateway !== "object") return null;
  const bag = gateway as Record<string, unknown>;
  for (const key of ["cost", "costUSD", "cost_usd", "totalCost", "total_cost_usd", "usageCost"]) {
    const value = bag[key];
    const num = typeof value === "string" ? Number(value) : value;
    if (typeof num === "number" && Number.isFinite(num)) return num;
  }
  return null;
}

async function finalize(
  args: {
    runId: string;
    status: RunStatus;
    outcome: string | null;
    modelId: string;
    stepCount: number;
    totalCostUsd: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    fallbackApplied: FallbackApplied | null;
    error: string | null;
    messages: ModelMessage[] | null;
    now: Date;
  },
  executor: DbOrTx,
): Promise<void> {
  await executor
    .update(runs)
    .set({
      status: args.status,
      outcome: args.outcome,
      modelId: args.modelId,
      stepCount: args.stepCount,
      totalCostUsd: Math.round(args.totalCostUsd * 1e8) / 1e8,
      totalInputTokens: args.totalInputTokens,
      totalOutputTokens: args.totalOutputTokens,
      fallbackApplied: args.fallbackApplied,
      error: args.error,
      finishedAt: args.now,
      ...(args.messages ? { messages: args.messages as unknown[] } : {}),
    })
    .where(eq(runs.id, args.runId));
}

/**
 * Execute one run to completion.
 *
 * Safe to call twice for the same run: a terminal run returns its stored summary
 * without re-running, and every write tool is idempotent on `(runId, toolCallId)`.
 */
export async function executeRun(
  runId: string,
  options?: { now?: Date; executor?: DbOrTx },
): Promise<ExecuteRunResult> {
  const executor = options?.executor ?? db;
  const startedAt = options?.now ?? new Date();
  // The clock the tools and prompt see. Fixed for the run so a replay lines up.
  const now = () => options?.now ?? new Date();

  const [loaded] = await executor
    .select({ run: runs, window: windows })
    .from(runs)
    .innerJoin(windows, eq(runs.windowId, windows.id))
    .where(eq(runs.id, runId))
    .limit(1);
  if (!loaded) throw new Error(`executeRun: run ${runId} not found`);
  const { run, window } = loaded;

  const summary = (over: Partial<ExecuteRunResult> = {}): ExecuteRunResult => ({
    runId,
    status: run.status,
    outcome: run.outcome,
    modelId: run.modelId,
    stepCount: run.stepCount,
    totalCostUsd: run.totalCostUsd,
    totalInputTokens: run.totalInputTokens,
    totalOutputTokens: run.totalOutputTokens,
    rationale: run.rationale,
    fallbackApplied: run.fallbackApplied,
    error: run.error,
    executed: false,
    ...over,
  });

  if (TERMINAL_STATUSES.includes(run.status)) return summary();

  // Commissioner runs belong to the social package's commissioner agent, which
  // calls resolveModel directly. Skip cleanly rather than throwing.
  if (run.kind === "commissioner") {
    const outcome = "skipped_commissioner_run";
    await finalize(
      {
        runId,
        status: "skipped",
        outcome,
        modelId: run.modelId,
        stepCount: 0,
        totalCostUsd: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        fallbackApplied: null,
        error: null,
        messages: null,
        now: startedAt,
      },
      executor,
    );
    return summary({ status: "skipped", outcome, executed: true });
  }

  const [rules] = await executor
    .select()
    .from(leagueRules)
    .where(eq(leagueRules.leagueId, run.leagueId))
    .limit(1);

  const fail = async (status: RunStatus, error: string, fallback: FallbackApplied | null = null) => {
    await finalize(
      {
        runId,
        status,
        outcome: status,
        modelId: run.modelId,
        stepCount: 0,
        totalCostUsd: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        fallbackApplied: fallback,
        error,
        messages: null,
        now: new Date(),
      },
      executor,
    );
    return summary({ status, outcome: status, error, fallbackApplied: fallback, executed: true });
  };

  if (!window.snapshotId) {
    return fail("failed", "window has no snapshot; nothing to read from");
  }

  let snapshot: SnapshotPayload;
  let digest: SnapshotDigest;
  try {
    const stored = await loadSnapshot(window.snapshotId, executor);
    snapshot = stored.payload;
    digest = stored.digest ?? emptyDigest();
  } catch (error) {
    return fail("failed", `could not load snapshot: ${error instanceof Error ? error.message : String(error)}`);
  }

  const weekNo = window.weekNo ?? snapshot.weekNo ?? 0;
  const teamId = run.teamId;
  const teamName = teamId
    ? ((await executor.select({ name: teams.name }).from(teams).where(eq(teams.id, teamId)).limit(1))[0]
        ?.name ?? "Unknown team")
    : "Commissioner";

  const config = await loadConfig(
    { teamId, configVersionId: run.configVersionId, fallbackModelId: run.modelId },
    executor,
  );
  const harness = config.harness;
  const maxSteps = Math.max(1, Math.min(harness.maxSteps, rules?.maxStepsCap ?? 30));
  const primaryModelId = config.modelId || run.modelId;

  const budget: RemainingBudget = await getRemainingBudget(
    { leagueId: run.leagueId, teamId, weekNo },
    executor,
  );

  const providers: CustomProvider[] = await executor
    .select()
    .from(customProviders)
    .where(
      and(
        eq(customProviders.enabled, true),
        or(isNull(customProviders.leagueId), eq(customProviders.leagueId, run.leagueId)),
        teamId
          ? or(isNull(customProviders.teamId), eq(customProviders.teamId, teamId))
          : isNull(customProviders.teamId),
      ),
    );

  const state = emptyRunToolState();
  let currentStep = 0;
  const ctx: ToolContext = {
    runId,
    leagueId: run.leagueId,
    teamId,
    teamName,
    configVersionId: config.configVersionId,
    windowId: window.id,
    windowType: window.type,
    windowLabel: window.label,
    windowScope: window.scope,
    weekNo,
    snapshot,
    digest,
    submissionDeadlineAt: window.submissionDeadlineAt,
    closesAt: window.closesAt,
    now,
    currentStepIndex: () => currentStep,
    budget,
    customProviders: providers,
    executor,
    state,
  };

  /** Fallback for a run that never produced its primary action. */
  const applyWindowFallback = async (
    kind: FallbackApplied["kind"],
    detail: string,
  ): Promise<FallbackApplied | null> => {
    if (window.type !== "lineup") return { kind, detail };
    if (rules && rules.safetyAutopilot === false) return { kind, detail };
    try {
      const result = await applySafetyAutopilot(
        { snapshot, teamId: teamId!, weekNo, runId, now: now() },
        executor,
      );
      return {
        kind: kind === "budget_exhausted" ? kind : "safety_autopilot",
        detail: result.changed
          ? `${detail}; safety autopilot filled ${result.filledSlots.length || "0"} slot(s): ${result.filledSlots.join(", ") || "none"}`
          : `${detail}; safety autopilot found nothing to fill`,
      };
    } catch (error) {
      return {
        kind,
        detail: `${detail}; safety autopilot failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };

  // --- league USD hard cap: stop before we spend a cent -----------------------
  if (budget.leagueCapReached) {
    const fallback = await applyWindowFallback(
      "budget_exhausted",
      `league USD hard cap reached ($${budget.leagueUsdUsed.toFixed(4)} of $${(budget.leagueUsdCap ?? 0).toFixed(2)})`,
    );
    await notifyCommissionerOfCap(run.leagueId, weekNo, executor).catch(() => ({ notified: false }));
    await finalize(
      {
        runId,
        status: "fallback",
        outcome: "budget_exhausted",
        modelId: primaryModelId,
        stepCount: 0,
        totalCostUsd: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        fallbackApplied: fallback,
        error: "league USD hard cap reached",
        messages: null,
        now: new Date(),
      },
      executor,
    );
    return summary({
      status: "fallback",
      outcome: "budget_exhausted",
      modelId: primaryModelId,
      fallbackApplied: fallback,
      error: "league USD hard cap reached",
      executed: true,
    });
  }

  // --- tools + prompt ---------------------------------------------------------
  const tools: ToolSet = buildTools(ctx);
  const toolNames = Object.keys(tools);

  const [inbox, forum] = await Promise.all([
    teamId && toolNames.includes("get_inbox")
      ? getInboxForTeam({ leagueId: run.leagueId, teamId, limit: 10 }).catch((): InboxThread[] => [])
      : Promise.resolve<InboxThread[]>([]),
    getForum({ leagueId: run.leagueId, sort: "new", limit: 5 }).catch(() => ({
      posts: [] as ForumPostView[],
      karma: {} as Record<string, number>,
    })),
  ]);

  const promptWindow: PromptWindow = {
    id: window.id,
    type: window.type,
    label: window.label,
    weekNo,
    roundNo: window.roundNo,
    scope: window.scope,
    opensAt: window.opensAt,
    submissionDeadlineAt: window.submissionDeadlineAt,
    closesAt: window.closesAt,
  };
  const prompt = buildPrompt({
    window: promptWindow,
    snapshot,
    digest,
    teamId,
    teamName,
    contextMd: config.contextMd,
    skills: config.skills,
    noteToAgent: config.noteToAgent,
    harness,
    toolNames,
    budget,
    inbox,
    forum,
  });

  await executor
    .update(runs)
    .set({
      status: "running",
      startedAt: run.startedAt ?? startedAt,
      claimedAt: run.claimedAt ?? startedAt,
      modelId: primaryModelId,
      configVersionId: config.configVersionId,
      promptSections: prompt.sections as PromptSection[],
    })
    .where(eq(runs.id, runId));

  // --- the model loop ---------------------------------------------------------
  const wallClockMs = PER_RUN_WALL_CLOCK_MS[window.type];
  let totalCostUsd = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let stepCount = 0;
  let budgetStopReason: string | null = null;
  let fallbackApplied: FallbackApplied | null = null;

  const initialMessages: ModelMessage[] = [{ role: "user", content: prompt.user }];

  /** Per-step persistence + ledger write. `offset` shifts indices past the plan step. */
  function makeOnStepEnd(modelId: string, offset: () => number) {
    return async (step: StepResult<ToolSet>) => {
      const stepIndex = step.stepNumber + offset();
      const usage = step.usage;
      const inputTokens = usage.inputTokens ?? 0;
      const outputTokens = usage.outputTokens ?? 0;
      const cachedInputTokens = usage.inputTokenDetails?.cacheReadTokens ?? 0;
      const reasoningTokens = usage.outputTokenDetails?.reasoningTokens ?? 0;
      const latencyMs = Math.round(step.performance?.stepTimeMs ?? 0);
      const gatewayCostUsd = readGatewayCostUsd(step.providerMetadata);

      const { costUsd } = await recordUsage(
        {
          runId,
          stepIndex,
          teamId,
          leagueId: run.leagueId,
          modelId,
          inputTokens,
          outputTokens,
          cachedInputTokens,
          reasoningTokens,
          latencyMs,
          gatewayCostUsd,
          weekNo,
        },
        executor,
      );

      await executor
        .insert(runSteps)
        .values({
          runId,
          stepIndex,
          modelId,
          text: step.text || null,
          reasoning: step.reasoningText ?? null,
          messages: (step.response?.messages ?? []) as unknown[],
          toolCalls: step.toolCalls as unknown[],
          toolResults: step.toolResults as unknown[],
          usage: {
            inputTokens,
            outputTokens,
            cachedInputTokens,
            reasoningTokens,
            totalTokens: inputTokens + outputTokens,
          },
          finishReason: step.finishReason,
          latencyMs,
          costUsd,
        })
        .onConflictDoNothing();

      totalCostUsd += costUsd;
      totalInputTokens += inputTokens;
      totalOutputTokens += outputTokens;
      stepCount = Math.max(stepCount, stepIndex + 1);
      currentStep = stepIndex + 1;
    };
  }

  /**
   * The pre-step budget check (PRD 5.9).
   *
   * Projects the next step from the last step's usage and stops the run when it
   * would breach the run's token budget, the team's weekly cap or the league's
   * USD cap. The abort is the real stop; `toolChoice: 'none'` is the backstop for
   * a provider call that is already in flight.
   */
  function makePrepareStep(modelId: string, controller: AbortController) {
    return async ({ steps }: { steps: Array<StepResult<ToolSet>> }) => {
      const last = steps.at(-1);
      const projectedInput = last
        ? (last.usage.inputTokens ?? 0) + (last.usage.outputTokens ?? 0) + 500
        : estimateTokens(prompt.system) + estimateTokens(prompt.user);
      const projectedTokens = projectedInput + PROJECTED_OUTPUT_TOKENS;
      const projectedCost = await estimateStepCostUsd(modelId, projectedInput, PROJECTED_OUTPUT_TOKENS);
      const usedTokens = totalInputTokens + totalOutputTokens;

      let reason: string | null = null;
      if (usedTokens + projectedTokens > harness.tokenBudget) {
        reason = `next step (~${projectedTokens} tokens) would exceed this run's token budget (${harness.tokenBudget})`;
      } else if (
        budget.teamTokensRemaining != null &&
        usedTokens + projectedTokens > budget.teamTokensRemaining
      ) {
        reason = `next step (~${projectedTokens} tokens) would exceed your team's weekly token cap`;
      } else if (
        budget.leagueUsdRemaining != null &&
        totalCostUsd + projectedCost > budget.leagueUsdRemaining
      ) {
        reason = `next step (~$${projectedCost.toFixed(4)}) would exceed the league's USD hard cap`;
      }

      if (reason) {
        budgetStopReason = reason;
        controller.abort(new BudgetExceededError(reason));
        return { toolChoice: "none" as const };
      }
      return {};
    };
  }

  const DELIBERATE_INSTRUCTION =
    "\n\nDELIBERATE MODE: for this first step only, write a short plan — what you will check, " +
    "what you will decide, and which tool calls you expect to make. Do not call any tool yet; " +
    "you will get your tools back on the next step.";

  async function runModel(modelId: string): Promise<{
    messages: ModelMessage[];
    text: string;
  }> {
    const controller = new AbortController();
    const timeout = new WallClockTimeoutError(wallClockMs);
    const timer = setTimeout(() => controller.abort(timeout), wallClockMs);
    // Step indices continue from whatever was already recorded, so a fallback-model
    // re-run after a primary failure does not collide with (and silently lose) the
    // steps the primary model already wrote under the `(run_id, step_index)` key.
    const baseOffset = stepCount;
    let stepOffset = baseOffset;

    const shared = {
      model: resolveModel(modelId),
      tools,
      temperature: harness.temperature,
      maxRetries: 3,
      abortSignal: controller.signal,
      ...(harness.reasoningEffort && modelSupportsReasoning(modelId)
        ? { reasoning: harness.reasoningEffort }
        : {}),
      onStepEnd: makeOnStepEnd(modelId, () => stepOffset),
    };

    try {
      let messages = initialMessages;
      const planMessages: ModelMessage[] = [];

      // Deliberate mode is a separate call, not a `prepareStep` override: the tool
      // loop stops as soon as a step produces no tool calls, so a plan step inside
      // the main loop would end the run before the agent ever acted.
      if (harness.deliberateMode && maxSteps > 1) {
        const plan = await generateText({
          ...shared,
          instructions: prompt.system + DELIBERATE_INSTRUCTION,
          messages,
          toolChoice: "none",
          stopWhen: stepCountIs(1),
        });
        planMessages.push(...(plan.responseMessages as ModelMessage[]));
        messages = [...messages, ...planMessages];
        stepOffset = baseOffset + 1;
      }

      const result = await generateText({
        ...shared,
        instructions: prompt.system,
        messages,
        stopWhen: stepCountIs(Math.max(1, maxSteps - (stepOffset - baseOffset))),
        prepareStep: makePrepareStep(modelId, controller),
      });

      return {
        messages: [
          { role: "system", content: prompt.system },
          ...initialMessages,
          ...planMessages,
          ...(result.responseMessages as ModelMessage[]),
        ],
        text: result.text,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  const isBudgetStop = (error: unknown) =>
    error instanceof BudgetExceededError ||
    budgetStopReason != null ||
    (error instanceof Error && /BudgetExceededError|budget exceeded/i.test(String(error.cause ?? "")));

  const isWallClockStop = (error: unknown) =>
    error instanceof WallClockTimeoutError ||
    (error instanceof Error &&
      (error.cause instanceof WallClockTimeoutError ||
        /wall-clock/i.test(String(error.cause ?? "")) ||
        error.name === "AbortError" ||
        error.name === "TimeoutError"));

  let finalMessages: ModelMessage[] | null = null;
  let modelId = primaryModelId;
  let terminalStatus: RunStatus | null = null;
  let terminalError: string | null = null;

  try {
    const result = await runModel(modelId);
    finalMessages = result.messages;
    if (budgetStopReason) {
      // The pre-step check aborted, but the provider had already returned and the
      // loop wound down through `toolChoice: 'none'` instead of throwing. Same
      // outcome either way: the run stopped on budget and the fallback applies.
      terminalStatus = "fallback";
      terminalError = budgetStopReason;
      fallbackApplied = await applyWindowFallback("budget_exhausted", budgetStopReason);
    }
  } catch (firstError) {
    if (isBudgetStop(firstError)) {
      terminalStatus = "fallback";
      terminalError = budgetStopReason ?? "budget exceeded";
      fallbackApplied = await applyWindowFallback("budget_exhausted", terminalError);
    } else if (isWallClockStop(firstError)) {
      terminalStatus = "timed_out";
      terminalError =
        firstError instanceof Error ? firstError.message : `run exceeded ${wallClockMs}ms`;
      fallbackApplied = await applyWindowFallback("safety_autopilot", "run timed out");
    } else {
      // Provider failure after `maxRetries` retries: try the commissioner's
      // designated fallback model once, disclosed in the trace (PRD 5.4).
      const message = firstError instanceof Error ? firstError.message : String(firstError);
      const fallbackModelId = rules?.fallbackModelId;
      if (fallbackModelId && fallbackModelId !== modelId) {
        try {
          const fromModelId = modelId;
          modelId = fallbackModelId;
          const result = await runModel(modelId);
          finalMessages = result.messages;
          fallbackApplied = {
            kind: "fallback_model",
            detail: `primary model failed (${message})`,
            fromModelId,
            toModelId: fallbackModelId,
          };
        } catch (secondError) {
          const secondMessage =
            secondError instanceof Error ? secondError.message : String(secondError);
          if (isBudgetStop(secondError)) {
            terminalStatus = "fallback";
            terminalError = budgetStopReason ?? "budget exceeded";
            fallbackApplied = await applyWindowFallback("budget_exhausted", terminalError);
          } else if (isWallClockStop(secondError)) {
            terminalStatus = "timed_out";
            terminalError = secondMessage;
            fallbackApplied = await applyWindowFallback("safety_autopilot", "run timed out");
          } else {
            terminalStatus = "failed";
            terminalError = `primary model failed (${message}); fallback model failed (${secondMessage})`;
            fallbackApplied = await applyWindowFallback("safety_autopilot", "provider failure");
          }
        }
      } else {
        terminalStatus = "failed";
        terminalError = message;
        fallbackApplied = await applyWindowFallback("safety_autopilot", "provider failure");
      }
    }
  }

  // --- outcome ----------------------------------------------------------------
  const primaryDone = (() => {
    switch (window.type) {
      case "lineup":
        return state.lineupCommitted;
      case "waiver":
        return state.waiverClaims > 0 || state.drops > 0;
      case "trade":
        return state.tradesProposed + state.tradeResponses + state.messagesSent > 0;
      case "draft":
        return state.draftActions > 0;
      default:
        return true;
    }
  })();

  let status: RunStatus;
  let outcome: string;
  if (terminalStatus) {
    status = terminalStatus;
    outcome = budgetStopReason ? "budget_exhausted" : terminalStatus;
  } else if (window.type === "lineup" && !state.lineupCommitted) {
    // A lineup window that produced no lineup is a partial run whatever the model
    // said; the autopilot backstops it (PRD 5.4 fallbacks).
    status = "partial";
    outcome = "no_lineup_set";
    fallbackApplied = await applyWindowFallback("safety_autopilot", "agent set no lineup");
  } else if (!primaryDone && state.rejected > 0) {
    status = "partial";
    outcome = "all_actions_rejected";
  } else {
    status = "succeeded";
    outcome = describeOutcome(window.type, state);
  }

  await finalize(
    {
      runId,
      status,
      outcome,
      modelId,
      stepCount,
      totalCostUsd,
      totalInputTokens,
      totalOutputTokens,
      fallbackApplied,
      error: terminalError,
      messages: finalMessages,
      now: new Date(),
    },
    executor,
  );

  return {
    runId,
    status,
    outcome,
    modelId,
    stepCount,
    totalCostUsd: Math.round(totalCostUsd * 1e8) / 1e8,
    totalInputTokens,
    totalOutputTokens,
    rationale: state.rationale,
    fallbackApplied,
    error: terminalError,
    executed: true,
  };
}

function describeOutcome(windowType: WindowType, state: ReturnType<typeof emptyRunToolState>): string {
  const parts: string[] = [];
  if (state.lineupCommitted) parts.push("lineup_set");
  if (state.waiverClaims > 0) parts.push(`${state.waiverClaims}_claims_submitted`);
  if (state.drops > 0) parts.push(`${state.drops}_dropped`);
  if (state.tradesProposed > 0) parts.push(`${state.tradesProposed}_trades_proposed`);
  if (state.tradeResponses > 0) parts.push(`${state.tradeResponses}_trades_answered`);
  if (state.messagesSent > 0) parts.push(`${state.messagesSent}_messages_sent`);
  if (state.draftActions > 0) parts.push("draft_action_recorded");
  if (state.forumPosts > 0) parts.push(`${state.forumPosts}_posts`);
  if (state.forumComments > 0) parts.push(`${state.forumComments}_comments`);
  if (parts.length === 0) parts.push(`${windowType}_no_action`);
  return parts.join("+");
}

export { toolsForWindow };
