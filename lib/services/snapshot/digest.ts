/**
 * The compact, prompt-injectable digest (PRD §6.6).
 *
 * It is deliberately a *diff*: what changed since the previous snapshot for this
 * league. That is the part an agent cannot cheaply recompute from the payload,
 * and it is what makes a 40 KB prompt preamble worth its tokens.
 */
import type { SnapshotDigest, SnapshotPayload } from "@/lib/snapshot/types";

const MAX_TOP_NEWS = 6;
const MAX_INJURY_CHANGES = 12;
const MAX_MOVERS = 8;
/** Projection swing (in the league's preset points) worth mentioning. */
const MOVER_THRESHOLD = 1.5;

export function buildDigest(
  payload: SnapshotPayload,
  previous: SnapshotPayload | null,
): SnapshotDigest {
  const name = (playerId: string): string =>
    payload.players[playerId]?.fullName ?? previous?.players[playerId]?.fullName ?? playerId;

  const topNews = payload.news.slice(0, MAX_TOP_NEWS).map((item) => ({
    headline: item.headline,
    playerName: item.playerId ? name(item.playerId) : undefined,
    publishedAt: item.publishedAt,
  }));

  const previousDesignations = new Map(
    (previous?.injuries ?? []).map((i) => [i.playerId, i.designation]),
  );
  const injuryChanges: SnapshotDigest["injuryChanges"] = [];
  for (const injury of payload.injuries) {
    const before = previousDesignations.get(injury.playerId) ?? null;
    if (before === injury.designation) continue;
    // Only surface designations for players someone actually rosters.
    if (payload.players[injury.playerId]?.ownerTeamId == null && before === null) continue;
    injuryChanges.push({
      playerName: name(injury.playerId),
      playerId: injury.playerId,
      from: before,
      to: injury.designation,
    });
    if (injuryChanges.length >= MAX_INJURY_CHANGES) break;
  }

  const movers: SnapshotDigest["projectionMovers"] = [];
  if (previous && previous.weekNo === payload.weekNo) {
    for (const [playerId, player] of Object.entries(payload.players)) {
      const before = previous.players[playerId]?.projection?.ppr;
      const after = player.projection?.ppr;
      if (before === undefined || after === undefined || before === null || after === null) continue;
      const delta = Math.round((after - before) * 10) / 10;
      if (Math.abs(delta) < MOVER_THRESHOLD) continue;
      movers.push({ playerName: player.fullName, playerId, delta });
    }
    movers.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    movers.splice(MAX_MOVERS);
  }

  const teamName = (teamId: string) =>
    payload.teams.find((t) => t.id === teamId)?.name ?? teamId;
  const leader = payload.standings[0];
  const standingsSummary = leader
    ? payload.standings
        .slice(0, 5)
        .map(
          (s, i) =>
            `${i + 1}. ${teamName(s.teamId)} ${s.wins}-${s.losses}${s.ties ? `-${s.ties}` : ""} (${s.pointsFor.toFixed(1)} PF)`,
        )
        .join(" · ")
    : "No games played yet.";

  const headlineParts = [`Week ${payload.weekNo}`];
  if (injuryChanges.length > 0) headlineParts.push(`${injuryChanges.length} injury change(s)`);
  if (movers.length > 0) headlineParts.push(`${movers.length} projection mover(s)`);
  if (payload.news.length > 0) headlineParts.push(`${payload.news.length} news item(s)`);
  if (leader) headlineParts.push(`${teamName(leader.teamId)} leads`);

  return {
    headline: headlineParts.join(" · "),
    topNews,
    injuryChanges,
    projectionMovers: movers,
    standingsSummary,
  };
}
