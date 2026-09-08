/**
 * Waiver outcomes (PRD 5.3): claims won/lost with bids, FAAB remaining, and the
 * current pending-claim count.
 *
 * Read from `waiver_claims` directly — `lib/services/waivers#getWaiverResults`
 * is a scheduler-package stub keyed by window id, and this view is keyed by
 * week (a week can have more than one waiver window once re-runs exist).
 */
import { aliasedTable, and, asc, desc, eq, sql } from "drizzle-orm";

import { db, type DbOrTx } from "@/lib/db";
import { players, teams, waiverClaims, windows } from "@/lib/db/schema";
import type { WaiverStatus } from "@/lib/db/types";

export type WaiverResultRow = {
  claimId: string;
  teamId: string;
  teamName: string;
  teamAbbreviation: string;
  addPlayerId: string;
  addPlayerName: string;
  addPlayerPosition: string | null;
  dropPlayerId: string | null;
  dropPlayerName: string | null;
  bid: number;
  priority: number;
  status: WaiverStatus;
  resultReason: string | null;
  processedAt: Date | null;
  runId: string | null;
  weekNo: number;
};

export type WaiverWeekView = {
  leagueId: string;
  weekNo: number;
  results: WaiverResultRow[];
  pendingCount: number;
  /** Every week that has at least one claim, newest first — powers the week picker. */
  weeksWithClaims: number[];
  faab: Array<{ teamId: string; teamName: string; abbreviation: string; remaining: number; spent: number }>;
  window: { id: string; opensAt: Date; closesAt: Date; status: string } | null;
};

export async function waiverResults(
  leagueId: string,
  weekNo: number,
  executor: DbOrTx = db,
): Promise<WaiverWeekView> {
  const addPlayer = aliasedTable(players, "add_player");
  const dropPlayer = aliasedTable(players, "drop_player");

  const rows = await executor
    .select({
      claimId: waiverClaims.id,
      teamId: waiverClaims.teamId,
      teamName: teams.name,
      teamAbbreviation: teams.abbreviation,
      addPlayerId: waiverClaims.addPlayerId,
      addPlayerName: addPlayer.fullName,
      addPlayerPosition: addPlayer.position,
      dropPlayerId: waiverClaims.dropPlayerId,
      dropPlayerName: dropPlayer.fullName,
      bid: waiverClaims.bid,
      priority: waiverClaims.priority,
      status: waiverClaims.status,
      resultReason: waiverClaims.resultReason,
      processedAt: waiverClaims.processedAt,
      runId: waiverClaims.runId,
      weekNo: waiverClaims.weekNo,
    })
    .from(waiverClaims)
    .innerJoin(teams, eq(teams.id, waiverClaims.teamId))
    .innerJoin(addPlayer, eq(addPlayer.id, waiverClaims.addPlayerId))
    .leftJoin(dropPlayer, eq(dropPlayer.id, waiverClaims.dropPlayerId))
    .where(and(eq(waiverClaims.leagueId, leagueId), eq(waiverClaims.weekNo, weekNo)))
    .orderBy(desc(waiverClaims.bid), asc(waiverClaims.priority));

  const [{ pendingCount } = { pendingCount: 0 }] = await executor
    .select({ pendingCount: sql<number>`count(*)::int` })
    .from(waiverClaims)
    .where(and(eq(waiverClaims.leagueId, leagueId), eq(waiverClaims.status, "pending")));

  const weekRows = await executor
    .selectDistinct({ weekNo: waiverClaims.weekNo })
    .from(waiverClaims)
    .where(eq(waiverClaims.leagueId, leagueId))
    .orderBy(desc(waiverClaims.weekNo));

  const spentRows = await executor
    .select({
      teamId: waiverClaims.teamId,
      spent: sql<number>`coalesce(sum(${waiverClaims.bid}) filter (where ${waiverClaims.status} = 'won'), 0)::int`,
    })
    .from(waiverClaims)
    .where(eq(waiverClaims.leagueId, leagueId))
    .groupBy(waiverClaims.teamId);
  const spentByTeam = new Map(spentRows.map((r) => [r.teamId, r.spent]));

  const teamRows = await executor
    .select({
      id: teams.id,
      name: teams.name,
      abbreviation: teams.abbreviation,
      faabRemaining: teams.faabRemaining,
    })
    .from(teams)
    .where(eq(teams.leagueId, leagueId))
    .orderBy(desc(teams.faabRemaining));

  const [windowRow] = await executor
    .select({
      id: windows.id,
      opensAt: windows.opensAt,
      closesAt: windows.closesAt,
      status: windows.status,
    })
    .from(windows)
    .where(
      and(
        eq(windows.leagueId, leagueId),
        eq(windows.type, "waiver"),
        eq(windows.weekNo, weekNo),
      ),
    )
    .orderBy(desc(windows.opensAt))
    .limit(1);

  return {
    leagueId,
    weekNo,
    results: rows,
    pendingCount,
    weeksWithClaims: weekRows.map((r) => r.weekNo),
    faab: teamRows.map((team) => ({
      teamId: team.id,
      teamName: team.name,
      abbreviation: team.abbreviation,
      remaining: team.faabRemaining,
      spent: spentByTeam.get(team.id) ?? 0,
    })),
    window: windowRow ?? null,
  };
}
