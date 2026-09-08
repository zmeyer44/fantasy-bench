/**
 * Decision-window read models: what is open now, what opens next, and the full
 * grid for a week (PRD 5.3).
 */
import { and, asc, eq, gte, sql } from "drizzle-orm";

import { db, type DbOrTx } from "@/lib/db";
import { runs, windows } from "@/lib/db/schema";
import type { WindowStatus, WindowType } from "@/lib/db/types";

import { countdown, windowLabelText } from "./shared";

export type WindowView = {
  id: string;
  type: WindowType;
  label: string;
  labelText: string;
  weekNo: number | null;
  roundNo: number;
  opensAt: Date;
  submissionDeadlineAt: Date;
  closesAt: Date;
  status: WindowStatus;
  snapshotId: string | null;
  runCount: number;
  /** Human countdown to the next state change, relative to `now`. */
  countdown: string;
  phase: "past" | "open" | "upcoming";
};

function decorate(
  row: {
    id: string;
    type: WindowType;
    label: string;
    weekNo: number | null;
    roundNo: number;
    opensAt: Date;
    submissionDeadlineAt: Date;
    closesAt: Date;
    status: WindowStatus;
    snapshotId: string | null;
    runCount: number;
  },
  now: Date,
): WindowView {
  const phase =
    now < row.opensAt ? "upcoming" : now >= row.closesAt ? "past" : ("open" as const);
  return {
    ...row,
    labelText: windowLabelText(row.label),
    phase,
    countdown:
      phase === "upcoming"
        ? countdown(now, row.opensAt)
        : phase === "open"
          ? countdown(now, row.closesAt)
          : "closed",
  };
}

const BASE_COLUMNS = {
  id: windows.id,
  type: windows.type,
  label: windows.label,
  weekNo: windows.weekNo,
  roundNo: windows.roundNo,
  opensAt: windows.opensAt,
  submissionDeadlineAt: windows.submissionDeadlineAt,
  closesAt: windows.closesAt,
  status: windows.status,
  snapshotId: windows.snapshotId,
  runCount: sql<number>`(select count(*)::int from ${runs} where ${runs.windowId} = ${windows.id})`,
};

/** Every window for a week, in schedule order. */
export async function windowsForWeek(
  leagueId: string,
  weekNo: number,
  opts: { now?: Date; executor?: DbOrTx } = {},
): Promise<WindowView[]> {
  const executor = opts.executor ?? db;
  const now = opts.now ?? new Date();
  const rows = await executor
    .select(BASE_COLUMNS)
    .from(windows)
    .where(and(eq(windows.leagueId, leagueId), eq(windows.weekNo, weekNo)))
    .orderBy(asc(windows.opensAt), asc(windows.roundNo));
  return rows.map((row) => decorate(row, now));
}

export type WindowSchedule = {
  /** Windows whose open/close bracket `now`. */
  open: WindowView[];
  /** The next few windows that have not opened yet. */
  upcoming: WindowView[];
  /** The single headline window for the league header countdown. */
  next: WindowView | null;
};

/** Currently-open + next-opening windows for a league (header countdown). */
export async function windowSchedule(
  leagueId: string,
  opts: { now?: Date; limit?: number; executor?: DbOrTx } = {},
): Promise<WindowSchedule> {
  const executor = opts.executor ?? db;
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 4;

  const rows = await executor
    .select(BASE_COLUMNS)
    .from(windows)
    .where(and(eq(windows.leagueId, leagueId), gte(windows.closesAt, now)))
    .orderBy(asc(windows.opensAt))
    .limit(limit * 3);

  const views = rows.map((row) => decorate(row, now));
  const open = views.filter((w) => w.phase === "open");
  const upcoming = views.filter((w) => w.phase === "upcoming").slice(0, limit);
  return { open, upcoming, next: open[0] ?? upcoming[0] ?? null };
}
