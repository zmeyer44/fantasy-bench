/**
 * Lineup rules: validation, the optimal lineup, commit, and the safety autopilot.
 *
 * Everything a run reads comes from the window's `SnapshotPayload` — these
 * functions never query live roster tables, so a replay against a stored
 * snapshot produces the same answer as the original run.
 *
 * Player locks (PRD 5.3): once a player's game has kicked off their slot is
 * frozen. `validateLineup` enforces that at write time; the scheduler does not
 * need to know about it.
 */
import { and, desc, eq } from "drizzle-orm";

import { db, withTransaction, type DbOrTx } from "@/lib/db";
import { lineups } from "@/lib/db/schema";
import type {
  LineupSlot,
  Position,
  ScoringPreset,
  SnapshotPayload,
  SnapshotPlayer,
  SnapshotTeam,
} from "@/lib/snapshot/types";

export type LineupSource = "agent" | "autopilot" | "carryover" | "draft_default";

export type LineupValidation =
  | { ok: true; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

/** Slot labels that are not part of the starting lineup. */
export const BENCH_SLOTS = new Set(["BENCH", "BN", "IR", "TAXI"]);

/** Injury designations that mean "this player will not score this week". */
const UNAVAILABLE_STATUSES = new Set([
  "out",
  "ir",
  "inactive",
  "suspended",
  "pup",
  "nfi",
  "dnr",
  "doubtful",
]);

const FLEX_POSITIONS: Position[] = ["RB", "WR", "TE"];
const SUPERFLEX_POSITIONS: Position[] = ["QB", "RB", "WR", "TE"];

/**
 * Positions that may fill `slot`. `null` means "any position" (bench).
 *
 * A `SUPERFLEX` slot only accepts a QB when the league's superflex toggle is on;
 * otherwise it behaves like a FLEX.
 */
export function eligiblePositions(slot: string, opts: { superflex: boolean }): Position[] | null {
  const key = slot.toUpperCase();
  if (BENCH_SLOTS.has(key)) return null;
  switch (key) {
    case "QB":
    case "RB":
    case "WR":
    case "TE":
    case "K":
    case "DEF":
      return [key as Position];
    case "FLEX":
    case "WRT":
    case "W/R/T":
      return FLEX_POSITIONS;
    case "SUPERFLEX":
    case "SFLEX":
    case "OP":
    case "QBFLEX":
      return opts.superflex ? SUPERFLEX_POSITIONS : FLEX_POSITIONS;
    case "WRRB":
    case "REC_FLEX":
      return ["WR", "TE"];
    default:
      return [];
  }
}

export function isEligible(
  position: Position,
  slot: string,
  opts: { superflex: boolean },
): boolean {
  const allowed = eligiblePositions(slot, opts);
  if (allowed === null) return true;
  return allowed.includes(position);
}

/**
 * Canonical display/commit order for starting slots. `rosterSlots` arrives as
 * jsonb, whose key order Postgres does not preserve, so the order comes from
 * here rather than from the object — otherwise the same lineup would render
 * differently depending on how it was loaded.
 */
const SLOT_ORDER = ["QB", "RB", "WR", "TE", "FLEX", "WRT", "W/R/T", "WRRB", "REC_FLEX", "SUPERFLEX", "SFLEX", "OP", "QBFLEX", "K", "DEF"];

/** `{ QB:1, RB:2, BENCH:6 }` → `["QB", "RB", "RB"]` (starting slots only, canonical order). */
export function startingSlotLabels(rosterSlots: Record<string, number>): string[] {
  const slots = Object.keys(rosterSlots).filter((slot) => !BENCH_SLOTS.has(slot.toUpperCase()));
  slots.sort((a, b) => {
    const ia = SLOT_ORDER.indexOf(a.toUpperCase());
    const ib = SLOT_ORDER.indexOf(b.toUpperCase());
    return (ia < 0 ? SLOT_ORDER.length : ia) - (ib < 0 ? SLOT_ORDER.length : ib) || a.localeCompare(b);
  });
  const out: string[] = [];
  for (const slot of slots) {
    for (let i = 0; i < Math.max(0, rosterSlots[slot] ?? 0); i++) out.push(slot);
  }
  return out;
}

export function benchSlotLabel(rosterSlots: Record<string, number>): string {
  const found = Object.keys(rosterSlots).find((s) => BENCH_SLOTS.has(s.toUpperCase()));
  return found ?? "BENCH";
}

/** Which projection field the league's scoring preset reads. */
export function projectionField(preset: ScoringPreset): "ppr" | "half" | "std" {
  if (preset === "half_ppr") return "half";
  if (preset === "standard") return "std";
  return "ppr";
}

export function projectedPoints(player: SnapshotPlayer | undefined, preset: ScoringPreset): number {
  if (!player?.projection) return 0;
  return player.projection[projectionField(preset)] ?? 0;
}

/** A player is locked once their game has kicked off. */
export function isLocked(player: SnapshotPlayer | undefined, now: Date): boolean {
  if (!player?.kickoffAt) return false;
  const kickoff = new Date(player.kickoffAt);
  return Number.isFinite(kickoff.getTime()) && kickoff.getTime() <= now.getTime();
}

export function isOnBye(player: SnapshotPlayer | undefined, weekNo: number): boolean {
  if (!player) return false;
  return player.byeWeek != null && player.byeWeek === weekNo;
}

export function isUnavailable(player: SnapshotPlayer | undefined, weekNo: number): boolean {
  if (!player) return true;
  if (isOnBye(player, weekNo)) return true;
  const status = (player.injuryStatus ?? "").trim().toLowerCase();
  return status.length > 0 && UNAVAILABLE_STATUSES.has(status);
}

function teamOf(snapshot: SnapshotPayload, teamId: string): SnapshotTeam | undefined {
  return snapshot.teams.find((t) => t.id === teamId);
}

/** Map of playerId → starting slot in `slots` (bench and empty entries excluded). */
function startingAssignment(
  slots: LineupSlot[],
  rosterSlots: Record<string, number>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of slots) {
    if (!entry.playerId) continue;
    if (BENCH_SLOTS.has(entry.slot.toUpperCase())) continue;
    if (!(entry.slot in rosterSlots)) continue;
    map.set(entry.playerId, entry.slot);
  }
  return map;
}

/**
 * Validate a proposed lineup against the league's slot shape, position
 * eligibility, roster membership and player locks.
 *
 * Bye-week and injured starters are allowed but reported in `warnings` so the
 * tool result can show them to the agent without rejecting the call.
 */
export function validateLineup(args: {
  snapshot: SnapshotPayload;
  teamId: string;
  slots: LineupSlot[];
  now: Date;
}): LineupValidation {
  const { snapshot, teamId, slots, now } = args;
  const errors: string[] = [];
  const warnings: string[] = [];

  const team = teamOf(snapshot, teamId);
  if (!team) {
    return { ok: false, errors: [`Team ${teamId} is not in this snapshot.`], warnings };
  }

  const rosterSlots = snapshot.rules.rosterSlots;
  const superflex = snapshot.rules.superflex;
  const roster = new Set(team.rosterPlayerIds);

  // 1. slot shape
  const counts = new Map<string, number>();
  for (const entry of slots) {
    if (!(entry.slot in rosterSlots)) {
      errors.push(
        `Unknown slot "${entry.slot}". Legal slots are: ${Object.keys(rosterSlots).join(", ")}.`,
      );
      continue;
    }
    counts.set(entry.slot, (counts.get(entry.slot) ?? 0) + 1);
  }
  for (const [slot, expected] of Object.entries(rosterSlots)) {
    if (BENCH_SLOTS.has(slot.toUpperCase())) continue;
    const got = counts.get(slot) ?? 0;
    if (got !== expected) {
      errors.push(`Slot "${slot}" must appear exactly ${expected} time(s); got ${got}.`);
    }
  }

  // 2. players: duplicates, roster membership, eligibility
  const seen = new Set<string>();
  for (const entry of slots) {
    const isBench = BENCH_SLOTS.has(entry.slot.toUpperCase());
    if (!entry.playerId) {
      if (!isBench) warnings.push(`Slot "${entry.slot}" is empty and will score 0.`);
      continue;
    }
    if (seen.has(entry.playerId)) {
      errors.push(`Player ${entry.playerId} appears more than once in the lineup.`);
      continue;
    }
    seen.add(entry.playerId);

    if (!roster.has(entry.playerId)) {
      errors.push(`Player ${entry.playerId} is not on your roster.`);
      continue;
    }
    const player = snapshot.players[entry.playerId];
    if (!player) {
      errors.push(`Player ${entry.playerId} is not in this snapshot.`);
      continue;
    }
    if (!isBench && !isEligible(player.position, entry.slot, { superflex })) {
      const allowed = eligiblePositions(entry.slot, { superflex }) ?? [];
      errors.push(
        `${player.fullName} (${player.position}) is not eligible for slot "${entry.slot}" (accepts ${allowed.join("/") || "nothing"}).`,
      );
      continue;
    }
    if (!isBench) {
      if (isOnBye(player, snapshot.weekNo)) {
        warnings.push(`${player.fullName} is on bye in week ${snapshot.weekNo} and will score 0.`);
      } else if (isUnavailable(player, snapshot.weekNo)) {
        warnings.push(`${player.fullName} is listed ${player.injuryStatus} and may not play.`);
      }
    }
  }

  // 3. locks — a locked player may not move into or out of the starting lineup
  const current = startingAssignment(team.lineup ?? [], rosterSlots);
  const proposed = startingAssignment(slots, rosterSlots);
  const touched = new Set<string>([...current.keys(), ...proposed.keys()]);
  for (const playerId of touched) {
    const player = snapshot.players[playerId];
    if (!isLocked(player, now)) continue;
    const before = current.get(playerId) ?? null;
    const after = proposed.get(playerId) ?? null;
    if (before === after) continue;
    const name = player?.fullName ?? playerId;
    const kickoff = player?.kickoffAt ?? "an earlier kickoff";
    if (before && !after) {
      errors.push(`${name} is locked (kickoff ${kickoff}) and cannot be moved out of "${before}".`);
    } else if (!before && after) {
      errors.push(`${name} is locked (kickoff ${kickoff}) and cannot be moved into "${after}".`);
    } else {
      errors.push(
        `${name} is locked (kickoff ${kickoff}) and cannot be moved from "${before}" to "${after}".`,
      );
    }
  }

  if (errors.length > 0) return { ok: false, errors, warnings };
  return { ok: true, warnings };
}

type Candidate = { playerId: string; points: number; position: Position };

function sortSlotsByRestrictiveness(slots: string[], superflex: boolean): string[] {
  return [...slots]
    .map((slot, index) => ({ slot, index, width: (eligiblePositions(slot, { superflex }) ?? []).length }))
    .sort((a, b) => a.width - b.width || a.index - b.index)
    .map((s) => s.slot);
}

/**
 * The best legal lineup available from the team's roster in the snapshot.
 *
 * Greedy assignment from the most restrictive slot outwards, then a hill-climb
 * over swaps and substitutions until nothing improves. Rosters are ~15 players
 * over ~9 slots, so this settles in a handful of passes and matches exhaustive
 * search on every shape we ship.
 *
 * When `current` is supplied, locked players keep exactly the slot they hold
 * there (and locked bench players stay benched), so the result is a lineup that
 * `validateLineup` will accept.
 */
export function computeOptimalLineup(args: {
  snapshot: SnapshotPayload;
  teamId: string;
  current?: LineupSlot[];
  now?: Date;
}): LineupSlot[] {
  const { snapshot, teamId } = args;
  const now = args.now ?? new Date(snapshot.takenAt);
  const team = teamOf(snapshot, teamId);
  if (!team) return [];

  const rosterSlots = snapshot.rules.rosterSlots;
  const superflex = snapshot.rules.superflex;
  const preset = snapshot.rules.scoringPreset;
  const benchLabel = benchSlotLabel(rosterSlots);
  const startingSlots = startingSlotLabels(rosterSlots);

  const current = args.current ?? team.lineup ?? [];
  const currentStarting = startingAssignment(current, rosterSlots);

  // Locked players are immovable: pin the ones already starting, exclude the rest.
  const excluded = new Set<string>();
  const lockedStarters: Array<{ slot: string; playerId: string }> = [];
  for (const playerId of team.rosterPlayerIds) {
    const player = snapshot.players[playerId];
    if (!isLocked(player, now)) continue;
    const slot = currentStarting.get(playerId);
    if (slot) lockedStarters.push({ slot, playerId });
    excluded.add(playerId);
  }

  const candidates: Candidate[] = team.rosterPlayerIds
    .filter((id) => !excluded.has(id))
    .map((id) => {
      const player = snapshot.players[id];
      return {
        playerId: id,
        position: player?.position ?? ("WR" as Position),
        points: isUnavailable(player, snapshot.weekNo) ? 0 : projectedPoints(player, preset),
      };
    })
    .sort((a, b) => b.points - a.points || a.playerId.localeCompare(b.playerId));

  // Build the open slot list: every starting slot minus the ones locked starters hold.
  const open: string[] = [...startingSlots];
  for (const locked of lockedStarters) {
    const idx = open.indexOf(locked.slot);
    if (idx >= 0) open.splice(idx, 1);
  }

  const ordered = sortSlotsByRestrictiveness(open, superflex);
  const assignment = new Map<number, Candidate | null>(); // index into `ordered`
  const used = new Set<string>();

  ordered.forEach((slot, i) => {
    const pick = candidates.find(
      (c) => !used.has(c.playerId) && isEligible(c.position, slot, { superflex }),
    );
    if (pick) {
      used.add(pick.playerId);
      assignment.set(i, pick);
    } else {
      assignment.set(i, null);
    }
  });

  // Greedy over a laminar eligibility family (QB ⊂ SUPERFLEX, RB/WR/TE ⊂ FLEX ⊂
  // SUPERFLEX) is optimal, but one improvement pass costs nothing and guards
  // against an exotic slot shape: promote any unused player who beats the holder
  // of a slot they are eligible for. Each accepted move strictly raises the total.
  for (let pass = 0; pass < 4; pass++) {
    let improved = false;
    for (let i = 0; i < ordered.length; i++) {
      const held = assignment.get(i) ?? null;
      for (const c of candidates) {
        if (used.has(c.playerId)) continue;
        if (!isEligible(c.position, ordered[i]!, { superflex })) continue;
        if (c.points > (held?.points ?? -1)) {
          if (held) used.delete(held.playerId);
          used.add(c.playerId);
          assignment.set(i, c);
          improved = true;
          break;
        }
      }
    }
    if (!improved) break;
  }

  // Re-materialise in the league's canonical slot order.
  const filled: LineupSlot[] = [];
  const remainingByOrdered = new Map<string, string[]>();
  ordered.forEach((slot, i) => {
    const list = remainingByOrdered.get(slot) ?? [];
    const c = assignment.get(i) ?? null;
    list.push(c?.playerId ?? "");
    remainingByOrdered.set(slot, list);
  });
  const lockedBySlot = new Map<string, string[]>();
  for (const locked of lockedStarters) {
    const list = lockedBySlot.get(locked.slot) ?? [];
    list.push(locked.playerId);
    lockedBySlot.set(locked.slot, list);
  }
  for (const slot of startingSlots) {
    const lockedList = lockedBySlot.get(slot);
    if (lockedList && lockedList.length > 0) {
      filled.push({ slot, playerId: lockedList.shift()! });
      continue;
    }
    const list = remainingByOrdered.get(slot) ?? [];
    const playerId = list.shift() ?? "";
    filled.push({ slot, playerId: playerId === "" ? null : playerId });
  }

  const starters = new Set(filled.map((s) => s.playerId).filter((id): id is string => !!id));
  for (const playerId of team.rosterPlayerIds) {
    if (starters.has(playerId)) continue;
    filled.push({ slot: benchLabel, playerId });
  }
  return filled;
}

/** Total projected points of the starting slots in `slots`. */
export function scoreLineup(args: {
  snapshot: SnapshotPayload;
  slots: LineupSlot[];
}): number {
  const preset = args.snapshot.rules.scoringPreset;
  let total = 0;
  for (const entry of args.slots) {
    if (!entry.playerId) continue;
    if (BENCH_SLOTS.has(entry.slot.toUpperCase())) continue;
    total += projectedPoints(args.snapshot.players[entry.playerId], preset);
  }
  return Math.round(total * 100) / 100;
}

/**
 * Lineup efficiency (PRD 5.12): actual points ÷ optimal points from the same
 * roster. Returns 0 when the optimal lineup was worth nothing, and is never
 * greater than 1 outside floating-point noise.
 */
export function lineupEfficiency(args: { actual: number; optimal: number }): number {
  if (!Number.isFinite(args.optimal) || args.optimal <= 0) return 0;
  return Math.round((args.actual / args.optimal) * 10000) / 10000;
}

/** Points the team left on its bench: `optimal - actual`, floored at 0. */
export function pointsLeftOnBench(args: { actual: number; optimal: number }): number {
  return Math.max(0, Math.round((args.optimal - args.actual) * 100) / 100);
}

/** Latest lineup version for a team-week, or null. */
export async function getCurrentLineup(
  args: { teamId: string; weekNo: number },
  executor: DbOrTx = db,
): Promise<{ id: string; version: number; slots: LineupSlot[]; source: LineupSource } | null> {
  const [row] = await executor
    .select({
      id: lineups.id,
      version: lineups.version,
      slots: lineups.slots,
      source: lineups.source,
    })
    .from(lineups)
    .where(and(eq(lineups.teamId, args.teamId), eq(lineups.weekNo, args.weekNo)))
    .orderBy(desc(lineups.version))
    .limit(1);
  return row ?? null;
}

/** Persist a new lineup version. `lineups` is append-only: never update in place. */
export async function commitLineup(
  args: {
    teamId: string;
    weekNo: number;
    slots: LineupSlot[];
    source: LineupSource;
    runId?: string | null;
  },
  executor: DbOrTx = db,
): Promise<{ lineupId: string; version: number }> {
  return withTransaction(async (tx) => {
    const previous = await getCurrentLineup({ teamId: args.teamId, weekNo: args.weekNo }, tx);
    const version = (previous?.version ?? 0) + 1;
    const [row] = await tx
      .insert(lineups)
      .values({
        teamId: args.teamId,
        weekNo: args.weekNo,
        version,
        slots: args.slots,
        source: args.source,
        setByRunId: args.runId ?? null,
      })
      .returning({ id: lineups.id, version: lineups.version });
    return { lineupId: row!.id, version: row!.version };
  }, executor);
}

/**
 * Safety autopilot (PRD 5.4 fallbacks).
 *
 * Keeps the last valid lineup and fills any starting slot that is empty, holds a
 * player who is no longer on the roster, or holds a player who cannot play (out,
 * IR, bye) — with the highest-projected eligible bench player who is not locked.
 * Slots whose player is already locked are left alone: they cannot be changed.
 *
 * Idempotent: a second call finds nothing to fill and writes no new version.
 */
export async function applySafetyAutopilot(
  args: {
    snapshot: SnapshotPayload;
    teamId: string;
    weekNo: number;
    runId?: string | null;
    now?: Date;
  },
  executor: DbOrTx = db,
): Promise<{ slots: LineupSlot[]; changed: boolean; filledSlots: string[] }> {
  const { snapshot, teamId, weekNo } = args;
  const now = args.now ?? new Date();
  const team = teamOf(snapshot, teamId);
  if (!team) return { slots: [], changed: false, filledSlots: [] };

  const rosterSlots = snapshot.rules.rosterSlots;
  const superflex = snapshot.rules.superflex;
  const preset = snapshot.rules.scoringPreset;
  const benchLabel = benchSlotLabel(rosterSlots);
  const roster = new Set(team.rosterPlayerIds);

  const stored = await getCurrentLineup({ teamId, weekNo }, executor);
  const base = stored?.slots?.length ? stored.slots : (team.lineup ?? []);

  // Normalise to the league's slot shape, preserving whatever the base lineup had.
  const bySlot = new Map<string, string[]>();
  for (const entry of base) {
    if (!entry.playerId) continue;
    if (BENCH_SLOTS.has(entry.slot.toUpperCase())) continue;
    const list = bySlot.get(entry.slot) ?? [];
    list.push(entry.playerId);
    bySlot.set(entry.slot, list);
  }
  const starting: LineupSlot[] = startingSlotLabels(rosterSlots).map((slot) => {
    const list = bySlot.get(slot) ?? [];
    return { slot, playerId: list.shift() ?? null };
  });

  const used = new Set(starting.map((s) => s.playerId).filter((id): id is string => !!id));
  const filledSlots: string[] = [];

  const holes = starting
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => {
      if (!entry.playerId) return true;
      if (!roster.has(entry.playerId)) return true;
      const player = snapshot.players[entry.playerId];
      if (isLocked(player, now)) return false; // frozen — nothing we can do
      return isUnavailable(player, snapshot.weekNo);
    })
    .sort(
      (a, b) =>
        (eligiblePositions(a.entry.slot, { superflex }) ?? []).length -
        (eligiblePositions(b.entry.slot, { superflex }) ?? []).length,
    );

  for (const hole of holes) {
    const slot = hole.entry.slot;
    const candidate = team.rosterPlayerIds
      .filter((id) => !used.has(id))
      .map((id) => ({ id, player: snapshot.players[id] }))
      .filter(({ player }) => player && !isLocked(player, now) && !isUnavailable(player, snapshot.weekNo))
      .filter(({ player }) => isEligible(player!.position, slot, { superflex }))
      .sort(
        (a, b) =>
          projectedPoints(b.player, preset) - projectedPoints(a.player, preset) ||
          a.id.localeCompare(b.id),
      )[0];
    if (!candidate) continue;
    if (hole.entry.playerId) used.delete(hole.entry.playerId);
    used.add(candidate.id);
    starting[hole.index] = { slot, playerId: candidate.id };
    filledSlots.push(slot);
  }

  const slots: LineupSlot[] = [...starting];
  for (const playerId of team.rosterPlayerIds) {
    if (used.has(playerId)) continue;
    slots.push({ slot: benchLabel, playerId });
  }

  if (filledSlots.length === 0) {
    // Nothing to do. If there is no stored lineup at all, persist the carried-over
    // shape once so the week always has a row; otherwise leave history untouched.
    if (!stored) {
      await commitLineup(
        { teamId, weekNo, slots, source: "carryover", runId: args.runId ?? null },
        executor,
      );
      return { slots, changed: true, filledSlots: [] };
    }
    return { slots: stored.slots, changed: false, filledSlots: [] };
  }

  await commitLineup(
    { teamId, weekNo, slots, source: "autopilot", runId: args.runId ?? null },
    executor,
  );
  return { slots, changed: true, filledSlots };
}
