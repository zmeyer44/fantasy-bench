import type { SnapshotPayload } from "../../lib/snapshot/types";

type RosterRow = { teamId: string; playerId: string };

/**
 * Keep the snapshot's projections, injuries and news frozen while replacing its
 * ownership layer with the current roster table. Draft pick windows deliberately
 * share a snapshot, but picks committed after that snapshot must be visible to
 * every later drafter.
 */
export function withLiveRosterOwnership(
  snapshot: SnapshotPayload,
  rosterRows: RosterRow[],
): SnapshotPayload {
  const rosterByTeam = new Map<string, string[]>();
  const ownerByPlayer = new Map<string, string>();

  for (const row of rosterRows) {
    const roster = rosterByTeam.get(row.teamId) ?? [];
    roster.push(row.playerId);
    rosterByTeam.set(row.teamId, roster);
    ownerByPlayer.set(row.playerId, row.teamId);
  }

  const players = Object.fromEntries(
    Object.entries(snapshot.players).map(([playerId, player]) => [
      playerId,
      { ...player, ownerTeamId: ownerByPlayer.get(playerId) ?? null },
    ]),
  );

  return {
    ...snapshot,
    teams: snapshot.teams.map((team) => ({
      ...team,
      rosterPlayerIds: [...(rosterByTeam.get(team.id) ?? [])],
    })),
    players,
    freeAgentIds: snapshot.freeAgentIds.filter((playerId) => !ownerByPlayer.has(playerId)),
  };
}
