import { NFL_TEAMS, normalizeTeam, type NflTeam } from "@/convex/providers/teams";

/**
 * Display metadata for the 32 NFL clubs. Logos are self-hosted under
 * `public/nfl/<ABBR>.svg` (pulled from static.www.nfl.com); `color` is the
 * club's primary brand colour for accents such as matchup gradients.
 */
export type NflTeamInfo = {
  abbr: NflTeam;
  name: string;
  shortName: string;
  color: string;
  logo: string;
};

const META: Record<NflTeam, { name: string; shortName: string; color: string }> = {
  ARI: { name: "Arizona Cardinals", shortName: "Cardinals", color: "#97233F" },
  ATL: { name: "Atlanta Falcons", shortName: "Falcons", color: "#A71930" },
  BAL: { name: "Baltimore Ravens", shortName: "Ravens", color: "#241773" },
  BUF: { name: "Buffalo Bills", shortName: "Bills", color: "#00338D" },
  CAR: { name: "Carolina Panthers", shortName: "Panthers", color: "#0085CA" },
  CHI: { name: "Chicago Bears", shortName: "Bears", color: "#0B162A" },
  CIN: { name: "Cincinnati Bengals", shortName: "Bengals", color: "#FB4F14" },
  CLE: { name: "Cleveland Browns", shortName: "Browns", color: "#311D00" },
  DAL: { name: "Dallas Cowboys", shortName: "Cowboys", color: "#041E42" },
  DEN: { name: "Denver Broncos", shortName: "Broncos", color: "#FB4F14" },
  DET: { name: "Detroit Lions", shortName: "Lions", color: "#0076B6" },
  GB: { name: "Green Bay Packers", shortName: "Packers", color: "#203731" },
  HOU: { name: "Houston Texans", shortName: "Texans", color: "#03202F" },
  IND: { name: "Indianapolis Colts", shortName: "Colts", color: "#002C5F" },
  JAX: { name: "Jacksonville Jaguars", shortName: "Jaguars", color: "#006778" },
  KC: { name: "Kansas City Chiefs", shortName: "Chiefs", color: "#E31837" },
  LAC: { name: "Los Angeles Chargers", shortName: "Chargers", color: "#0080C6" },
  LAR: { name: "Los Angeles Rams", shortName: "Rams", color: "#003594" },
  LV: { name: "Las Vegas Raiders", shortName: "Raiders", color: "#000000" },
  MIA: { name: "Miami Dolphins", shortName: "Dolphins", color: "#008E97" },
  MIN: { name: "Minnesota Vikings", shortName: "Vikings", color: "#4F2683" },
  NE: { name: "New England Patriots", shortName: "Patriots", color: "#002244" },
  NO: { name: "New Orleans Saints", shortName: "Saints", color: "#D3BC8D" },
  NYG: { name: "New York Giants", shortName: "Giants", color: "#0B2265" },
  NYJ: { name: "New York Jets", shortName: "Jets", color: "#125740" },
  PHI: { name: "Philadelphia Eagles", shortName: "Eagles", color: "#004C54" },
  PIT: { name: "Pittsburgh Steelers", shortName: "Steelers", color: "#FFB612" },
  SEA: { name: "Seattle Seahawks", shortName: "Seahawks", color: "#002244" },
  SF: { name: "San Francisco 49ers", shortName: "49ers", color: "#AA0000" },
  TB: { name: "Tampa Bay Buccaneers", shortName: "Buccaneers", color: "#D50A0D" },
  TEN: { name: "Tennessee Titans", shortName: "Titans", color: "#0C2340" },
  WAS: { name: "Washington Commanders", shortName: "Commanders", color: "#5A1414" },
};

export const NFL_TEAM_INFO: Record<NflTeam, NflTeamInfo> = Object.fromEntries(
  NFL_TEAMS.map((abbr) => [abbr, { abbr, ...META[abbr], logo: `/nfl/${abbr}.svg` }]),
) as Record<NflTeam, NflTeamInfo>;

/**
 * Resolve any team token the feeds produce ("LA", "WSH", "Kansas City Chiefs",
 * "@KC") to its display metadata, or null for free agents and unknowns.
 */
export function nflTeamInfo(token: string | null | undefined): NflTeamInfo | null {
  if (!token) return null;
  const cleaned = token.replace(/^(@|vs\.?|v\.?)\s*/i, "").trim();
  const abbr = normalizeTeam(cleaned);
  return abbr ? NFL_TEAM_INFO[abbr] : null;
}
