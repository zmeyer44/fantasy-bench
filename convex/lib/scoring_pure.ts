/**
 * Fantasy point computation, with no database access.
 *
 * The table and the scorer live in `convex/lib/scoring_table.ts` (pure, no
 * database): one scoring table, one scorer, used by the Convex mutations, the
 * ingest pipeline and the public rules page. This module re-exports them and
 * adds the two slot predicates the Convex scorer needs.
 */
export {
  computeAllPresets,
  computeFantasyPoints,
  inferPosition,
  pointsAllowedScore,
  pointsForPreset,
  round2,
  scoringTableForPreset,
  POINTS_ALLOWED_TIERS,
  RECEPTION_POINTS,
  SCORING_TABLE,
  TE_PREMIUM_BONUS,
} from "./scoring_table";

export type {
  ScoringOptions,
  ScoringPreset,
  ScoringRule,
  StatMap,
} from "./scoring_table";

/** Bench slots never score. Anything else is a starter. */
export function isStartingSlot(slot: string): boolean {
  const upper = slot.toUpperCase();
  return upper !== "BENCH" && !upper.startsWith("BENCH") && upper !== "IR";
}

/**
 * Which stored preset column a league reads.
 *
 * TE premium is a league toggle, so the stored (league-agnostic) column can only
 * be trusted when the league does not run it — otherwise the scorer recomputes
 * from the stat map.
 */
export function storedPointsFor(
  preset: "ppr" | "half_ppr" | "standard",
  row: { fantasyPointsPpr: number; fantasyPointsHalf: number; fantasyPointsStd: number },
): number {
  if (preset === "ppr") return row.fantasyPointsPpr;
  if (preset === "half_ppr") return row.fantasyPointsHalf;
  return row.fantasyPointsStd;
}
