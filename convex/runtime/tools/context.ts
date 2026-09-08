/**
 * The per-run context every tool closes over, plus the write-tool idempotency
 * wrapper.
 *
 * Tools are built fresh for each run by `buildTools(ctx)` and capture this object
 * in a closure. That is deliberately not the AI SDK's `toolsContext` mechanism:
 * `toolsContext` requires a `contextSchema` on every tool and threads a single
 * shared generic through `generateText`, which buys nothing here because the
 * context is fixed for the life of the run and is never mutated by the model.
 *
 * **What changed in the Convex port.** In Postgres, `commitAction` inserted the
 * `run_actions` claim itself and then ran the domain write. In Convex the domain
 * write *is* a transaction, and every runtime-facing mutation already writes its
 * own `run_actions` row inside it (`convex/lib/agent_action.ts` →
 * `withAgentAction`). Claiming here as well would produce two rows, so this
 * wrapper does the other half of the same contract:
 *
 *   1. ask `internal.runs.actionResult` whether `(runId, toolCallId)` already has
 *      a stored result and replay it verbatim if so;
 *   2. otherwise run the body — which validates against the in-memory snapshot
 *      and then calls the service mutation, whose transaction writes the action
 *      row;
 *   3. if the body rejected *before* reaching a mutation (a snapshot-level
 *      validation failure, or a mutation that threw), record the rejection
 *      through `internal.runs.recordRejectedAction` so the audit ledger and
 *      `runs.rejectedActionCount` look exactly as they did in Postgres.
 */
import { internal } from "../../_generated/api";
import type { AgentCtx } from "../../lib/agent_action";
import type { ToolContext, ToolResult } from "../types";

export { emptyRunToolState, toolError } from "../types";
export type { RunToolState, ToolContext, ToolResult } from "../types";

/** The `agentCtx` the messaging/trades/forum/waivers/draft/lineup mutations expect. */
export function agentContext(ctx: ToolContext, toolCallId: string): AgentCtx {
  return {
    runId: ctx.runId,
    stepIndex: ctx.currentStepIndex(),
    toolCallId,
    ...(ctx.configVersionId ? { configVersionId: ctx.configVersionId } : {}),
    windowId: ctx.windowId,
    weekNo: ctx.weekNo,
  };
}

/**
 * Run a write tool exactly once per `(runId, toolCallId)`.
 *
 * Safe to re-enter: a replayed call returns the stored result with
 * `replayed: true` and commits nothing a second time — PRD 6.2, and the resume
 * contract in `docs/migration-plan.md` §4.
 */
export async function commitAction<T extends ToolResult>(
  args: {
    ctx: ToolContext;
    toolCallId: string;
    actionType: string;
    payload: Record<string, unknown>;
  },
  run: () => Promise<T>,
): Promise<ToolResult> {
  const { ctx, toolCallId, actionType, payload } = args;
  const stepIndex = ctx.currentStepIndex();

  const stored = await ctx.ctx.runQuery(internal.runs.actionResult, {
    runId: ctx.runId,
    toolCallId,
  });
  if (stored.found) {
    const previous = stored.result as ToolResult | null;
    if (previous && typeof previous === "object" && "ok" in previous) {
      return { ...previous, replayed: true } as ToolResult;
    }
    return {
      ok: false,
      errors: [
        `This tool call (${toolCallId}) was already recorded for this run but produced no stored result. Do not retry it.`,
      ],
    };
  }

  let result: ToolResult;
  try {
    result = await run();
  } catch (error) {
    result = {
      ok: false,
      errors: [`${actionType} failed: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  if (!result.ok) {
    // Idempotent on `(runId, toolCallId)`: a no-op when the service mutation
    // already recorded this rejection inside its own transaction.
    await ctx.ctx.runMutation(internal.runs.recordRejectedAction, {
      runId: ctx.runId,
      toolCallId,
      stepIndex,
      actionType,
      payload,
      errors: result.errors,
    });
    ctx.state.rejected += 1;
    ctx.state.rejectedThisStep += 1;
    ctx.state.errors.push(...result.errors);
  } else {
    ctx.state.committed += 1;
  }
  return result;
}
