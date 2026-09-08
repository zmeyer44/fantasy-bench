/**
 * CONTRACT STUB — owned by the scheduler/data package, which replaces this file.
 */
import type { DbOrTx } from "@/lib/db";
import type { SnapshotDigest, SnapshotPayload } from "@/lib/snapshot/types";

/** Build and persist a snapshot for a league (optionally bound to a window). Returns the snapshot id. */
export async function takeSnapshot(
  _args: { leagueId: string; weekNo: number; windowId?: string | null; now?: Date },
  _executor?: DbOrTx,
): Promise<{ snapshotId: string; payload: SnapshotPayload; digest: SnapshotDigest }> {
  throw new Error("not implemented (scheduler package)");
}

export async function loadSnapshot(_snapshotId: string, _executor?: DbOrTx): Promise<{
  id: string;
  payload: SnapshotPayload;
  digest: SnapshotDigest;
  takenAt: Date;
}> {
  throw new Error("not implemented (scheduler package)");
}
