/**
 * The one Workpool that runs agent runs (migration plan §4, "Workpool").
 *
 * Every `runs` document is one Workpool job: `enqueueRun(ctx, runId)` (the helper
 * `convex/runs.ts` exports and `windows.dispatch` calls) enqueues
 * `internal.runtime.execute.executeRun`
 * with `internal.runs.onComplete` as the completion mutation, and stores the
 * returned work id on `runs.workId` so `internal.runs.cancelForWindow` can cancel
 * it when the window closes.
 *
 * `maxParallelism: 24` is the whole deployment's budget — this is the only pool,
 * so the sum stays far under the documented guidance (100 on Pro, 20 free tier).
 * Retries are on by default because a run is idempotent on resume:
 * `runs.lastPersistedStep` plus the `(runId, toolCallId)` contract in
 * `convex/lib/agent_action.ts` mean a retried attempt re-uses the steps and tool
 * results the previous attempt already committed.
 *
 * This file holds no Convex functions, only the pool instance, so both
 * `convex/runs.ts` (mutations) and the scheduler package can import it.
 *
 * Deviation from the plan: `statusTtl` is not an option in `@convex-dev/workpool`
 * 0.4.11 (`WorkpoolOptions` is `maxParallelism`, `logLevel`,
 * `defaultRetryBehavior`, `retryActionsByDefault`). The pool keeps its own
 * completion records; the durable record of a run is the `runs` document, which
 * `internal.runs.onComplete` finalises, so nothing depended on the TTL.
 */
import { Workpool } from "@convex-dev/workpool";

import { components } from "../_generated/api";

export const runPool = new Workpool(components.runPool, {
  maxParallelism: 24,
  retryActionsByDefault: true,
  defaultRetryBehavior: { maxAttempts: 3, initialBackoffMs: 2000, base: 2 },
  logLevel: "INFO",
});
