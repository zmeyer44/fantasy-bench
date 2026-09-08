/**
 * Deterministic trade fairness (PRD 5.6 "Review and fairness").
 *
 * The number is computed here and only here. The Commissioner Agent may attach
 * a one-paragraph narrative to `fairness_detail.narrative`, but it never moves
 * the score — a model deciding which trades get vetoed would make the game
 * unauditable.
 *
 * v1 formula
 * ----------
 *   playerValue = rosProjection × positionalScarcity × rosterFit
 *     rosProjection    latest snapshot's `rosProjection`, else this week's
 *                      projection × remaining weeks
 *     scarcity         fixed multipliers (RB/TE scarce, K/DEF fungible;
 *                      QB rises in superflex)
 *     rosterFit        ×1.10 when the receiving team would actually start them
 *   sideValue   = Σ playerValue of the package that side receives
 *                 + FAAB received × FAAB_POINTS_PER_DOLLAR
 *   fairness    = min(sideA, sideB) / max(sideA, sideB)  ∈ [0, 1]
 *   flagged     = fairness < league_rules.fairness_floor (default 0.6)
 */
import { and, desc, eq, inArray } from "drizzle-orm";

import { db, type DbOrTx } from "@/lib/db";
import {
  leagues,
  playerProjections,
  players,
  rosterSlots,
  snapshots,
  tradeItems,
  trades,
} from "@/lib/db/schema";
import type { FairnessDetail, RosterSlots } from "@/lib/db/schema";
import { loadSocialRules, type SocialRules } from "@/lib/services/messaging/shared";
import { loadSnapshot } from "@/lib/services/snapshot";
import type { SnapshotPayload } from "@/lib/snapshot/types";

/** PRD default; used when `league_rules.fairness_floor` is null. */
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

export type PlayerValuation = {
  playerId: string;
  playerName: string;
  position: string;
  /** Rest-of-season projected points before multipliers. */
  baseRos: number;
  scarcity: number;
  /** 1.0, or ROSTER_FIT_BONUS when the receiving team would start them. */
  rosterFit: number;
  value: number;
  /** Team that ends up with the player. */
  toTeamId: string;
};

export type FairnessDetailV1 = FairnessDetail & {
  version: 1;
  method: "ros_projection_v1";
  /** Value of the package the proposer receives. */
  proposerValue: number;
  /** Value of the package the recipient receives. */
  recipientValue: number;
  score: number;
  floor: number;
  flagged: boolean;
  /** Net FAAB proposer → recipient, and its point equivalent. */
  faab: number;
  faabPoints: number;
  items: PlayerValuation[];
  notes: string[];
  /** Optional Commissioner-Agent prose. Never affects the score. */
  narrative?: string;
};

export type FairnessResult = {
  score: number;
  flagged: boolean;
  detail: FairnessDetailV1;
};

// ------------------------------------------------------------- valuation data

export type PlayerValueRow = {
  playerId: string;
  name: string;
  position: string;
  /** Rest-of-season projected points. */
  ros: number;
};

export type ValuationContext = {
  weekNo: number;
  remainingWeeks: number;
  rules: SocialRules;
  values: Map<string, PlayerValueRow>;
  source: "snapshot" | "projections" | "none";
};

function remainingWeeksFor(rules: SocialRules, weekNo: number): number {
  return Math.max(1, (rules.seasonWeeks ?? 17) - weekNo + 1);
}

/**
 * Rest-of-season value per player.
 *
 * Prefers the league's latest snapshot (agents and the scorer must agree on the
 * numbers they can see); falls back to the live projections table so fairness
 * still works before the first snapshot exists.
 */
export async function buildValuationContext(
  leagueId: string,
  weekNo: number,
  executor: DbOrTx = db,
  rulesArg?: SocialRules,
): Promise<ValuationContext> {
  const rules = rulesArg ?? (await loadSocialRules(leagueId, executor));
  const remainingWeeks = remainingWeeksFor(rules, weekNo);
  const values = new Map<string, PlayerValueRow>();

  const payload = await latestSnapshotPayload(leagueId, executor);
  if (payload) {
    for (const [id, player] of Object.entries(payload.players ?? {})) {
      const weekly = pickProjection(player.projection, rules.scoringPreset);
      const ros = player.rosProjection ?? weekly * remainingWeeks;
      values.set(id, {
        playerId: id,
        name: player.fullName,
        position: player.position,
        ros: Number.isFinite(ros) ? ros : 0,
      });
    }
    if (values.size > 0) {
      return { weekNo, remainingWeeks, rules, values, source: "snapshot" };
    }
  }

  // No snapshot yet — derive from the newest projection vintage for the week.
  const league = await executor.query.leagues.findFirst({ where: eq(leagues.id, leagueId) });
  if (league) {
    const rows = await executor
      .select({
        playerId: players.id,
        name: players.fullName,
        position: players.position,
        ppr: playerProjections.projectedPointsPpr,
        half: playerProjections.projectedPointsHalf,
        std: playerProjections.projectedPointsStd,
        effectiveAt: playerProjections.effectiveAt,
      })
      .from(playerProjections)
      .innerJoin(players, eq(players.id, playerProjections.playerId))
      .where(
        and(
          eq(playerProjections.season, league.season),
          eq(playerProjections.week, weekNo),
        ),
      )
      .orderBy(desc(playerProjections.effectiveAt));

    for (const row of rows) {
      // Rows arrive newest-first; the first one wins per player.
      if (values.has(row.playerId)) continue;
      const weekly =
        rules.scoringPreset === "standard"
          ? (row.std ?? 0)
          : rules.scoringPreset === "half_ppr"
            ? (row.half ?? 0)
            : (row.ppr ?? 0);
      values.set(row.playerId, {
        playerId: row.playerId,
        name: row.name,
        position: row.position,
        ros: weekly * remainingWeeks,
      });
    }
  }

  return {
    weekNo,
    remainingWeeks,
    rules,
    values,
    source: values.size > 0 ? "projections" : "none",
  };
}

function pickProjection(
  projection: SnapshotPayload["players"][string]["projection"],
  preset: SocialRules["scoringPreset"],
): number {
  if (!projection) return 0;
  if (preset === "standard") return projection.std ?? 0;
  if (preset === "half_ppr") return projection.half ?? 0;
  return projection.ppr ?? 0;
}

/**
 * The newest snapshot payload for the league.
 *
 * Goes through the scheduler package's `loadSnapshot` contract so we pick up
 * whatever materialization it settles on; if that is still a stub, read the row
 * directly rather than failing the trade.
 */
async function latestSnapshotPayload(
  leagueId: string,
  executor: DbOrTx,
): Promise<SnapshotPayload | null> {
  const [row] = await executor
    .select({ id: snapshots.id, payload: snapshots.payload })
    .from(snapshots)
    .where(eq(snapshots.leagueId, leagueId))
    .orderBy(desc(snapshots.takenAt))
    .limit(1);
  if (!row) return null;
  try {
    const loaded = await loadSnapshot(row.id, executor);
    return loaded.payload;
  } catch {
    return row.payload ?? null;
  }
}

// ----------------------------------------------------------------- valuation

export function scarcityFor(position: string, rules: SocialRules): number {
  if (position === "QB" && rules.superflex) return SUPERFLEX_QB_SCARCITY;
  if (position === "TE" && rules.tePremium) return (POSITION_SCARCITY.TE ?? 1) + 0.1;
  return POSITION_SCARCITY[position] ?? 1;
}

/** Starting slots a position competes for, counting FLEX for RB/WR/TE. */
export function startingSlotsFor(position: string, slots: RosterSlots): number {
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
  slots: RosterSlots,
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

// ------------------------------------------------------------------- scoring

export type FairnessTradeInput = {
  leagueId: string;
  proposerTeamId: string;
  recipientTeamId: string;
  weekNo: number;
  /** Players moving proposer → recipient. */
  give: string[];
  /** Players moving recipient → proposer. */
  receive: string[];
  /** Net FAAB proposer → recipient. */
  faab?: number;
};

/**
 * Score a proposal that may not be persisted yet (used by `respondToTrade`
 * before the accept transaction commits, and by tests).
 */
export async function scoreTrade(
  input: FairnessTradeInput,
  executor: DbOrTx = db,
): Promise<FairnessResult> {
  const rules = await loadSocialRules(input.leagueId, executor);
  const ctx = await buildValuationContext(input.leagueId, input.weekNo, executor, rules);
  const notes: string[] = [];
  if (ctx.source !== "snapshot") {
    notes.push(
      ctx.source === "projections"
        ? "No snapshot available; valued from the live projection table."
        : "No projection data available; players valued at zero.",
    );
  }

  const rosters = await loadRosters(
    [input.proposerTeamId, input.recipientTeamId],
    ctx,
    executor,
  );
  // Roster fit is judged against the roster *before* the swap, minus whatever
  // that side is sending away, so a team does not "fit" a player it just traded.
  const proposerRoster = (rosters.get(input.proposerTeamId) ?? []).filter(
    (p) => !input.give.includes(p.playerId),
  );
  const recipientRoster = (rosters.get(input.recipientTeamId) ?? []).filter(
    (p) => !input.receive.includes(p.playerId),
  );

  const items: PlayerValuation[] = [];
  let proposerValue = 0;
  let recipientValue = 0;

  for (const playerId of input.receive) {
    const row = ctx.values.get(playerId) ?? unknownPlayer(playerId);
    const valuation = valuePlayer(row, input.proposerTeamId, proposerRoster, rules);
    items.push(valuation);
    proposerValue += valuation.value;
  }
  for (const playerId of input.give) {
    const row = ctx.values.get(playerId) ?? unknownPlayer(playerId);
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

/** Score a persisted trade by id. */
export async function scoreTradeById(
  tradeId: string,
  executor: DbOrTx = db,
): Promise<FairnessResult | null> {
  const trade = await executor.query.trades.findFirst({ where: eq(trades.id, tradeId) });
  if (!trade) return null;
  const items = await executor
    .select()
    .from(tradeItems)
    .where(eq(tradeItems.tradeId, tradeId));

  const give: string[] = [];
  const receive: string[] = [];
  let faab = 0;
  for (const item of items) {
    if (item.playerId) {
      if (item.fromTeamId === trade.proposerTeamId) give.push(item.playerId);
      else receive.push(item.playerId);
    } else if (item.faab) {
      faab += item.fromTeamId === trade.proposerTeamId ? item.faab : -item.faab;
    }
  }

  return scoreTrade(
    {
      leagueId: trade.leagueId,
      proposerTeamId: trade.proposerTeamId,
      recipientTeamId: trade.recipientTeamId,
      weekNo: trade.weekNo ?? 1,
      give,
      receive,
      faab,
    },
    executor,
  );
}

async function loadRosters(
  teamIds: string[],
  ctx: ValuationContext,
  executor: DbOrTx,
): Promise<Map<string, PlayerValueRow[]>> {
  const rows = await executor
    .select({
      teamId: rosterSlots.teamId,
      playerId: rosterSlots.playerId,
      name: players.fullName,
      position: players.position,
    })
    .from(rosterSlots)
    .innerJoin(players, eq(players.id, rosterSlots.playerId))
    .where(inArray(rosterSlots.teamId, teamIds));

  const byTeam = new Map<string, PlayerValueRow[]>();
  for (const row of rows) {
    const value = ctx.values.get(row.playerId);
    const entry: PlayerValueRow = {
      playerId: row.playerId,
      name: value?.name ?? row.name,
      position: value?.position ?? row.position,
      ros: value?.ros ?? 0,
    };
    const list = byTeam.get(row.teamId);
    if (list) list.push(entry);
    else byTeam.set(row.teamId, [entry]);
  }
  return byTeam;
}

function unknownPlayer(playerId: string): PlayerValueRow {
  return { playerId, name: "Unknown player", position: "WR", ros: 0 };
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
