/**
 * nflverse `games.csv` — the season-schedule backfill (CC-BY-4.0).
 *
 * ESPN's scoreboard is authoritative for kickoff (it reports true UTC); this is
 * the fallback that fills weeks ESPN has not published yet. `gametime` is ET
 * *without* a timezone, so it must be localized through `America/New_York` —
 * here with `convex/lib/templates#fromETParts`, the dependency-free ET helper
 * `convex/windows.test.ts` proves agrees with `lib/time.ts` instant for instant.
 */
import { fromETParts } from "../lib/templates";

import { fetchText, num, providerLog, type HttpOptions } from "./http";
import { normalizeTeam } from "./teams";
import { makeGameId } from "./espn";
import type { NormalizedGame } from "./types";

export const NFLVERSE_SOURCE = "nflverse";

export const GAMES_CSV_URL =
  "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv";

/** Minimal RFC-4180 splitter — nflverse quotes stadium names containing commas. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

export function parseGamesCsv(csv: string, season?: number): NormalizedGame[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) return [];
  const header = splitCsvLine(lines[0]);
  const col = (name: string) => header.indexOf(name);
  const idx = {
    season: col("season"),
    gameType: col("game_type"),
    week: col("week"),
    gameday: col("gameday"),
    gametime: col("gametime"),
    away: col("away_team"),
    home: col("home_team"),
    awayScore: col("away_score"),
    homeScore: col("home_score"),
    espn: col("espn"),
  };

  const out: NormalizedGame[] = [];
  for (let i = 1; i < lines.length; i++) {
    try {
      const cells = splitCsvLine(lines[i]);
      const rowSeason = num(cells[idx.season]);
      if (rowSeason === null) continue;
      if (season !== undefined && rowSeason !== season) continue;
      if (idx.gameType >= 0 && cells[idx.gameType] && cells[idx.gameType] !== "REG") continue;

      const week = num(cells[idx.week]);
      const home = normalizeTeam(cells[idx.home]);
      const away = normalizeTeam(cells[idx.away]);
      const gameday = cells[idx.gameday]?.trim();
      if (week === null || !home || !away || !gameday) continue;

      const [y, m, d] = gameday.split("-").map(Number);
      if (!y || !m || !d) continue;
      // `gametime` is ET wall-clock with no zone; empty for very old rows.
      const time = (cells[idx.gametime] ?? "").trim();
      const [hh, mm] = time ? time.split(":").map(Number) : [13, 0];
      const kickoffAt = fromETParts({
        year: y,
        month: m,
        day: d,
        hour: Number.isFinite(hh) ? hh : 13,
        minute: Number.isFinite(mm) ? mm : 0,
      });

      const homeScore = num(cells[idx.homeScore]);
      const awayScore = num(cells[idx.awayScore]);
      out.push({
        season: rowSeason,
        week,
        gameId: makeGameId(rowSeason, week, away, home),
        espnId: idx.espn >= 0 && cells[idx.espn]?.trim() ? cells[idx.espn].trim() : null,
        homeTeam: home,
        awayTeam: away,
        kickoffAt,
        status: homeScore !== null && awayScore !== null ? "final" : "scheduled",
        homeScore,
        awayScore,
        source: NFLVERSE_SOURCE,
      });
    } catch (err) {
      providerLog("nflverse", `skipping malformed games.csv row ${i}`, err);
    }
  }
  return out;
}

export async function fetchGamesCsv(
  season: number,
  opts: HttpOptions = {},
): Promise<NormalizedGame[]> {
  const csv = await fetchText(GAMES_CSV_URL, {
    ...opts,
    label: "nflverse",
    timeoutMs: opts.timeoutMs ?? 30_000,
  });
  if (!csv) return [];
  return parseGamesCsv(csv, season);
}
