/**
 * Schedule generation and standings-derived orderings — the port of the
 * database half of `lib/services/standings/index.ts`.
 *
 * The standings themselves are *not* computed here: migration plan §2.6 retires
 * the query-time fold over `team_results` in favour of the `team_standings`
 * rollup, which `scoring.scoreLeague` maintains. This file only writes the
 * regular-season schedule and answers "who is first in the waiver line", both of
 * which read that rollup.
 */
import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import { compareStandings, roundRobinRounds } from "./lib/standings_pure";

/** The largest league the rules allow. */
const MAX_TEAMS = 20;

/** League teams in their stable creation order — the input to the round robin. */
export async function orderedTeams(
  ctx: QueryCtx,
  leagueId: Id<"leagues">,
): Promise<Doc<"teams">[]> {
  // Bounded: ≤ 14 teams.
  const rows = await ctx.db
    .query("teams")
    .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
    .collect();
  return rows.sort(
    (a, b) =>
      (a.createdAt ?? a._creationTime) - (b.createdAt ?? b._creationTime) ||
      a.name.localeCompare(b.name),
  );
}

/**
 * Write `matchups` for weeks 1..`regularSeasonWeeks`.
 *
 * Idempotent: a week that already has matchups is left alone, so re-running
 * after a draft restart never duplicates a schedule.
 */
export const generateSchedule = internalMutation({
  args: { leagueId: v.id("leagues") },
  returns: v.object({ weeks: v.number(), matchups: v.number() }),
  handler: async (ctx, { leagueId }) => {
    const rules = await ctx.db
      .query("league_rules")
      .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
      .unique();
    if (!rules) return { weeks: 0, matchups: 0 };

    const teams = await orderedTeams(ctx, leagueId);
    if (teams.length < 2) return { weeks: 0, matchups: 0 };

    const rounds = roundRobinRounds(teams.map((t) => t._id));
    if (rounds.length === 0) return { weeks: 0, matchups: 0 };

    let weeksWritten = 0;
    let written = 0;
    for (let weekNo = 1; weekNo <= rules.regularSeasonWeeks; weekNo++) {
      // Bounded: one league week holds ≤ teams/2 matchups.
      const existing = await ctx.db
        .query("matchups")
        .withIndex("by_leagueId_weekNo", (q) => q.eq("leagueId", leagueId).eq("weekNo", weekNo))
        .take(MAX_TEAMS);
      if (existing.length > 0) continue;

      for (const [home, away] of rounds[(weekNo - 1) % rounds.length]) {
        await ctx.db.insert("matchups", {
          leagueId,
          weekNo,
          homeTeamId: home,
          awayTeamId: away,
          isFinal: false,
        });
        written++;
      }
      weeksWritten++;
    }
    return { weeks: weeksWritten, matchups: written };
  },
});

/**
 * Waiver priority is worst-record-first (PRD 5.3 tiebreak for FAAB ties).
 *
 * Reads `team_standings` rather than folding `team_results`; a team with no
 * standings row yet sorts as 0-0-0, which is what the pre-season order is.
 */
export const waiverPriorityOrder = internalQuery({
  args: { leagueId: v.id("leagues") },
  returns: v.array(v.id("teams")),
  handler: async (ctx, { leagueId }) => {
    const teams = await orderedTeams(ctx, leagueId);
    if (teams.length === 0) return [];
    const league = await ctx.db.get("leagues", leagueId);
    if (!league) return [];

    // Bounded: one row per team-season.
    const standings = await ctx.db
      .query("team_standings")
      .withIndex("by_leagueId_season", (q) =>
        q.eq("leagueId", leagueId).eq("season", league.season),
      )
      .take(MAX_TEAMS);
    const byTeam = new Map(standings.map((s) => [s.teamId as string, s]));

    const rows = teams.map((team) => {
      const standing = byTeam.get(team._id);
      return {
        teamId: team._id,
        teamName: team.name,
        wins: standing?.wins ?? 0,
        losses: standing?.losses ?? 0,
        ties: standing?.ties ?? 0,
        pointsFor: standing?.pointsFor ?? 0,
      };
    });
    rows.sort(compareStandings);
    return rows.reverse().map((r) => r.teamId);
  },
});

/** Every matchup of one league week (bounded: ≤ teams/2 rows). */
export async function matchupsForWeek(
  ctx: QueryCtx,
  leagueId: Id<"leagues">,
  weekNo: number,
): Promise<Doc<"matchups">[]> {
  return ctx.db
    .query("matchups")
    .withIndex("by_leagueId_weekNo", (q) => q.eq("leagueId", leagueId).eq("weekNo", weekNo))
    .take(MAX_TEAMS);
}

export { MAX_TEAMS };
