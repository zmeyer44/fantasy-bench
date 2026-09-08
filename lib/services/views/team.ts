/**
 * Team page read model (PRD 5.11): roster grouped by slot with projection /
 * injury / kickoff from the latest snapshot, the current lineup, record, karma,
 * FAAB, the current config version summary, recent runs and cost.
 */
import { and, desc, eq, sql } from "drizzle-orm";

import { db, type DbOrTx } from "@/lib/db";
import {
  agentConfigs,
  budgetRollups,
  configVersions,
  leagueRules,
  leagues,
  lineups,
  rosterSlots,
  players,
  teams,
} from "@/lib/db/schema";
import type { LineupSlot } from "@/lib/db/schema";
import type { HarnessSettings } from "@/lib/db/schema/config";

import { currentWeekNo } from "./league-home";
import {
  expandRosterSlots,
  isStartingSlot,
  latestSnapshot,
  liveScoreFor,
  modelLabel,
  round2,
  slotRank,
  snapshotPlayer,
} from "./shared";
import { standings, type StandingsRow } from "./standings";
import { recentRunsForTeam, type TraceListItem } from "./traces";

export type RosterEntry = {
  playerId: string;
  fullName: string;
  position: string;
  nflTeam: string | null;
  injuryStatus: string | null;
  byeWeek: number | null;
  acquiredVia: string;
  acquiredAt: Date;
  /** From the latest snapshot; null when no snapshot has been taken yet. */
  projection: number | null;
  livePoints: number | null;
  kickoffAt: string | null;
  opponent: string | null;
  /** The lineup slot this player currently occupies, or null if unassigned. */
  slot: string | null;
  starting: boolean;
};

export type TeamPage = {
  team: {
    id: string;
    leagueId: string;
    name: string;
    abbreviation: string;
    ownerUserId: string | null;
    ownerName: string | null;
    ownerEmail: string | null;
    faabRemaining: number;
    faabBudget: number;
    karma: number;
    waiverPriority: number;
  };
  league: { id: string; name: string; season: number; status: string };
  weekNo: number;
  record: Pick<StandingsRow, "wins" | "losses" | "ties" | "pointsFor" | "pointsAgainst" | "rank" | "streak">;
  roster: RosterEntry[];
  /** Roster grouped and ordered by lineup slot; unassigned players land in `BENCH`. */
  lineup: Array<{ slot: string; entry: RosterEntry | null; starting: boolean }>;
  lineupSource: string | null;
  lineupSetByRunId: string | null;
  projectedTotal: number;
  liveTotal: number;
  config: {
    configId: string | null;
    versionId: string | null;
    versionNo: number | null;
    modelId: string | null;
    modelLabel: string;
    harness: HarnessSettings | null;
    changeSummary: string | null;
    createdAt: Date | null;
    contextChars: number;
    hasPendingVersion: boolean;
  };
  recentRuns: TraceListItem[];
  cost: { seasonUsd: number; weekUsd: number; seasonTokens: number; runCount: number };
  snapshotTakenAt: Date | null;
};

export async function teamPage(
  teamId: string,
  opts: { now?: Date; executor?: DbOrTx } = {},
): Promise<TeamPage | null> {
  const executor = opts.executor ?? db;
  const now = opts.now ?? new Date();

  const team = await executor.query.teams.findFirst({
    where: eq(teams.id, teamId),
    with: { owner: true },
  });
  if (!team) return null;

  const league = await executor.query.leagues.findFirst({
    where: eq(leagues.id, team.leagueId),
  });
  if (!league) return null;

  const rules = await executor.query.leagueRules.findFirst({
    where: eq(leagueRules.leagueId, team.leagueId),
  });

  const weekNo = await currentWeekNo(team.leagueId, now, executor);
  const snapshot = await latestSnapshot(team.leagueId, executor);

  const rosterRows = await executor
    .select({
      playerId: players.id,
      fullName: players.fullName,
      position: players.position,
      nflTeam: players.nflTeam,
      injuryStatus: players.injuryStatus,
      byeWeek: players.byeWeek,
      acquiredVia: rosterSlots.acquiredVia,
      acquiredAt: rosterSlots.acquiredAt,
    })
    .from(rosterSlots)
    .innerJoin(players, eq(players.id, rosterSlots.playerId))
    .where(eq(rosterSlots.teamId, teamId));

  const [currentLineup] = await executor
    .select({
      slots: lineups.slots,
      source: lineups.source,
      setByRunId: lineups.setByRunId,
      version: lineups.version,
    })
    .from(lineups)
    .where(and(eq(lineups.teamId, teamId), eq(lineups.weekNo, weekNo)))
    .orderBy(desc(lineups.version))
    .limit(1);

  const slotByPlayer = new Map<string, string>();
  for (const slot of currentLineup?.slots ?? []) {
    if (slot.playerId) slotByPlayer.set(slot.playerId, slot.slot);
  }

  const roster: RosterEntry[] = rosterRows
    .map((row) => {
      const snap = snapshotPlayer(snapshot, row.playerId);
      const slot = slotByPlayer.get(row.playerId) ?? null;
      return {
        playerId: row.playerId,
        fullName: row.fullName,
        position: row.position,
        nflTeam: row.nflTeam,
        injuryStatus: snap?.injuryStatus ?? row.injuryStatus,
        byeWeek: row.byeWeek,
        acquiredVia: row.acquiredVia,
        acquiredAt: row.acquiredAt,
        projection: snap?.projection ? round2(projectionFor(snap.projection, rules?.scoringPreset)) : null,
        livePoints: liveScoreFor(snapshot, row.playerId),
        kickoffAt: snap?.kickoffAt ?? null,
        opponent: snap?.opponent ?? null,
        slot,
        starting: slot ? isStartingSlot(slot) : false,
      };
    })
    .sort((a, b) => {
      if (a.starting !== b.starting) return a.starting ? -1 : 1;
      const rank = slotRank(a.slot ?? "BENCH") - slotRank(b.slot ?? "BENCH");
      if (rank !== 0) return rank;
      return (b.projection ?? 0) - (a.projection ?? 0);
    });

  const entryByPlayer = new Map(roster.map((entry) => [entry.playerId, entry]));

  // Build the slot grid from the league's roster shape so empty slots are visible.
  const slotLabels =
    (currentLineup?.slots ?? []).length > 0
      ? (currentLineup!.slots as LineupSlot[]).map((s) => s.slot)
      : expandRosterSlots(rules?.rosterSlots ?? {});
  const assigned = new Set<string>();
  const lineup = slotLabels.map((slotLabel) => {
    const slotRow = (currentLineup?.slots ?? []).find((s) => s.slot === slotLabel);
    const entry = slotRow?.playerId ? (entryByPlayer.get(slotRow.playerId) ?? null) : null;
    if (entry) assigned.add(entry.playerId);
    return { slot: slotLabel, entry, starting: isStartingSlot(slotLabel) };
  });
  for (const entry of roster) {
    if (!assigned.has(entry.playerId)) {
      lineup.push({ slot: "BENCH", entry, starting: false });
    }
  }

  const table = await standings(team.leagueId, executor);
  const standing = table.find((row) => row.teamId === teamId);

  const config = await executor.query.agentConfigs.findFirst({
    where: eq(agentConfigs.teamId, teamId),
  });
  const version = config?.currentVersionId
    ? await executor.query.configVersions.findFirst({
        where: eq(configVersions.id, config.currentVersionId),
      })
    : undefined;

  const [costRow = { seasonUsd: 0, seasonTokens: 0, runCount: 0 }] = await executor
    .select({
      seasonUsd: sql<number>`coalesce(sum(${budgetRollups.usdUsed}), 0)::float8`,
      seasonTokens: sql<number>`coalesce(sum(${budgetRollups.tokensUsed}), 0)::int`,
      runCount: sql<number>`coalesce(sum(${budgetRollups.runCount}), 0)::int`,
    })
    .from(budgetRollups)
    .where(eq(budgetRollups.teamId, teamId));

  const [weekCost = { weekUsd: 0 }] = await executor
    .select({ weekUsd: sql<number>`coalesce(sum(${budgetRollups.usdUsed}), 0)::float8` })
    .from(budgetRollups)
    .where(and(eq(budgetRollups.teamId, teamId), eq(budgetRollups.weekNo, weekNo)));

  const recentRuns = await recentRunsForTeam(teamId, 8, executor);

  const projectedTotal = round2(
    lineup
      .filter((row) => row.starting && row.entry)
      .reduce((sum, row) => sum + (row.entry?.projection ?? 0), 0),
  );
  const liveTotal = round2(
    lineup
      .filter((row) => row.starting && row.entry)
      .reduce((sum, row) => sum + (row.entry?.livePoints ?? 0), 0),
  );

  return {
    team: {
      id: team.id,
      leagueId: team.leagueId,
      name: team.name,
      abbreviation: team.abbreviation,
      ownerUserId: team.ownerUserId,
      ownerName: team.owner?.name ?? null,
      ownerEmail: team.owner?.email ?? null,
      faabRemaining: team.faabRemaining,
      faabBudget: rules?.faabBudget ?? 0,
      karma: team.karma,
      waiverPriority: team.waiverPriority,
    },
    league: {
      id: league.id,
      name: league.name,
      season: league.season,
      status: league.status,
    },
    weekNo,
    record: {
      wins: standing?.wins ?? 0,
      losses: standing?.losses ?? 0,
      ties: standing?.ties ?? 0,
      pointsFor: standing?.pointsFor ?? 0,
      pointsAgainst: standing?.pointsAgainst ?? 0,
      rank: standing?.rank ?? 0,
      streak: standing?.streak ?? "—",
    },
    roster,
    lineup,
    lineupSource: currentLineup?.source ?? null,
    lineupSetByRunId: currentLineup?.setByRunId ?? null,
    projectedTotal,
    liveTotal,
    config: {
      configId: config?.id ?? null,
      versionId: version?.id ?? null,
      versionNo: version?.versionNo ?? null,
      modelId: version?.modelId ?? null,
      modelLabel: modelLabel(version?.modelId),
      harness: version?.harness ?? null,
      changeSummary: version?.changeSummary ?? null,
      createdAt: version?.createdAt ?? null,
      contextChars: version?.contextMd.length ?? 0,
      hasPendingVersion: Boolean(config?.pendingVersionId),
    },
    recentRuns,
    cost: {
      seasonUsd: round2(costRow.seasonUsd),
      weekUsd: round2(weekCost.weekUsd),
      seasonTokens: costRow.seasonTokens,
      runCount: costRow.runCount,
    },
    snapshotTakenAt: snapshot?.takenAt ?? null,
  };
}

function projectionFor(
  projection: { ppr: number; half: number; std: number },
  preset: string | undefined,
): number {
  if (preset === "half_ppr") return projection.half;
  if (preset === "standard") return projection.std;
  return projection.ppr;
}

/** Every team in a league with the badges the `/teams` grid needs. */
export type TeamCard = {
  id: string;
  name: string;
  abbreviation: string;
  ownerUserId: string | null;
  ownerName: string | null;
  record: string;
  rank: number;
  pointsFor: number;
  karma: number;
  faabRemaining: number;
  modelId: string | null;
  modelLabel: string;
  configVersionNo: number | null;
};

export async function teamCards(
  leagueId: string,
  executor: DbOrTx = db,
): Promise<TeamCard[]> {
  const table = await standings(leagueId, executor);
  const rows = await executor.query.teams.findMany({
    where: eq(teams.leagueId, leagueId),
    with: { owner: true },
  });
  const ownerById = new Map(rows.map((row) => [row.id, row.owner?.name ?? null]));

  return table.map((row) => ({
    id: row.teamId,
    name: row.teamName,
    abbreviation: row.abbreviation,
    ownerUserId: row.ownerUserId,
    ownerName: ownerById.get(row.teamId) ?? null,
    record: `${row.wins}-${row.losses}${row.ties ? `-${row.ties}` : ""}`,
    rank: row.rank,
    pointsFor: row.pointsFor,
    karma: row.karma,
    faabRemaining: row.faabRemaining,
    modelId: row.modelId,
    modelLabel: modelLabel(row.modelId),
    configVersionNo: row.configVersionNo,
  }));
}
