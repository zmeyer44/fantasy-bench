/**
 * Provider -> Postgres ingestion (PRD §6.5).
 *
 * Everything here is idempotent and effective-dated so a snapshot can pin an
 * exact projection vintage (PRD §6.6). Two rules run through the whole file:
 *
 *  - Projections are **append-only vintages**: a new row is written only when
 *    the provider's `effective_at` is newer than the newest stored row for that
 *    (player, season, week, source). Older vintages are never deleted.
 *  - Nothing throws on partial data. A row that will not resolve is counted in
 *    `skipped` and logged.
 */
import { and, eq, inArray, or, sql } from "drizzle-orm";

import { db, type DbOrTx } from "@/lib/db";
import {
  injuryDesignations,
  newsItems,
  nflGames,
  players,
  playerProjections,
  playerStatsWeekly,
} from "@/lib/db/schema";
import { computeAllPresets } from "@/lib/services/scoring/points";

import * as espn from "./espn";
import { providerLog, type HttpOptions } from "./http";
import * as nflverse from "./nflverse";
import * as sleeper from "./sleeper";
import { normalizeTeam } from "./teams";
import type {
  NormalizedGame,
  NormalizedInjury,
  NormalizedNews,
  NormalizedProjection,
  NormalizedStatLine,
  ProjectionProvider,
} from "./types";

export type IngestCounts = {
  fetched: number;
  written: number;
  skipped: number;
  source: string;
};

const CHUNK = 250;

function chunk<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// --------------------------------------------------------------- id lookup

export type PlayerIndex = {
  bySleeperId: Map<string, string>;
  byEspnId: Map<string, string>;
  /** `name|team|position`, lowercased and stripped — the fallback join. */
  byNameKey: Map<string, string>;
  /** Player id -> position, for scoring stat lines. */
  positionById: Map<string, string>;
};

export function nameKey(
  name: string,
  team: string | null | undefined,
  position: string | null | undefined,
): string {
  const clean = name.toLowerCase().replace(/[^a-z]/g, "");
  return `${clean}|${normalizeTeam(team) ?? ""}|${(position ?? "").toUpperCase()}`;
}

/** One pass over `players` gives every join we need for a whole ingest run. */
export async function loadPlayerIndex(executor: DbOrTx = db): Promise<PlayerIndex> {
  const rows = await executor
    .select({
      id: players.id,
      sleeperId: players.sleeperId,
      fullName: players.fullName,
      nflTeam: players.nflTeam,
      position: players.position,
      raw: players.raw,
    })
    .from(players);

  const index: PlayerIndex = {
    bySleeperId: new Map(),
    byEspnId: new Map(),
    byNameKey: new Map(),
    positionById: new Map(),
  };
  for (const row of rows) {
    index.bySleeperId.set(row.sleeperId, row.id);
    index.positionById.set(row.id, row.position);
    const espnId = (row.raw as Record<string, unknown> | null)?.espn_id;
    if (espnId !== undefined && espnId !== null && espnId !== "") {
      index.byEspnId.set(String(espnId), row.id);
    }
    index.byNameKey.set(nameKey(row.fullName, row.nflTeam, row.position), row.id);
    // Team-less fallback: two players with the same name at the same position
    // is rare enough that first-wins is acceptable, and only used as a last try.
    const looseKey = nameKey(row.fullName, null, row.position);
    if (!index.byNameKey.has(looseKey)) index.byNameKey.set(looseKey, row.id);
  }
  return index;
}

function resolveByName(
  index: PlayerIndex,
  name: string,
  team: string | null,
  position: string | null,
): string | null {
  return (
    index.byNameKey.get(nameKey(name, team, position)) ??
    index.byNameKey.get(nameKey(name, null, position)) ??
    null
  );
}

// -------------------------------------------------------------- 1. players

export async function ingestPlayers(
  opts: sleeper.FetchAllPlayersOptions & { executor?: DbOrTx } = {},
): Promise<IngestCounts> {
  const { executor = db, ...fetchOpts } = opts;
  const rows = await sleeper.fetchAllPlayers(fetchOpts);
  if (rows.length === 0) {
    return { fetched: 0, written: 0, skipped: 0, source: sleeper.SLEEPER_STATS_SOURCE };
  }

  const values = rows.map((p) => ({
    sleeperId: p.sleeperId,
    gsisId: p.gsisId,
    fullName: p.fullName,
    firstName: p.firstName,
    lastName: p.lastName,
    position: p.position as "QB" | "RB" | "WR" | "TE" | "K" | "DEF",
    nflTeam: p.nflTeam,
    status: p.status,
    injuryStatus: p.injuryStatus,
    injuryBodyPart: p.injuryBodyPart,
    injuryNotes: p.injuryNotes,
    yearsExp: p.yearsExp,
    age: p.age,
    searchRank: p.searchRank,
    fantasyPositions: p.fantasyPositions,
    // Cross ids live in `raw` so ESPN / FantasyPros joins never need a refetch.
    raw: { ...p.raw, ...p.crossIds, practice_participation: p.practiceParticipation },
    updatedAt: new Date(),
  }));

  let written = 0;
  for (const batch of chunk(values)) {
    await executor
      .insert(players)
      .values(batch)
      .onConflictDoUpdate({
        target: players.sleeperId,
        set: {
          gsisId: sql`excluded.gsis_id`,
          fullName: sql`excluded.full_name`,
          firstName: sql`excluded.first_name`,
          lastName: sql`excluded.last_name`,
          position: sql`excluded.position`,
          nflTeam: sql`excluded.nfl_team`,
          status: sql`excluded.status`,
          injuryStatus: sql`excluded.injury_status`,
          injuryBodyPart: sql`excluded.injury_body_part`,
          injuryNotes: sql`excluded.injury_notes`,
          yearsExp: sql`excluded.years_exp`,
          age: sql`excluded.age`,
          searchRank: sql`excluded.search_rank`,
          fantasyPositions: sql`excluded.fantasy_positions`,
          raw: sql`excluded.raw`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
    written += batch.length;
  }
  return { fetched: rows.length, written, skipped: 0, source: "sleeper" };
}

// ------------------------------------------------------------- 2. schedule

export type IngestScheduleOptions = HttpOptions & {
  executor?: DbOrTx;
  weeks?: number[];
  /** Injected for tests: pre-fetched games instead of hitting the network. */
  games?: NormalizedGame[];
};

/**
 * Upsert `nfl_games` for a season. ESPN is authoritative for kickoff (true UTC
 * + live status); nflverse fills in anything ESPN has not published, and the
 * bye-week derivation in the snapshot depends on this table being complete.
 */
export async function ingestSchedule(
  season: number,
  opts: IngestScheduleOptions = {},
): Promise<IngestCounts> {
  const { executor = db, weeks = Array.from({ length: 18 }, (_, i) => i + 1), games, ...http } = opts;

  const byKey = new Map<string, NormalizedGame>();
  if (games) {
    for (const g of games) byKey.set(g.gameId, g);
  } else {
    // nflverse first so ESPN (better kickoff data) overwrites it.
    for (const g of await nflverse.fetchGamesCsv(season, http)) byKey.set(g.gameId, g);
    for (const week of weeks) {
      const espnGames = await espn.fetchScoreboard(season, week, http);
      for (const g of espnGames) {
        const existing = byKey.get(g.gameId);
        byKey.set(g.gameId, existing ? { ...existing, ...g } : g);
      }
    }
  }

  const rows = [...byKey.values()];
  let written = 0;
  for (const batch of chunk(rows)) {
    await executor
      .insert(nflGames)
      .values(
        batch.map((g) => ({
          season: g.season,
          week: g.week,
          gameId: g.gameId,
          espnId: g.espnId,
          homeTeam: g.homeTeam,
          awayTeam: g.awayTeam,
          kickoffAt: g.kickoffAt,
          status: g.status,
          homeScore: g.homeScore,
          awayScore: g.awayScore,
        })),
      )
      .onConflictDoUpdate({
        target: nflGames.gameId,
        set: {
          season: sql`excluded.season`,
          week: sql`excluded.week`,
          espnId: sql`coalesce(excluded.espn_id, ${nflGames.espnId})`,
          homeTeam: sql`excluded.home_team`,
          awayTeam: sql`excluded.away_team`,
          kickoffAt: sql`excluded.kickoff_at`,
          status: sql`excluded.status`,
          homeScore: sql`coalesce(excluded.home_score, ${nflGames.homeScore})`,
          awayScore: sql`coalesce(excluded.away_score, ${nflGames.awayScore})`,
        },
      });
    written += batch.length;
  }
  return { fetched: rows.length, written, skipped: 0, source: "espn+nflverse" };
}

// ---------------------------------------------------------- 3. projections

export type IngestProjectionsOptions = HttpOptions & {
  executor?: DbOrTx;
  provider?: ProjectionProvider;
  /** Injected for tests. */
  rows?: NormalizedProjection[];
};

/**
 * Insert a new projection vintage. Rows whose `effectiveAt` is not strictly
 * newer than the newest stored row for the same (player, season, week, source)
 * are skipped, which is what makes a 10-minute poll cheap.
 */
export async function ingestProjections(
  season: number,
  week: number,
  opts: IngestProjectionsOptions = {},
): Promise<IngestCounts> {
  const { executor = db, provider = sleeper.sleeperProjectionProvider, rows, ...http } = opts;
  const fetched = rows ?? (provider.isConfigured() ? await provider.fetchProjections(season, week, http) : []);
  const source = rows?.[0]?.source ?? provider.source;
  if (fetched.length === 0) return { fetched: 0, written: 0, skipped: 0, source };

  const index = await loadPlayerIndex(executor);

  // Newest stored vintage per player for this (season, week, source).
  const latest = await executor
    .select({
      playerId: playerProjections.playerId,
      effectiveAt: sql<Date>`max(${playerProjections.effectiveAt})`,
    })
    .from(playerProjections)
    .where(
      and(
        eq(playerProjections.season, season),
        eq(playerProjections.week, week),
        eq(playerProjections.source, source),
      ),
    )
    .groupBy(playerProjections.playerId);
  const latestByPlayer = new Map(
    latest.map((r) => [r.playerId, new Date(r.effectiveAt).getTime()]),
  );

  const values: Array<typeof playerProjections.$inferInsert> = [];
  let skipped = 0;
  for (const row of fetched) {
    // FantasyPros has no Sleeper id; its synthetic `fp:<name>|<team>|<pos>` key
    // is exactly the shape of our name-fallback index.
    const playerId = row.sleeperId.startsWith("fp:")
      ? (index.byNameKey.get(row.sleeperId.slice(3)) ?? null)
      : (index.bySleeperId.get(row.sleeperId) ?? null);
    if (!playerId) {
      skipped++;
      continue;
    }
    const previous = latestByPlayer.get(playerId);
    if (previous !== undefined && row.effectiveAt.getTime() <= previous) {
      skipped++;
      continue;
    }
    values.push({
      playerId,
      season: row.season,
      week: row.week,
      source: row.source,
      projectedPointsPpr: row.pointsPpr,
      projectedPointsHalf: row.pointsHalf,
      projectedPointsStd: row.pointsStd,
      stats: {
        ...row.stats,
        ...(row.team ? { team: row.team } : {}),
        ...(row.opponent ? { opponent: row.opponent } : {}),
        ...(row.gameId ? { game_id: row.gameId } : {}),
      },
      effectiveAt: row.effectiveAt,
    });
  }

  let written = 0;
  for (const batch of chunk(values)) {
    await executor.insert(playerProjections).values(batch);
    written += batch.length;
  }
  return { fetched: fetched.length, written, skipped, source };
}

// ---------------------------------------------------------------- 4. stats

export type IngestStatsOptions = HttpOptions & {
  executor?: DbOrTx;
  rows?: NormalizedStatLine[];
};

/**
 * Upsert actual weekly stats and score them into all three presets so the
 * scorer (and every read model) can use a stored number.
 */
export async function ingestStats(
  season: number,
  week: number,
  opts: IngestStatsOptions = {},
): Promise<IngestCounts> {
  const { executor = db, rows, ...http } = opts;
  const fetched = rows ?? (await sleeper.fetchStats(season, week, http));
  if (fetched.length === 0) {
    return { fetched: 0, written: 0, skipped: 0, source: sleeper.SLEEPER_STATS_SOURCE };
  }

  const index = await loadPlayerIndex(executor);
  const values: Array<typeof playerStatsWeekly.$inferInsert> = [];
  let skipped = 0;
  for (const row of fetched) {
    const playerId = index.bySleeperId.get(row.sleeperId);
    if (!playerId) {
      skipped++;
      continue;
    }
    const position = row.position ?? index.positionById.get(playerId) ?? null;
    const scored = computeAllPresets(row.stats, { position });
    values.push({
      playerId,
      season: row.season,
      week: row.week,
      source: row.source,
      stats: row.stats,
      fantasyPointsPpr: scored.ppr,
      fantasyPointsHalf: scored.half,
      fantasyPointsStd: scored.std,
      effectiveAt: row.effectiveAt,
    });
  }

  let written = 0;
  for (const batch of chunk(values)) {
    await executor
      .insert(playerStatsWeekly)
      .values(batch)
      .onConflictDoUpdate({
        target: [
          playerStatsWeekly.playerId,
          playerStatsWeekly.season,
          playerStatsWeekly.week,
          playerStatsWeekly.source,
        ],
        set: {
          stats: sql`excluded.stats`,
          fantasyPointsPpr: sql`excluded.fantasy_points_ppr`,
          fantasyPointsHalf: sql`excluded.fantasy_points_half`,
          fantasyPointsStd: sql`excluded.fantasy_points_std`,
          effectiveAt: sql`excluded.effective_at`,
        },
      });
    written += batch.length;
  }
  return { fetched: fetched.length, written, skipped, source: sleeper.SLEEPER_STATS_SOURCE };
}

// ------------------------------------------------------ 5. injuries + news

export type IngestNewsOptions = HttpOptions & {
  executor?: DbOrTx;
  season?: number;
  week?: number;
  newsLimit?: number;
  injuries?: NormalizedInjury[];
  news?: NormalizedNews[];
};

/**
 * ESPN injuries + news.
 *
 * A designation row is written only when the designation actually changed for
 * that player this week (the table is an effective-dated log, not a state
 * table), and news is deduped on url, falling back to headline.
 */
export async function ingestInjuriesAndNews(
  opts: IngestNewsOptions = {},
): Promise<{ injuries: IngestCounts; news: IngestCounts }> {
  const {
    executor = db,
    season = new Date().getUTCFullYear(),
    week = 1,
    newsLimit = 50,
    injuries: injectedInjuries,
    news: injectedNews,
    ...http
  } = opts;

  const index = await loadPlayerIndex(executor);

  // ---- injuries
  const fetchedInjuries = injectedInjuries ?? (await espn.fetchInjuries(http));
  let injuriesWritten = 0;
  let injuriesSkipped = 0;

  const resolved = new Map<string, NormalizedInjury>();
  for (const inj of fetchedInjuries) {
    const playerId =
      (inj.espnAthleteId ? index.byEspnId.get(inj.espnAthleteId) : undefined) ??
      resolveByName(index, inj.playerName, inj.nflTeam, null) ??
      resolveByNameAcrossPositions(index, inj.playerName, inj.nflTeam);
    if (!playerId) {
      injuriesSkipped++;
      continue;
    }
    // Last write for a player wins (ESPN can list a player twice).
    resolved.set(playerId, inj);
  }

  if (resolved.size > 0) {
    const ids = [...resolved.keys()];
    const current = await executor
      .select({
        playerId: injuryDesignations.playerId,
        designation: injuryDesignations.designation,
        effectiveAt: injuryDesignations.effectiveAt,
      })
      .from(injuryDesignations)
      .where(
        and(
          inArray(injuryDesignations.playerId, ids),
          eq(injuryDesignations.season, season),
          eq(injuryDesignations.week, week),
        ),
      );
    const latestDesignation = new Map<string, string>();
    const latestAt = new Map<string, number>();
    for (const row of current) {
      const at = new Date(row.effectiveAt).getTime();
      if ((latestAt.get(row.playerId) ?? -1) <= at) {
        latestAt.set(row.playerId, at);
        latestDesignation.set(row.playerId, row.designation);
      }
    }

    const newRows: Array<typeof injuryDesignations.$inferInsert> = [];
    for (const [playerId, inj] of resolved) {
      if (latestDesignation.get(playerId) === inj.designation) continue;
      newRows.push({
        playerId,
        season,
        week,
        designation: inj.designation,
        practiceStatus: inj.practiceStatus,
        effectiveAt: inj.effectiveAt,
        source: inj.source,
      });
    }
    for (const batch of chunk(newRows)) {
      await executor.insert(injuryDesignations).values(batch);
      injuriesWritten += batch.length;
    }
  }

  // ---- news
  const fetchedNews = injectedNews ?? (await espn.fetchNews(newsLimit, http));
  let newsWritten = 0;
  let newsSkipped = 0;
  if (fetchedNews.length > 0) {
    const urls = fetchedNews.map((n) => n.url).filter((u): u is string => !!u);
    const headlines = fetchedNews.map((n) => n.headline);
    const existing = await executor
      .select({ url: newsItems.url, headline: newsItems.headline })
      .from(newsItems)
      .where(
        urls.length > 0
          ? or(inArray(newsItems.url, urls), inArray(newsItems.headline, headlines))
          : inArray(newsItems.headline, headlines),
      );
    const seenUrls = new Set(existing.map((r) => r.url).filter(Boolean) as string[]);
    const seenHeadlines = new Set(existing.map((r) => r.headline));

    const rows: Array<typeof newsItems.$inferInsert> = [];
    for (const item of fetchedNews) {
      if ((item.url && seenUrls.has(item.url)) || seenHeadlines.has(item.headline)) {
        newsSkipped++;
        continue;
      }
      if (item.url) seenUrls.add(item.url);
      seenHeadlines.add(item.headline);
      const playerId = item.espnAthleteId ? (index.byEspnId.get(item.espnAthleteId) ?? null) : null;
      if (item.espnAthleteId && !playerId) {
        providerLog("espn", `news athlete ${item.espnAthleteId} did not join to a player`);
      }
      rows.push({
        playerId,
        source: item.source,
        headline: item.headline,
        body: item.body,
        publishedAt: item.publishedAt,
        effectiveAt: item.publishedAt ?? new Date(),
        url: item.url,
        raw: item.raw,
      });
    }
    for (const batch of chunk(rows)) {
      await executor.insert(newsItems).values(batch);
      newsWritten += batch.length;
    }
  }

  return {
    injuries: {
      fetched: fetchedInjuries.length,
      written: injuriesWritten,
      skipped: injuriesSkipped,
      source: "espn",
    },
    news: { fetched: fetchedNews.length, written: newsWritten, skipped: newsSkipped, source: "espn" },
  };
}

/** Injury feeds do not carry a position, so try each one we track. */
function resolveByNameAcrossPositions(
  index: PlayerIndex,
  name: string,
  team: string | null,
): string | null {
  for (const position of ["QB", "RB", "WR", "TE", "K", "DEF"]) {
    const hit = resolveByName(index, name, team, position);
    if (hit) return hit;
  }
  return null;
}

// ------------------------------------------------------------- ownership

export async function ingestOwnership(
  season: number,
  week: number,
  opts: HttpOptions & { executor?: DbOrTx } = {},
): Promise<IngestCounts> {
  const { executor = db, ...http } = opts;
  const rows = await sleeper.fetchOwnership(season, week, http);
  if (rows.length === 0) return { fetched: 0, written: 0, skipped: 0, source: "sleeper" };

  const index = await loadPlayerIndex(executor);
  let written = 0;
  let skipped = 0;
  // Ownership rides along on `players.raw` — it is a display-only percentage,
  // not something worth its own effective-dated table.
  for (const row of rows) {
    const playerId = index.bySleeperId.get(row.sleeperId);
    if (!playerId) {
      skipped++;
      continue;
    }
    await executor
      .update(players)
      .set({
        raw: sql`coalesce(${players.raw}, '{}'::jsonb) || ${JSON.stringify({
          owned_pct: row.ownedPct,
          started_pct: row.startedPct,
        })}::jsonb`,
      })
      .where(eq(players.id, playerId));
    written++;
  }
  return { fetched: rows.length, written, skipped, source: "sleeper" };
}
