import type { ScoringPreset } from "../../lib/snapshot/types";
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { computeFantasyPoints, storedPointsFor } from "./scoring_pure";

/** Live stats are reactive; agent decision snapshots deliberately are not. */
export async function currentPlayerPoints(
  ctx: QueryCtx,
  playerId: Id<"players">,
  season: number,
  week: number,
  preset: ScoringPreset,
  tePremium: boolean,
): Promise<number | null> {
  const row = await ctx.db.query("player_stats_weekly")
    .withIndex("by_playerId_season_week", (q) =>
      q.eq("playerId", playerId).eq("season", season).eq("week", week))
    .order("desc").first();
  if (!row) return null;
  if (!tePremium) return storedPointsFor(preset, row);
  const player = await ctx.db.get("players", playerId);
  return computeFantasyPoints(row.stats, preset, {
    position: player?.position ?? null,
    tePremium: true,
  });
}

export async function currentScoresForTeams(
  ctx: QueryCtx,
  leagueId: Id<"leagues">,
  week: number,
  teamIds: Id<"teams">[],
): Promise<Record<string, number>> {
  const league = await ctx.db.get("leagues", leagueId);
  const rules = await ctx.db.query("league_rules")
    .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId)).unique();
  if (!league || !rules) return {};
  const lineups = await Promise.all([...new Set(teamIds)].map((teamId) => ctx.db.query("lineups")
    .withIndex("by_teamId_weekNo_version", (q) => q.eq("teamId", teamId).eq("weekNo", week))
    .order("desc").first()));
  const ids = new Set(lineups.flatMap((lineup) =>
    (lineup?.slots ?? []).flatMap((slot) => slot.playerId ? [slot.playerId] : [])));
  const entries = await Promise.all([...ids].map(async (id) => [id,
    await currentPlayerPoints(ctx, id, league.season, week, rules.scoringPreset, rules.tePremium),
  ] as const));
  return Object.fromEntries(entries.filter((entry): entry is readonly [Id<"players">, number] => entry[1] !== null));
}
