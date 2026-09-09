/**
 * Snapshot builder and loader (PRD §5.3 / §6.6) — the port of
 * the snapshot builder and loader.
 *
 * A snapshot is the ONLY thing agents read during a run. It is taken once at
 * window open and every run in that window sees the identical bytes, which is
 * what makes the benchmark comparison fair.
 *
 * Storage (migration plan §1, decision 2): the frozen `SnapshotPayload` lives in
 * `snapshot_chunks` — one `meta` chunk holding everything except `players`, and
 * `players` chunks of {@link PLAYERS_PER_CHUNK} players each — so no document
 * comes near the 1 MiB limit and the runtime reassembles the payload with a
 * single indexed range. The `snapshots` row stays metadata only.
 *
 * Building reads a few thousand rows, which is far more than a mutation's 1 s
 * budget allows, so `build` is an action: it pulls its inputs through bounded
 * internal queries, assembles the payload in memory, and writes it back through
 * batched internal mutations. It carries no `"use node"` — nothing here needs
 * Node APIs.
 *
 * Timestamps *inside* the payload stay ISO-8601 strings: `lib/snapshot/types.ts`
 * is the cross-package contract the agent tools read, and it is unchanged.
 * Everything outside the payload (rows, args, returns) is epoch milliseconds.
 */
import { getConvexSize, v } from "convex/values";

import { computeFantasyPoints, type StatMap } from "./lib/scoring_table";
import type {
  Position,
  ScoringPreset,
  SnapshotDigest,
  SnapshotGame,
  SnapshotInjury,
  SnapshotMatchup,
  SnapshotNews,
  SnapshotPayload,
  SnapshotPlayer,
  SnapshotStanding,
  SnapshotTeam,
} from "../lib/snapshot/types";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  query,
  type QueryCtx,
} from "./_generated/server";
import { requireLeagueRead } from "./lib/auth";
import { appError } from "./lib/errors";
import { compareStandings, rankRows } from "./lib/standings_pure";
import { dayBucketFor } from "./lib/templates";

// --------------------------------------------------------------- constants

/** Free agents carried in a snapshot, ranked by this week's projection. */
export const FREE_AGENT_LIMIT = 250;
/** Rows pulled off the ranked projection index before the rostered ones are removed. */
export const RANKED_PROJECTION_TAKE = 600;
const NEWS_LIMIT = 60;
const NEWS_WINDOW_DAYS = 7;
/** Players per `players` chunk. 100 × ~600 B ≈ 60 KB per document. */
export const PLAYERS_PER_CHUNK = 100;
/** Upper bound on chunks per snapshot (used as the `take` bound when loading). */
export const MAX_SNAPSHOT_CHUNKS = 32;
/** Batch sizes for the action's fan-out queries; each stays well inside 1 s. */
const PLAYER_BATCH = 100;
const STAT_BATCH = 60;

/**
 * Projection feeds, best first. `player_projection_latest` is keyed by source,
 * so the builder picks the first source that has rows for the week rather than
 * de-duplicating vintages the way the old `distinct on` query did.
 */
export const PROJECTION_SOURCES = ["sleeper_rotowire", "espn", "fantasypros", "nflverse"];

// ----------------------------------------------------------------- helpers

/** Default empty lineup shaped by the league's roster slots. */
export function defaultLineupSlots(
  rosterShape: Record<string, number>,
): Array<{ slot: string; playerId: string | null }> {
  const order = ["QB", "RB", "WR", "TE", "FLEX", "SUPERFLEX", "K", "DEF", "BENCH"];
  const keys = [
    ...order.filter((k) => (rosterShape[k] ?? 0) > 0),
    ...Object.keys(rosterShape).filter((k) => !order.includes(k) && (rosterShape[k] ?? 0) > 0),
  ];
  const slots: Array<{ slot: string; playerId: string | null }> = [];
  for (const key of keys) {
    const count = rosterShape[key] ?? 0;
    for (let i = 1; i <= count; i++) {
      slots.push({ slot: count > 1 ? `${key}${i}` : key, playerId: null });
    }
  }
  return slots;
}

/**
 * Bye weeks, derived from the schedule: a team's bye is the week it has no
 * game. `players.byeWeek` is usually null because Sleeper's player endpoint does
 * not carry it, so this is the only source.
 */
export function byeWeeksFromSchedule(
  games: Array<{ week: number; homeTeam: string; awayTeam: string }>,
  seasonWeeks = 18,
): Map<string, number> {
  const played = new Map<string, Set<number>>();
  for (const game of games) {
    for (const team of [game.homeTeam, game.awayTeam]) {
      if (!played.has(team)) played.set(team, new Set());
      played.get(team)!.add(game.week);
    }
  }
  const byes = new Map<string, number>();
  for (const [team, weeks] of played) {
    // Guard against a partially-ingested schedule producing bogus byes.
    if (weeks.size < seasonWeeks - 2) continue;
    for (let week = 1; week <= seasonWeeks; week++) {
      if (!weeks.has(week)) {
        byes.set(team, week);
        break;
      }
    }
  }
  return byes;
}

function pointsFor(
  preset: ScoringPreset,
  row: { ppr: number; half: number; std: number },
): number {
  return preset === "ppr" ? row.ppr : preset === "half_ppr" ? row.half : row.std;
}

function statPoints(
  row: Doc<"player_stats_weekly">,
  position: string,
  preset: ScoringPreset,
  tePremium: boolean,
): number {
  const stored =
    preset === "ppr"
      ? row.fantasyPointsPpr
      : preset === "half_ppr"
        ? row.fantasyPointsHalf
        : row.fantasyPointsStd;
  // TE premium is a league toggle, so a stored (league-agnostic) column can only
  // be trusted when the league does not run it — same rule as playerPointsForWeek.
  if (!tePremium && stored !== null && stored !== undefined) return stored;
  return computeFantasyPoints(row.stats as StatMap, preset, { position, tePremium });
}

function numericOnly(input: Record<string, number> | null | undefined) {
  if (!input) return undefined;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ------------------------------------------------------------ build inputs

type LeagueInputs = {
  league: { id: string; name: string; season: number };
  rules: SnapshotPayload["rules"] & { seasonWeeks: number; tePremium: boolean };
  teams: SnapshotTeam[];
  rosteredIds: string[];
};

/**
 * League, rules, teams, rosters, current lineups, standings and model ids.
 *
 * Bounded by construction: at most 14 teams, one roster (≤ ~20 rows) and one
 * lineup per team, one standings row per team.
 */
export const loadBuildInputs = internalQuery({
  args: { leagueId: v.id("leagues"), weekNo: v.number() },
  handler: async (ctx, { leagueId, weekNo }): Promise<LeagueInputs> => {
    const league = await ctx.db.get("leagues", leagueId);
    const rules = await ctx.db
      .query("league_rules")
      .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
      .unique();
    if (!league || !rules) throw appError("NOT_FOUND", `League ${leagueId} not found`);

    // Bounded: a league has at most 14 teams.
    const teamRows = await ctx.db
      .query("teams")
      .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
      .collect();

    const standingRows = await ctx.db
      .query("team_standings")
      .withIndex("by_leagueId_season", (q) => q.eq("leagueId", leagueId).eq("season", league.season))
      .take(20);
    const standingByTeam = new Map(standingRows.map((row) => [row.teamId, row]));

    const teams: SnapshotTeam[] = [];
    const rosteredIds: string[] = [];
    for (const team of teamRows) {
      // Bounded: one team's roster is at most ~20 rows.
      const roster = await ctx.db
        .query("roster_slots")
        .withIndex("by_teamId", (q) => q.eq("teamId", team._id))
        .collect();
      const playerIds = roster.map((row) => row.playerId as string);
      rosteredIds.push(...playerIds);

      const lineup = await ctx.db
        .query("lineups")
        .withIndex("by_teamId_weekNo_version", (q) =>
          q.eq("teamId", team._id).eq("weekNo", weekNo),
        )
        .order("desc")
        .first();

      const config = await ctx.db
        .query("agent_configs")
        .withIndex("by_teamId", (q) => q.eq("teamId", team._id))
        .unique();
      const version = config?.currentVersionId
        ? await ctx.db.get("config_versions", config.currentVersionId)
        : null;

      const standing = standingByTeam.get(team._id);
      teams.push({
        id: team._id,
        name: team.name,
        abbreviation: team.abbreviation,
        ...(team.avatarTemplate ? { avatarTemplate: team.avatarTemplate } : {}),
        ...(team.avatarStatus ? { avatarStatus: team.avatarStatus } : {}),
        ownerUserId: team.ownerUserId ?? null,
        faabRemaining: team.faabRemaining,
        waiverPriority: team.waiverPriority,
        karma: team.karma,
        record: {
          wins: standing?.wins ?? 0,
          losses: standing?.losses ?? 0,
          ties: standing?.ties ?? 0,
          pointsFor: standing?.pointsFor ?? 0,
          pointsAgainst: standing?.pointsAgainst ?? 0,
        },
        rosterPlayerIds: playerIds,
        lineup: lineup
          ? lineup.slots.map((s) => ({ slot: s.slot, playerId: s.playerId as string | null }))
          : defaultLineupSlots(rules.rosterSlots),
        modelId: version?.modelId ?? null,
      });
    }

    return {
      league: { id: league._id, name: league.name, season: league.season },
      rules: {
        scoringPreset: rules.scoringPreset,
        superflex: rules.superflex,
        tePremium: rules.tePremium,
        rosterSlots: rules.rosterSlots,
        faabBudget: rules.faabBudget,
        injectionPolicy: rules.injectionPolicy,
        transparencyMode: rules.transparencyMode,
        regularSeasonWeeks: rules.regularSeasonWeeks,
        playoffStartWeek: rules.playoffStartWeek,
        maxOpenProposals: rules.maxOpenProposals,
        maxMessagesPerRun: rules.maxMessagesPerRun,
        maxThreadsPerWindow: rules.maxThreadsPerWindow,
        forumPostsPerDay: rules.forumPostsPerDay,
        forumCommentsPerDay: rules.forumCommentsPerDay,
        antiChurnWeeks: rules.antiChurnWeeks,
        seasonWeeks: rules.seasonWeeks,
      },
      teams,
      rosteredIds: [...new Set(rosteredIds)],
    };
  },
});

export type ProjectionRow = {
  playerId: string;
  ppr: number;
  half: number;
  std: number;
  source: string;
  effectiveAt: number;
  stats: Record<string, number>;
};

/**
 * The ranked free-agent pool: the top {@link RANKED_PROJECTION_TAKE} projections
 * for the week, minus everyone rostered, capped at {@link FREE_AGENT_LIMIT}.
 */
export const loadFreeAgentPool = internalQuery({
  args: {
    season: v.number(),
    weekNo: v.number(),
    rosteredIds: v.array(v.id("players")),
    source: v.optional(v.string()),
    asOf: v.number(),
  },
  handler: async (
    ctx,
    { season, weekNo, rosteredIds, source, asOf },
  ): Promise<{ source: string | null; freeAgents: ProjectionRow[] }> => {
    const rostered = new Set<string>(rosteredIds);
    const sources = source ? [source] : PROJECTION_SOURCES;
    for (const candidate of sources) {
      const ranked = await ctx.db
        .query("player_projection_latest")
        .withIndex("by_season_week_source_projectedPointsPpr", (q) =>
          q.eq("season", season).eq("week", weekNo).eq("source", candidate),
        )
        .order("desc")
        .take(RANKED_PROJECTION_TAKE);
      if (ranked.length === 0) continue;
      const freeAgents: ProjectionRow[] = [];
      for (const row of ranked) {
        if (rostered.has(row.playerId)) continue;
        if (row.effectiveAt > asOf) continue; // vintage pinning
        freeAgents.push({
          playerId: row.playerId,
          ppr: row.projectedPointsPpr,
          half: row.projectedPointsHalf,
          std: row.projectedPointsStd,
          source: row.source,
          effectiveAt: row.effectiveAt,
          stats: row.stats,
        });
        if (freeAgents.length >= FREE_AGENT_LIMIT) break;
      }
      return { source: candidate, freeAgents };
    }
    return { source: null, freeAgents: [] };
  },
});

/** This week's projection for a batch of players (rostered ones, by id). */
export const loadProjectionsFor = internalQuery({
  args: {
    season: v.number(),
    weekNo: v.number(),
    playerIds: v.array(v.id("players")),
    source: v.optional(v.string()),
    asOf: v.number(),
  },
  handler: async (
    ctx,
    { season, weekNo, playerIds, source, asOf },
  ): Promise<ProjectionRow[]> => {
    const sources = source ? [source] : PROJECTION_SOURCES;
    const out: ProjectionRow[] = [];
    for (const playerId of playerIds) {
      for (const candidate of sources) {
        const row = await ctx.db
          .query("player_projection_latest")
          .withIndex("by_playerId_season_week_source", (q) =>
            q
              .eq("playerId", playerId)
              .eq("season", season)
              .eq("week", weekNo)
              .eq("source", candidate),
          )
          .unique();
        if (!row || row.effectiveAt > asOf) continue;
        out.push({
          playerId: row.playerId,
          ppr: row.projectedPointsPpr,
          half: row.projectedPointsHalf,
          std: row.projectedPointsStd,
          source: row.source,
          effectiveAt: row.effectiveAt,
          stats: row.stats,
        });
        break;
      }
    }
    return out;
  },
});

/** Rest-of-season points for one future week, restricted to the snapshot's pool. */
export const loadRosWeek = internalQuery({
  args: {
    season: v.number(),
    week: v.number(),
    source: v.string(),
    preset: v.string(),
    asOf: v.number(),
  },
  handler: async (
    ctx,
    { season, week, source, preset, asOf },
  ): Promise<Array<{ playerId: string; points: number }>> => {
    const rows = await ctx.db
      .query("player_projection_latest")
      .withIndex("by_season_week_source_projectedPointsPpr", (q) =>
        q.eq("season", season).eq("week", week).eq("source", source),
      )
      .order("desc")
      .take(RANKED_PROJECTION_TAKE + 200);
    return rows
      .filter((row) => row.effectiveAt <= asOf)
      .map((row) => ({
        playerId: row.playerId,
        points: pointsFor(preset as ScoringPreset, {
          ppr: row.projectedPointsPpr,
          half: row.projectedPointsHalf,
          std: row.projectedPointsStd,
        }),
      }));
  },
});

export type PlayerRow = {
  id: string;
  sleeperId: string;
  fullName: string;
  position: Position;
  nflTeam: string | null;
  status: string | null;
  injuryStatus: string | null;
  injuryNotes: string | null;
  byeWeek: number | null;
  ownedPct: number | null;
  startedPct: number | null;
};

/** Player rows plus this week's ownership percentages, by id. */
export const loadPlayers = internalQuery({
  args: {
    playerIds: v.array(v.id("players")),
    season: v.number(),
    weekNo: v.number(),
  },
  handler: async (ctx, { playerIds, season, weekNo }): Promise<PlayerRow[]> => {
    const out: PlayerRow[] = [];
    for (const playerId of playerIds) {
      const player = await ctx.db.get("players", playerId);
      if (!player) continue;
      const ownership = await ctx.db
        .query("player_ownership")
        .withIndex("by_season_week_playerId", (q) =>
          q.eq("season", season).eq("week", weekNo).eq("playerId", playerId),
        )
        .first();
      out.push({
        id: player._id,
        sleeperId: player.sleeperId,
        fullName: player.fullName,
        position: player.position,
        nflTeam: player.nflTeam ?? null,
        status: player.status ?? null,
        injuryStatus: player.injuryStatus ?? null,
        injuryNotes: player.injuryNotes ?? null,
        byeWeek: player.byeWeek ?? null,
        ownedPct: ownership?.ownedPct ?? null,
        startedPct: ownership?.startedPct ?? null,
      });
    }
    return out;
  },
});

/** Season-to-date, last-week and in-progress points for a batch of players. */
export const loadStats = internalQuery({
  args: {
    playerIds: v.array(v.id("players")),
    season: v.number(),
    weekNo: v.number(),
    preset: v.string(),
    tePremium: v.boolean(),
  },
  handler: async (
    ctx,
    { playerIds, season, weekNo, preset, tePremium },
  ): Promise<
    Array<{ playerId: string; season: number; lastWeek: number | null; thisWeek: number | null }>
  > => {
    const out: Array<{
      playerId: string;
      season: number;
      lastWeek: number | null;
      thisWeek: number | null;
    }> = [];
    for (const playerId of playerIds) {
      const player = await ctx.db.get("players", playerId);
      if (!player) continue;
      // Bounded: one player's stat lines for one season (≤ 18 rows + playoffs).
      const rows = await ctx.db
        .query("player_stats_weekly")
        .withIndex("by_playerId_season_week", (q) =>
          q.eq("playerId", playerId).eq("season", season),
        )
        .take(25);
      let seasonTotal = 0;
      let lastWeek: number | null = null;
      let thisWeek: number | null = null;
      for (const row of rows) {
        const points = statPoints(row, player.position, preset as ScoringPreset, tePremium);
        if (row.week < weekNo) seasonTotal += points;
        if (row.week === weekNo - 1) lastWeek = points;
        if (row.week === weekNo) thisWeek = points;
      }
      out.push({ playerId, season: seasonTotal, lastWeek, thisWeek });
    }
    return out;
  },
});

type WeekContext = {
  games: SnapshotGame[];
  seasonGames: Array<{ week: number; homeTeam: string; awayTeam: string }>;
  matchups: SnapshotMatchup[];
  news: SnapshotNews[];
  injuries: SnapshotInjury[];
  standings: SnapshotStanding[];
};

/** Games, schedule, matchups, news and injury designations for the week. */
export const loadWeekContext = internalQuery({
  args: {
    leagueId: v.id("leagues"),
    season: v.number(),
    weekNo: v.number(),
    seasonWeeks: v.number(),
    asOf: v.number(),
  },
  handler: async (
    ctx,
    { leagueId, season, weekNo, seasonWeeks, asOf },
  ): Promise<WeekContext> => {
    // Bounded: at most 16 games in an NFL week.
    const gameRows = await ctx.db
      .query("nfl_games")
      .withIndex("by_season_week", (q) => q.eq("season", season).eq("week", weekNo))
      .take(24);
    const games: SnapshotGame[] = gameRows
      .slice()
      .sort((a, b) => a.kickoffAt - b.kickoffAt)
      .map((g) => ({
        gameId: g.gameId,
        week: g.week,
        homeTeam: g.homeTeam,
        awayTeam: g.awayTeam,
        kickoffAt: new Date(g.kickoffAt).toISOString(),
        status: g.status,
        dayBucket: dayBucketFor(g.kickoffAt),
      }));

    // Bye derivation needs the whole schedule: one bounded range per week.
    const seasonGames: Array<{ week: number; homeTeam: string; awayTeam: string }> = [];
    for (let week = 1; week <= seasonWeeks + 1; week++) {
      const rows = await ctx.db
        .query("nfl_games")
        .withIndex("by_season_week", (q) => q.eq("season", season).eq("week", week))
        .take(24);
      for (const row of rows) {
        seasonGames.push({ week: row.week, homeTeam: row.homeTeam, awayTeam: row.awayTeam });
      }
    }

    // Bounded: one league week has at most 7 matchups.
    const matchupRows = await ctx.db
      .query("matchups")
      .withIndex("by_leagueId_weekNo", (q) => q.eq("leagueId", leagueId).eq("weekNo", weekNo))
      .take(16);
    const matchups: SnapshotMatchup[] = matchupRows.map((m) => ({
      weekNo: m.weekNo,
      homeTeamId: m.homeTeamId,
      awayTeamId: m.awayTeamId,
      homeScore: m.homeScore ?? null,
      awayScore: m.awayScore ?? null,
      isFinal: m.isFinal,
    }));

    const since = asOf - NEWS_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const newsRows = await ctx.db
      .query("news_items")
      .withIndex("by_effectiveAt", (q) => q.gte("effectiveAt", since).lte("effectiveAt", asOf))
      .order("desc")
      .take(NEWS_LIMIT);
    const news: SnapshotNews[] = newsRows.map((n) => ({
      id: n._id,
      playerId: n.playerId ?? null,
      headline: n.headline,
      body: n.body ?? null,
      source: n.source,
      url: n.url ?? null,
      publishedAt: new Date(n.publishedAt ?? n.effectiveAt).toISOString(),
    }));

    // Newest designation per player for the week, as of `asOf`.
    const designationRows = await ctx.db
      .query("injury_designations")
      .withIndex("by_season_week_effectiveAt", (q) =>
        q.eq("season", season).eq("week", weekNo).lte("effectiveAt", asOf),
      )
      .order("desc")
      .take(500);
    const seen = new Set<string>();
    const injuries: SnapshotInjury[] = [];
    for (const row of designationRows) {
      if (seen.has(row.playerId)) continue;
      seen.add(row.playerId);
      injuries.push({
        playerId: row.playerId,
        designation: row.designation,
        practiceStatus: row.practiceStatus ?? null,
        effectiveAt: new Date(row.effectiveAt).toISOString(),
      });
    }

    const standingRows = await ctx.db
      .query("team_standings")
      .withIndex("by_leagueId_season", (q) => q.eq("leagueId", leagueId).eq("season", season))
      .take(20);
    // Bounded: at most 14 teams.
    const teamRows = await ctx.db
      .query("teams")
      .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
      .collect();
    const nameById = new Map(teamRows.map((t) => [t._id as string, t.name]));
    const ranked = rankRows(
      teamRows.map((team) => {
        const row = standingRows.find((s) => s.teamId === team._id);
        return {
          teamId: team._id as string,
          teamName: nameById.get(team._id) ?? "",
          rank: 0,
          wins: row?.wins ?? 0,
          losses: row?.losses ?? 0,
          ties: row?.ties ?? 0,
          pointsFor: row?.pointsFor ?? 0,
          pointsAgainst: row?.pointsAgainst ?? 0,
        };
      }),
      compareStandings,
    );
    // `teamName` is only there to break ties in the ranking; it is not in the contract.
    const standings: SnapshotStanding[] = ranked.map((row) => ({
      teamId: row.teamId,
      rank: row.rank,
      wins: row.wins,
      losses: row.losses,
      ties: row.ties,
      pointsFor: row.pointsFor,
      pointsAgainst: row.pointsAgainst,
    }));

    return { games, seasonGames, matchups, news, injuries, standings };
  },
});

// ------------------------------------------------------------------ digest

const MAX_TOP_NEWS = 6;
const MAX_INJURY_CHANGES = 12;
const MAX_MOVERS = 8;
/** Projection swing (in PPR points) worth mentioning. */
const MOVER_THRESHOLD = 1.5;

/**
 * The compact, prompt-injectable digest (PRD §6.6) — a port of
 * the prompt digest.
 *
 * It is deliberately a *diff*: what changed since the previous snapshot for this
 * league. That is the part an agent cannot cheaply recompute from the payload.
 */
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

  const teamName = (teamId: string) => payload.teams.find((t) => t.id === teamId)?.name ?? teamId;
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

// ------------------------------------------------------------------ writes

export const createSnapshot = internalMutation({
  args: {
    leagueId: v.id("leagues"),
    windowId: v.optional(v.id("windows")),
    season: v.number(),
    weekNo: v.number(),
    takenAt: v.number(),
  },
  returns: v.id("snapshots"),
  handler: async (ctx, args) =>
    ctx.db.insert("snapshots", {
      leagueId: args.leagueId,
      windowId: args.windowId,
      season: args.season,
      weekNo: args.weekNo,
      takenAt: args.takenAt,
      status: "building",
      chunkCount: 0,
      playerCount: 0,
    }),
});

export const writeChunk = internalMutation({
  args: {
    snapshotId: v.id("snapshots"),
    kind: v.union(v.literal("meta"), v.literal("players")),
    part: v.number(),
    data: v.any(),
  },
  returns: v.number(),
  handler: async (ctx, { snapshotId, kind, part, data }) => {
    const bytes = getConvexSize(data);
    const existing = await ctx.db
      .query("snapshot_chunks")
      .withIndex("by_snapshotId_kind_part", (q) =>
        q.eq("snapshotId", snapshotId).eq("kind", kind).eq("part", part),
      )
      .unique();
    if (existing) {
      await ctx.db.replace("snapshot_chunks", existing._id, {
        snapshotId,
        kind,
        part,
        data,
        bytes,
      });
    } else {
      await ctx.db.insert("snapshot_chunks", { snapshotId, kind, part, data, bytes });
    }
    return bytes;
  },
});

export const finishSnapshot = internalMutation({
  args: {
    snapshotId: v.id("snapshots"),
    chunkCount: v.number(),
    playerCount: v.number(),
    projectionEffectiveAt: v.optional(v.number()),
    digest: v.any(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const digest = args.digest as SnapshotDigest;
    const snapshot = await ctx.db.get("snapshots", args.snapshotId);
    if (!snapshot) throw appError("NOT_FOUND", "Snapshot not found");

    await ctx.db.patch("snapshots", args.snapshotId, {
      status: "ready",
      chunkCount: args.chunkCount,
      playerCount: args.playerCount,
      projectionEffectiveAt: args.projectionEffectiveAt,
      headline: digest.headline,
    });

    const existing = await ctx.db
      .query("snapshot_digests")
      .withIndex("by_snapshotId", (q) => q.eq("snapshotId", args.snapshotId))
      .unique();
    const row = {
      snapshotId: args.snapshotId,
      headline: digest.headline,
      topNews: digest.topNews,
      injuryChanges: digest.injuryChanges,
      projectionMovers: digest.projectionMovers,
      standingsSummary: digest.standingsSummary,
    };
    if (existing) await ctx.db.replace("snapshot_digests", existing._id, row);
    else await ctx.db.insert("snapshot_digests", row);

    // Bind the window to its snapshot when the caller passed one and the open
    // mutation has not already done it.
    if (snapshot.windowId) {
      const window = await ctx.db.get("windows", snapshot.windowId);
      if (window && !window.snapshotId) {
        await ctx.db.patch("windows", snapshot.windowId, { snapshotId: args.snapshotId });
      }
    }
    return null;
  },
});

export const failSnapshot = internalMutation({
  args: { snapshotId: v.id("snapshots"), error: v.string() },
  returns: v.null(),
  handler: async (ctx, { snapshotId, error }) => {
    await ctx.db.patch("snapshots", snapshotId, {
      status: "failed",
      headline: `Snapshot failed: ${error}`.slice(0, 500),
    });
    return null;
  },
});

// ------------------------------------------------------------------- reads

/** All chunks of one snapshot, reassembled into the frozen payload. */
export async function readPayload(
  ctx: QueryCtx,
  snapshotId: Id<"snapshots">,
): Promise<SnapshotPayload | null> {
  // Bounded: `MAX_SNAPSHOT_CHUNKS` (1 meta + ≤ 31 player parts) per snapshot.
  const chunks = await ctx.db
    .query("snapshot_chunks")
    .withIndex("by_snapshotId_kind_part", (q) => q.eq("snapshotId", snapshotId))
    .take(MAX_SNAPSHOT_CHUNKS);
  return assemble(chunks);
}

function assemble(chunks: Array<Doc<"snapshot_chunks">>): SnapshotPayload | null {
  const meta = chunks.find((c) => c.kind === "meta");
  if (!meta) return null;
  const players: Record<string, SnapshotPlayer> = {};
  for (const chunk of chunks.filter((c) => c.kind === "players").sort((a, b) => a.part - b.part)) {
    Object.assign(players, chunk.data as Record<string, SnapshotPlayer>);
  }
  return { ...(meta.data as Omit<SnapshotPayload, "players">), players } as SnapshotPayload;
}

/** The league's newest ready snapshot row (metadata only). */
export async function latestSnapshotRow(
  ctx: QueryCtx,
  leagueId: Id<"leagues">,
): Promise<Doc<"snapshots"> | null> {
  const rows = await ctx.db
    .query("snapshots")
    .withIndex("by_leagueId_takenAt", (q) => q.eq("leagueId", leagueId))
    .order("desc")
    .take(5);
  return rows.find((row) => row.status === "ready") ?? null;
}

/** The `meta` chunk of the league's newest ready snapshot (no player map). */
export async function latestMetaChunk(
  ctx: QueryCtx,
  leagueId: Id<"leagues">,
): Promise<{ snapshot: Doc<"snapshots">; meta: Omit<SnapshotPayload, "players"> } | null> {
  const snapshot = await latestSnapshotRow(ctx, leagueId);
  if (!snapshot) return null;
  const meta = await ctx.db
    .query("snapshot_chunks")
    .withIndex("by_snapshotId_kind_part", (q) =>
      q.eq("snapshotId", snapshot._id).eq("kind", "meta").eq("part", 0),
    )
    .unique();
  if (!meta) return null;
  return { snapshot, meta: meta.data as Omit<SnapshotPayload, "players"> };
}

/** The league's newest ready snapshot, fully reassembled. */
export async function latestPayload(
  ctx: QueryCtx,
  leagueId: Id<"leagues">,
): Promise<{ snapshot: Doc<"snapshots">; payload: SnapshotPayload } | null> {
  const snapshot = await latestSnapshotRow(ctx, leagueId);
  if (!snapshot) return null;
  const payload = await readPayload(ctx, snapshot._id);
  return payload ? { snapshot, payload } : null;
}

/** The full snapshot: metadata, frozen payload and digest. */
export const load = internalQuery({
  args: { snapshotId: v.id("snapshots") },
  handler: async (ctx, { snapshotId }) => {
    const snapshot = await ctx.db.get("snapshots", snapshotId);
    if (!snapshot) return null;
    const payload = await readPayload(ctx, snapshotId);
    const digest = await ctx.db
      .query("snapshot_digests")
      .withIndex("by_snapshotId", (q) => q.eq("snapshotId", snapshotId))
      .unique();
    return { snapshot, payload, digest };
  },
});

export const latestForLeague = internalQuery({
  args: { leagueId: v.id("leagues") },
  handler: async (ctx, { leagueId }) => latestSnapshotRow(ctx, leagueId),
});

/** The metadata banner the UI shows over a trace or a lineup ("as of …"). */
export const meta = query({
  args: { snapshotId: v.id("snapshots") },
  returns: v.union(
    v.null(),
    v.object({
      id: v.id("snapshots"),
      leagueId: v.id("leagues"),
      windowId: v.union(v.null(), v.id("windows")),
      season: v.number(),
      weekNo: v.number(),
      takenAt: v.number(),
      status: v.union(v.literal("building"), v.literal("ready"), v.literal("failed")),
      chunkCount: v.number(),
      playerCount: v.number(),
      projectionEffectiveAt: v.union(v.null(), v.number()),
      headline: v.union(v.null(), v.string()),
    }),
  ),
  handler: async (ctx, { snapshotId }) => {
    const snapshot = await ctx.db.get("snapshots", snapshotId);
    if (!snapshot) return null;
    await requireLeagueRead(ctx, snapshot.leagueId);
    return {
      id: snapshot._id,
      leagueId: snapshot.leagueId,
      windowId: snapshot.windowId ?? null,
      season: snapshot.season,
      weekNo: snapshot.weekNo,
      takenAt: snapshot.takenAt,
      status: snapshot.status,
      chunkCount: snapshot.chunkCount,
      playerCount: snapshot.playerCount,
      projectionEffectiveAt: snapshot.projectionEffectiveAt ?? null,
      headline: snapshot.headline ?? null,
    };
  },
});

/** The previous ready snapshot's payload, for the digest diff. */
export const previousPayload = internalQuery({
  args: { leagueId: v.id("leagues"), beforeTakenAt: v.number() },
  handler: async (ctx, { leagueId, beforeTakenAt }): Promise<SnapshotPayload | null> => {
    const rows = await ctx.db
      .query("snapshots")
      .withIndex("by_leagueId_takenAt", (q) =>
        q.eq("leagueId", leagueId).lt("takenAt", beforeTakenAt),
      )
      .order("desc")
      .take(5);
    const previous = rows.find((row) => row.status === "ready");
    if (!previous) return null;
    return readPayload(ctx, previous._id);
  },
});

// ------------------------------------------------------------------- build

/**
 * Build one snapshot: read the inputs through bounded queries, assemble the
 * payload, write it as chunks plus a digest, and mark the row `ready`.
 *
 * Scheduled by `internal.windows.open` (Phase 5). Failure marks the snapshot
 * `failed` and rethrows so the caller's fallback path applies.
 */
export const build = internalAction({
  args: {
    leagueId: v.id("leagues"),
    weekNo: v.number(),
    windowId: v.optional(v.id("windows")),
    snapshotId: v.optional(v.id("snapshots")),
    now: v.optional(v.number()),
    source: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    snapshotId: Id<"snapshots">;
    chunkCount: number;
    playerCount: number;
    bytes: number;
    headline: string;
  }> => {
    const takenAt = args.now ?? Date.now();
    const inputs: LeagueInputs = await ctx.runQuery(internal.snapshot.loadBuildInputs, {
      leagueId: args.leagueId,
      weekNo: args.weekNo,
    });
    const preset = inputs.rules.scoringPreset;
    const season = inputs.league.season;

    const snapshotId: Id<"snapshots"> =
      args.snapshotId ??
      (await ctx.runMutation(internal.snapshot.createSnapshot, {
        leagueId: args.leagueId,
        windowId: args.windowId,
        season,
        weekNo: args.weekNo,
        takenAt,
      }));

    try {
      const rosteredIds = inputs.rosteredIds as Id<"players">[];

      // ---- projections: rostered by id, free agents off the ranked index
      const pool: { source: string | null; freeAgents: ProjectionRow[] } =
        await ctx.runQuery(internal.snapshot.loadFreeAgentPool, {
        season,
        weekNo: args.weekNo,
          rosteredIds,
          source: args.source,
          asOf: takenAt,
        });
      const projections = new Map<string, ProjectionRow>();
      for (const row of pool.freeAgents) projections.set(row.playerId, row);
      for (const batch of chunk(rosteredIds, PLAYER_BATCH)) {
        const rows: ProjectionRow[] = await ctx.runQuery(internal.snapshot.loadProjectionsFor, {
          season,
          weekNo: args.weekNo,
          playerIds: batch,
          source: args.source ?? pool.source ?? undefined,
          asOf: takenAt,
        });
        for (const row of rows) projections.set(row.playerId, row);
      }

      const freeAgentIds = pool.freeAgents.map((row) => row.playerId);
      const poolIds = [...new Set<string>([...inputs.rosteredIds, ...freeAgentIds])];

      // ---- players + ownership
      const playerRows: PlayerRow[] = [];
      for (const batch of chunk(poolIds as Id<"players">[], PLAYER_BATCH)) {
        const rows: PlayerRow[] = await ctx.runQuery(internal.snapshot.loadPlayers, {
          playerIds: batch,
          season,
          weekNo: args.weekNo,
        });
        playerRows.push(...rows);
      }

      // ---- stats: season / last week / in-progress, for rostered players
      const statsByPlayer = new Map<
        string,
        { season: number; lastWeek: number | null; thisWeek: number | null }
      >();
      for (const batch of chunk(rosteredIds, STAT_BATCH)) {
        const rows: Array<{
          playerId: string;
          season: number;
          lastWeek: number | null;
          thisWeek: number | null;
        }> = await ctx.runQuery(internal.snapshot.loadStats, {
          playerIds: batch,
          season,
          weekNo: args.weekNo,
          preset,
          tePremium: inputs.rules.tePremium,
        });
        for (const row of rows) {
          statsByPlayer.set(row.playerId, {
            season: row.season,
            lastWeek: row.lastWeek,
            thisWeek: row.thisWeek,
          });
        }
      }

      // ---- games, schedule, matchups, news, injuries, standings
      const context: WeekContext = await ctx.runQuery(internal.snapshot.loadWeekContext, {
        leagueId: args.leagueId,
        season,
        weekNo: args.weekNo,
        seasonWeeks: inputs.rules.seasonWeeks,
        asOf: takenAt,
      });

      // ---- rest-of-season projections (only when future weeks are ingested)
      const ros = new Map<string, number>();
      if (pool.source) {
        const poolSet = new Set(poolIds);
        for (let week = args.weekNo + 1; week <= inputs.rules.seasonWeeks; week++) {
          const rows: Array<{ playerId: string; points: number }> = await ctx.runQuery(
            internal.snapshot.loadRosWeek,
            {
              season,
              week,
              source: pool.source,
              preset,
              asOf: takenAt,
            },
          );
          if (rows.length === 0) break; // no projections past here
          for (const row of rows) {
            if (!poolSet.has(row.playerId)) continue;
            ros.set(row.playerId, (ros.get(row.playerId) ?? 0) + row.points);
          }
        }
      }

      // ---- assemble
      const byeWeeks = byeWeeksFromSchedule(context.seasonGames, inputs.rules.seasonWeeks + 1);
      const gameByTeam = new Map<string, { game: SnapshotGame; opponent: string }>();
      for (const g of context.games) {
        gameByTeam.set(g.homeTeam, { game: g, opponent: g.awayTeam });
        gameByTeam.set(g.awayTeam, { game: g, opponent: g.homeTeam });
      }
      const ownerByPlayer = new Map<string, string>();
      for (const team of inputs.teams) {
        for (const playerId of team.rosterPlayerIds) ownerByPlayer.set(playerId, team.id);
      }
      const designationByPlayer = new Map(context.injuries.map((i) => [i.playerId, i]));

      const players: Record<string, SnapshotPlayer> = {};
      let projectionEffectiveAt: number | undefined;
      for (const p of playerRows) {
        const projection = projections.get(p.id);
        if (projection) {
          projectionEffectiveAt = Math.max(projectionEffectiveAt ?? 0, projection.effectiveAt);
        }
        const game = p.nflTeam ? gameByTeam.get(p.nflTeam) : undefined;
        const designation = designationByPlayer.get(p.id);
        const stats = statsByPlayer.get(p.id);
        players[p.id] = {
          id: p.id,
          sleeperId: p.sleeperId,
          fullName: p.fullName,
          position: p.position,
          nflTeam: p.nflTeam,
          status: p.status,
          injuryStatus: designation?.designation ?? p.injuryStatus,
          injuryNotes: p.injuryNotes,
          byeWeek: p.byeWeek ?? (p.nflTeam ? (byeWeeks.get(p.nflTeam) ?? null) : null),
          projection: projection
            ? {
                ppr: projection.ppr,
                half: projection.half,
                std: projection.std,
                source: projection.source,
                effectiveAt: new Date(projection.effectiveAt).toISOString(),
                stats: numericOnly(projection.stats),
              }
            : null,
          rosProjection: ros.has(p.id) ? Math.round((ros.get(p.id) as number) * 10) / 10 : null,
          lastWeekPoints: stats?.lastWeek ?? null,
          seasonPoints: stats?.season ?? null,
          ownerTeamId: ownerByPlayer.get(p.id) ?? null,
          // No game this week for the player's NFL team === bye.
          opponent: game?.opponent ?? null,
          gameId: game?.game.gameId ?? null,
          kickoffAt: game?.game.kickoffAt ?? null,
          ownedPct: p.ownedPct,
          startedPct: p.startedPct,
        };
      }

      const liveScores: Record<string, number> = {};
      for (const [playerId, stat] of statsByPlayer) {
        if (typeof stat.thisWeek === "number" && stat.thisWeek !== 0) {
          liveScores[playerId] = Math.round(stat.thisWeek * 100) / 100;
        }
      }

      const payload: SnapshotPayload = {
        version: 1,
        leagueId: args.leagueId,
        leagueName: inputs.league.name,
        season,
        weekNo: args.weekNo,
        takenAt: new Date(takenAt).toISOString(),
        rules: {
          scoringPreset: inputs.rules.scoringPreset,
          superflex: inputs.rules.superflex,
          tePremium: inputs.rules.tePremium,
          rosterSlots: inputs.rules.rosterSlots,
          faabBudget: inputs.rules.faabBudget,
          injectionPolicy: inputs.rules.injectionPolicy,
          transparencyMode: inputs.rules.transparencyMode,
          regularSeasonWeeks: inputs.rules.regularSeasonWeeks,
          playoffStartWeek: inputs.rules.playoffStartWeek,
          maxOpenProposals: inputs.rules.maxOpenProposals,
          maxMessagesPerRun: inputs.rules.maxMessagesPerRun,
          maxThreadsPerWindow: inputs.rules.maxThreadsPerWindow,
          forumPostsPerDay: inputs.rules.forumPostsPerDay,
          forumCommentsPerDay: inputs.rules.forumCommentsPerDay,
          antiChurnWeeks: inputs.rules.antiChurnWeeks,
        },
        teams: inputs.teams,
        players,
        freeAgentIds: freeAgentIds.filter((id) => players[id]),
        games: context.games,
        matchups: context.matchups,
        standings: context.standings,
        news: context.news,
        injuries: context.injuries.filter((i) => players[i.playerId]),
        liveScores,
      };

      // ---- write: one meta chunk, then players in parts of PLAYERS_PER_CHUNK
      const { players: playerMap, ...metaPayload } = payload;
      let bytes: number = await ctx.runMutation(internal.snapshot.writeChunk, {
        snapshotId,
        kind: "meta",
        part: 0,
        data: metaPayload,
      });
      const entries = Object.entries(playerMap);
      const parts = chunk(entries, PLAYERS_PER_CHUNK);
      for (const [index, part] of parts.entries()) {
        bytes += await ctx.runMutation(internal.snapshot.writeChunk, {
          snapshotId,
          kind: "players",
          part: index,
          data: Object.fromEntries(part),
        });
      }

      const previous: SnapshotPayload | null = await ctx.runQuery(
        internal.snapshot.previousPayload,
        {
          leagueId: args.leagueId,
          beforeTakenAt: takenAt,
        },
      );
      const digest = buildDigest(payload, previous);

      await ctx.runMutation(internal.snapshot.finishSnapshot, {
        snapshotId,
        chunkCount: parts.length + 1,
        playerCount: entries.length,
        projectionEffectiveAt,
        digest,
      });

      return {
        snapshotId,
        chunkCount: parts.length + 1,
        playerCount: entries.length,
        bytes,
        headline: digest.headline,
      };
    } catch (error) {
      await ctx.runMutation(internal.snapshot.failSnapshot, {
        snapshotId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
});
