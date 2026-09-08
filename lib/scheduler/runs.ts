/**
 * The run queue (PRD §6.2): creating pending runs, reaping expired leases, and
 * fanning out dispatch requests.
 *
 * `runs` IS the queue. The tick only ever creates `pending` rows and asks the
 * executor to pick them up; the executor claims a row with a conditional UPDATE,
 * so a duplicate dispatch is harmless.
 */
import { and, eq, gt, inArray, lt, ne } from "drizzle-orm";

import { db, type DbOrTx } from "@/lib/db";
import { agentConfigs, configVersions, leagueRules, runs, teams, windows } from "@/lib/db/schema";
import type { Run, Window } from "@/lib/db/types";
import { DEFAULT_MODEL_ID } from "@/lib/models";

export type RunAssignment = { teamId: string; modelId: string; configVersionId: string | null };

/**
 * Which config version (and therefore model) each team runs.
 *
 * `getCurrentConfigVersion` is the console package's contract; while it is a
 * stub we read the applied version directly. A team with no config at all falls
 * back to the league's first allowlisted model so it still gets a run.
 */
export async function assignmentsForTeams(
  leagueId: string,
  teamIds: string[],
  executor: DbOrTx = db,
): Promise<RunAssignment[]> {
  if (teamIds.length === 0) return [];
  const rules = await executor.query.leagueRules.findFirst({
    where: eq(leagueRules.leagueId, leagueId),
  });
  const leagueDefault = rules?.modelAllowlist?.[0] ?? DEFAULT_MODEL_ID;

  const assignments = new Map<string, RunAssignment>(
    teamIds.map((teamId) => [teamId, { teamId, modelId: leagueDefault, configVersionId: null }]),
  );

  try {
    const { getCurrentConfigVersion } = await import("@/lib/services/config");
    for (const teamId of teamIds) {
      const version = await getCurrentConfigVersion(teamId, executor);
      if (version) {
        assignments.set(teamId, {
          teamId,
          modelId: version.modelId || leagueDefault,
          configVersionId: version.id,
        });
      }
    }
    return [...assignments.values()];
  } catch {
    const rows = await executor
      .select({
        teamId: agentConfigs.teamId,
        versionId: configVersions.id,
        modelId: configVersions.modelId,
      })
      .from(agentConfigs)
      .leftJoin(configVersions, eq(configVersions.id, agentConfigs.currentVersionId))
      .where(inArray(agentConfigs.teamId, teamIds));
    for (const row of rows) {
      assignments.set(row.teamId, {
        teamId: row.teamId,
        modelId: row.modelId ?? leagueDefault,
        configVersionId: row.versionId ?? null,
      });
    }
    return [...assignments.values()];
  }
}

/**
 * One pending run per team for a window. Idempotent: teams that already have a
 * run in this window are skipped, so re-opening is a no-op.
 */
export async function createRunsForWindow(
  window: Pick<Window, "id" | "leagueId">,
  teamIds: string[],
  executor: DbOrTx = db,
): Promise<Run[]> {
  if (teamIds.length === 0) return [];
  const existing = await executor
    .select({ teamId: runs.teamId })
    .from(runs)
    .where(eq(runs.windowId, window.id));
  const already = new Set(existing.map((r) => r.teamId));
  const missing = teamIds.filter((id) => !already.has(id));
  if (missing.length === 0) return [];

  const assignments = await assignmentsForTeams(window.leagueId, missing, executor);
  return executor
    .insert(runs)
    .values(
      assignments.map((a) => ({
        windowId: window.id,
        teamId: a.teamId,
        leagueId: window.leagueId,
        configVersionId: a.configVersionId,
        modelId: a.modelId,
        kind: "team" as const,
        status: "pending" as const,
      })),
    )
    .returning();
}

export async function teamIdsForLeague(leagueId: string, executor: DbOrTx = db): Promise<string[]> {
  const rows = await executor
    .select({ id: teams.id })
    .from(teams)
    .where(eq(teams.leagueId, leagueId));
  return rows.map((r) => r.id);
}

const TERMINAL_STATUSES = ["succeeded", "partial", "failed", "timed_out", "fallback", "skipped"] as const;

/**
 * Mark every run in a window that never reached a terminal state: a run that was
 * claimed but never finished is `timed_out`, one that never started is `skipped`.
 */
export async function terminateOpenRuns(
  windowId: string,
  now: Date,
  executor: DbOrTx = db,
): Promise<{ timedOut: number; skipped: number }> {
  const timedOut = await executor
    .update(runs)
    .set({ status: "timed_out", finishedAt: now, error: "Window closed before the run finished." })
    .where(and(eq(runs.windowId, windowId), eq(runs.status, "running")))
    .returning({ id: runs.id });
  const skipped = await executor
    .update(runs)
    .set({ status: "skipped", finishedAt: now, error: "Window closed before the run started." })
    .where(and(eq(runs.windowId, windowId), eq(runs.status, "pending")))
    .returning({ id: runs.id });
  return { timedOut: timedOut.length, skipped: skipped.length };
}

/** Runs whose lease expired while `running` — the tick's reaper (PRD 6.2). */
export async function reapExpiredRuns(
  now: Date,
  executor: DbOrTx = db,
): Promise<Array<Run & { windowType: string; weekNo: number | null; snapshotId: string | null }>> {
  const rows = await executor
    .select({
      run: runs,
      windowType: windows.type,
      weekNo: windows.weekNo,
      snapshotId: windows.snapshotId,
    })
    .from(runs)
    .innerJoin(windows, eq(windows.id, runs.windowId))
    .where(and(eq(runs.status, "running"), lt(runs.leaseExpiresAt, now)));
  if (rows.length === 0) return [];

  await executor
    .update(runs)
    .set({ status: "timed_out", finishedAt: now, error: "Lease expired; reaped by the tick." })
    .where(
      inArray(
        runs.id,
        rows.map((r) => r.run.id),
      ),
    );

  return rows.map((r) => ({
    ...r.run,
    status: "timed_out" as const,
    windowType: r.windowType,
    weekNo: r.weekNo,
    snapshotId: r.snapshotId,
  }));
}

/** Pending runs that may still be dispatched (deadline has not passed). */
export async function pendingRunsToDispatch(
  now: Date,
  limit: number,
  executor: DbOrTx = db,
): Promise<Array<{ id: string; leagueId: string; teamId: string | null }>> {
  return executor
    .select({ id: runs.id, leagueId: runs.leagueId, teamId: runs.teamId })
    .from(runs)
    .innerJoin(windows, eq(windows.id, runs.windowId))
    .where(
      and(
        eq(runs.status, "pending"),
        eq(windows.status, "open"),
        gt(windows.submissionDeadlineAt, now),
        ne(windows.type, "commissioner"),
      ),
    )
    .orderBy(runs.createdAt)
    .limit(limit);
}

export { TERMINAL_STATUSES };
