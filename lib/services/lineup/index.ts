/**
 * CONTRACT STUB — owned by the agent-runtime package, which replaces this file.
 * Lineup validation, commit, optimal-lineup and safety-autopilot logic.
 */
import type { DbOrTx } from "@/lib/db";
import type { LineupSlot, SnapshotPayload } from "@/lib/snapshot/types";

export type LineupValidation = { ok: true } | { ok: false; errors: string[] };

/** Validate a proposed lineup for `teamId` against roster shape, eligibility and player locks (as of `now`). */
export function validateLineup(_args: {
  snapshot: SnapshotPayload;
  teamId: string;
  slots: LineupSlot[];
  now: Date;
}): LineupValidation {
  throw new Error("not implemented (runtime package)");
}

/** Best projected legal lineup from the team's roster in the snapshot. */
export function computeOptimalLineup(_args: {
  snapshot: SnapshotPayload;
  teamId: string;
  /** If given, keep locked slots as they are in this lineup. */
  current?: LineupSlot[];
  now?: Date;
}): LineupSlot[] {
  throw new Error("not implemented (runtime package)");
}

/** Persist a new lineup version. */
export async function commitLineup(
  _args: {
    teamId: string;
    weekNo: number;
    slots: LineupSlot[];
    source: "agent" | "autopilot" | "carryover" | "draft_default";
    runId?: string | null;
  },
  _executor?: DbOrTx,
): Promise<{ lineupId: string; version: number }> {
  throw new Error("not implemented (runtime package)");
}

/**
 * Safety autopilot (PRD 5.4 fallbacks): keep the last valid lineup and fill empty / locked-out
 * starting slots with the highest-projected eligible bench player. Idempotent.
 * Returns the lineup that now stands and whether anything changed.
 */
export async function applySafetyAutopilot(
  _args: { snapshot: SnapshotPayload; teamId: string; weekNo: number; runId?: string | null; now?: Date },
  _executor?: DbOrTx,
): Promise<{ slots: LineupSlot[]; changed: boolean; filledSlots: string[] }> {
  throw new Error("not implemented (runtime package)");
}
