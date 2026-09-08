/**
 * Standings.
 *
 * `lib/services/standings` (scheduler package) does not exist yet, so this
 * computes the table from `team_results` — the per-team, per-week rollup the
 * scheduler writes when a week is finalized. When the service lands, swap the
 * body for a `tryService(getStandings, …)` call; the row shape below is the
 * contract the pages use.
 */
import { asc, eq, inArray } from "drizzle-orm";

import { db, type DbOrTx } from "@/lib/db";
import { agentConfigs, configVersions, teamResults, teams } from "@/lib/db/schema";

export type StandingsRow = {
  rank: number;
  teamId: string;
  teamName: string;
  abbreviation: string;
  ownerUserId: string | null;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  pointsAgainst: number;
  streak: string;
  karma: number;
  faabRemaining: number;
  modelId: string | null;
  configVersionNo: number | null;
};

/** Sort: wins desc, then points-for desc, then name. */
function compareRows(a: StandingsRow, b: StandingsRow): number {
  if (a.wins !== b.wins) return b.wins - a.wins;
  if (a.pointsFor !== b.pointsFor) return b.pointsFor - a.pointsFor;
  return a.teamName.localeCompare(b.teamName);
}

export async function standings(
  leagueId: string,
  executor: DbOrTx = db,
): Promise<StandingsRow[]> {
  const teamRows = await executor
    .select()
    .from(teams)
    .where(eq(teams.leagueId, leagueId))
    .orderBy(asc(teams.waiverPriority));
  if (teamRows.length === 0) return [];

  const teamIds = teamRows.map((t) => t.id);

  const results = await executor
    .select()
    .from(teamResults)
    .where(inArray(teamResults.teamId, teamIds))
    .orderBy(asc(teamResults.weekNo));

  const configs = await executor
    .select({
      teamId: agentConfigs.teamId,
      modelId: configVersions.modelId,
      versionNo: configVersions.versionNo,
    })
    .from(agentConfigs)
    .leftJoin(configVersions, eq(configVersions.id, agentConfigs.currentVersionId))
    .where(inArray(agentConfigs.teamId, teamIds));
  const configByTeam = new Map(configs.map((c) => [c.teamId, c]));

  const byTeam = new Map<string, typeof results>();
  for (const row of results) {
    const list = byTeam.get(row.teamId) ?? [];
    list.push(row);
    byTeam.set(row.teamId, list);
  }

  const rows: StandingsRow[] = teamRows.map((team) => {
    const weeks = byTeam.get(team.id) ?? [];
    let wins = 0;
    let losses = 0;
    let ties = 0;
    let pointsFor = 0;
    let pointsAgainst = 0;
    for (const week of weeks) {
      if (week.won) wins++;
      if (week.lost) losses++;
      if (week.tied) ties++;
      pointsFor += week.pointsFor;
      pointsAgainst += week.pointsAgainst;
    }
    const config = configByTeam.get(team.id);
    return {
      rank: 0,
      teamId: team.id,
      teamName: team.name,
      abbreviation: team.abbreviation,
      ownerUserId: team.ownerUserId,
      wins,
      losses,
      ties,
      pointsFor: Math.round(pointsFor * 100) / 100,
      pointsAgainst: Math.round(pointsAgainst * 100) / 100,
      streak: streakOf(weeks),
      karma: team.karma,
      faabRemaining: team.faabRemaining,
      modelId: config?.modelId ?? null,
      configVersionNo: config?.versionNo ?? null,
    };
  });

  rows.sort(compareRows);
  rows.forEach((row, index) => {
    row.rank = index + 1;
  });
  return rows;
}

/** `W3` / `L2` / `—` from the tail of the (week-ordered) result list. */
function streakOf(weeks: Array<{ won: boolean; lost: boolean; tied: boolean }>): string {
  if (weeks.length === 0) return "—";
  const last = weeks[weeks.length - 1];
  const kind = last.won ? "W" : last.lost ? "L" : "T";
  let count = 0;
  for (let i = weeks.length - 1; i >= 0; i--) {
    const w = weeks[i];
    const k = w.won ? "W" : w.lost ? "L" : "T";
    if (k !== kind) break;
    count++;
  }
  return `${kind}${count}`;
}
