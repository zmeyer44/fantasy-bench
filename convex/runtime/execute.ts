/**
 * The executor (PRD 5.4, 6.3) — the agent loop as a Convex
 * action on the Workpool.
 *
 * ## Runtime: the DEFAULT Convex runtime, not `"use node"`.
 *
 * The migration plan expected `"use node"` here, because the documented API list
 * for the default (V8 isolate) runtime says `setTimeout` is unavailable and the
 * executor needs a timer for the wall-clock abort, for the custom-provider fetch
 * timeout and for the AI SDK's `maxRetries` backoff. That is out of date. A probe
 * action (`convex/runtime/probe.ts`, removed after the check) on the dev
 * deployment reported, in the default runtime:
 *
 *     setTimeout: "function"     clearTimeout: "function"   setInterval: "function"
 *     AbortController: "function"  process: "object"        Buffer: "undefined"
 *     a 60 ms timer fired after 61 ms;
 *     an AbortController wired to a timer aborted an in-flight `generateText`;
 *     a two-step `generateText` tool loop ran to completion (1 tool call).
 *
 * So this file stays in the default runtime, which buys a 30-minute action limit
 * (vs 10 under Node), no cold starts, and low-latency `ctx.runQuery` /
 * `ctx.runMutation`. `typeof setTimeout` is logged at the start of every run so a
 * regression shows up in the logs rather than as a hung run. If it ever does
 * regress, adding `"use node"` as the first line of this file is the whole fix:
 * nothing imports this module (the scheduler reaches it only through
 * `internal.runtime.execute.executeRun`) and it declares no queries or mutations.
 *
 * ## Shape of a run
 *
 *   load context → resume from `runs.lastPersistedStep` → markRunning →
 *   build tools + prompt → `generateText` with a bounded multi-step tool loop →
 *   per-step `runs.persistStep` (which records the ledger in-transaction) → return a summary.
 *
 * Four things are load-bearing and easy to get wrong, so they are spelled out:
 *
 * 1. **The action never writes a terminal status.** It returns a summary and
 *    `internal.runs.onComplete` — the Workpool completion mutation, which runs in
 *    its own transaction — turns it into `succeeded` / `partial` / `fallback` /
 *    `timed_out`, or into `failed` when this action threw. Infrastructure
 *    failures therefore *throw*, so the pool retries them; agent-level outcomes
 *    are returned.
 * 2. **Per-step ledger + step writes are awaited** in `onStepEnd`, before the
 *    next model call starts, so a run that dies mid-loop has already paid for
 *    what it burned and can resume from where it stopped.
 * 3. **The pre-step budget check** lives in `prepareStep`. When the projected
 *    cost of the next step would breach the run's token budget, the team's
 *    weekly cap or the league's USD cap, we abort the shared `AbortController`
 *    with a `BudgetExceededError` *and* return `toolChoice: 'none'`. The abort is
 *    the real stop; the `toolChoice` is a belt-and-braces fallback for a provider
 *    that has already started the call.
 * 4. **Partial commits stand** (PRD 5.4 step 5). Nothing here rolls back a tool
 *    that already committed, including on timeout, budget stop or retry. A
 *    retried attempt replays the persisted steps into the prompt and serves any
 *    duplicate tool call from `run_actions`.
 */
import { NonRetryableError } from "@convex-dev/workpool";
import {
  generateText,
  stepCountIs,
  type ModelMessage,
  type StepResult,
  type ToolSet,
} from "ai";
import { v } from "convex/values";

import { emptyDigest, type SnapshotPayload } from "../../lib/snapshot/types";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction, type ActionCtx } from "../_generated/server";
import { DEFAULT_HARNESS } from "../lib/defaults";
import { countEmptyStarterWarnings } from "../lib/lineup_pure";
import { estimateNextStepCostUsd, type ResolvedModelPrice } from "../lib/pricing_pure";

import { decryptSecret } from "../lib/secrets";
import { modelSupportsReasoning, readGatewayCostUsd, resolveModel } from "./model";
import { modelSupportsTemperature } from "../../lib/models";
import { buildPrompt, estimateTokens, type PromptWindow } from "./prompt";
import { buildTools, guidanceByTool, type ToolOverride } from "./tools";
import {
  emptyRunToolState,
  type ExecuteRunSummary,
  type FallbackApplied,
  type HarnessSettings,
  type PromptSection,
  type RemainingBudget,
  type RunToolState,
  type ToolContext,
  type WindowType,
} from "./types";

/**
 * Wall-clock budget per run, by window type (PRD 6.3 defaults). Only used when
 * `league_rules.runWallclockSeconds` is missing; the rule wins when it is set,
 * and an explicit `wallClockMs` argument (tests, and any per-window override the
 * scheduler package adds) wins over both.
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
/** Hard ceiling on `harness.maxSteps` when the league sets no cap. */
const DEFAULT_MAX_STEPS_CAP = 30;

class BudgetExceededError extends Error {
  constructor(readonly reason: string) {
    super(`budget exceeded: ${reason}`);
    this.name = "BudgetExceededError";
  }
}

/**
 * Thrown (via the abort signal) when a step could not be persisted after
 * retries. The AI SDK swallows errors thrown from `onStepEnd` and keeps looping,
 * so a failed `persistStep` would otherwise silently lose the step, its usage
 * event and its tool commits from the trace. Aborting the run and rethrowing
 * turns it into a Workpool retry, which resumes from `lastPersistedStep`.
 */
class PersistFailedError extends Error {
  constructor(readonly stepIndex: number, cause: unknown) {
    super(`could not persist step ${stepIndex}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "PersistFailedError";
  }
}

const PERSIST_ATTEMPTS = 5;
const PERSIST_BACKOFF_MS = 250;

class WallClockTimeoutError extends Error {
  constructor(readonly limitMs: number) {
    super(`run exceeded its ${Math.round(limitMs / 1000)}s wall-clock budget`);
    this.name = "WallClockTimeoutError";
  }
}

type LoadedConfig = {
  configVersionId: Id<"config_versions"> | null;
  modelId: string;
  contextMd: string;
  harness: HarnessSettings;
  skills: Array<{ name: string; bodyMd: string; description?: string }>;
  toolOverrides: ToolOverride[];
};

/** Rebuild the in-memory tool state from what earlier attempts already committed. */
function seedState(
  priorActions: Array<{ actionType: string; committed: boolean; lineupWarnings: string[] }>,
  rationale: string | null,
): RunToolState {
  const state = emptyRunToolState();
  state.rationale = rationale;
  for (const action of priorActions) {
    if (!action.committed) {
      state.rejected += 1;
      continue;
    }
    state.committed += 1;
    switch (action.actionType) {
      case "set_lineup":
        state.lineupCommitted = true;
        state.lineupEmptyStarters = countEmptyStarterWarnings(action.lineupWarnings);
        break;
      case "submit_waiver_claims":
        state.waiverClaims += 1;
        break;
      case "drop_player":
        state.drops += 1;
        break;
      case "propose_trade":
        state.tradesProposed += 1;
        break;
      case "respond_to_trade":
        state.tradeResponses += 1;
        break;
      case "send_message":
        state.messagesSent += 1;
        break;
      case "post_to_forum":
        state.forumPosts += 1;
        break;
      case "comment_on_forum":
        state.forumComments += 1;
        break;
      case "vote_on_forum":
        state.forumVotes += 1;
        break;
      case "make_draft_pick":
      case "submit_bid":
      case "nominate_player":
        state.draftActions += 1;
        break;
      default:
        break;
    }
  }
  return state;
}

function describeOutcome(windowType: WindowType, state: RunToolState): string {
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

/** `responseMessages` of the already-committed steps, flattened in step order. */
async function resumeMessages(
  ctx: ActionCtx,
  runId: Id<"runs">,
  upToStepIndex: number,
): Promise<ModelMessage[]> {
  if (upToStepIndex < 0) return [];
  const rows = await ctx.runQuery(internal.runtime.load.persistedMessages, {
    runId,
    upToStepIndex,
  });
  const out: ModelMessage[] = [];
  for (const row of rows) {
    if (Array.isArray(row.responseMessages)) out.push(...(row.responseMessages as ModelMessage[]));
  }
  return out;
}

const DELIBERATE_INSTRUCTION =
  "\n\nDELIBERATE MODE: for this first step only, write a short plan — what you will check, " +
  "what you will decide, and which tool calls you expect to make. Do not call any tool yet; " +
  "you will get your tools back on the next step.";

export const executeRun = internalAction({
  args: {
    runId: v.id("runs"),
    /** Override the wall clock (tests, and any per-window scheduler override). */
    wallClockMs: v.optional(v.number()),
    /** Fixed clock for replays and tests. */
    now: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<ExecuteRunSummary> => {
    const { runId } = args;
    // Runtime probe, logged once per run: see this file's header. If this ever
    // prints "undefined", the wall-clock abort is dead and this file needs
    // `"use node"`.
    console.log(
      `[runtime.execute] run=${runId} setTimeout=${typeof setTimeout} AbortController=${typeof AbortController}`,
    );

    const nowFn = () => (args.now !== undefined ? new Date(args.now) : new Date());

    const loaded = await ctx.runQuery(internal.runtime.load.runContext, { runId });
    if (!loaded) throw new NonRetryableError(`executeRun: run ${runId} not found`);
    const { run, window, rules, teamName, snapshot, digest, customProviders } = loaded;

    const summaryOf = (over: Partial<ExecuteRunSummary>): ExecuteRunSummary => ({
      runId,
      status: "succeeded",
      outcome: run.outcome ?? null,
      error: run.error ?? null,
      modelId: run.modelId,
      stepCount: run.stepCount,
      totalCostUsd: run.totalCostUsd,
      totalInputTokens: run.totalInputTokens,
      totalOutputTokens: run.totalOutputTokens,
      rationale: run.rationale ?? null,
      fallbackApplied: run.fallbackApplied ?? null,
      executed: true,
      ...over,
    });

    // Idempotent: a terminal run replays its own summary and does no work. This
    // is what makes a duplicate Workpool delivery harmless.
    const terminal = new Set(["succeeded", "partial", "failed", "timed_out", "fallback", "skipped"]);
    if (terminal.has(run.status)) {
      return summaryOf({
        status: run.status === "failed" ? "partial" : (run.status as ExecuteRunSummary["status"]),
        executed: false,
      });
    }

    // Commissioner runs belong to `convex/commissioner_agent.ts`, which resolves
    // its own model. Skip cleanly rather than throwing.
    if (run.kind === "commissioner") {
      return summaryOf({ status: "skipped", outcome: "skipped_commissioner_run", stepCount: 0 });
    }

    if (!window.snapshotId || !snapshot) {
      // Nothing to read from: fail fast so `onComplete` marks the run failed and
      // schedules the safety autopilot, rather than burning three retries.
      throw new NonRetryableError(
        `executeRun: window ${window._id} has no ready snapshot; nothing to read from`,
      );
    }

    const weekNo = window.weekNo ?? snapshot.weekNo ?? 0;
    const teamId = run.teamId ?? null;

    // --- config ---------------------------------------------------------------
    let config: LoadedConfig = {
      configVersionId: null,
      modelId: run.modelId,
      contextMd: "",
      harness: { ...DEFAULT_HARNESS },
      skills: [],
      toolOverrides: [],
    };
    if (loaded.pinnedConfig) {
      config = {
        configVersionId: loaded.pinnedConfig.configVersionId,
        modelId: loaded.pinnedConfig.modelId,
        contextMd: loaded.pinnedConfig.contextMd,
        harness: { ...DEFAULT_HARNESS, ...loaded.pinnedConfig.harness },
        skills: loaded.pinnedConfig.skills,
        toolOverrides: loaded.pinnedConfig.toolOverrides ?? [],
      };
    } else if (teamId) {
      const current = await ctx.runQuery(internal.configs.currentForTeam, { teamId });
      if (current) {
        config = {
          configVersionId: current._id,
          modelId: current.modelId,
          contextMd: current.contextMd,
          harness: { ...DEFAULT_HARNESS, ...current.harness },
          skills: current.skills.map((s) => ({
            name: s.name,
            bodyMd: s.bodyMd,
            ...(s.description ? { description: s.description } : {}),
          })),
          toolOverrides: current.toolOverrides ?? [],
        };
      }
    }
    const harness = config.harness;
    const maxSteps = Math.max(
      1,
      Math.min(harness.maxSteps, rules?.maxStepsCap ?? DEFAULT_MAX_STEPS_CAP),
    );
    // A fallback-model run overrides its config version's model: `onComplete`
    // created it precisely because that model failed. Everything else about the
    // config (context, skills, harness) still applies.
    const primaryModelId =
      run.fallbackOfRunId != null || run.fallbackApplied?.kind === "fallback_model"
        ? run.modelId
        : config.modelId || run.modelId;

    // --- budget ---------------------------------------------------------------
    const budget: RemainingBudget = await ctx.runQuery(internal.ledger.remainingBudget, {
      leagueId: run.leagueId,
      ...(teamId ? { teamId } : {}),
      weekNo,
    });
    const price: ResolvedModelPrice = await ctx.runQuery(internal.runtime.load.modelPrice, {
      modelId: primaryModelId,
      at: nowFn().getTime(),
    });

    // --- bring-your-own-key ---------------------------------------------------
    // A team running on its owner's own gateway key bypasses every spend cap;
    // the ledger meters it all the same. A key that fails to decrypt falls back
    // to the league key *with* caps rather than silently spending the league's money uncapped.
    let ownApiKey: string | null = null;
    if (loaded.teamKey) {
      try {
        ownApiKey = await decryptSecret({ ciphertext: loaded.teamKey.ciphertext, iv: loaded.teamKey.iv });
      } catch (error) {
        await ctx
          .runMutation(internal.gateway_keys.markUsed, {
            keyId: loaded.teamKey.id,
            error: `could not decrypt key: ${error instanceof Error ? error.message : String(error)}`,
          })
          .catch(() => null);
      }
    }
    const bypassCaps = ownApiKey !== null;
    const keySource: "league" | "team" = bypassCaps ? "team" : "league";

    // League USD hard cap: stop before we spend a cent (PRD 5.9).
    if (budget.leagueCapReached && !bypassCaps) {
      await ctx
        .runMutation(internal.ledger.notifyCommissionerOfCap, { leagueId: run.leagueId, weekNo })
        .catch(() => ({ notified: false }));
      const detail = `league USD hard cap reached ($${budget.leagueUsdUsed.toFixed(4)} of $${(budget.leagueUsdCap ?? 0).toFixed(2)})`;
      return summaryOf({
        status: "fallback",
        outcome: "budget_exhausted",
        modelId: primaryModelId,
        error: "league USD hard cap reached",
        fallbackApplied: { kind: "budget_exhausted", detail },
        stepCount: run.stepCount,
      });
    }

    // Team weekly spend cap (commissioner-set, default $2.00): same treatment.
    if (budget.teamCapReached && !bypassCaps) {
      const detail = `team weekly spend cap reached ($${budget.teamUsdUsed.toFixed(4)} of $${(budget.teamUsdCap ?? 0).toFixed(2)} this week)`;
      return summaryOf({
        status: "fallback",
        outcome: "budget_exhausted",
        modelId: primaryModelId,
        error: "team weekly spend cap reached",
        fallbackApplied: { kind: "budget_exhausted", detail },
        stepCount: run.stepCount,
      });
    }

    // --- tools + prompt -------------------------------------------------------
    const state = seedState(loaded.priorActions, run.rationale ?? null);
    let currentStep = Math.max(0, run.lastPersistedStep + 1);
    const toolCtx: ToolContext = {
      ctx,
      runId,
      leagueId: run.leagueId,
      teamId,
      teamName,
      configVersionId: config.configVersionId,
      windowId: window._id,
      windowType: window.type,
      windowLabel: window.label,
      windowScope: window.scope,
      weekNo,
      snapshot: snapshot as SnapshotPayload,
      digest: digest ?? emptyDigest(),
      submissionDeadlineAt: new Date(window.submissionDeadlineAt),
      closesAt: new Date(window.closesAt),
      now: nowFn,
      currentStepIndex: () => currentStep,
      budget,
      customProviders,
      toolOverrides: config.toolOverrides,
      state,
    };

    const tools: ToolSet = buildTools(toolCtx);
    const toolNames = Object.keys(tools);
    const toolGuidance = guidanceByTool(toolNames, config.toolOverrides);

    const [inbox, forum] = await Promise.all([
      teamId && toolNames.includes("get_inbox")
        ? ctx
            .runQuery(internal.messaging.inboxForTeam, {
              leagueId: run.leagueId,
              teamId,
              limit: 10,
            })
            .catch(() => [])
        : Promise.resolve([]),
      ctx
        .runQuery(internal.forum.digest, { leagueId: run.leagueId, sort: "new", limit: 5 })
        .catch(() => ({ posts: [], karma: {} as Record<string, number> })),
    ]);

    const promptWindow: PromptWindow = {
      id: window._id,
      type: window.type,
      label: window.label,
      weekNo,
      roundNo: window.roundNo,
      scope: window.scope,
      opensAt: new Date(window.opensAt),
      submissionDeadlineAt: new Date(window.submissionDeadlineAt),
      closesAt: new Date(window.closesAt),
    };
    const prompt = buildPrompt({
      window: promptWindow,
      snapshot: snapshot as SnapshotPayload,
      digest: digest ?? emptyDigest(),
      teamId,
      teamName,
      contextMd: config.contextMd,
      skills: config.skills,
      noteToAgent: loaded.noteToAgent,
      harness,
      ownKey: bypassCaps,
      toolNames,
      toolGuidance,
      budget,
      inbox,
      forum,
    });

    await ctx.runMutation(internal.runs.markRunning, {
      runId,
      modelId: primaryModelId,
      ...(config.configVersionId ? { configVersionId: config.configVersionId } : {}),
      promptSections: prompt.sections as PromptSection[],
      keySource,
      now: nowFn().getTime(),
    });
    if (bypassCaps && loaded.teamKey) {
      await ctx
        .runMutation(internal.gateway_keys.markUsed, { keyId: loaded.teamKey.id })
        .catch(() => null);
    }

    // --- the model loop -------------------------------------------------------
    const wallClockMs =
      args.wallClockMs ??
      (rules?.runWallclockSeconds
        ? rules.runWallclockSeconds * 1000
        : PER_RUN_WALL_CLOCK_MS[window.type]);

    let totalCostUsd = run.totalCostUsd;
    let totalInputTokens = run.totalInputTokens;
    let totalOutputTokens = run.totalOutputTokens;
    let stepCount = run.stepCount;
    let budgetStopReason: string | null = null;
    const isFallbackRun = run.fallbackOfRunId != null;

    const persistedCount = Math.max(0, run.lastPersistedStep + 1);
    const initialMessages: ModelMessage[] = [{ role: "user", content: prompt.user }];
    const replayed = await resumeMessages(ctx, runId, run.lastPersistedStep);

    /** Set when a step could not be persisted; the run is aborted and rethrown. */
    let persistFailure: PersistFailedError | null = null;
    /** The controller of the model call in flight, so a persist failure can stop it. */
    let activeController: AbortController | null = null;

    async function persistWithRetry<T>(stepIndex: number, attempt: () => Promise<T>): Promise<T | null> {
      let lastError: unknown = null;
      for (let i = 0; i < PERSIST_ATTEMPTS; i++) {
        try {
          return await attempt();
        } catch (error) {
          lastError = error;
          if (i < PERSIST_ATTEMPTS - 1) {
            const backoff = PERSIST_BACKOFF_MS * 2 ** i * (0.5 + Math.random());
            await new Promise((resolve) => setTimeout(resolve, backoff));
          }
        }
      }
      persistFailure = new PersistFailedError(stepIndex, lastError);
      console.error(`[runtime] run ${runId}: ${persistFailure.message}`);
      activeController?.abort(persistFailure);
      return null;
    }

    /** Per-step ledger write + persistence. `offset` shifts indices past the plan step. */
    function makeOnStepEnd(modelId: string, offset: () => number) {
      return async (step: StepResult<ToolSet>) => {
        const stepIndex = step.stepNumber + offset();
        console.log(
          `[runtime] run ${runId} onStepEnd stepNumber=${step.stepNumber} offset=${offset()} stepIndex=${stepIndex} tools=${step.toolCalls.map((t) => t.toolName).join(",")} finish=${String(step.finishReason)}`,
        );
        const usage = step.usage;
        const inputTokens = usage.inputTokens ?? 0;
        const outputTokens = usage.outputTokens ?? 0;
        const cachedInputTokens = usage.inputTokenDetails?.cacheReadTokens ?? 0;
        const reasoningTokens = usage.outputTokenDetails?.reasoningTokens ?? 0;
        const latencyMs = Math.round(step.performance?.stepTimeMs ?? 0);
        const gatewayCostUsd = readGatewayCostUsd(step.providerMetadata);
        const invalidActionCount = state.rejectedThisStep;
        state.rejectedThisStep = 0;

        // One transaction: step document + usage event + rollups (persistStep
        // calls internal.ledger.recordStep inside the same mutation). Retried with
        // backoff: at window open every team's first step lands on the same
        // league/model rollup rows, so transient write conflicts are expected.
        const persisted = await persistWithRetry(stepIndex, () => ctx.runMutation(internal.runs.persistStep, {
          runId,
          stepIndex,
          modelId,
          ...(step.text ? { text: step.text } : {}),
          ...(step.reasoningText ? { reasoning: step.reasoningText } : {}),
          responseMessages: (step.response?.messages ?? []) as unknown[],
          toolCalls: step.toolCalls as unknown[],
          toolResults: step.toolResults as unknown[],
          usage: {
            inputTokens,
            outputTokens,
            cachedInputTokens,
            reasoningTokens,
            totalTokens: inputTokens + outputTokens,
          },
          finishReason: String(step.finishReason ?? ""),
          latencyMs,
          ...(gatewayCostUsd == null ? {} : { gatewayCostUsd }),
          ...(state.rationale ? { rationale: state.rationale } : {}),
          ...(isFallbackRun ? { isFallbackStep: true } : {}),
          ...(invalidActionCount > 0 ? { invalidActionCount } : {}),
        }));
        if (!persisted) return; // the run has been aborted; nothing to count

        totalCostUsd += persisted.costUsd;
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
     * USD cap. The abort is the real stop; `toolChoice: 'none'` is the backstop
     * for a provider call that is already in flight.
     */
    function makePrepareStep(controller: AbortController) {
      return async ({ steps }: { steps: Array<StepResult<ToolSet>> }) => {
        console.log(`[runtime] run ${runId} prepareStep stepsSoFar=${steps.length}`);
        const last = steps.at(-1);
        const projectedInput = last
          ? (last.usage.inputTokens ?? 0) + (last.usage.outputTokens ?? 0) + 500
          : estimateTokens(prompt.system) + estimateTokens(prompt.user);
        const projectedTokens = projectedInput + PROJECTED_OUTPUT_TOKENS;
        const projectedCost = estimateNextStepCostUsd({
          price,
          inputTokens: projectedInput,
          outputTokens: PROJECTED_OUTPUT_TOKENS,
        });
        const usedTokens = totalInputTokens + totalOutputTokens;

        let reason: string | null = null;
        // The per-run token budget is the owner's own harness setting and always
        // applies; the league's caps are skipped on an owner's own key.
        if (usedTokens + projectedTokens > harness.tokenBudget) {
          reason = `next step (~${projectedTokens} tokens) would exceed this run's token budget (${harness.tokenBudget})`;
        } else if (
          !bypassCaps &&
          budget.teamTokensRemaining != null &&
          usedTokens + projectedTokens > budget.teamTokensRemaining
        ) {
          reason = `next step (~${projectedTokens} tokens) would exceed your team's weekly token cap`;
        } else if (
          !bypassCaps &&
          budget.leagueUsdRemaining != null &&
          totalCostUsd + projectedCost > budget.leagueUsdRemaining
        ) {
          reason = `next step (~$${projectedCost.toFixed(4)}) would exceed the league's USD hard cap`;
        } else if (
          !bypassCaps &&
          budget.teamUsdRemaining != null &&
          totalCostUsd + projectedCost > budget.teamUsdRemaining
        ) {
          reason = `next step (~$${projectedCost.toFixed(4)}) would exceed your team's weekly spend cap`;
        }

        if (reason) {
          budgetStopReason = reason;
          controller.abort(new BudgetExceededError(reason));
          return { toolChoice: "none" as const };
        }
        return {};
      };
    }

    async function runModel(modelId: string): Promise<void> {
      const controller = new AbortController();
      activeController = controller;
      const timeout = new WallClockTimeoutError(wallClockMs);
      const timer = setTimeout(() => controller.abort(timeout), wallClockMs);
      // Step indices continue from whatever this run already persisted, so a
      // retried attempt never collides with (and silently loses) the steps the
      // previous attempt wrote under the `(runId, stepIndex)` key.
      let stepOffset = persistedCount;

      const shared = {
        model: resolveModel(modelId, { apiKey: ownApiKey }),
        tools,
        ...(modelSupportsTemperature(modelId) ? { temperature: harness.temperature } : {}),
        maxRetries: 3,
        abortSignal: controller.signal,
        ...(harness.reasoningEffort && modelSupportsReasoning(modelId)
          ? { reasoning: harness.reasoningEffort }
          : {}),
        onStepEnd: makeOnStepEnd(modelId, () => stepOffset),
      };

      try {
        let messages: ModelMessage[] = [...initialMessages, ...replayed];

        // Deliberate mode is a separate call, not a `prepareStep` override: the
        // tool loop stops as soon as a step produces no tool calls, so a plan
        // step inside the main loop would end the run before the agent ever
        // acted. It is skipped on resume — the plan is already in `messages`.
        if (harness.deliberateMode && maxSteps > 1 && persistedCount === 0) {
          const plan = await generateText({
            ...shared,
            instructions: prompt.system + DELIBERATE_INSTRUCTION,
            messages,
            toolChoice: "none",
            stopWhen: stepCountIs(1),
          });
          messages = [...messages, ...(plan.responseMessages as ModelMessage[])];
          stepOffset = persistedCount + 1;
        }

        await generateText({
          ...shared,
          instructions: prompt.system,
          messages,
          stopWhen: stepCountIs(Math.max(1, maxSteps - stepOffset)),
          prepareStep: makePrepareStep(controller),
        });
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

    let terminalStatus: ExecuteRunSummary["status"] | null = null;
    let terminalError: string | null = null;
    let fallbackApplied: FallbackApplied | null = run.fallbackApplied ?? null;

    try {
      await runModel(primaryModelId);
      if (persistFailure) throw persistFailure;
      if (budgetStopReason) {
        // The pre-step check aborted, but the provider had already returned and
        // the loop wound down through `toolChoice: 'none'` instead of throwing.
        terminalStatus = "fallback";
        terminalError = budgetStopReason;
        fallbackApplied = { kind: "budget_exhausted", detail: budgetStopReason };
      }
    } catch (error) {
      if (isBudgetStop(error)) {
        terminalStatus = "fallback";
        terminalError = budgetStopReason ?? "budget exceeded";
        fallbackApplied = { kind: "budget_exhausted", detail: terminalError };
      } else if (isWallClockStop(error)) {
        terminalStatus = "timed_out";
        terminalError = error instanceof Error ? error.message : `run exceeded ${wallClockMs}ms`;
        fallbackApplied = { kind: "safety_autopilot", detail: "run timed out" };
      } else {
        // A provider failure that survived the AI SDK's own `maxRetries`. Throw
        // so the Workpool retries the whole run — the retry resumes from
        // `runs.lastPersistedStep` — and, once the retries are spent,
        // `internal.runs.onComplete` marks it failed and enqueues the league's
        // fallback model.
        throw error instanceof Error ? error : new Error(String(error));
      }
    }

    // --- outcome --------------------------------------------------------------
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

    let status: ExecuteRunSummary["status"];
    let outcome: string;
    if (terminalStatus) {
      status = terminalStatus;
      outcome = budgetStopReason ? "budget_exhausted" : terminalStatus;
    } else if (window.type === "lineup" && !state.lineupCommitted) {
      // A lineup window that produced no lineup is a partial run whatever the
      // model said; `onComplete` schedules the autopilot behind it.
      status = "partial";
      outcome = "no_lineup_set";
      fallbackApplied = { kind: "safety_autopilot", detail: "agent set no lineup" };
    } else if (window.type === "lineup" && state.lineupEmptyStarters > 0) {
      status = "partial";
      outcome = "lineup_incomplete";
      const noun = state.lineupEmptyStarters === 1 ? "slot" : "slots";
      fallbackApplied = {
        kind: "safety_autopilot",
        detail: `agent left ${state.lineupEmptyStarters} starting ${noun} empty`,
      };
    } else if (!primaryDone && state.rejected > 0) {
      status = "partial";
      outcome = "all_actions_rejected";
    } else {
      status = "succeeded";
      outcome = describeOutcome(window.type, state);
    }

    return {
      runId,
      status,
      outcome,
      error: terminalError,
      modelId: primaryModelId,
      stepCount,
      totalCostUsd: Math.round(totalCostUsd * 1e8) / 1e8,
      totalInputTokens,
      totalOutputTokens,
      rationale: state.rationale,
      fallbackApplied,
      executed: true,
    };
  },
});
