/**
 * Deterministic trade fairness (PRD 5.6) — the pure half of
 * `lib/services/trades/fairness.ts`.
 *
 * The number is computed here and only here. The Commissioner Agent may attach
 * a one-paragraph narrative to `fairnessDetail.narrative`, but it never moves
 * the score — a model deciding which trades get vetoed would make the game
 * unauditable.
 *
 * v1 formula (unchanged from Postgres)
 * ------------------------------------
 *   playerValue = rosProjection × positionalScarcity × rosterFit
 *     rosProjection    latest snapshot's `rosProjection`, else this week's
 *                      projection × remaining weeks
 *     scarcity         fixed multipliers (RB/TE scarce, K/DEF fungible;
 *                      QB rises in superflex)
 *     rosterFit        ×1.10 when the receiving team would actually start them
 *   sideValue   = Σ playerValue of the package that side receives
 *                 + FAAB received × FAAB_POINTS_PER_DOLLAR
 *   fairness    = min(sideA, sideB) / max(sideA, sideB)  ∈ [0, 1]
 *   flagged     = fairness < league_rules.fairnessFloor (default 0.6)
 *
 * Everything below is pure: `convex/trades.ts` does the reads (snapshot payload,
 * `player_projection_latest`, `roster_slots`) and hands the results in.
 */
import type { FairnessDetailV1 } from "../../lib/services/trades/fairness";
import type { SocialRules } from "./social_pure";

export type { FairnessDetailV1 };

/** PRD default; used when `league_rules.fairnessFloor` is null. */
export const DEFAULT_FAIRNESS_FLOOR = 0.6;

/** Rest-of-season points one FAAB dollar is worth. */
export const FAAB_POINTS_PER_DOLLAR = 0.25;

/** Multiplier applied when the receiving team would start the player. */
export const ROSTER_FIT_BONUS = 1.1;

/**
 * Positional scarcity. Startable RBs are the scarcest commodity in a standard
 * league; kickers and defenses are close to interchangeable.
 */
export const POSITION_SCARCITY: Record<string, number> = {
  QB: 0.9,
  RB: 1.15,
  WR: 1.0,
  TE: 1.1,
  K: 0.6,
  DEF: 0.7,
};

/** In superflex a second startable QB is worth more than any RB. */
export const SUPERFLEX_QB_SCARCITY = 1.2;

export type PlayerValueRow = {
  playerId: string;
  name: string;
  position: string;
  /** Rest-of-season projected points. */
  ros: number;
};

export type PlayerValuation = {
  playerId: string;
  playerName: string;
  position: string;
  baseRos: number;
  scarcity: number;
  rosterFit: number;
  value: number;
  toTeamId: string;
};

export type FairnessResult = {
  score: number;
  flagged: boolean;
  detail: FairnessDetailV1;
};

/** Where the rest-of-season numbers came from; drives `detail.notes`. */
export type ValuationSource = "snapshot" | "projections" | "none";

export function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Weeks left in the season, inclusive of `weekNo`; never below 1. */
export function remainingWeeksFor(rules: SocialRules, weekNo: number): number {
  return Math.max(1, (rules.seasonWeeks ?? 17) - weekNo + 1);
}

/** This week's projection under the league's scoring preset. */
export function pickProjection(
  projection: { ppr?: number; half?: number; std?: number } | null | undefined,
  preset: SocialRules["scoringPreset"],
): number {
  if (!projection) return 0;
  if (preset === "standard") return projection.std ?? 0;
  if (preset === "half_ppr") return projection.half ?? 0;
  return projection.ppr ?? 0;
}

export function scarcityFor(position: string, rules: SocialRules): number {
  if (position === "QB" && rules.superflex) return SUPERFLEX_QB_SCARCITY;
  if (position === "TE" && rules.tePremium) return (POSITION_SCARCITY.TE ?? 1) + 0.1;
  return POSITION_SCARCITY[position] ?? 1;
}

/** Starting slots a position competes for, counting FLEX for RB/WR/TE. */
export function startingSlotsFor(position: string, slots: Record<string, number>): number {
  const direct = Number(slots[position] ?? 0);
  const flex = ["RB", "WR", "TE"].includes(position) ? Number(slots.FLEX ?? 0) : 0;
  const superflex =
    position === "QB" ? Number(slots.SUPERFLEX ?? slots.SFLEX ?? 0) : 0;
  return direct + flex + superflex;
}

/**
 * Would `player` crack the receiving team's starting lineup?
 *
 * Approximated by counting how many players the receiving team already rosters
 * at that position who project higher: if fewer than the number of startable
 * slots, the incoming player starts.
 */
export function wouldStart(
  player: PlayerValueRow,
  receivingRoster: PlayerValueRow[],
  slots: Record<string, number>,
): boolean {
  const available = startingSlotsFor(player.position, slots);
  if (available === 0) return false;
  const better = receivingRoster.filter(
    (p) => p.position === player.position && p.ros > player.ros,
  ).length;
  return better < available;
}

export function valuePlayer(
  player: PlayerValueRow,
  receivingTeamId: string,
  receivingRoster: PlayerValueRow[],
  rules: SocialRules,
): PlayerValuation {
  const scarcity = scarcityFor(player.position, rules);
  const rosterFit = wouldStart(player, receivingRoster, rules.rosterSlots)
    ? ROSTER_FIT_BONUS
    : 1;
  return {
    playerId: player.playerId,
    playerName: player.name,
    position: player.position,
    baseRos: round(player.ros),
    scarcity,
    rosterFit,
    value: round(player.ros * scarcity * rosterFit),
    toTeamId: receivingTeamId,
  };
}

/** A player the valuation context never heard of: worth nothing, named so. */
export function unknownPlayer(playerId: string): PlayerValueRow {
  return { playerId, name: "Unknown player", position: "WR", ros: 0 };
}

export type ScoreTradeInput = {
  proposerTeamId: string;
  recipientTeamId: string;
  /** Players moving proposer → recipient. */
  give: string[];
  /** Players moving recipient → proposer. */
  receive: string[];
  /** Net FAAB proposer → recipient. */
  faab?: number;
  rules: SocialRules;
  /** Rest-of-season value per player id, for everyone named below. */
  values: Map<string, PlayerValueRow>;
  /** Both teams' current rosters (before the swap). */
  proposerRoster: PlayerValueRow[];
  recipientRoster: PlayerValueRow[];
  source: ValuationSource;
};

/**
 * Score a proposal. Identical arithmetic and identical `fairness_detail` v1
 * shape to `scoreTrade` in `lib/services/trades/fairness.ts`.
 */
export function scoreTradePure(input: ScoreTradeInput): FairnessResult {
  const { rules } = input;
  const notes: string[] = [];
  if (input.source !== "snapshot") {
    notes.push(
      input.source === "projections"
        ? "No snapshot available; valued from the live projection table."
        : "No projection data available; players valued at zero.",
    );
  }

  // Roster fit is judged against the roster *before* the swap, minus whatever
  // that side is sending away, so a team does not "fit" a player it just traded.
  const proposerRoster = input.proposerRoster.filter((p) => !input.give.includes(p.playerId));
  const recipientRoster = input.recipientRoster.filter(
    (p) => !input.receive.includes(p.playerId),
  );

  const items: PlayerValuation[] = [];
  let proposerValue = 0;
  let recipientValue = 0;

  for (const playerId of input.receive) {
    const row = input.values.get(playerId) ?? unknownPlayer(playerId);
    const valuation = valuePlayer(row, input.proposerTeamId, proposerRoster, rules);
    items.push(valuation);
    proposerValue += valuation.value;
  }
  for (const playerId of input.give) {
    const row = input.values.get(playerId) ?? unknownPlayer(playerId);
    const valuation = valuePlayer(row, input.recipientTeamId, recipientRoster, rules);
    items.push(valuation);
    recipientValue += valuation.value;
  }

  const faab = input.faab ?? 0;
  const faabPoints = Math.abs(faab) * FAAB_POINTS_PER_DOLLAR;
  if (faab > 0) recipientValue += faabPoints;
  else if (faab < 0) proposerValue += faabPoints;

  const floor = rules.fairnessFloor ?? DEFAULT_FAIRNESS_FLOOR;
  const high = Math.max(proposerValue, recipientValue);
  const low = Math.min(proposerValue, recipientValue);
  const score = high <= 0 ? 1 : round(low / high, 4);
  if (high <= 0) notes.push("Both sides valued at zero; fairness defaults to 1.");

  const detail: FairnessDetailV1 = {
    version: 1,
    method: "ros_projection_v1",
    proposerValue: round(proposerValue),
    recipientValue: round(recipientValue),
    score,
    floor,
    flagged: score < floor,
    faab,
    faabPoints: round(faabPoints),
    items,
    notes,
    rosterFitAdjustment: items.some((i) => i.rosterFit > 1) ? ROSTER_FIT_BONUS : 1,
  };

  return { score, flagged: score < floor, detail };
}
