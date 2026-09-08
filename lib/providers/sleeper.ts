/**
 * Sleeper — the canonical ID space, the default projection source, and actual stats.
 *
 * Endpoints and response shapes are verified in docs/DATA_PROVIDERS.md. Nothing
 * here throws: a failed fetch returns an empty list and logs, so ingestion
 * degrades instead of dying.
 */
import { fetchJson, numericStats, num, providerLog, str, type HttpOptions } from "./http";
import { normalizeTeam } from "./teams";
import type {
  NormalizedOwnership,
  NormalizedPlayer,
  NormalizedProjection,
  NormalizedStatLine,
  NormalizedTrending,
  ProjectionProvider,
  SeasonState,
} from "./types";

export const SLEEPER_SOURCE = "sleeper_rotowire";
export const SLEEPER_STATS_SOURCE = "sleeper";

const API_V1 = "https://api.sleeper.app/v1";
const API = "https://api.sleeper.com";

/** Positions we carry. Everything else in the feed is ignored. */
export const FANTASY_POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"] as const;
const FANTASY_POSITION_SET = new Set<string>(FANTASY_POSITIONS);

/** `players/nfl` is 14.6 MB — refetch at most once a day (docs/DATA_PROVIDERS.md). */
export const PLAYERS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const PLAYERS_CACHE_PATH = ".cache/sleeper-players.json";

// -------------------------------------------------------------- raw shapes

export type SleeperRawPlayer = {
  player_id?: string;
  gsis_id?: string | null;
  espn_id?: string | number | null;
  yahoo_id?: string | number | null;
  rotowire_id?: string | number | null;
  sportradar_id?: string | null;
  fantasy_data_id?: string | number | null;
  full_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  position?: string | null;
  team?: string | null;
  status?: string | null;
  active?: boolean | null;
  injury_status?: string | null;
  injury_body_part?: string | null;
  injury_notes?: string | null;
  practice_participation?: string | null;
  news_updated?: number | null;
  years_exp?: number | null;
  age?: number | null;
  search_rank?: number | null;
  fantasy_positions?: string[] | null;
  [key: string]: unknown;
};

type SleeperStatRow = {
  player_id?: string;
  week?: number;
  season?: string | number;
  team?: string | null;
  opponent?: string | null;
  game_id?: string | null;
  category?: string;
  company?: string;
  last_modified?: number;
  stats?: Record<string, unknown>;
  player?: { position?: string | null; team?: string | null; [key: string]: unknown } | null;
};

// -------------------------------------------------------------- normalizers

/** Stat keys that are ADP noise rather than a projection (docs/DATA_PROVIDERS.md). */
const DROPPED_STAT_KEYS = new Set(["adp_dd_ppr", "pos_adp_dd_ppr", "adp_dd_std", "adp_dd_half_ppr"]);

function cleanStats(raw: unknown): Record<string, number> {
  const stats = numericStats(raw);
  for (const key of DROPPED_STAT_KEYS) delete stats[key];
  return stats;
}

export function normalizePlayer(raw: SleeperRawPlayer): NormalizedPlayer | null {
  const sleeperId = str(raw.player_id);
  const position = str(raw.position);
  if (!sleeperId || !position || !FANTASY_POSITION_SET.has(position)) return null;
  if (raw.active === false) return null;

  // Team defenses have no `full_name`; Sleeper splits them into first/last.
  const fullName =
    str(raw.full_name) ?? [raw.first_name, raw.last_name].filter(Boolean).join(" ").trim();
  if (!fullName) return null;

  return {
    sleeperId,
    gsisId: str(raw.gsis_id),
    fullName,
    firstName: str(raw.first_name),
    lastName: str(raw.last_name),
    position,
    nflTeam: normalizeTeam(raw.team),
    status: str(raw.status),
    injuryStatus: str(raw.injury_status),
    injuryBodyPart: str(raw.injury_body_part),
    injuryNotes: str(raw.injury_notes),
    practiceParticipation: str(raw.practice_participation),
    yearsExp: num(raw.years_exp),
    age: num(raw.age),
    searchRank: num(raw.search_rank),
    fantasyPositions: raw.fantasy_positions ?? [position],
    newsUpdated: num(raw.news_updated),
    crossIds: {
      espn_id: str(raw.espn_id),
      yahoo_id: str(raw.yahoo_id),
      rotowire_id: str(raw.rotowire_id),
      sportradar_id: str(raw.sportradar_id),
      fantasy_data_id: str(raw.fantasy_data_id),
      gsis_id: str(raw.gsis_id),
    },
    raw: raw as Record<string, unknown>,
  };
}

export function normalizeProjectionRow(
  row: SleeperStatRow,
  season: number,
  week: number,
): NormalizedProjection | null {
  const sleeperId = str(row.player_id);
  if (!sleeperId) return null;
  const position = str(row.player?.position);
  if (position && !FANTASY_POSITION_SET.has(position)) return null;
  const stats = cleanStats(row.stats);
  const lastModified = num(row.last_modified);
  return {
    sleeperId,
    season: num(row.season) ?? season,
    week: num(row.week) ?? week,
    position,
    team: normalizeTeam(row.team ?? row.player?.team),
    opponent: normalizeTeam(row.opponent),
    gameId: str(row.game_id),
    pointsPpr: stats.pts_ppr ?? null,
    pointsHalf: stats.pts_half_ppr ?? null,
    pointsStd: stats.pts_std ?? null,
    stats,
    effectiveAt: lastModified ? new Date(lastModified) : new Date(),
    source: SLEEPER_SOURCE,
  };
}

export function normalizeStatRow(
  row: SleeperStatRow,
  season: number,
  week: number,
): NormalizedStatLine | null {
  const sleeperId = str(row.player_id);
  if (!sleeperId) return null;
  const position = str(row.player?.position);
  if (position && !FANTASY_POSITION_SET.has(position)) return null;
  const lastModified = num(row.last_modified);
  return {
    sleeperId,
    season: num(row.season) ?? season,
    week: num(row.week) ?? week,
    position,
    team: normalizeTeam(row.team ?? row.player?.team),
    opponent: normalizeTeam(row.opponent),
    gameId: str(row.game_id),
    stats: cleanStats(row.stats),
    effectiveAt: lastModified ? new Date(lastModified) : new Date(),
    source: SLEEPER_STATS_SOURCE,
  };
}

export function parsePlayers(payload: unknown): NormalizedPlayer[] {
  if (!payload || typeof payload !== "object") return [];
  const rows: SleeperRawPlayer[] = Array.isArray(payload)
    ? (payload as SleeperRawPlayer[])
    : Object.values(payload as Record<string, SleeperRawPlayer>);
  const out: NormalizedPlayer[] = [];
  for (const row of rows) {
    try {
      const normalized = normalizePlayer(row);
      if (normalized) out.push(normalized);
    } catch (err) {
      providerLog("sleeper", `skipping malformed player row`, err);
    }
  }
  return out;
}

export function parseProjections(
  payload: unknown,
  season: number,
  week: number,
): NormalizedProjection[] {
  if (!Array.isArray(payload)) return [];
  const out: NormalizedProjection[] = [];
  for (const row of payload as SleeperStatRow[]) {
    try {
      const normalized = normalizeProjectionRow(row, season, week);
      if (normalized) out.push(normalized);
    } catch (err) {
      providerLog("sleeper", "skipping malformed projection row", err);
    }
  }
  return out;
}

export function parseStats(payload: unknown, season: number, week: number): NormalizedStatLine[] {
  if (!Array.isArray(payload)) return [];
  const out: NormalizedStatLine[] = [];
  for (const row of payload as SleeperStatRow[]) {
    try {
      const normalized = normalizeStatRow(row, season, week);
      if (normalized) out.push(normalized);
    } catch (err) {
      providerLog("sleeper", "skipping malformed stat row", err);
    }
  }
  return out;
}

export function parseOwnership(payload: unknown): NormalizedOwnership[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  return Object.entries(payload as Record<string, { owned?: unknown; started?: unknown }>).map(
    ([sleeperId, value]) => ({
      sleeperId,
      ownedPct: num(value?.owned),
      startedPct: num(value?.started),
    }),
  );
}

export function parseState(payload: unknown): SeasonState | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const season = num(p.season);
  const week = num(p.week);
  if (season === null || week === null) return null;
  return {
    season,
    week,
    displayWeek: num(p.display_week) ?? week,
    seasonType: str(p.season_type) ?? "regular",
    seasonStartDate: str(p.season_start_date),
  };
}

// ------------------------------------------------------------------ fetchers

async function readCache(
  cachePath: string,
  ttlMs: number,
): Promise<Record<string, SleeperRawPlayer> | SleeperRawPlayer[] | null> {
  try {
    const [fs, path] = await Promise.all([import("node:fs/promises"), import("node:path")]);
    const abs = path.isAbsolute(cachePath) ? cachePath : path.join(process.cwd(), cachePath);
    const stat = await fs.stat(abs);
    if (ttlMs > 0 && Date.now() - stat.mtimeMs > ttlMs) return null;
    return JSON.parse(await fs.readFile(abs, "utf8"));
  } catch {
    return null;
  }
}

async function writeCache(cachePath: string, payload: unknown): Promise<void> {
  try {
    const [fs, path] = await Promise.all([import("node:fs/promises"), import("node:path")]);
    const abs = path.isAbsolute(cachePath) ? cachePath : path.join(process.cwd(), cachePath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, JSON.stringify(payload));
  } catch (err) {
    providerLog("sleeper", "could not write player cache", err);
  }
}

export type FetchAllPlayersOptions = HttpOptions & {
  cachePath?: string;
  cacheTtlMs?: number;
  /** Skip the cache entirely (the ingest CLI's `--force`). */
  force?: boolean;
};

/**
 * The full player universe. Cached on disk for 24h because the payload is 14.6 MB
 * and the upstream changes at most daily.
 */
export async function fetchAllPlayers(
  opts: FetchAllPlayersOptions = {},
): Promise<NormalizedPlayer[]> {
  const {
    cachePath = PLAYERS_CACHE_PATH,
    cacheTtlMs = PLAYERS_CACHE_TTL_MS,
    force = false,
    ...http
  } = opts;

  if (!force) {
    const cached = await readCache(cachePath, cacheTtlMs);
    if (cached) return parsePlayers(cached);
  }

  const payload = await fetchJson<Record<string, SleeperRawPlayer>>(`${API_V1}/players/nfl`, {
    ...http,
    label: "sleeper",
    timeoutMs: http.timeoutMs ?? 120_000,
  });
  if (payload) {
    await writeCache(cachePath, payload);
    return parsePlayers(payload);
  }

  // Network failed — a stale cache still beats nothing.
  const stale = await readCache(cachePath, 0);
  if (stale) {
    providerLog("sleeper", "network failed; using stale player cache");
    return parsePlayers(stale);
  }
  return [];
}

function projectionsUrl(season: number, week: number): string {
  const positions = FANTASY_POSITIONS.map((p) => `position[]=${p}`).join("&");
  return `${API}/projections/nfl/${season}/${week}?season_type=regular&${positions}&order_by=pts_ppr`;
}

export async function fetchProjections(
  season: number,
  week: number,
  opts: HttpOptions = {},
): Promise<NormalizedProjection[]> {
  const payload = await fetchJson<unknown>(projectionsUrl(season, week), {
    ...opts,
    label: "sleeper",
  });
  return parseProjections(payload, season, week);
}

export async function fetchStats(
  season: number,
  week: number,
  opts: HttpOptions = {},
): Promise<NormalizedStatLine[]> {
  const payload = await fetchJson<unknown>(
    `${API}/stats/nfl/${season}/${week}?season_type=regular`,
    { ...opts, label: "sleeper" },
  );
  return parseStats(payload, season, week);
}

export async function fetchState(opts: HttpOptions = {}): Promise<SeasonState | null> {
  return parseState(await fetchJson<unknown>(`${API_V1}/state/nfl`, { ...opts, label: "sleeper" }));
}

export async function fetchTrending(
  opts: HttpOptions & { type?: "add" | "drop"; lookbackHours?: number; limit?: number } = {},
): Promise<NormalizedTrending[]> {
  const { type = "add", lookbackHours = 24, limit = 25, ...http } = opts;
  const payload = await fetchJson<Array<{ player_id?: string; count?: number }>>(
    `${API_V1}/players/nfl/trending/${type}?lookback_hours=${lookbackHours}&limit=${limit}`,
    { ...http, label: "sleeper" },
  );
  if (!Array.isArray(payload)) return [];
  return payload
    .map((row) => ({ sleeperId: str(row.player_id) ?? "", count: num(row.count) ?? 0 }))
    .filter((row) => row.sleeperId !== "");
}

export async function fetchOwnership(
  season: number,
  week: number,
  opts: HttpOptions = {},
): Promise<NormalizedOwnership[]> {
  const payload = await fetchJson<unknown>(
    `${API}/players/nfl/research/regular/${season}/${week}`,
    { ...opts, label: "sleeper" },
  );
  return parseOwnership(payload);
}

/** The default `ProjectionProvider` (PRD §6.5). Keyless, so always configured. */
export const sleeperProjectionProvider: ProjectionProvider = {
  source: SLEEPER_SOURCE,
  isConfigured: () => true,
  fetchProjections: (season, week, opts) => fetchProjections(season, week, opts),
};
