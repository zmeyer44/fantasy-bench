/**
 * Fantasy point computation, with no database access.
 *
 * `lib/services/scoring/points.ts` and `lib/services/scoring/table.ts` are pure
 * (they import nothing but each other), so per docs/CONVEX_CONVENTIONS.md they
 * are imported at runtime rather than copied: one scoring table, one scorer,
 * used by the Convex mutations, the ingest pipeline and the public rules page.
 *
 * The only additions here are the two slot predicates the Convex scorer needs,
 * ported from `lib/services/scoring/index.ts`.
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
} from "../../lib/services/scoring/points";

export type {
  ScoringOptions,
  ScoringPreset,
  ScoringRule,
  StatMap,
} from "../../lib/services/scoring/points";

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
