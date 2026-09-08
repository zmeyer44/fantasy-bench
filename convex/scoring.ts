/**
 * Weekly scoring: lineup × stats → matchup scores, team results, standings —
 * the port of `lib/services/scoring/index.ts` plus the playoff half of
 * `lib/services/standings/index.ts`.
 *
 * The scorer always reads the *latest lineup version* for the week (`lineups` is
 * append-only history) and the stored stat line for each starter, so it is safe
 * to run on every tick: scores are recomputed from scratch and written
 * idempotently, and a mid-game run just refreshes the partial totals. Wins and
 * losses are only decided once every NFL game of the week is final, so the
 * standings never flap.
 *
 * `team_standings` is maintained here and nowhere else (migration plan §2.6):
 * no read path folds `team_results` at query time any more.
 */
import { v } from "convex/values";

import type { ScoringPreset } from "../lib/snapshot/types";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { computeFantasyPoints, isStartingSlot, round2, storedPointsFor } from "./lib/scoring_pure";
import { bracketForSeeds, compareStandings, streakOf, winnerOf } from "./lib/standings_pure";
import { matchupsForWeek, orderedTeams } from "./standings";

export { computeFantasyPoints, isStartingSlot, round2 } from "./lib/scoring_pure";

/** The largest league the rules allow. */
const MAX_TEAMS = 20;
/** Weeks in a league season, with headroom. */
const MAX_WEEKS = 25;
/** NFL games in one week: 16, with headroom for flexed/international slates. */
const MAX_GAMES_PER_WEEK = 40;
/** Rostered rows in one league: 14 teams × 16 roster slots, with headroom. */
const MAX_ROSTER_ROWS = 400;

type LeagueContext = {
  league: Doc<"leagues">;
  rules: Doc<"league_rules">;
  season: number;
  preset: ScoringPreset;
  tePremium: boolean;
};

async function leagueContext(
  ctx: QueryCtx,
  leagueId: Id<"leagues">,
): Promise<LeagueContext | null> {
  const league = await ctx.db.get("leagues", leagueId);
  const rules = await ctx.db
    .query("league_rules")
    .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
    .unique();
  if (!league || !rules) return null;
  return {
    league,
    rules,
    season: league.season,
    preset: rules.scoringPreset,
    tePremium: rules.tePremium,
  };
}

/**
 * Fantasy points for one player-week under a league's rules.
 *
 * The stored preset column is league-agnostic, so it can only be trusted when
 * the league does not run TE premium; otherwise the scorer recomputes from the
 * stat map.
 */
async function pointsFor(
  ctx: QueryCtx,
  args: { playerId: Id<"players">; season: number; week: number; ctxL: LeagueContext },
): Promise<number> {
  const row = await ctx.db
    .query("player_stats_weekly")
    .withIndex("by_playerId_season_week", (q) =>
      q.eq("playerId", args.playerId).eq("season", args.season).eq("week", args.week),
    )
    .order("desc")
    .first();
  if (!row) return 0;
  if (!args.ctxL.tePremium) return storedPointsFor(args.ctxL.preset, row);
  const player = await ctx.db.get("players", args.playerId);
  return computeFantasyPoints(row.stats, args.ctxL.preset, {
    position: player?.position ?? null,
    tePremium: true,
  });
}

/** Latest lineup version for a team-week, or null. */
async function latestLineup(
  ctx: QueryCtx,
  teamId: Id<"teams">,
  weekNo: number,
): Promise<Doc<"lineups"> | null> {
  return ctx.db
    .query("lineups")
    .withIndex("by_teamId_weekNo_version", (q) => q.eq("teamId", teamId).eq("weekNo", weekNo))
    .order("desc")
    .first();
}

/** True when every NFL game in the week has a terminal status. */
export async function isWeekComplete(
  ctx: QueryCtx,
  season: number,
  weekNo: number,
): Promise<boolean> {
  // Bounded: one NFL week is ~16 games.
  const games = await ctx.db
    .query("nfl_games")
    .withIndex("by_season_week", (q) => q.eq("season", season).eq("week", weekNo))
    .take(MAX_GAMES_PER_WEEK);
  if (games.length === 0) return false;
  return games.every((g) => g.status === "final" || g.status === "canceled");
}

// ---------------------------------------------------------------- live scores

/**
 * Points so far this week for every rostered player in the league — the
 * snapshot's `liveScores` (PRD 5.11 live scoring). Bounded to rostered players.
 */
export const liveScoresForWeek = internalQuery({
  args: { leagueId: v.id("leagues"), weekNo: v.number() },
  returns: v.record(v.string(), v.number()),
  handler: async (ctx, { leagueId, weekNo }) => {
    const ctxL = await leagueContext(ctx, leagueId);
    if (!ctxL) return {};
    // Bounded: teams × roster size.
    const rostered = await ctx.db
      .query("roster_slots")
      .withIndex("by_leagueId_playerId", (q) => q.eq("leagueId", leagueId))
      .take(MAX_ROSTER_ROWS);
    const seen = new Set<string>();
    const out: Record<string, number> = {};
    for (const row of rostered) {
      if (seen.has(row.playerId)) continue;
      seen.add(row.playerId);
      const points = await pointsFor(ctx, {
        playerId: row.playerId,
        season: ctxL.season,
        week: weekNo,
        ctxL,
      });
      if (points !== 0) out[row.playerId] = points;
    }
    return out;
  },
});

// -------------------------------------------------------------- scoreLeague

/**
 * Recompute every matchup score, team result and standings row for a week.
 *
 * Idempotent. Does *not* decide wins/losses unless every NFL game of the week is
 * final — an in-progress week records points only.
 */
export const scoreLeague = internalMutation({
  args: { leagueId: v.id("leagues"), weekNo: v.number() },
  returns: v.object({
    teams: v.number(),
    matchups: v.number(),
    finalized: v.boolean(),
  }),
  handler: async (ctx, { leagueId, weekNo }) => scoreLeagueWeek(ctx, leagueId, weekNo),
});

/** The body of `scoreLeague`, shared with `finalizeWeek` (one transaction, no nesting). */
async function scoreLeagueWeek(
  ctx: MutationCtx,
  leagueId: Id<"leagues">,
  weekNo: number,
): Promise<{ teams: number; matchups: number; finalized: boolean }> {
  {
    const ctxL = await leagueContext(ctx, leagueId);
    if (!ctxL) return { teams: 0, matchups: 0, finalized: false };

    const teams = await orderedTeams(ctx, leagueId);
    if (teams.length === 0) return { teams: 0, matchups: 0, finalized: false };

    const scores = new Map<string, number>();
    for (const team of teams) {
      const lineup = await latestLineup(ctx, team._id, weekNo);
      let total = 0;
      for (const slot of lineup?.slots ?? []) {
        if (!isStartingSlot(slot.slot) || !slot.playerId) continue;
        total += await pointsFor(ctx, {
          playerId: slot.playerId,
          season: ctxL.season,
          week: weekNo,
          ctxL,
        });
      }
      scores.set(team._id, round2(total));
    }

    const complete = await isWeekComplete(ctx, ctxL.season, weekNo);
    const weekMatchups = await matchupsForWeek(ctx, leagueId, weekNo);

    for (const m of weekMatchups) {
      const home = scores.get(m.homeTeamId) ?? 0;
      const away = scores.get(m.awayTeamId) ?? 0;
      await ctx.db.patch("matchups", m._id, {
        homeScore: home,
        awayScore: away,
        isFinal: complete,
      });
      await upsertTeamResult(ctx, {
        leagueId,
        teamId: m.homeTeamId,
        weekNo,
        pointsFor: home,
        pointsAgainst: away,
        final: complete,
      });
      await upsertTeamResult(ctx, {
        leagueId,
        teamId: m.awayTeamId,
        weekNo,
        pointsFor: away,
        pointsAgainst: home,
        final: complete,
      });
    }

    for (const team of teams) {
      await refreshStandings(ctx, { leagueId, teamId: team._id, season: ctxL.season });
    }

    return { teams: teams.length, matchups: weekMatchups.length, finalized: complete };
  }
}

async function upsertTeamResult(
  ctx: MutationCtx,
  args: {
    leagueId: Id<"leagues">;
    teamId: Id<"teams">;
    weekNo: number;
    pointsFor: number;
    pointsAgainst: number;
    final: boolean;
  },
): Promise<void> {
  const won = args.final && args.pointsFor > args.pointsAgainst;
  const lost = args.final && args.pointsFor < args.pointsAgainst;
  const tied = args.final && args.pointsFor === args.pointsAgainst;
  const existing = await ctx.db
    .query("team_results")
    .withIndex("by_teamId_weekNo", (q) => q.eq("teamId", args.teamId).eq("weekNo", args.weekNo))
    .first();
  const fields = {
    leagueId: args.leagueId,
    teamId: args.teamId,
    weekNo: args.weekNo,
    pointsFor: args.pointsFor,
    pointsAgainst: args.pointsAgainst,
    won,
    lost,
    tied,
  };
  if (existing) await ctx.db.patch("team_results", existing._id, fields);
  else await ctx.db.insert("team_results", fields);
}

/**
 * Rebuild one team's `team_standings` row from its `team_results`.
 *
 * The fold is over one bounded index range (≤ 22 week rows for one team), which
 * is why the standings page never has to do it. `streak` is the string form the
 * views render (`W3` / `L2` / `—`).
 */
async function refreshStandings(
  ctx: MutationCtx,
  args: { leagueId: Id<"leagues">; teamId: Id<"teams">; season: number },
): Promise<void> {
  // Bounded: one team's season is ≤ 22 rows.
  const results = (
    await ctx.db
      .query("team_results")
      .withIndex("by_teamId_weekNo", (q) => q.eq("teamId", args.teamId))
      .take(MAX_WEEKS)
  ).sort((a, b) => a.weekNo - b.weekNo);

  let wins = 0;
  let losses = 0;
  let ties = 0;
  let pointsFor = 0;
  let pointsAgainst = 0;
  for (const row of results) {
    pointsFor += row.pointsFor;
    pointsAgainst += row.pointsAgainst;
    if (row.won) wins++;
    else if (row.lost) losses++;
    else if (row.tied) ties++;
  }
  // Only decided weeks contribute to a streak; an in-progress week is not a tie.
  const streak = streakOf(results.filter((r) => r.won || r.lost || r.tied));

  const fields = {
    leagueId: args.leagueId,
    teamId: args.teamId,
    season: args.season,
    wins,
    losses,
    ties,
    pointsFor: round2(pointsFor),
    pointsAgainst: round2(pointsAgainst),
    streak,
    updatedAt: Date.now(),
  };
  const existing = await ctx.db
    .query("team_standings")
    .withIndex("by_teamId_season", (q) => q.eq("teamId", args.teamId).eq("season", args.season))
    .first();
  if (existing) await ctx.db.patch("team_standings", existing._id, fields);
  else await ctx.db.insert("team_standings", fields);
}

// ------------------------------------------------------------- finalizeWeek

/**
 * Close the week: score it one last time, mark the matchups final, flip the
 * `weeks` row to `complete`, and move the playoff bracket along.
 *
 * A no-op until every NFL game of the week is final, so it is safe to call from
 * the game-day cron on every tick.
 */
export const finalizeWeek = internalMutation({
  args: { leagueId: v.id("leagues"), weekNo: v.number() },
  returns: v.object({
    finalized: v.boolean(),
    playoffsSeeded: v.number(),
    bracketAdvanced: v.number(),
  }),
  handler: async (ctx, { leagueId, weekNo }) => {
    const ctxL = await leagueContext(ctx, leagueId);
    if (!ctxL) return { finalized: false, playoffsSeeded: 0, bracketAdvanced: 0 };
    if (!(await isWeekComplete(ctx, ctxL.season, weekNo))) {
      return { finalized: false, playoffsSeeded: 0, bracketAdvanced: 0 };
    }

    await scoreLeagueWeek(ctx, leagueId, weekNo);

    const week = await ctx.db
      .query("weeks")
      .withIndex("by_leagueId_weekNo", (q) => q.eq("leagueId", leagueId).eq("weekNo", weekNo))
      .first();
    if (week) await ctx.db.patch("weeks", week._id, { status: "complete" });

    // The regular season ends the week before `playoffStartWeek`: that is when
    // the bracket is seeded. Every later week advances it.
    let playoffsSeeded = 0;
    let bracketAdvanced = 0;
    if (weekNo === ctxL.rules.playoffStartWeek - 1) {
      playoffsSeeded = await seedPlayoffs(ctx, ctxL);
    } else if (weekNo >= ctxL.rules.playoffStartWeek) {
      bracketAdvanced = await advanceBracket(ctx, ctxL, weekNo);
    }

    return { finalized: true, playoffsSeeded, bracketAdvanced };
  },
});

/** Season standings order (best first), from the `team_standings` rollup. */
async function seedOrder(ctx: QueryCtx, ctxL: LeagueContext): Promise<Id<"teams">[]> {
  const teams = await orderedTeams(ctx, ctxL.league._id);
  const standings = await ctx.db
    .query("team_standings")
    .withIndex("by_leagueId_season", (q) =>
      q.eq("leagueId", ctxL.league._id).eq("season", ctxL.season),
    )
    .take(MAX_TEAMS);
  const byTeam = new Map(standings.map((s) => [s.teamId as string, s]));
  const rows = teams.map((team) => {
    const s = byTeam.get(team._id);
    return {
      teamId: team._id,
      teamName: team.name,
      wins: s?.wins ?? 0,
      losses: s?.losses ?? 0,
      ties: s?.ties ?? 0,
      pointsFor: s?.pointsFor ?? 0,
    };
  });
  rows.sort(compareStandings);
  return rows.map((r) => r.teamId);
}

/** Write the first playoff round from the final standings. Idempotent. */
async function seedPlayoffs(ctx: MutationCtx, ctxL: LeagueContext): Promise<number> {
  const startWeek = ctxL.rules.playoffStartWeek;
  const already = await matchupsForWeek(ctx, ctxL.league._id, startWeek);
  if (already.length > 0) return 0;

  const slots = bracketForSeeds(await seedOrder(ctx, ctxL), ctxL.rules.playoffTeams, startWeek);
  if (slots.length === 0) return 0;
  for (const slot of slots) {
    await ctx.db.insert("matchups", {
      leagueId: ctxL.league._id,
      weekNo: slot.weekNo,
      homeTeamId: slot.homeTeamId,
      awayTeamId: slot.awayTeamId,
      isFinal: false,
    });
  }
  await markPlayoffWeek(ctx, ctxL.league._id, startWeek);
  return slots.length;
}

/**
 * After week `weekNo` is final, create the next round from its winners (plus the
 * bye seeds when leaving round 1 of a 6-team bracket).
 */
async function advanceBracket(
  ctx: MutationCtx,
  ctxL: LeagueContext,
  weekNo: number,
): Promise<number> {
  const round = await matchupsForWeek(ctx, ctxL.league._id, weekNo);
  if (round.length === 0 || !round.every((m) => m.isFinal)) return 0;
  if (round.length === 1) return 0; // the final was just played

  const nextWeek = weekNo + 1;
  if ((await matchupsForWeek(ctx, ctxL.league._id, nextWeek)).length > 0) return 0;

  const seeds = await seedOrder(ctx, ctxL);
  const seedOf = new Map(seeds.map((id, i) => [id as string, i]));
  const winners = round.map((m) => winnerOf(m)).filter((id): id is Id<"teams"> => id !== null);

  // Leaving round 1 of a 6-team bracket the byes join the field.
  const byes =
    ctxL.rules.playoffTeams === 6 && weekNo === ctxL.rules.playoffStartWeek
      ? seeds.slice(0, 2)
      : [];
  const field = [...byes, ...winners].sort(
    (a, b) => (seedOf.get(a) ?? 99) - (seedOf.get(b) ?? 99),
  );
  if (field.length < 2) return 0;

  let created = 0;
  for (let i = 0; i < Math.floor(field.length / 2); i++) {
    await ctx.db.insert("matchups", {
      leagueId: ctxL.league._id,
      weekNo: nextWeek,
      homeTeamId: field[i],
      awayTeamId: field[field.length - 1 - i],
      isFinal: false,
    });
    created++;
  }
  await markPlayoffWeek(ctx, ctxL.league._id, nextWeek);
  return created;
}

async function markPlayoffWeek(
  ctx: MutationCtx,
  leagueId: Id<"leagues">,
  weekNo: number,
): Promise<void> {
  const week = await ctx.db
    .query("weeks")
    .withIndex("by_leagueId_weekNo", (q) => q.eq("leagueId", leagueId).eq("weekNo", weekNo))
    .first();
  if (week) await ctx.db.patch("weeks", week._id, { isPlayoff: true });
}
