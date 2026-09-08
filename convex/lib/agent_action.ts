/**
 * Agent write-tool plumbing: the `agentCtx` every runtime-facing mutation takes,
 * and the `(runId, toolCallId)` idempotency contract from
 * docs/migration-plan.md §4 ("Idempotency on retry").
 *
 * A write tool may be replayed — the Workpool retries the whole action, and a
 * tool call whose service mutation committed but whose `persistStep` did not
 * land is the one hazard the plan calls out. So every service mutation writes
 * its own `run_actions` row inside the same transaction as the domain write:
 * that row is the idempotency key. `withAgentAction` does three things in one
 * transaction:
 *
 *  1. look the row up on `by_runId_toolCallId`; on a hit, return the stored
 *     `result` verbatim and touch nothing else;
 *  2. otherwise run the body, which either validates-and-writes or returns
 *     `{ ok: false, errors }` **before** writing anything (a mutation is a
 *     transaction, so a rejection must not have written);
 *  3. insert the `run_actions` row and bump `runs.committedActionCount` /
 *     `rejectedActionCount`.
 *
 * Validation failures are recorded as rejected actions and returned, never
 * thrown: the agent gets a structured error it can retry against.
 */
import { v, type Infer } from "convex/values";

import type { MutationCtx } from "../_generated/server";

export const agentCtxValidator = v.object({
  runId: v.id("runs"),
  stepIndex: v.number(),
  toolCallId: v.string(),
  configVersionId: v.optional(v.id("config_versions")),
  windowId: v.id("windows"),
  weekNo: v.number(),
});

export type AgentCtx = Infer<typeof agentCtxValidator>;

/** Every runtime-facing mutation returns this shape (never throws on validation). */
export type ActionFailure = { ok: false; errors: string[] };
export type ActionOutcome = { ok: true } | ActionFailure;

export function fail(...errors: string[]): ActionFailure {
  return { ok: false, errors };
}

/**
 * Run `body` under the `(runId, toolCallId)` idempotency contract.
 *
 * With no `agentCtx` (platform-made writes: the seed, the auto-pick, the
 * commissioner console) the body simply runs — there is no run to key on.
 */
export async function withAgentAction<T extends ActionOutcome>(
  ctx: MutationCtx,
  agentCtx: AgentCtx | undefined,
  spec: { actionType: string; payload: Record<string, unknown> },
  body: () => Promise<T>,
): Promise<T> {
  if (!agentCtx) return body();

  const existing = await ctx.db
    .query("run_actions")
    .withIndex("by_runId_toolCallId", (q) =>
      q.eq("runId", agentCtx.runId).eq("toolCallId", agentCtx.toolCallId),
    )
    .first();
  // A replay of a call that already committed (or was already rejected) returns
  // the recorded result verbatim; it never re-runs the domain write.
  if (existing) return existing.result as T;

  const run = await ctx.db.get("runs", agentCtx.runId);
  if (!run) return fail(`Run ${agentCtx.runId} does not exist.`) as T;

  const result = await body();
  const ok = result.ok === true;

  await ctx.db.insert("run_actions", {
    runId: agentCtx.runId,
    leagueId: run.leagueId,
    teamId: run.teamId,
    toolCallId: agentCtx.toolCallId,
    stepIndex: agentCtx.stepIndex,
    actionType: spec.actionType,
    payload: spec.payload,
    validationResult: ok ? { ok: true } : { ok: false, errors: (result as ActionFailure).errors },
    result,
    committedAt: ok ? Date.now() : undefined,
  });
  await ctx.db.patch("runs", agentCtx.runId, {
    committedActionCount: run.committedActionCount + (ok ? 1 : 0),
    rejectedActionCount: run.rejectedActionCount + (ok ? 0 : 1),
  });

  return result;
}
