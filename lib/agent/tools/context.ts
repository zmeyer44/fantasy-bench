/**
 * The per-run context every tool closes over, plus the write-tool idempotency
 * wrapper.
 *
 * Tools are built fresh for each run by `buildTools(ctx)` and capture this object
 * in a closure. That is deliberately not the AI SDK's `toolsContext` mechanism:
 * `toolsContext` requires a `contextSchema` on every tool and threads a single
 * shared generic through `generateText`, which buys nothing here because the
 * context is fixed for the life of the run and is never mutated by the model.
 */
import { and, eq } from "drizzle-orm";

import { db, type DbOrTx } from "@/lib/db";
import { runActions } from "@/lib/db/schema";
import type { CustomProvider, WindowType } from "@/lib/db/types";
import type { WindowScope } from "@/lib/db/schema";
import type { AgentContext } from "@/lib/services/messaging";
import type { RemainingBudget } from "@/lib/services/ledger";
import type { SnapshotDigest, SnapshotPayload } from "@/lib/snapshot/types";

/** Everything the run did, accumulated by the write tools for the executor. */
export type RunToolState = {
  rationale: string | null;
  lineupCommitted: boolean;
  waiverClaims: number;
  drops: number;
  tradesProposed: number;
  tradeResponses: number;
  messagesSent: number;
  forumPosts: number;
  forumComments: number;
  forumVotes: number;
  draftActions: number;
  committed: number;
  rejected: number;
  /** Validation errors returned to the model, newest last. */
  errors: string[];
};

export function emptyRunToolState(): RunToolState {
  return {
    rationale: null,
    lineupCommitted: false,
    waiverClaims: 0,
    drops: 0,
    tradesProposed: 0,
    tradeResponses: 0,
    messagesSent: 0,
    forumPosts: 0,
    forumComments: 0,
    forumVotes: 0,
    draftActions: 0,
    committed: 0,
    rejected: 0,
    errors: [],
  };
}

export type ToolContext = {
  runId: string;
  leagueId: string;
  /** null for commissioner runs, which have no roster. */
  teamId: string | null;
  teamName: string;
  configVersionId: string | null;
  windowId: string;
  windowType: WindowType;
  windowLabel: string;
  windowScope: WindowScope;
  weekNo: number;
  snapshot: SnapshotPayload;
  digest: SnapshotDigest;
  submissionDeadlineAt: Date;
  closesAt: Date;
  /** Injectable clock — tests and replays pass a fixed instant. */
  now: () => Date;
  /** Step index the model is currently on; stamped onto `run_actions`. */
  currentStepIndex: () => number;
  budget: RemainingBudget;
  customProviders: CustomProvider[];
  executor: DbOrTx;
  state: RunToolState;
};

/** The `AgentContext` the messaging/trades/forum/waivers/draft services expect. */
export function agentContext(ctx: ToolContext, toolCallId: string): AgentContext {
  return {
    runId: ctx.runId,
    stepIndex: ctx.currentStepIndex(),
    toolCallId,
    configVersionId: ctx.configVersionId,
    windowId: ctx.windowId,
    weekNo: ctx.weekNo,
  };
}

export type ToolOk = { ok: true; [key: string]: unknown };
export type ToolErr = { ok: false; errors: string[] };
export type ToolResult = ToolOk | ToolErr;

export function toolError(...errors: string[]): ToolErr {
  return { ok: false, errors };
}

/**
 * Run a write tool exactly once per `(runId, toolCallId)`.
 *
 * The insert is the idempotency claim: if the row already exists the stored
 * result is replayed verbatim and nothing is committed a second time. This is
 * what makes re-executing a run (a retried dispatch, a duplicated cron tick)
 * safe — PRD 6.2.
 *
 * The row is stamped with the result and `committed_at` after the commit
 * succeeds, so a crash mid-commit leaves an uncommitted claim rather than a
 * silent double write.
 */
export async function commitAction<T extends ToolResult>(
  args: {
    ctx: ToolContext;
    toolCallId: string;
    actionType: string;
    payload: Record<string, unknown>;
  },
  run: () => Promise<T>,
): Promise<T | ToolResult> {
  const { ctx, toolCallId, actionType, payload } = args;
  const executor: DbOrTx = ctx.executor ?? db;
  const stepIndex = ctx.currentStepIndex();

  const claimed = await executor
    .insert(runActions)
    .values({ runId: ctx.runId, toolCallId, stepIndex, actionType, payload })
    .onConflictDoNothing()
    .returning({ id: runActions.id });

  if (claimed.length === 0) {
    const [existing] = await executor
      .select({ result: runActions.result, validationResult: runActions.validationResult })
      .from(runActions)
      .where(and(eq(runActions.runId, ctx.runId), eq(runActions.toolCallId, toolCallId)))
      .limit(1);
    const stored = existing?.result as ToolResult | undefined;
    if (stored) return { ...stored, replayed: true } as ToolResult;
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

  await executor
    .update(runActions)
    .set({
      result: result as unknown as Record<string, unknown>,
      validationResult: result.ok ? { ok: true } : { ok: false, errors: result.errors },
      committedAt: result.ok ? new Date() : null,
    })
    .where(and(eq(runActions.runId, ctx.runId), eq(runActions.toolCallId, toolCallId)));

  if (result.ok) ctx.state.committed += 1;
  else {
    ctx.state.rejected += 1;
    ctx.state.errors.push(...result.errors);
  }
  return result;
}
