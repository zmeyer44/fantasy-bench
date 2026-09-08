/**
 * A local optimal-lineup / commit implementation used ONLY when the runtime
 * package's `lib/services/lineup` is still a throwing contract stub.
 *
 * The runtime owns lineup logic; this exists so the scheduler (draft
 * finalization, the demo seed, autopilot at window close) is not blocked during
 * parallel development. Every call goes through `safeComputeOptimalLineup` /
 * `safeCommitLineup`, which prefer the real implementation and fall back here.
 */
import { and, desc, eq } from "drizzle-orm";

import { db, type DbOrTx } from "@/lib/db";
import { lineups } from "@/lib/db/schema";
import type { LineupSlot, SnapshotPayload, SnapshotPlayer } from "@/lib/snapshot/types";

/**
 * The real lineup service exists now; a fallback here means it threw. Fail safe
 * (PRD 1.2) but never silently — the error is logged so it cannot hide a bug.
 */
function logFallback(fn: string, error: unknown): void {
  console.error(
    `[scheduler] lib/services/lineup.${fn} failed; using local fallback:`,
    error instanceof Error ? error.message : error,
  );
}

/** Which positions may fill a slot name. */
export function eligiblePositions(slot: string): string[] {
  const base = slot.replace(/\d+$/, "").toUpperCase();
  switch (base) {
    case "FLEX":
      return ["RB", "WR", "TE"];
    case "SUPERFLEX":
    case "SFLEX":
    case "QB/RB/WR/TE":
      return ["QB", "RB", "WR", "TE"];
    case "WRRB":
      return ["RB", "WR"];
    case "BENCH":
    case "IR":
      return ["QB", "RB", "WR", "TE", "K", "DEF"];
    default:
      return [base];
  }
}

export function isStarter(slot: string): boolean {
  const base = slot.replace(/\d+$/, "").toUpperCase();
  return base !== "BENCH" && base !== "IR";
}

function projectionOf(player: SnapshotPlayer | undefined, preset: string): number {
  if (!player?.projection) return 0;
  if (preset === "half_ppr") return player.projection.half;
  if (preset === "standard") return player.projection.std;
  return player.projection.ppr;
}

/**
 * Greedy best-projected legal lineup: fill the most constrained slots first
 * (single-position before FLEX) with the highest projection available.
 */
export function localOptimalLineup(snapshot: SnapshotPayload, teamId: string): LineupSlot[] {
  const team = snapshot.teams.find((t) => t.id === teamId);
  if (!team) return [];
  const preset = snapshot.rules.scoringPreset;

  const shape = team.lineup.length > 0 ? team.lineup.map((s) => s.slot) : slotsFromShape(snapshot.rules.rosterSlots);
  const available = new Set(team.rosterPlayerIds);

  const byValue = (a: string, b: string) =>
    projectionOf(snapshot.players[b], preset) - projectionOf(snapshot.players[a], preset);

  const starters = shape.filter(isStarter);
  const bench = shape.filter((s) => !isStarter(s));
  // Narrower eligibility first, so a FLEX does not steal the only startable TE.
  const ordered = [...starters].sort(
    (a, b) => eligiblePositions(a).length - eligiblePositions(b).length,
  );

  const assignment = new Map<string, string | null>(shape.map((s) => [s, null]));
  for (const slot of ordered) {
    const allowed = new Set(eligiblePositions(slot));
    const candidate = [...available]
      .filter((id) => allowed.has(snapshot.players[id]?.position ?? ""))
      .sort(byValue)[0];
    if (candidate) {
      assignment.set(slot, candidate);
      available.delete(candidate);
    }
  }
  const leftovers = [...available].sort(byValue);
  for (const slot of bench) {
    const next = leftovers.shift();
    assignment.set(slot, next ?? null);
  }

  return shape.map((slot) => ({ slot, playerId: assignment.get(slot) ?? null }));
}

export function slotsFromShape(shape: Record<string, number>): string[] {
  const order = ["QB", "RB", "WR", "TE", "FLEX", "SUPERFLEX", "K", "DEF", "BENCH"];
  const keys = [
    ...order.filter((k) => (shape[k] ?? 0) > 0),
    ...Object.keys(shape).filter((k) => !order.includes(k) && (shape[k] ?? 0) > 0),
  ];
  const out: string[] = [];
  for (const key of keys) {
    const count = shape[key] ?? 0;
    for (let i = 1; i <= count; i++) out.push(count > 1 ? `${key}${i}` : key);
  }
  return out;
}

/** Append a new lineup version (the `lineups` table is append-only history). */
export async function localCommitLineup(
  args: {
    teamId: string;
    weekNo: number;
    slots: LineupSlot[];
    source: "agent" | "autopilot" | "carryover" | "draft_default";
    runId?: string | null;
  },
  executor: DbOrTx = db,
): Promise<{ lineupId: string; version: number }> {
  const latest = await executor
    .select({ version: lineups.version })
    .from(lineups)
    .where(and(eq(lineups.teamId, args.teamId), eq(lineups.weekNo, args.weekNo)))
    .orderBy(desc(lineups.version))
    .limit(1);
  const version = (latest[0]?.version ?? 0) + 1;
  const [row] = await executor
    .insert(lineups)
    .values({
      teamId: args.teamId,
      weekNo: args.weekNo,
      version,
      slots: args.slots,
      source: args.source,
      setByRunId: args.runId ?? null,
    })
    .returning({ id: lineups.id });
  return { lineupId: row.id, version };
}

// ------------------------------------------------- prefer the real package

export async function safeComputeOptimalLineup(args: {
  snapshot: SnapshotPayload;
  teamId: string;
  current?: LineupSlot[];
  now?: Date;
}): Promise<LineupSlot[]> {
  try {
    const { computeOptimalLineup } = await import("@/lib/services/lineup");
    return computeOptimalLineup(args);
  } catch (error) {
    logFallback("computeOptimalLineup", error);
    return localOptimalLineup(args.snapshot, args.teamId);
  }
}

export async function safeCommitLineup(
  args: {
    teamId: string;
    weekNo: number;
    slots: LineupSlot[];
    source: "agent" | "autopilot" | "carryover" | "draft_default";
    runId?: string | null;
  },
  executor: DbOrTx = db,
): Promise<{ lineupId: string; version: number }> {
  try {
    const { commitLineup } = await import("@/lib/services/lineup");
    return await commitLineup(args, executor);
  } catch (error) {
    logFallback("commitLineup", error);
    return localCommitLineup(args, executor);
  }
}

/**
 * Safety autopilot with a local fallback: fill every empty starting slot from
 * the bench. Returns whether anything changed.
 */
export async function safeApplySafetyAutopilot(
  args: {
    snapshot: SnapshotPayload;
    teamId: string;
    weekNo: number;
    runId?: string | null;
    now?: Date;
  },
  executor: DbOrTx = db,
): Promise<{ slots: LineupSlot[]; changed: boolean; filledSlots: string[] }> {
  try {
    const { applySafetyAutopilot } = await import("@/lib/services/lineup");
    return await applySafetyAutopilot(args, executor);
  } catch (error) {
    logFallback("applySafetyAutopilot", error);
    const team = args.snapshot.teams.find((t) => t.id === args.teamId);
    const current = team?.lineup ?? [];
    const hasEmptyStarter = current.some((s) => isStarter(s.slot) && !s.playerId);
    if (current.length > 0 && !hasEmptyStarter) {
      return { slots: current, changed: false, filledSlots: [] };
    }
    const slots = localOptimalLineup(args.snapshot, args.teamId);
    const filled = slots
      .filter((s, i) => isStarter(s.slot) && s.playerId && !current[i]?.playerId)
      .map((s) => s.slot);
    await localCommitLineup(
      { teamId: args.teamId, weekNo: args.weekNo, slots, source: "autopilot", runId: args.runId },
      executor,
    );
    return { slots, changed: true, filledSlots: filled };
  }
}
