/**
 * Shared, pure helpers for the read models — the port of
 * `lib/services/views/shared.ts` (package B).
 *
 * Nothing here touches the database: the Convex read paths do their own bounded
 * index reads and then decorate the rows with these functions, exactly as the
 * old services did. `tryService` has no successor — the contract stubs it worked
 * around are gone.
 */
import { findModel } from "../../lib/models";
import type { ScoringPreset, SnapshotPlayer } from "../../lib/snapshot/types";

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
export function countdown(from: number, to: number): string {
  const ms = to - from;
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

/** The projection figure the league's scoring preset reads. */
export function projectionFor(
  projection: { ppr: number; half: number; std: number } | null | undefined,
  preset: ScoringPreset | string | undefined,
): number | null {
  if (!projection) return null;
  if (preset === "half_ppr") return projection.half;
  if (preset === "standard") return projection.std;
  return projection.ppr;
}

/** Player lookup out of a snapshot players map, tolerant of a missing snapshot. */
export function snapshotPlayer(
  players: Record<string, SnapshotPlayer> | null | undefined,
  playerId: string | null | undefined,
): SnapshotPlayer | null {
  if (!players || !playerId) return null;
  return players[playerId] ?? null;
}

export function liveScoreFor(
  liveScores: Record<string, number> | null | undefined,
  playerId: string | null | undefined,
): number | null {
  if (!liveScores || !playerId) return null;
  const value = liveScores[playerId];
  return typeof value === "number" ? value : null;
}

const EXCERPT_CHARS = 260;

/** First `max` characters of a rationale, on a word boundary. */
export function excerpt(text: string | null | undefined, max = EXCERPT_CHARS): string | null {
  if (!text) return null;
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max).replace(/\s+\S*$/, "")}…`;
}

/** `4-2-1` / `0-0` — the record badge used on every card. */
export function recordText(record: { wins: number; losses: number; ties: number } | null | undefined): string {
  if (!record) return "0-0";
  return `${record.wins}-${record.losses}${record.ties ? `-${record.ties}` : ""}`;
}
