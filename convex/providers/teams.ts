/**
 * Canonical NFL team abbreviations.
 * (pure string maps — nothing to change for the Convex runtime).
 *
 * Sleeper's abbreviations are the canonical ID space for the whole app
 * (docs/DATA_PROVIDERS.md), so every other feed is normalized into them:
 * nflverse `LA` -> `LAR`, ESPN `WSH` -> `WAS`, DynastyProcess `LVR` -> `LV`.
 * DEF "players" are keyed by these abbreviations because no numeric id exists
 * for a team defense in any feed.
 */

export const NFL_TEAMS = [
  "ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE",
  "DAL", "DEN", "DET", "GB", "HOU", "IND", "JAX", "KC",
  "LAC", "LAR", "LV", "MIA", "MIN", "NE", "NO", "NYG",
  "NYJ", "PHI", "PIT", "SEA", "SF", "TB", "TEN", "WAS",
] as const;

export type NflTeam = (typeof NFL_TEAMS)[number];

const CANONICAL = new Set<string>(NFL_TEAMS);

/** Everything we have actually seen in the wild, mapped to the canonical form. */
const ALIASES: Record<string, NflTeam> = {
  // Los Angeles / St. Louis / San Diego / Oakland moves
  LA: "LAR",
  LAR: "LAR",
  RAM: "LAR",
  STL: "LAR",
  SD: "LAC",
  SDG: "LAC",
  OAK: "LV",
  LVR: "LV",
  RAI: "LV",
  // Washington
  WSH: "WAS",
  WFT: "WAS",
  WAS: "WAS",
  // Jacksonville
  JAC: "JAX",
  // PFR / nflverse three-letter variants
  ARZ: "ARI",
  BLT: "BAL",
  CLV: "CLE",
  HST: "HOU",
  GNB: "GB",
  KAN: "KC",
  KCC: "KC",
  NWE: "NE",
  NOR: "NO",
  SFO: "SF",
  TAM: "TB",
  TBB: "TB",
  NOS: "NO",
};

/** ESPN injuries groups players by team *display name*; this bridges back. */
const DISPLAY_NAMES: Record<string, NflTeam> = {
  "arizona cardinals": "ARI",
  "atlanta falcons": "ATL",
  "baltimore ravens": "BAL",
  "buffalo bills": "BUF",
  "carolina panthers": "CAR",
  "chicago bears": "CHI",
  "cincinnati bengals": "CIN",
  "cleveland browns": "CLE",
  "dallas cowboys": "DAL",
  "denver broncos": "DEN",
  "detroit lions": "DET",
  "green bay packers": "GB",
  "houston texans": "HOU",
  "indianapolis colts": "IND",
  "jacksonville jaguars": "JAX",
  "kansas city chiefs": "KC",
  "los angeles chargers": "LAC",
  "los angeles rams": "LAR",
  "las vegas raiders": "LV",
  "miami dolphins": "MIA",
  "minnesota vikings": "MIN",
  "new england patriots": "NE",
  "new orleans saints": "NO",
  "new york giants": "NYG",
  "new york jets": "NYJ",
  "philadelphia eagles": "PHI",
  "pittsburgh steelers": "PIT",
  "seattle seahawks": "SEA",
  "san francisco 49ers": "SF",
  "tampa bay buccaneers": "TB",
  "tennessee titans": "TEN",
  "washington commanders": "WAS",
};

/**
 * Normalize any team token to the canonical Sleeper abbreviation.
 * Returns null for free agents / unknown tokens rather than throwing — provider
 * parsers must never blow up on one bad row.
 */
export function normalizeTeam(value: string | null | undefined): NflTeam | null {
  if (!value) return null;
  const key = value.trim().toUpperCase();
  if (!key || key === "FA" || key === "NONE" || key === "null") return null;
  if (CANONICAL.has(key)) return key as NflTeam;
  const alias = ALIASES[key];
  if (alias) return alias;
  const byName = DISPLAY_NAMES[value.trim().toLowerCase()];
  return byName ?? null;
}

/** True when the token names a real NFL team (after normalization). */
export function isNflTeam(value: string | null | undefined): boolean {
  return normalizeTeam(value) !== null;
}

export function teamFromDisplayName(name: string | null | undefined): NflTeam | null {
  if (!name) return null;
  return DISPLAY_NAMES[name.trim().toLowerCase()] ?? normalizeTeam(name);
}
