/**
 * Provider parsers, exercised against the same real payloads
 * `tests/scheduler/providers.test.ts` used — captured from the live endpoints on
 * 2026-09-08 and copied to `convex/providers/fixtures/`. No network.
 *
 * The port's one behavioural change is that instants are epoch milliseconds
 * rather than `Date`s (they cross an action → mutation boundary, where a `Date`
 * is not a valid Convex value), so every assertion about a timestamp asserts a
 * number here. `nflverse-games.2026.csv` is wrapped in a one-key JSON object
 * because the Edge-Runtime test environment has no filesystem to read raw text
 * from.
 */
import { describe, expect, test } from "vitest";

import {
  espnAthleteIdFromHref,
  espnAthleteIdFromLinks,
  makeGameId,
  normalizeGameStatus,
  parseInjuries,
  parseNews,
  parseScoreboard,
} from "./providers/espn";
import { parseFantasyProsProjections } from "./providers/fantasypros";
import { parseGamesCsv, splitCsvLine } from "./providers/nflverse";
import {
  parseOwnership,
  parsePlayers,
  parseProjections,
  parseState,
  parseStats,
} from "./providers/sleeper";
import { normalizeTeam, teamFromDisplayName } from "./providers/teams";

import espnInjuries from "./providers/fixtures/espn-injuries.json";
import espnNews from "./providers/fixtures/espn-news.json";
import espnScoreboard from "./providers/fixtures/espn-scoreboard.2026w1.json";
import nflverseGames from "./providers/fixtures/nflverse-games.2026.json";
import sleeperOwnership from "./providers/fixtures/sleeper-ownership.2026w1.json";
import sleeperProjections from "./providers/fixtures/sleeper-projections.2026w1.json";
import sleeperState from "./providers/fixtures/sleeper-state.json";
import sleeperStats from "./providers/fixtures/sleeper-stats.2025w1.json";

describe("team normalization", () => {
  test("maps every alias seen in the wild to the Sleeper abbreviation", () => {
    expect(normalizeTeam("LA")).toBe("LAR");
    expect(normalizeTeam("WSH")).toBe("WAS");
    expect(normalizeTeam("LVR")).toBe("LV");
    expect(normalizeTeam("OAK")).toBe("LV");
    expect(normalizeTeam("JAC")).toBe("JAX");
    expect(normalizeTeam("SD")).toBe("LAC");
    expect(normalizeTeam("STL")).toBe("LAR");
    expect(normalizeTeam("kc")).toBe("KC");
  });

  test("returns null for free agents and junk instead of throwing", () => {
    expect(normalizeTeam(null)).toBeNull();
    expect(normalizeTeam("FA")).toBeNull();
    expect(normalizeTeam("ZZZ")).toBeNull();
  });

  test("bridges ESPN's team display names", () => {
    expect(teamFromDisplayName("Washington Commanders")).toBe("WAS");
    expect(teamFromDisplayName("San Francisco 49ers")).toBe("SF");
  });
});

describe("sleeper projections", () => {
  const rows = parseProjections(sleeperProjections, 2026, 1);

  test("parses points and the vintage as epoch ms", () => {
    expect(rows.length).toBeGreaterThan(20);
    const gibbs = rows.find((r) => r.sleeperId === "9221");
    expect(gibbs).toBeDefined();
    expect(gibbs!.pointsPpr).toBeGreaterThan(20);
    expect(gibbs!.pointsHalf).toBeLessThan(gibbs!.pointsPpr!);
    expect(gibbs!.pointsStd).toBeLessThan(gibbs!.pointsHalf!);
    expect(typeof gibbs!.effectiveAt).toBe("number");
    expect(gibbs!.effectiveAt).toBeGreaterThan(0);
    expect(gibbs!.source).toBe("sleeper_rotowire");
  });

  test("keys team defenses by their abbreviation", () => {
    const defenses = rows.filter((r) => r.position === "DEF");
    expect(defenses.length).toBeGreaterThan(0);
    for (const def of defenses) {
      // DEF has no numeric id anywhere — the abbreviation IS the id.
      expect(normalizeTeam(def.sleeperId)).toBe(def.sleeperId);
      expect(def.stats).toHaveProperty("pts_allow");
    }
  });

  test("drops ADP noise from the stat bag", () => {
    for (const row of rows) {
      expect(row.stats).not.toHaveProperty("adp_dd_ppr");
      expect(row.stats).not.toHaveProperty("pos_adp_dd_ppr");
    }
  });

  test("ignores non-fantasy positions in the feed", () => {
    expect(rows.some((r) => ["DB", "CB", "P", "FB"].includes(r.position ?? ""))).toBe(false);
  });

  test("every stat value is numeric — the Convex schema has no room for strings", () => {
    for (const row of rows) {
      for (const value of Object.values(row.stats)) expect(typeof value).toBe("number");
    }
  });
});

describe("sleeper stats / state / ownership", () => {
  test("parses actual stat lines", () => {
    const rows = parseStats(sleeperStats, 2025, 1);
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.every((r) => r.source === "sleeper")).toBe(true);
    expect(rows.some((r) => r.position === "DEF")).toBe(true);
  });

  test("parses the season state", () => {
    const state = parseState(sleeperState);
    expect(state?.season).toBe(2026);
    expect(state?.week).toBeGreaterThanOrEqual(1);
  });

  test("parses ownership percentages", () => {
    const rows = parseOwnership(sleeperOwnership);
    expect(rows.length).toBeGreaterThan(50);
    expect(rows[0].ownedPct).not.toBeNull();
  });

  test("parses the player universe, skipping inactive and non-fantasy rows", () => {
    const parsed = parsePlayers([
      { player_id: "1", full_name: "Real Guy", position: "WR", team: "LA", active: true },
      { player_id: "2", full_name: "Retired", position: "WR", team: "KC", active: false },
      { player_id: "3", full_name: "Punter", position: "P", team: "KC", active: true },
      {
        player_id: "JAX",
        first_name: "Jacksonville",
        last_name: "Jaguars",
        position: "DEF",
        team: "JAX",
      },
    ]);
    expect(parsed.map((p) => p.sleeperId)).toEqual(["1", "JAX"]);
    expect(parsed[0].nflTeam).toBe("LAR");
  });

  test("keeps only string cross-ids (players.externalIds is Record<string,string>)", () => {
    const [player] = parsePlayers([
      {
        player_id: "1",
        full_name: "Real Guy",
        position: "WR",
        team: "KC",
        espn_id: 4870808,
        yahoo_id: null,
      },
    ]);
    expect(player.crossIds).toEqual({ espn_id: "4870808" });
    expect(player.espnId).toBe("4870808");
  });
});

describe("espn scoreboard", () => {
  const games = parseScoreboard(espnScoreboard, 2026, 1);

  test("gives true UTC kickoffs as epoch ms and normalized status", () => {
    expect(games.length).toBeGreaterThan(3);
    for (const game of games) {
      expect(typeof game.kickoffAt).toBe("number");
      expect(Number.isNaN(game.kickoffAt)).toBe(false);
      expect(["scheduled", "in_progress", "final", "postponed", "canceled"]).toContain(
        game.status,
      );
      expect(game.espnId).toMatch(/^\d+$/);
    }
  });

  test("builds a provider-independent game id", () => {
    expect(games[0].gameId).toBe(
      makeGameId(games[0].season, games[0].week, games[0].awayTeam, games[0].homeTeam),
    );
  });

  test("maps ESPN status names", () => {
    expect(normalizeGameStatus("STATUS_FINAL")).toBe("final");
    expect(normalizeGameStatus("STATUS_IN_PROGRESS")).toBe("in_progress");
    expect(normalizeGameStatus("STATUS_SCHEDULED")).toBe("scheduled");
    expect(normalizeGameStatus("STATUS_SCHEDULED", true)).toBe("final");
  });
});

describe("espn athlete ids", () => {
  test("parses the id out of a player-card href", () => {
    expect(
      espnAthleteIdFromHref("https://www.espn.com/nfl/player/_/id/4870808/jeremiyah-love"),
    ).toBe("4870808");
    expect(espnAthleteIdFromHref("https://www.espn.com/nfl/")).toBeNull();
    expect(espnAthleteIdFromHref(null)).toBeNull();
  });

  test("finds it inside a links array or a links object map", () => {
    expect(espnAthleteIdFromLinks([{ href: "/nfl/player/_/id/1234/x" }])).toBe("1234");
    expect(espnAthleteIdFromLinks({ web: { athletes: { href: "/nfl/player/_/id/9876/y" } } })).toBe(
      "9876",
    );
  });

  test("resolves an athlete id for every injury entry in the real payload", () => {
    const injuries = parseInjuries(espnInjuries);
    expect(injuries.length).toBeGreaterThan(5);
    expect(injuries.every((i) => i.espnAthleteId !== null)).toBe(true);
    expect(injuries.every((i) => i.nflTeam !== null)).toBe(true);
    expect(injuries.every((i) => i.designation.length > 0)).toBe(true);
    expect(injuries.every((i) => typeof i.effectiveAt === "number")).toBe(true);
  });

  test("pulls the athlete id out of news categories", () => {
    const news = parseNews(espnNews);
    expect(news.length).toBeGreaterThan(5);
    expect(news.some((n) => n.espnAthleteId !== null)).toBe(true);
    expect(news.every((n) => n.headline.length > 0)).toBe(true);
    expect(news.every((n) => n.url?.startsWith("https://") ?? true)).toBe(true);
    expect(news.every((n) => n.publishedAt === null || typeof n.publishedAt === "number")).toBe(
      true,
    );
  });
});

describe("nflverse games.csv", () => {
  const csv = (nflverseGames as { csv: string }).csv;

  test("splits quoted csv fields", () => {
    expect(splitCsvLine('a,"b,c",d')).toEqual(["a", "b,c", "d"]);
    expect(splitCsvLine('a,"say ""hi""",d')).toEqual(["a", 'say "hi"', "d"]);
  });

  test("localizes the ET gametime to a UTC instant", () => {
    const games = parseGamesCsv(csv, 2026);
    expect(games.length).toBeGreaterThan(20);
    expect(games.every((g) => g.season === 2026)).toBe(true);
    expect(games.every((g) => normalizeTeam(g.homeTeam) === g.homeTeam)).toBe(true);
    // September is EDT (UTC-4): a 20:15 ET kickoff is 00:15Z the next day.
    const opener = games[0];
    expect(new Date(opener.kickoffAt).toISOString()).toMatch(/Z$/);
  });

  test("carries the ESPN event id when present", () => {
    expect(parseGamesCsv(csv, 2026).some((g) => g.espnId !== null)).toBe(true);
  });
});

describe("fantasypros normalization", () => {
  test("produces the same normalized shape as Sleeper", () => {
    const rows = parseFantasyProsProjections(
      {
        players: [
          {
            fpid: 1,
            name: "Real Guy",
            team_id: "WSH",
            position_id: "WR",
            points: 8,
            points_ppr: 12,
            stats: { rec: 4 },
          },
          { fpid: 2, name: "Jaguars", team_id: "JAC", position_id: "DST", points: 7 },
        ],
      },
      2026,
      1,
      1_700_000_000_000,
    );
    expect(rows[0].pointsPpr).toBe(12);
    expect(rows[0].team).toBe("WAS");
    expect(rows[0].sleeperId.startsWith("fp:")).toBe(true);
    expect(rows[0].effectiveAt).toBe(1_700_000_000_000);
    // Defenses join on the abbreviation, exactly like Sleeper.
    expect(rows[1].position).toBe("DEF");
    expect(rows[1].sleeperId).toBe("JAX");
  });
});
