/**
 * Shared helpers for the public read models.
 *
 * Everything here is read-only and defensive: several of the services this
 * package reads from (`lib/services/{snapshot,draft,waivers,forum,standings}`)
 * are CONTRACT STUBS owned by other work packages and throw
 * `not implemented (…)` until they land. `tryService` lets a page call the real
 * implementation when it exists and fall back to a direct query when it does
 * not, so the public pages render either way.
 */
import { desc, eq } from "drizzle-orm";

import { db, type DbOrTx } from "@/lib/db";
import { snapshots } from "@/lib/db/schema";
import { findModel } from "@/lib/models";
import type { SnapshotPayload } from "@/lib/snapshot/types";

/** Run `fn`; if it throws (typically a not-yet-implemented contract stub), use `fallback`. */
export async function tryService<T>(
  fn: () => Promise<T> | T,
  fallback: () => Promise<T> | T,
): Promise<T> {
  try {
    return await fn();
  } catch {
    return await fallback();
  }
}

export type LatestSnapshot = {
  id: string;
  takenAt: Date;
  weekNo: number | null;
  payload: SnapshotPayload;
} | null;

/**
 * The most recent snapshot for a league.
 *
 * `lib/services/snapshot#loadSnapshot` takes a snapshot id, so finding "the
 * latest" needs this query regardless; we read the row directly rather than
 * doing a lookup + a second service round-trip.
 */
export async function latestSnapshot(
  leagueId: string,
  executor: DbOrTx = db,
): Promise<LatestSnapshot> {
  const [row] = await executor
    .select({
      id: snapshots.id,
      takenAt: snapshots.takenAt,
      weekNo: snapshots.weekNo,
      payload: snapshots.payload,
    })
    .from(snapshots)
    .where(eq(snapshots.leagueId, leagueId))
    .orderBy(desc(snapshots.takenAt))
    .limit(1);
  return row ?? null;
}

/** Player lookup out of a snapshot payload, tolerant of a missing snapshot. */
export function snapshotPlayer(snapshot: LatestSnapshot, playerId: string | null) {
  if (!snapshot || !playerId) return null;
  return snapshot.payload.players?.[playerId] ?? null;
}

export function liveScoreFor(snapshot: LatestSnapshot, playerId: string | null): number | null {
  if (!snapshot || !playerId) return null;
  const value = snapshot.payload.liveScores?.[playerId];
  return typeof value === "number" ? value : null;
}

/** `anthropic/claude-sonnet-4.5` → `Claude Sonnet 4.5` (falls back to the raw id). */
export function modelLabel(modelId: string | null | undefined): string {
  if (!modelId) return "—";
  return findModel(modelId)?.displayName ?? modelId;
}

/** `lineup_sun_early` → `Lineup Sun early`. Window labels are template keys. */
export function windowLabelText(label: string): string {
  const words = label.split("_");
  const head = words[0] ?? label;
  return [head.charAt(0).toUpperCase() + head.slice(1), ...words.slice(1)].join(" ");
}

/** Compact relative countdown: `2h 10m`, `4d 3h`, `now`. */
export function countdown(from: Date, to: Date): string {
  const ms = to.getTime() - from.getTime();
  if (ms <= 0) return "now";
  const minutes = Math.floor(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export function round2(value: number | null | undefined): number {
  return Math.round((value ?? 0) * 100) / 100;
}

/** Slot order used everywhere a roster or lineup is rendered. */
export const SLOT_ORDER = ["QB", "RB", "WR", "TE", "FLEX", "SUPERFLEX", "K", "DEF", "BENCH"];

export function slotRank(slot: string): number {
  const base = slot.replace(/\d+$/, "");
  const index = SLOT_ORDER.indexOf(base);
  return index === -1 ? SLOT_ORDER.length : index;
}

/** Expand `{ QB: 1, RB: 2 }` into `["QB", "RB1", "RB2"]`. */
export function expandRosterSlots(shape: Record<string, number>): string[] {
  const out: string[] = [];
  for (const slot of Object.keys(shape).sort((a, b) => slotRank(a) - slotRank(b))) {
    const count = shape[slot] ?? 0;
    if (count <= 1) {
      if (count === 1) out.push(slot);
      continue;
    }
    for (let i = 1; i <= count; i++) out.push(`${slot}${i}`);
  }
  return out;
}

export function isStartingSlot(slot: string): boolean {
  return !slot.toUpperCase().startsWith("BENCH") && !slot.toUpperCase().startsWith("IR");
}
