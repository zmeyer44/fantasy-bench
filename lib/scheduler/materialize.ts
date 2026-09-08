/**
 * Turning templates into `windows` rows.
 *
 * Idempotent by construction: the unique index
 * `(league_id, label, week_no, round_no)` is the dedupe key, so calling this
 * every five minutes for the same week is free.
 */
import { and, eq } from "drizzle-orm";

import { db, type DbOrTx } from "@/lib/db";
import { leagueRules, weeks, windows } from "@/lib/db/schema";
import type { Window } from "@/lib/db/types";

import { resolveWindowsForWeek, type ResolvedWindow } from "./templates";

export type MaterializeResult = {
  weekNo: number;
  created: number;
  existing: number;
  windows: ResolvedWindow[];
};

/** The week's Tuesday 06:00 ET anchor. */
export async function weekAnchor(
  leagueId: string,
  weekNo: number,
  executor: DbOrTx = db,
): Promise<Date | null> {
  const row = await executor.query.weeks.findFirst({
    where: and(eq(weeks.leagueId, leagueId), eq(weeks.weekNo, weekNo)),
  });
  return row?.startsAt ?? null;
}

/**
 * Create every `windows` row for one league week. Safe to call repeatedly and
 * concurrently — conflicting inserts are dropped, not merged, so a window that
 * has already opened is never rewritten underneath a running agent.
 */
export async function materializeWindows(
  leagueId: string,
  weekNo: number,
  executor: DbOrTx = db,
): Promise<MaterializeResult> {
  const anchor = await weekAnchor(leagueId, weekNo, executor);
  if (!anchor) return { weekNo, created: 0, existing: 0, windows: [] };

  const rules = await executor.query.leagueRules.findFirst({
    where: eq(leagueRules.leagueId, leagueId),
  });
  const resolved = resolveWindowsForWeek(anchor, rules?.windowOverrides ?? null);
  if (resolved.length === 0) return { weekNo, created: 0, existing: 0, windows: [] };

  const inserted = await executor
    .insert(windows)
    .values(
      resolved.map((w) => ({
        leagueId,
        type: w.type,
        label: w.label,
        weekNo,
        roundNo: w.roundNo,
        opensAt: w.opensAt,
        submissionDeadlineAt: w.submissionDeadlineAt,
        closesAt: w.closesAt,
        scope: w.scope,
        status: "scheduled" as const,
      })),
    )
    .onConflictDoNothing({
      target: [windows.leagueId, windows.label, windows.weekNo, windows.roundNo],
    })
    .returning({ id: windows.id });

  return {
    weekNo,
    created: inserted.length,
    existing: resolved.length - inserted.length,
    windows: resolved,
  };
}

/** All windows for a league week, in open order. */
export async function windowsForWeek(
  leagueId: string,
  weekNo: number,
  executor: DbOrTx = db,
): Promise<Window[]> {
  return executor
    .select()
    .from(windows)
    .where(and(eq(windows.leagueId, leagueId), eq(windows.weekNo, weekNo)))
    .orderBy(windows.opensAt);
}

export async function findWindow(
  leagueId: string,
  label: string,
  weekNo: number,
  roundNo = 1,
  executor: DbOrTx = db,
): Promise<Window | undefined> {
  return executor.query.windows.findFirst({
    where: and(
      eq(windows.leagueId, leagueId),
      eq(windows.label, label),
      eq(windows.weekNo, weekNo),
      eq(windows.roundNo, roundNo),
    ),
  });
}
