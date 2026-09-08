/**
 * FantasyPros v2 — the optional keyed fallback projection source
 * (docs/DATA_PROVIDERS.md). Off unless `FANTASYPROS_API_KEY` is set.
 *
 * The key is read straight off `process.env` through a local accessor rather
 * than `lib/env.ts`, which is owned by another package; add
 * `FANTASYPROS_API_KEY=` to `.env.example` when you want it on.
 *
 * FantasyPros has no Sleeper ids, so rows come back keyed by name+team+position
 * and `ingestProjections` resolves them through the same name fallback it uses
 * for ESPN news. Rows it cannot resolve are logged and skipped.
 */
import { fetchJson, num, providerLog, str, type HttpOptions } from "./http";
import { normalizeTeam } from "./teams";
import type { NormalizedProjection, ProjectionProvider } from "./types";

export const FANTASYPROS_SOURCE = "fantasypros";

const BASE = "https://api.fantasypros.com/public/v2/json/nfl";
const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"] as const;

/** Local accessor — `lib/env.ts` belongs to the foundation package. */
export function fantasyProsApiKey(): string | null {
  const key = process.env.FANTASYPROS_API_KEY?.trim();
  return key ? key : null;
}

type FpPlayer = {
  fpid?: number | string;
  player_id?: number | string;
  mflid?: number | string;
  name?: string;
  team_id?: string;
  team?: string;
  position_id?: string;
  position?: string;
  stats?: Record<string, unknown>;
  points?: number | string;
  points_ppr?: number | string;
  points_half?: number | string;
};

/**
 * `key` is what we can join on: FantasyPros never carries a Sleeper id, so the
 * synthetic key is `fp:<name>|<team>|<pos>` and ingestion resolves it by name.
 */
export function fantasyProsKey(name: string, team: string | null, position: string | null): string {
  return `fp:${name.toLowerCase().replace(/[^a-z]/g, "")}|${team ?? ""}|${position ?? ""}`;
}

export function parseFantasyProsProjections(
  payload: unknown,
  season: number,
  week: number,
  effectiveAt = new Date(),
): NormalizedProjection[] {
  const root = payload as { players?: FpPlayer[] } | null;
  if (!root || !Array.isArray(root.players)) return [];
  const out: NormalizedProjection[] = [];
  for (const row of root.players) {
    try {
      const name = str(row.name);
      if (!name) continue;
      const rawPosition = str(row.position_id ?? row.position);
      const position = rawPosition === "DST" ? "DEF" : rawPosition;
      const team = normalizeTeam(row.team_id ?? row.team);
      const stats: Record<string, number> = {};
      for (const [k, v] of Object.entries(row.stats ?? {})) {
        const parsed = num(v);
        if (parsed !== null) stats[k] = parsed;
      }
      const std = num(row.points);
      const ppr = num(row.points_ppr) ?? std;
      const half = num(row.points_half) ?? (ppr !== null && std !== null ? (ppr + std) / 2 : null);
      out.push({
        // DEF joins on the team abbreviation everywhere in this codebase.
        sleeperId: position === "DEF" && team ? team : fantasyProsKey(name, team, position),
        season,
        week,
        position,
        team,
        opponent: null,
        gameId: null,
        pointsPpr: ppr,
        pointsHalf: half,
        pointsStd: std,
        stats: { ...stats, ...(ppr !== null ? { pts_ppr: ppr } : {}) },
        effectiveAt,
        source: FANTASYPROS_SOURCE,
      });
    } catch (err) {
      providerLog("fantasypros", "skipping malformed projection row", err);
    }
  }
  return out;
}

export async function fetchProjections(
  season: number,
  week: number,
  opts: HttpOptions = {},
): Promise<NormalizedProjection[]> {
  const key = fantasyProsApiKey();
  if (!key) return [];
  const effectiveAt = new Date();
  const all: NormalizedProjection[] = [];
  for (const position of POSITIONS) {
    const payload = await fetchJson<unknown>(
      `${BASE}/${season}/projections?position=${position}&week=${week}&scoring=PPR`,
      { ...opts, label: "fantasypros", headers: { "x-api-key": key, ...opts.headers } },
    );
    if (!payload) continue;
    all.push(...parseFantasyProsProjections(payload, season, week, effectiveAt));
  }
  return all;
}

export const fantasyProsProjectionProvider: ProjectionProvider = {
  source: FANTASYPROS_SOURCE,
  isConfigured: () => fantasyProsApiKey() !== null,
  fetchProjections: (season, week, opts) => fetchProjections(season, week, opts),
};
