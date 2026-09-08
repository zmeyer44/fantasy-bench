/**
 * POST /api/runs/[runId]/execute — the agent run executor.
 *
 * Internal endpoint: the tick fans out one fire-and-forget request per pending
 * run (PRD 6.2). Authenticated with `INTERNAL_SECRET`, never exposed to the
 * browser.
 *
 * The claim is the queue: `status='pending' → 'running'` under a lease. Zero rows
 * updated means another tick already took this run, which is a 409, not an error.
 * A run that is already `running` (a retried dispatch of the same claim) is
 * executed anyway — every write tool is idempotent on `(runId, toolCallId)`.
 */
import { timingSafeEqual } from "node:crypto";

import { claimRun, executeRun } from "@/lib/agent/execute";
import { db } from "@/lib/db";
import { runs } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { env } from "@/lib/env";

/** Fluid Compute: the longest per-run wall clock (8 min) plus headroom. */
export const maxDuration = 600;
export const dynamic = "force-dynamic";

function authorized(request: Request): boolean {
  const header = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${env.INTERNAL_SECRET}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ runId: string }> },
): Promise<Response> {
  if (!authorized(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const { runId } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(runId)) {
    return Response.json({ error: "invalid run id" }, { status: 400 });
  }

  const [existing] = await db
    .select({ id: runs.id, status: runs.status })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);
  if (!existing) {
    return Response.json({ error: "run not found" }, { status: 404 });
  }

  if (existing.status === "pending") {
    const { claimed, leaseExpiresAt } = await claimRun(runId);
    if (!claimed) {
      return Response.json(
        { error: "run already claimed", runId, status: "conflict" },
        { status: 409 },
      );
    }
    void leaseExpiresAt;
  } else if (existing.status !== "running") {
    // Terminal already — hand back the stored summary rather than re-running.
    const result = await executeRun(runId);
    return Response.json({ ...result, alreadyFinished: true }, { status: 200 });
  }

  try {
    const result = await executeRun(runId);
    return Response.json(result, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .update(runs)
      .set({ status: "failed", error: message, finishedAt: new Date() })
      .where(eq(runs.id, runId));
    return Response.json({ error: message, runId, status: "failed" }, { status: 500 });
  }
}
