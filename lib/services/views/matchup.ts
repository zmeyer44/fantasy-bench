/**
 * Matchup read model (PRD 5.11): both lineups with per-slot points and
 * projection, plus a rationale excerpt from the run that set each lineup.
 */
import { and, desc, eq, inArray } from "drizzle-orm";

import { db, type DbOrTx } from "@/lib/db";
import {
  leagueRules,
  lineups,
  matchups,
  players,
  runs,
  teams,
  windows,
} from "@/lib/db/schema";

import { currentWeekNo } from "./league-home";
import {
  isStartingSlot,
  latestSnapshot,
  liveScoreFor,
  round2,
  snapshotPlayer,
  windowLabelText,
} from "./shared";
import { standings } from "./standings";

export type MatchupSlot = {
  slot: string;
  starting: boolean;
  playerId: string | null;
  playerName: string | null;
  position: string | null;
  nflTeam: string | null;
  opponent: string | null;
  injuryStatus: string | null;
  kickoffAt: string | null;
  projection: number | null;
  points: number | null;
};

export type MatchupTeamView = {
  teamId: string;
  teamName: string;
  abbreviation: string;
  record: string;
  slots: MatchupSlot[];
  projectedTotal: number;
  liveTotal: number;
  officialScore: number;
  lineupSource: string | null;
  /** The run that set this lineup, with its public rationale (PRD 5.11). */
  rationale: {
    runId: string;
    windowLabel: string;
    excerpt: string | null;
    fullText: string | null;
    modelId: string;
    status: string;
  } | null;
};

export type MatchupPage = {
  leagueId: string;
  weekNo: number;
  matchupId: string;
  isFinal: boolean;
  home: MatchupTeamView;
  away: MatchupTeamView;
};

const EXCERPT_CHARS = 260;

export function excerpt(text: string | null, max = EXCERPT_CHARS): string | null {
  if (!text) return null;
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max).replace(/\s+\S*$/, "")}…`;
}

/** Every matchup for a week (the `/matchups/[weekNo]` index). */
export async function matchupsForWeek(
  leagueId: string,
  weekNo: number,
  executor: DbOrTx = db,
) {
  const { buildMatchups } = await import("./league-home");
  const [snapshot, table, teamRows] = await Promise.all([
    latestSnapshot(leagueId, executor),
    standings(leagueId, executor),
    executor.select().from(teams).where(eq(teams.leagueId, leagueId)),
  ]);
  return buildMatchups({
    leagueId,
    weekNo,
    teamById: new Map(teamRows.map((t) => [t.id, t])),
    standingById: new Map(table.map((row) => [row.teamId, row])),
    snapshot,
    executor,
  });
}

export async function matchupPage(
  leagueId: string,
  weekNo: number,
  matchupId: string,
  opts: { now?: Date; executor?: DbOrTx } = {},
): Promise<MatchupPage | null> {
  const executor = opts.executor ?? db;

  const matchup = await executor.query.matchups.findFirst({
    where: and(eq(matchups.id, matchupId), eq(matchups.leagueId, leagueId)),
  });
  if (!matchup) return null;

  const rules = await executor.query.leagueRules.findFirst({
    where: eq(leagueRules.leagueId, leagueId),
  });
  const preset = rules?.scoringPreset ?? "ppr";

  const snapshot = await latestSnapshot(leagueId, executor);
  const table = await standings(leagueId, executor);

  const [home, away] = await Promise.all([
    buildSide(matchup.homeTeamId, weekNo, matchup.homeScore, preset, snapshot, table, executor),
    buildSide(matchup.awayTeamId, weekNo, matchup.awayScore, preset, snapshot, table, executor),
  ]);

  return {
    leagueId,
    weekNo,
    matchupId,
    isFinal: matchup.isFinal,
    home,
    away,
  };
}

async function buildSide(
  teamId: string,
  weekNo: number,
  officialScore: number,
  preset: string,
  snapshot: Awaited<ReturnType<typeof latestSnapshot>>,
  table: Awaited<ReturnType<typeof standings>>,
  executor: DbOrTx,
): Promise<MatchupTeamView> {
  const team = await executor.query.teams.findFirst({ where: eq(teams.id, teamId) });
  const standing = table.find((row) => row.teamId === teamId);

  const [lineup] = await executor
    .select({
      slots: lineups.slots,
      source: lineups.source,
      setByRunId: lineups.setByRunId,
    })
    .from(lineups)
    .where(and(eq(lineups.teamId, teamId), eq(lineups.weekNo, weekNo)))
    .orderBy(desc(lineups.version))
    .limit(1);

  const slotRows = lineup?.slots ?? [];
  const playerIds = slotRows
    .map((slot) => slot.playerId)
    .filter((id): id is string => id !== null);

  const playerRows =
    playerIds.length > 0
      ? await executor
          .select({
            id: players.id,
            fullName: players.fullName,
            position: players.position,
            nflTeam: players.nflTeam,
            injuryStatus: players.injuryStatus,
          })
          .from(players)
          .where(inArray(players.id, playerIds))
      : [];
  const playerById = new Map(playerRows.map((p) => [p.id, p]));

  const slots: MatchupSlot[] = slotRows.map((slot) => {
    const player = slot.playerId ? playerById.get(slot.playerId) : undefined;
    const snap = snapshotPlayer(snapshot, slot.playerId);
    const projection = snap?.projection
      ? preset === "half_ppr"
        ? snap.projection.half
        : preset === "standard"
          ? snap.projection.std
          : snap.projection.ppr
      : null;
    return {
      slot: slot.slot,
      starting: isStartingSlot(slot.slot),
      playerId: slot.playerId,
      playerName: player?.fullName ?? null,
      position: player?.position ?? null,
      nflTeam: player?.nflTeam ?? null,
      opponent: snap?.opponent ?? null,
      injuryStatus: snap?.injuryStatus ?? player?.injuryStatus ?? null,
      kickoffAt: snap?.kickoffAt ?? null,
      projection: projection === null ? null : round2(projection),
      points: liveScoreFor(snapshot, slot.playerId),
    };
  });

  const starters = slots.filter((slot) => slot.starting);

  let rationale: MatchupTeamView["rationale"] = null;
  if (lineup?.setByRunId) {
    const [row] = await executor
      .select({
        id: runs.id,
        rationale: runs.rationale,
        modelId: runs.modelId,
        status: runs.status,
        windowLabel: windows.label,
      })
      .from(runs)
      .innerJoin(windows, eq(windows.id, runs.windowId))
      .where(eq(runs.id, lineup.setByRunId))
      .limit(1);
    if (row) {
      rationale = {
        runId: row.id,
        windowLabel: windowLabelText(row.windowLabel),
        excerpt: excerpt(row.rationale),
        fullText: row.rationale,
        modelId: row.modelId,
        status: row.status,
      };
    }
  }

  return {
    teamId,
    teamName: team?.name ?? "Unknown",
    abbreviation: team?.abbreviation ?? "??",
    record: standing
      ? `${standing.wins}-${standing.losses}${standing.ties ? `-${standing.ties}` : ""}`
      : "0-0",
    slots,
    projectedTotal: round2(starters.reduce((sum, slot) => sum + (slot.projection ?? 0), 0)),
    liveTotal: round2(starters.reduce((sum, slot) => sum + (slot.points ?? 0), 0)),
    officialScore: round2(officialScore),
    lineupSource: lineup?.source ?? null,
    rationale,
  };
}

export { currentWeekNo };
