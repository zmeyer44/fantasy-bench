/**
 * Live draft board (PRD 5.2).
 *
 * The scheduler package owns `lib/services/draft`, but its exported surface is
 * still moving (`getDraftBoard` came and went while this was being written), so
 * the board is read straight from the `draft_picks` table it populates. The
 * shape below is what the page consumes; if the scheduler later exposes
 * `getDraftBoard(leagueId)` returning this shape, `draftBoard` becomes a
 * one-line delegate.
 */
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import { db, type DbOrTx } from "@/lib/db";
import { draftPicks, leagues, players, runs, teams, windows } from "@/lib/db/schema";
import type { DraftType, LeagueStatus } from "@/lib/db/types";

import { round2 } from "./shared";

export type DraftBoardPick = {
  id: string;
  round: number;
  pickNo: number;
  overallNo: number;
  teamId: string;
  teamName: string;
  teamAbbreviation: string;
  playerId: string | null;
  playerName: string | null;
  position: string | null;
  nflTeam: string | null;
  price: number | null;
  auto: boolean;
  rationale: string | null;
  runId: string | null;
  costUsd: number | null;
  madeAt: Date | null;
};

export type DraftBoard = {
  leagueId: string;
  draftType: DraftType;
  status: LeagueStatus;
  scheduledAt: Date | null;
  rounds: number;
  teams: Array<{ id: string; name: string; abbreviation: string; slotIndex: number }>;
  picks: DraftBoardPick[];
  /** `grid[round - 1][slotIndex]` — the pick for that cell, or undefined. */
  grid: Array<Array<DraftBoardPick | undefined>>;
  onTheClock: {
    teamId: string;
    teamName: string;
    overallNo: number;
    round: number;
    pickNo: number;
    deadlineAt: Date | null;
  } | null;
  picksMade: number;
  totalPicks: number;
  runningCostUsd: number;
};

export async function draftBoard(
  leagueId: string,
  executor: DbOrTx = db,
): Promise<DraftBoard | null> {
  const league = await executor.query.leagues.findFirst({ where: eq(leagues.id, leagueId) });
  if (!league) return null;

  const teamRows = await executor
    .select({
      id: teams.id,
      name: teams.name,
      abbreviation: teams.abbreviation,
      waiverPriority: teams.waiverPriority,
    })
    .from(teams)
    .where(eq(teams.leagueId, leagueId))
    .orderBy(asc(teams.waiverPriority));

  const pickRows = await executor
    .select({
      id: draftPicks.id,
      round: draftPicks.round,
      pickNo: draftPicks.pickNo,
      overallNo: draftPicks.overallNo,
      teamId: draftPicks.teamId,
      playerId: draftPicks.playerId,
      price: draftPicks.price,
      auto: draftPicks.auto,
      rationale: draftPicks.rationale,
      runId: draftPicks.madeByRunId,
      madeAt: draftPicks.madeAt,
      playerName: players.fullName,
      position: players.position,
      nflTeam: players.nflTeam,
      costUsd: runs.totalCostUsd,
    })
    .from(draftPicks)
    .leftJoin(players, eq(players.id, draftPicks.playerId))
    .leftJoin(runs, eq(runs.id, draftPicks.madeByRunId))
    .where(eq(draftPicks.leagueId, leagueId))
    .orderBy(asc(draftPicks.overallNo));

  const nameById = new Map(teamRows.map((t) => [t.id, t]));
  const picks: DraftBoardPick[] = pickRows.map((row) => ({
    id: row.id,
    round: row.round,
    pickNo: row.pickNo,
    overallNo: row.overallNo,
    teamId: row.teamId,
    teamName: nameById.get(row.teamId)?.name ?? "Unknown",
    teamAbbreviation: nameById.get(row.teamId)?.abbreviation ?? "??",
    playerId: row.playerId,
    playerName: row.playerName,
    position: row.position,
    nflTeam: row.nflTeam,
    price: row.price,
    auto: row.auto,
    rationale: row.rationale,
    runId: row.runId,
    costUsd: row.costUsd,
    madeAt: row.madeAt,
  }));

  // Draft-order slot index comes from round 1, falling back to waiver priority
  // so the grid still lines up before the order is generated.
  const roundOne = picks.filter((p) => p.round === 1).sort((a, b) => a.pickNo - b.pickNo);
  const slotOrder =
    roundOne.length > 0 ? roundOne.map((p) => p.teamId) : teamRows.map((t) => t.id);
  const boardTeams = slotOrder
    .map((teamId, index) => {
      const team = nameById.get(teamId);
      return team
        ? { id: team.id, name: team.name, abbreviation: team.abbreviation, slotIndex: index }
        : null;
    })
    .filter((t): t is NonNullable<typeof t> => t !== null);
  const slotIndexByTeam = new Map(boardTeams.map((t) => [t.id, t.slotIndex]));

  const rounds = picks.reduce((max, pick) => Math.max(max, pick.round), 0);
  const grid: Array<Array<DraftBoardPick | undefined>> = Array.from(
    { length: rounds },
    () => new Array<DraftBoardPick | undefined>(boardTeams.length).fill(undefined),
  );
  for (const pick of picks) {
    const slot = slotIndexByTeam.get(pick.teamId);
    if (slot === undefined || pick.round < 1 || pick.round > rounds) continue;
    grid[pick.round - 1][slot] = pick;
  }

  // On the clock = the lowest unmade pick. Its deadline is the open draft window's close.
  const [next] = await executor
    .select({
      teamId: draftPicks.teamId,
      overallNo: draftPicks.overallNo,
      round: draftPicks.round,
      pickNo: draftPicks.pickNo,
    })
    .from(draftPicks)
    .where(and(eq(draftPicks.leagueId, leagueId), isNull(draftPicks.playerId)))
    .orderBy(asc(draftPicks.overallNo))
    .limit(1);

  let onTheClock: DraftBoard["onTheClock"] = null;
  if (next && league.status === "drafting") {
    const [openWindow] = await executor
      .select({ closesAt: windows.closesAt })
      .from(windows)
      .where(
        and(
          eq(windows.leagueId, leagueId),
          eq(windows.type, "draft"),
          inArray(windows.status, ["open", "closing"]),
        ),
      )
      .orderBy(asc(windows.closesAt))
      .limit(1);
    onTheClock = {
      teamId: next.teamId,
      teamName: nameById.get(next.teamId)?.name ?? "Unknown",
      overallNo: next.overallNo,
      round: next.round,
      pickNo: next.pickNo,
      deadlineAt: openWindow?.closesAt ?? null,
    };
  }

  const [{ cost } = { cost: 0 }] = await executor
    .select({ cost: sql<number>`coalesce(sum(${runs.totalCostUsd}), 0)::float8` })
    .from(runs)
    .innerJoin(windows, eq(windows.id, runs.windowId))
    .where(and(eq(runs.leagueId, leagueId), eq(windows.type, "draft")));

  return {
    leagueId,
    draftType: league.draftType,
    status: league.status,
    scheduledAt: league.draftScheduledAt,
    rounds,
    teams: boardTeams,
    picks,
    grid,
    onTheClock,
    picksMade: picks.filter((p) => p.playerId !== null).length,
    totalPicks: picks.length,
    runningCostUsd: round2(cost),
  };
}
