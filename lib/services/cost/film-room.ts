/**
 * The film room read model (PRD 5.5 "Film room").
 *
 * The owner's Tuesday landing page: what the agent did last week, how well it
 * did it, and what it cost. This composes read models owned by other packages
 * (`lib/services/lineup`, `lib/services/scoring`, `lib/services/snapshot`) with
 * the ledger rollups in this module — it deliberately owns no rules of its own.
 *
 * It lives under `lib/services/cost` because spend-vs-budget is the only part
 * of it this work package owns outright; if a `film-room` domain is ever carved
 * out, move this file wholesale.
 */
import { and, asc, desc, eq, inArray, or } from "drizzle-orm";

import { db, type DbOrTx } from "@/lib/db";
import {
  leagueRules,
  leagues,
  players,
  runs,
  snapshots,
  teamResults,
  teams,
  trades,
  waiverClaims,
  weeks,
  windows,
} from "@/lib/db/schema";
import {
  BENCH_SLOTS,
  computeOptimalLineup,
  getCurrentLineup,
  lineupEfficiency,
  pointsLeftOnBench,
  projectedPoints,
} from "@/lib/services/lineup";
import { playerPointsForWeek } from "@/lib/services/scoring";
import type { LineupSlot, SnapshotPayload } from "@/lib/snapshot/types";

import { budgetStatus, teamSeasonSpend, teamWeekSpend, type BudgetStatus, type SpendTotals } from "./index";

export type FilmRoomRun = {
  runId: string;
  windowLabel: string;
  windowType: string;
  opensAt: Date;
  status: string;
  outcome: string | null;
  rationale: string | null;
  stepCount: number;
  costUsd: number;
  modelId: string;
  fallback: string | null;
};

export type FilmRoomEfficiency = {
  /** "actual" once the week has stat lines; "projected" while it is still open. */
  basis: "actual" | "projected";
  /** Points the agent's committed lineup actually scored. */
  actual: number;
  /**
   * Points the best lineup *by Sunday-morning projection* would have scored,
   * measured on the same basis as `actual`. This is a decision-quality metric,
   * not hindsight: it asks what the best call was with the information the agent
   * had, then scores that call the same way the agent's was scored.
   */
  optimal: number;
  efficiency: number;
  pointsLeftOnBench: number;
  actualSlots: Array<{ slot: string; playerId: string | null; playerName: string | null; points: number }>;
  optimalSlots: Array<{ slot: string; playerId: string | null; playerName: string | null; points: number }>;
  snapshotTakenAt: Date;
};

export type FilmRoomWaiver = {
  id: string;
  addPlayerName: string | null;
  dropPlayerName: string | null;
  bid: number;
  status: string;
  resultReason: string | null;
  runId: string | null;
};

export type FilmRoomTrade = {
  id: string;
  status: string;
  counterpartyName: string | null;
  proposedByMe: boolean;
  fairnessScore: number | null;
  flagged: boolean;
  createdAt: Date;
};

export type FilmRoom = {
  team: { id: string; name: string; abbreviation: string; ownerUserId: string | null };
  leagueId: string;
  weekNo: number;
  /** Every week that has data, for the week picker. */
  availableWeeks: number[];
  runs: FilmRoomRun[];
  efficiency: FilmRoomEfficiency | null;
  /** Why efficiency is null, for the "n/a" copy. */
  efficiencyUnavailableReason: string | null;
  result: { pointsFor: number; pointsAgainst: number; won: boolean; lost: boolean; tied: boolean } | null;
  waivers: FilmRoomWaiver[];
  trades: FilmRoomTrade[];
  spend: SpendTotals & { teamId: string; weekNo: number };
  seasonSpend: number;
  budget: BudgetStatus;
  noteToAgent: string | null;
};

/** The league week `now` falls in (the first week that has not ended yet). */
export async function currentLeagueWeek(
  leagueId: string,
  now: Date = new Date(),
  executor: DbOrTx = db,
): Promise<number> {
  const rows = await executor
    .select({ weekNo: weeks.weekNo, endsAt: weeks.endsAt })
    .from(weeks)
    .where(eq(weeks.leagueId, leagueId))
    .orderBy(asc(weeks.weekNo));
  const open = rows.find((w) => w.endsAt.getTime() > now.getTime());
  return open?.weekNo ?? rows.at(-1)?.weekNo ?? 1;
}

/**
 * The week the film room defaults to: the most recently *finished* league week,
 * falling back to week 1 before any week has closed.
 */
export async function defaultFilmRoomWeek(
  leagueId: string,
  now: Date = new Date(),
  executor: DbOrTx = db,
): Promise<number> {
  const rows = await executor
    .select({ weekNo: weeks.weekNo, endsAt: weeks.endsAt })
    .from(weeks)
    .where(eq(weeks.leagueId, leagueId))
    .orderBy(asc(weeks.weekNo));

  const finished = rows.filter((w) => w.endsAt.getTime() <= now.getTime());
  if (finished.length > 0) return finished.at(-1)!.weekNo;
  return rows[0]?.weekNo ?? 1;
}

function startingOnly(slots: LineupSlot[]): LineupSlot[] {
  return slots.filter((s) => !BENCH_SLOTS.has(s.slot.toUpperCase()));
}

function scoreWith(slots: LineupSlot[], points: Record<string, number>): number {
  let total = 0;
  for (const entry of startingOnly(slots)) {
    if (entry.playerId) total += points[entry.playerId] ?? 0;
  }
  return Math.round(total * 100) / 100;
}

/** Everything on the Tuesday landing page for one team-week. */
export async function filmRoom(
  args: { teamId: string; weekNo?: number; now?: Date },
  executor: DbOrTx = db,
): Promise<FilmRoom | null> {
  const now = args.now ?? new Date();

  const team = await executor.query.teams.findFirst({ where: eq(teams.id, args.teamId) });
  if (!team) return null;

  const league = await executor.query.leagues.findFirst({ where: eq(leagues.id, team.leagueId) });
  if (!league) return null;

  const rules = await executor.query.leagueRules.findFirst({
    where: eq(leagueRules.leagueId, team.leagueId),
  });

  const weekNo = args.weekNo ?? (await defaultFilmRoomWeek(team.leagueId, now, executor));

  const weekRows = await executor
    .select({ weekNo: weeks.weekNo })
    .from(weeks)
    .where(eq(weeks.leagueId, team.leagueId))
    .orderBy(asc(weeks.weekNo));

  // ---- runs -----------------------------------------------------------------
  const runRows = await executor
    .select({
      runId: runs.id,
      windowLabel: windows.label,
      windowType: windows.type,
      opensAt: windows.opensAt,
      status: runs.status,
      outcome: runs.outcome,
      rationale: runs.rationale,
      stepCount: runs.stepCount,
      costUsd: runs.totalCostUsd,
      modelId: runs.modelId,
      fallbackApplied: runs.fallbackApplied,
    })
    .from(runs)
    .innerJoin(windows, eq(windows.id, runs.windowId))
    .where(and(eq(runs.teamId, args.teamId), eq(windows.weekNo, weekNo)))
    .orderBy(asc(windows.opensAt));

  // ---- lineup efficiency ----------------------------------------------------
  let efficiency: FilmRoomEfficiency | null = null;
  let efficiencyUnavailableReason: string | null = null;

  const [snapshotRow] = await executor
    .select({ id: snapshots.id, payload: snapshots.payload, takenAt: snapshots.takenAt })
    .from(snapshots)
    .leftJoin(windows, eq(windows.id, snapshots.windowId))
    .where(and(eq(snapshots.leagueId, team.leagueId), eq(snapshots.weekNo, weekNo)))
    // Prefer the last snapshot of the week — the fullest picture the agent saw.
    .orderBy(desc(snapshots.takenAt))
    .limit(1);

  if (!snapshotRow) {
    efficiencyUnavailableReason = `No snapshot was stored for week ${weekNo}, so there is nothing to compare against.`;
  } else {
    const payload = snapshotRow.payload as SnapshotPayload;
    const inSnapshot = payload.teams?.some((t) => t.id === args.teamId);
    if (!inSnapshot) {
      efficiencyUnavailableReason = `This team is not in week ${weekNo}'s snapshot.`;
    } else {
      const lineup = await getCurrentLineup({ teamId: args.teamId, weekNo }, executor);
      const snapshotTeam = payload.teams.find((t) => t.id === args.teamId)!;
      const actualSlots = lineup?.slots ?? snapshotTeam.lineup ?? [];
      const optimalSlots = computeOptimalLineup({
        snapshot: payload,
        teamId: args.teamId,
        current: actualSlots,
        now: new Date(payload.takenAt),
      });

      const rosterIds = snapshotTeam.rosterPlayerIds ?? [];
      const actualPoints = await playerPointsForWeek(
        league.season,
        weekNo,
        payload.rules.scoringPreset,
        { tePremium: rules?.tePremium ?? false, playerIds: rosterIds },
        executor,
      ).catch(() => ({}) as Record<string, number>);

      const haveActuals = Object.values(actualPoints).some((v) => v !== 0);
      const points: Record<string, number> = haveActuals
        ? actualPoints
        : Object.fromEntries(
            rosterIds.map((id) => [
              id,
              projectedPoints(payload.players[id], payload.rules.scoringPreset),
            ]),
          );

      const actual = scoreWith(actualSlots, points);
      const optimal = scoreWith(optimalSlots, points);

      const nameOf = (id: string | null) =>
        id ? (payload.players[id]?.fullName ?? null) : null;
      const decorate = (slots: LineupSlot[]) =>
        startingOnly(slots).map((s) => ({
          slot: s.slot,
          playerId: s.playerId,
          playerName: nameOf(s.playerId),
          points: s.playerId ? Math.round((points[s.playerId] ?? 0) * 100) / 100 : 0,
        }));

      efficiency = {
        basis: haveActuals ? "actual" : "projected",
        actual,
        optimal,
        efficiency: lineupEfficiency({ actual, optimal }),
        pointsLeftOnBench: pointsLeftOnBench({ actual, optimal }),
        actualSlots: decorate(actualSlots),
        optimalSlots: decorate(optimalSlots),
        snapshotTakenAt: snapshotRow.takenAt,
      };
    }
  }

  // ---- waivers --------------------------------------------------------------
  const claimRows = await executor
    .select({
      id: waiverClaims.id,
      addPlayerId: waiverClaims.addPlayerId,
      dropPlayerId: waiverClaims.dropPlayerId,
      bid: waiverClaims.bid,
      status: waiverClaims.status,
      resultReason: waiverClaims.resultReason,
      runId: waiverClaims.runId,
    })
    .from(waiverClaims)
    .where(and(eq(waiverClaims.teamId, args.teamId), eq(waiverClaims.weekNo, weekNo)))
    .orderBy(asc(waiverClaims.priority));

  const playerIds = [
    ...new Set(
      claimRows.flatMap((c) => [c.addPlayerId, c.dropPlayerId].filter((v): v is string => !!v)),
    ),
  ];
  const playerNames = new Map<string, string>();
  if (playerIds.length > 0) {
    const rows = await executor
      .select({ id: players.id, fullName: players.fullName })
      .from(players)
      .where(inArray(players.id, playerIds));
    for (const row of rows) playerNames.set(row.id, row.fullName);
  }

  // ---- trades ---------------------------------------------------------------
  const tradeRows = await executor
    .select({
      id: trades.id,
      status: trades.status,
      proposerTeamId: trades.proposerTeamId,
      recipientTeamId: trades.recipientTeamId,
      fairnessScore: trades.fairnessScore,
      flagged: trades.flagged,
      createdAt: trades.createdAt,
    })
    .from(trades)
    .where(
      and(
        eq(trades.leagueId, team.leagueId),
        or(eq(trades.proposerTeamId, args.teamId), eq(trades.recipientTeamId, args.teamId)),
      ),
    )
    .orderBy(desc(trades.createdAt))
    .limit(20);

  const counterpartyIds = [
    ...new Set(
      tradeRows.map((t) =>
        t.proposerTeamId === args.teamId ? t.recipientTeamId : t.proposerTeamId,
      ),
    ),
  ];
  const teamNames = new Map<string, string>();
  if (counterpartyIds.length > 0) {
    const rows = await executor
      .select({ id: teams.id, name: teams.name })
      .from(teams)
      .where(inArray(teams.id, counterpartyIds));
    for (const row of rows) teamNames.set(row.id, row.name);
  }

  // ---- spend + result -------------------------------------------------------
  const [spend, season, budget, result, config] = await Promise.all([
    teamWeekSpend(args.teamId, weekNo, executor),
    teamSeasonSpend(args.teamId, executor),
    budgetStatus(args.teamId, weekNo, executor),
    executor.query.teamResults.findFirst({
      where: and(eq(teamResults.teamId, args.teamId), eq(teamResults.weekNo, weekNo)),
    }),
    executor.query.agentConfigs.findFirst({
      where: (c, { eq: equals }) => equals(c.teamId, args.teamId),
    }),
  ]);

  return {
    team: {
      id: team.id,
      name: team.name,
      abbreviation: team.abbreviation,
      ownerUserId: team.ownerUserId,
    },
    leagueId: team.leagueId,
    weekNo,
    availableWeeks: weekRows.map((w) => w.weekNo),
    runs: runRows.map((r) => ({
      runId: r.runId,
      windowLabel: r.windowLabel,
      windowType: r.windowType,
      opensAt: r.opensAt,
      status: r.status,
      outcome: r.outcome,
      rationale: r.rationale,
      stepCount: r.stepCount,
      costUsd: r.costUsd,
      modelId: r.modelId,
      fallback: r.fallbackApplied?.kind ?? null,
    })),
    efficiency,
    efficiencyUnavailableReason,
    result: result
      ? {
          pointsFor: result.pointsFor,
          pointsAgainst: result.pointsAgainst,
          won: result.won,
          lost: result.lost,
          tied: result.tied,
        }
      : null,
    waivers: claimRows.map((c) => ({
      id: c.id,
      addPlayerName: playerNames.get(c.addPlayerId) ?? null,
      dropPlayerName: c.dropPlayerId ? (playerNames.get(c.dropPlayerId) ?? null) : null,
      bid: c.bid,
      status: c.status,
      resultReason: c.resultReason,
      runId: c.runId,
    })),
    trades: tradeRows.map((t) => ({
      id: t.id,
      status: t.status,
      counterpartyName:
        teamNames.get(t.proposerTeamId === args.teamId ? t.recipientTeamId : t.proposerTeamId) ??
        null,
      proposedByMe: t.proposerTeamId === args.teamId,
      fairnessScore: t.fairnessScore,
      flagged: t.flagged,
      createdAt: t.createdAt,
    })),
    spend,
    seasonSpend: season.usd,
    budget,
    noteToAgent: config?.noteToAgent ?? null,
  };
}
