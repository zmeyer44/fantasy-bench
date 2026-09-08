/**
 * Snapshot builder (PRD §5.3 / §6.6) — the scheduler package owns this file.
 *
 * A snapshot is the ONLY thing agents read during a run. It is taken once at
 * window open and every run in that window sees the identical bytes, which is
 * what makes the benchmark comparison fair.
 *
 * Two properties matter and are enforced here:
 *
 *  1. **Vintage pinning.** Projections are read as "the newest row per player
 *     whose `effective_at <= takenAt`". Later vintages arriving mid-window do
 *     not change what the agents saw.
 *  2. **Bounded size.** All rostered players plus the top ~250 free agents by
 *     this week's projection. That keeps the payload comfortably under 1.5 MB
 *     while still giving the waiver wire real depth.
 */
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";

import { db, type DbOrTx } from "@/lib/db";
import {
  agentConfigs,
  configVersions,
  leagueRules,
  leagues,
  matchups,
  newsItems,
  nflGames,
  players,
  rosterSlots,
  snapshots,
  teams,
} from "@/lib/db/schema";
import { latestLineups, liveScoresForWeek } from "@/lib/services/scoring";
import { getStandings } from "@/lib/services/standings";
import { toET } from "@/lib/time";
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
} from "@/lib/snapshot/types";

import { buildDigest } from "./digest";

export { buildDigest } from "./digest";

/** Free agents carried in a snapshot, ranked by this week's projection. */
export const FREE_AGENT_LIMIT = 250;
const NEWS_LIMIT = 60;
const NEWS_WINDOW_DAYS = 7;

export type TakeSnapshotArgs = {
  leagueId: string;
  weekNo: number;
  windowId?: string | null;
  now?: Date;
};

export type TakeSnapshotResult = {
  snapshotId: string;
  payload: SnapshotPayload;
  digest: SnapshotDigest;
};

// --------------------------------------------------------------- helpers

type ProjectionRow = {
  player_id: string;
  ppr: number | null;
  half: number | null;
  std: number | null;
  source: string;
  effective_at: string | Date;
  stats: Record<string, unknown> | null;
};

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function pointsFor(preset: ScoringPreset, row: { ppr: number | null; half: number | null; std: number | null }): number {
  const value = preset === "ppr" ? row.ppr : preset === "half_ppr" ? row.half : row.std;
  return value ?? 0;
}

/**
 * `dayBucket` drives lineup-window scopes: a Sunday-late window may only touch
 * players in `sun_late` and `mon` games. Computed in Eastern, so it stays
 * correct across the DST switch inside the NFL season.
 */
export function dayBucketFor(kickoffAt: Date): SnapshotGame["dayBucket"] {
  const et = toET(kickoffAt);
  const day = et.getDay();
  if (day === 4) return "thu";
  if (day === 1) return "mon";
  if (day === 0) return et.getHours() < 16 ? "sun_early" : "sun_late";
  return "other";
}

/** Newest projection per player as of `asOf`, for one week. */
async function projectionsAsOf(
  season: number,
  week: number,
  asOf: Date,
  executor: DbOrTx,
): Promise<Map<string, ProjectionRow>> {
  const rows = (await executor.execute(sql`
    select distinct on (player_id)
      player_id,
      projected_points_ppr as ppr,
      projected_points_half as half,
      projected_points_std as std,
      source,
      effective_at,
      stats
    from player_projections
    where season = ${season} and week = ${week} and effective_at <= ${asOf.toISOString()}
    order by player_id, effective_at desc
  `)) as unknown as ProjectionRow[];
  // postgres.js hands back `numeric` as a string; drizzle's `mode: "number"`
  // only applies to typed selects, so raw queries have to coerce.
  return new Map(
    rows.map((r) => [
      r.player_id,
      { ...r, ppr: toNumber(r.ppr), half: toNumber(r.half), std: toNumber(r.std) },
    ]),
  );
}

/** Rest-of-season projected points per player (weeks after `week`). */
async function rosProjections(
  season: number,
  week: number,
  seasonWeeks: number,
  preset: ScoringPreset,
  asOf: Date,
  executor: DbOrTx,
): Promise<Map<string, number>> {
  const column =
    preset === "ppr"
      ? sql`projected_points_ppr`
      : preset === "half_ppr"
        ? sql`projected_points_half`
        : sql`projected_points_std`;
  const rows = (await executor.execute(sql`
    select player_id, sum(pts)::float8 as total from (
      select distinct on (player_id, week)
        player_id, week, coalesce(${column}, 0) as pts
      from player_projections
      where season = ${season}
        and week > ${week}
        and week <= ${seasonWeeks}
        and effective_at <= ${asOf.toISOString()}
      order by player_id, week, effective_at desc
    ) latest
    group by player_id
  `)) as unknown as Array<{ player_id: string; total: number | string }>;
  return new Map(rows.map((r) => [r.player_id, Number(r.total)]));
}

/** Season-to-date and last-week actual points per player. */
async function actualPoints(
  season: number,
  week: number,
  preset: ScoringPreset,
  executor: DbOrTx,
): Promise<{ season: Map<string, number>; lastWeek: Map<string, number> }> {
  const column =
    preset === "ppr"
      ? sql`fantasy_points_ppr`
      : preset === "half_ppr"
        ? sql`fantasy_points_half`
        : sql`fantasy_points_std`;
  const rows = (await executor.execute(sql`
    select player_id,
           sum(coalesce(${column}, 0))::float8 as season_total,
           sum(case when week = ${week - 1} then coalesce(${column}, 0) else 0 end)::float8 as last_week
    from player_stats_weekly
    where season = ${season} and week < ${week}
    group by player_id
  `)) as unknown as Array<{ player_id: string; season_total: number | string; last_week: number | string }>;
  return {
    season: new Map(rows.map((r) => [r.player_id, Number(r.season_total)])),
    lastWeek: new Map(rows.map((r) => [r.player_id, Number(r.last_week)])),
  };
}

/**
 * Bye weeks, derived from the schedule: a team's bye is the week it has no
 * game. `players.bye_week` is always null because Sleeper's player endpoint
 * does not carry it (see scripts/seed.ts), so this is the only source.
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

/** Newest designation per player for the week, as of `asOf`. */
async function currentInjuries(
  season: number,
  week: number,
  asOf: Date,
  executor: DbOrTx,
): Promise<SnapshotInjury[]> {
  const rows = (await executor.execute(sql`
    select distinct on (player_id)
      player_id, designation, practice_status, effective_at
    from injury_designations
    where season = ${season} and week = ${week} and effective_at <= ${asOf.toISOString()}
    order by player_id, effective_at desc
  `)) as unknown as Array<{
    player_id: string;
    designation: string;
    practice_status: string | null;
    effective_at: string | Date;
  }>;
  return rows.map((r) => ({
    playerId: r.player_id,
    designation: r.designation,
    practiceStatus: r.practice_status,
    effectiveAt: new Date(r.effective_at).toISOString(),
  }));
}

/**
 * The team's live model id. `getCurrentConfigVersion` (console package) is the
 * contract, but it is a stub during parallel development — fall back to reading
 * the applied version directly rather than failing the whole snapshot.
 */
async function modelIdsForTeams(
  teamIds: string[],
  executor: DbOrTx,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (teamIds.length === 0) return out;
  try {
    const { getCurrentConfigVersion } = await import("@/lib/services/config");
    const results = await Promise.all(
      teamIds.map(async (id) => [id, (await getCurrentConfigVersion(id, executor))?.modelId ?? null] as const),
    );
    for (const [id, modelId] of results) out.set(id, modelId);
    return out;
  } catch {
    const rows = await executor
      .select({ teamId: agentConfigs.teamId, modelId: configVersions.modelId })
      .from(agentConfigs)
      .leftJoin(configVersions, eq(configVersions.id, agentConfigs.currentVersionId))
      .where(inArray(agentConfigs.teamId, teamIds));
    for (const row of rows) out.set(row.teamId, row.modelId ?? null);
    return out;
  }
}

/** Default empty lineup shaped by the league's roster slots. */
export function defaultLineupSlots(rosterShape: Record<string, number>): Array<{ slot: string; playerId: string | null }> {
  const order = ["QB", "RB", "WR", "TE", "FLEX", "SUPERFLEX", "K", "DEF", "BENCH"];
  const keys = [
    ...order.filter((k) => rosterShape[k] > 0),
    ...Object.keys(rosterShape).filter((k) => !order.includes(k) && rosterShape[k] > 0),
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

// -------------------------------------------------------------- the builder

export async function buildSnapshotPayload(
  args: TakeSnapshotArgs,
  executor: DbOrTx = db,
): Promise<SnapshotPayload> {
  const now = args.now ?? new Date();
  const { leagueId, weekNo } = args;

  const league = await executor.query.leagues.findFirst({ where: eq(leagues.id, leagueId) });
  const rules = await executor.query.leagueRules.findFirst({
    where: eq(leagueRules.leagueId, leagueId),
  });
  if (!league || !rules) throw new Error(`League ${leagueId} not found`);
  const preset = rules.scoringPreset as ScoringPreset;
  const season = league.season;

  // ---- teams, rosters, lineups
  const leagueTeams = await executor
    .select()
    .from(teams)
    .where(eq(teams.leagueId, leagueId))
    .orderBy(asc(teams.createdAt), asc(teams.name));
  const teamIds = leagueTeams.map((t) => t.id);

  const rosterRows = teamIds.length
    ? await executor
        .select({ teamId: rosterSlots.teamId, playerId: rosterSlots.playerId })
        .from(rosterSlots)
        .where(inArray(rosterSlots.teamId, teamIds))
    : [];
  const rosterByTeam = new Map<string, string[]>(teamIds.map((id) => [id, []]));
  const ownerByPlayer = new Map<string, string>();
  for (const row of rosterRows) {
    rosterByTeam.get(row.teamId)?.push(row.playerId);
    ownerByPlayer.set(row.playerId, row.teamId);
  }

  const lineupByTeam = await latestLineups(teamIds, weekNo, executor);
  const modelIds = await modelIdsForTeams(teamIds, executor);
  const standings = await getStandings(leagueId, executor);
  const standingByTeam = new Map(standings.map((s) => [s.teamId, s]));

  const snapshotTeams: SnapshotTeam[] = leagueTeams.map((team) => {
    const standing = standingByTeam.get(team.id);
    return {
      id: team.id,
      name: team.name,
      abbreviation: team.abbreviation,
      ownerUserId: team.ownerUserId,
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
      rosterPlayerIds: rosterByTeam.get(team.id) ?? [],
      lineup: lineupByTeam.get(team.id)?.slots ?? defaultLineupSlots(rules.rosterSlots),
      modelId: modelIds.get(team.id) ?? null,
    };
  });

  // ---- projections / stats / games
  const projections = await projectionsAsOf(season, weekNo, now, executor);
  const ros = await rosProjections(season, weekNo, rules.seasonWeeks, preset, now, executor);
  const actuals = await actualPoints(season, weekNo, preset, executor);

  const seasonGames = await executor
    .select({ week: nflGames.week, homeTeam: nflGames.homeTeam, awayTeam: nflGames.awayTeam })
    .from(nflGames)
    .where(eq(nflGames.season, season));
  const byeWeeks = byeWeeksFromSchedule(seasonGames, rules.seasonWeeks + 1);

  const gameRows = await executor
    .select()
    .from(nflGames)
    .where(and(eq(nflGames.season, season), eq(nflGames.week, weekNo)))
    .orderBy(asc(nflGames.kickoffAt));
  const games: SnapshotGame[] = gameRows.map((g) => ({
    gameId: g.gameId,
    week: g.week,
    homeTeam: g.homeTeam,
    awayTeam: g.awayTeam,
    kickoffAt: g.kickoffAt.toISOString(),
    status: g.status,
    dayBucket: dayBucketFor(g.kickoffAt),
  }));
  // Player-level lock time: the kickoff of that player's NFL team's game.
  const gameByTeam = new Map<string, { game: SnapshotGame; opponent: string }>();
  for (const g of games) {
    gameByTeam.set(g.homeTeam, { game: g, opponent: g.awayTeam });
    gameByTeam.set(g.awayTeam, { game: g, opponent: g.homeTeam });
  }

  // ---- the player pool: everyone rostered + the best free agents
  const rosteredIds = [...ownerByPlayer.keys()];
  const rankedFreeAgents = await selectFreeAgents(
    leagueId,
    { preset, projections, exclude: new Set(rosteredIds) },
    executor,
  );
  const poolIds = [...new Set([...rosteredIds, ...rankedFreeAgents])];

  const playerRows = poolIds.length
    ? await executor.select().from(players).where(inArray(players.id, poolIds))
    : [];

  const injuries = await currentInjuries(season, weekNo, now, executor);
  const designationByPlayer = new Map(injuries.map((i) => [i.playerId, i]));

  const snapshotPlayers: Record<string, SnapshotPlayer> = {};
  for (const p of playerRows) {
    const projection = projections.get(p.id);
    const game = p.nflTeam ? gameByTeam.get(p.nflTeam) : undefined;
    const raw = (p.raw ?? {}) as Record<string, unknown>;
    const designation = designationByPlayer.get(p.id);
    snapshotPlayers[p.id] = {
      id: p.id,
      sleeperId: p.sleeperId,
      fullName: p.fullName,
      position: p.position as Position,
      nflTeam: p.nflTeam,
      status: p.status,
      injuryStatus: designation?.designation ?? p.injuryStatus,
      injuryNotes: p.injuryNotes,
      byeWeek: p.byeWeek ?? (p.nflTeam ? (byeWeeks.get(p.nflTeam) ?? null) : null),
      projection: projection
        ? {
            ppr: projection.ppr ?? 0,
            half: projection.half ?? 0,
            std: projection.std ?? 0,
            source: projection.source,
            effectiveAt: new Date(projection.effective_at).toISOString(),
            stats: numericOnly(projection.stats),
          }
        : null,
      rosProjection: ros.has(p.id) ? Math.round((ros.get(p.id) as number) * 10) / 10 : null,
      lastWeekPoints: actuals.lastWeek.get(p.id) ?? null,
      seasonPoints: actuals.season.get(p.id) ?? null,
      ownerTeamId: ownerByPlayer.get(p.id) ?? null,
      // No game this week for the player's NFL team === bye.
      opponent: game?.opponent ?? null,
      gameId: game?.game.gameId ?? null,
      kickoffAt: game?.game.kickoffAt ?? null,
      ownedPct: typeof raw.owned_pct === "number" ? raw.owned_pct : null,
      startedPct: typeof raw.started_pct === "number" ? raw.started_pct : null,
    };
  }

  const freeAgentIds = rankedFreeAgents.filter((id) => snapshotPlayers[id]);

  // ---- matchups, news, live scores
  const matchupRows = await executor
    .select()
    .from(matchups)
    .where(and(eq(matchups.leagueId, leagueId), eq(matchups.weekNo, weekNo)));
  const snapshotMatchups: SnapshotMatchup[] = matchupRows.map((m) => ({
    weekNo: m.weekNo,
    homeTeamId: m.homeTeamId,
    awayTeamId: m.awayTeamId,
    homeScore: m.homeScore,
    awayScore: m.awayScore,
    isFinal: m.isFinal,
  }));

  const since = new Date(now.getTime() - NEWS_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const newsRows = await executor
    .select()
    .from(newsItems)
    .where(and(gte(newsItems.effectiveAt, since), lte(newsItems.effectiveAt, now)))
    .orderBy(desc(newsItems.effectiveAt))
    .limit(NEWS_LIMIT);
  const news: SnapshotNews[] = newsRows.map((n) => ({
    id: n.id,
    playerId: n.playerId,
    headline: n.headline,
    body: n.body,
    source: n.source,
    url: n.url,
    publishedAt: (n.publishedAt ?? n.effectiveAt).toISOString(),
  }));

  const liveScores = await liveScoresForWeek(leagueId, weekNo, executor);

  const snapshotStandings: SnapshotStanding[] = standings.map((s) => ({
    teamId: s.teamId,
    rank: s.rank,
    wins: s.wins,
    losses: s.losses,
    ties: s.ties,
    pointsFor: s.pointsFor,
    pointsAgainst: s.pointsAgainst,
  }));

  return {
    version: 1,
    leagueId,
    leagueName: league.name,
    season,
    weekNo,
    takenAt: now.toISOString(),
    rules: {
      scoringPreset: preset,
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
    },
    teams: snapshotTeams,
    players: snapshotPlayers,
    freeAgentIds,
    games,
    matchups: snapshotMatchups,
    standings: snapshotStandings,
    news,
    injuries: injuries.filter((i) => snapshotPlayers[i.playerId]),
    liveScores,
  };
}

function numericOnly(input: Record<string, unknown> | null): Record<string, number> | undefined {
  if (!input) return undefined;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Top free agents by this week's projection. Players with no projection (bye,
 * deep bench) still appear if there is room, ordered by Sleeper's search rank,
 * so a streaming-DEF search is not empty in a bye-heavy week.
 */
async function selectFreeAgents(
  leagueId: string,
  ctx: {
    preset: ScoringPreset;
    projections: Map<string, ProjectionRow>;
    exclude: Set<string>;
  },
  executor: DbOrTx,
  limit = FREE_AGENT_LIMIT,
): Promise<string[]> {
  const candidates = await executor
    .select({ id: players.id, searchRank: players.searchRank })
    .from(players)
    .leftJoin(
      rosterSlots,
      and(
        eq(rosterSlots.playerId, players.id),
        inArray(
          rosterSlots.teamId,
          executor.select({ id: teams.id }).from(teams).where(eq(teams.leagueId, leagueId)),
        ),
      ),
    )
    .where(sql`${rosterSlots.id} is null`);

  const scored = candidates
    .filter((c) => !ctx.exclude.has(c.id))
    .map((c) => {
      const projection = ctx.projections.get(c.id);
      return {
        id: c.id,
        points: projection ? pointsFor(ctx.preset, projection) : -1,
        rank: c.searchRank ?? 99_999,
      };
    })
    .sort((a, b) => (b.points !== a.points ? b.points - a.points : a.rank - b.rank));

  return scored.slice(0, limit).map((c) => c.id);
}

// ------------------------------------------------------------------- public

/** Build and persist a snapshot for a league (optionally bound to a window). */
export async function takeSnapshot(
  args: TakeSnapshotArgs,
  executor: DbOrTx = db,
): Promise<TakeSnapshotResult> {
  const payload = await buildSnapshotPayload(args, executor);

  const previous = await executor
    .select({ payload: snapshots.payload })
    .from(snapshots)
    .where(eq(snapshots.leagueId, args.leagueId))
    .orderBy(desc(snapshots.takenAt))
    .limit(1);
  const digest = buildDigest(payload, previous[0]?.payload ?? null);

  const [row] = await executor
    .insert(snapshots)
    .values({
      leagueId: args.leagueId,
      windowId: args.windowId ?? null,
      takenAt: new Date(payload.takenAt),
      season: payload.season,
      weekNo: payload.weekNo,
      digest,
      payload,
    })
    .returning({ id: snapshots.id });

  return { snapshotId: row.id, payload, digest };
}

export async function loadSnapshot(
  snapshotId: string,
  executor: DbOrTx = db,
): Promise<{ id: string; payload: SnapshotPayload; digest: SnapshotDigest; takenAt: Date }> {
  const row = await executor.query.snapshots.findFirst({ where: eq(snapshots.id, snapshotId) });
  if (!row) throw new Error(`Snapshot ${snapshotId} not found`);
  return { id: row.id, payload: row.payload, digest: row.digest, takenAt: row.takenAt };
}

/** Most recent snapshot for a league, if any. Used by the tick's reuse window. */
export async function latestSnapshotForLeague(
  leagueId: string,
  executor: DbOrTx = db,
): Promise<{ id: string; takenAt: Date; weekNo: number | null } | null> {
  const rows = await executor
    .select({ id: snapshots.id, takenAt: snapshots.takenAt, weekNo: snapshots.weekNo })
    .from(snapshots)
    .where(eq(snapshots.leagueId, leagueId))
    .orderBy(desc(snapshots.takenAt))
    .limit(1);
  return rows[0] ?? null;
}
