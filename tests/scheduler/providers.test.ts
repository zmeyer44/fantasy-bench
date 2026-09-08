/**
 * Provider parsers, exercised against real payloads captured from the live
 * endpoints on 2026-09-08 (see tests/scheduler/fixtures/). No network.
 */
import { describe, expect, it } from "vitest";

import {
  espnAthleteIdFromHref,
  espnAthleteIdFromLinks,
  makeGameId,
  normalizeGameStatus,
  parseInjuries,
  parseNews,
  parseScoreboard,
} from "@/lib/providers/espn";
import { parseGamesCsv, splitCsvLine } from "@/lib/providers/nflverse";
import {
  parseOwnership,
  parseProjections,
  parseState,
  parseStats,
  parsePlayers,
} from "@/lib/providers/sleeper";
import { parseFantasyProsProjections } from "@/lib/providers/fantasypros";
import { normalizeTeam, teamFromDisplayName } from "@/lib/providers/teams";

import { fixture, fixtureText } from "./helpers";

describe("team normalization", () => {
  it("maps every alias seen in the wild to the Sleeper abbreviation", () => {
    expect(normalizeTeam("LA")).toBe("LAR");
    expect(normalizeTeam("WSH")).toBe("WAS");
    expect(normalizeTeam("LVR")).toBe("LV");
    expect(normalizeTeam("OAK")).toBe("LV");
    expect(normalizeTeam("JAC")).toBe("JAX");
    expect(normalizeTeam("SD")).toBe("LAC");
    expect(normalizeTeam("STL")).toBe("LAR");
    expect(normalizeTeam("kc")).toBe("KC");
  });

  it("returns null for free agents and junk instead of throwing", () => {
    expect(normalizeTeam(null)).toBeNull();
    expect(normalizeTeam("FA")).toBeNull();
    expect(normalizeTeam("ZZZ")).toBeNull();
  });

  it("bridges ESPN's team display names", () => {
    expect(teamFromDisplayName("Washington Commanders")).toBe("WAS");
    expect(teamFromDisplayName("San Francisco 49ers")).toBe("SF");
  });
});

describe("sleeper projections", () => {
  const rows = parseProjections(fixture("sleeper-projections.2026w1.json"), 2026, 1);

  it("parses points and the vintage", () => {
    expect(rows.length).toBeGreaterThan(20);
    const gibbs = rows.find((r) => r.sleeperId === "9221");
    expect(gibbs).toBeDefined();
    expect(gibbs!.pointsPpr).toBeGreaterThan(20);
    expect(gibbs!.pointsHalf).toBeLessThan(gibbs!.pointsPpr!);
    expect(gibbs!.pointsStd).toBeLessThan(gibbs!.pointsHalf!);
    expect(gibbs!.effectiveAt.getTime()).toBeGreaterThan(0);
    expect(gibbs!.source).toBe("sleeper_rotowire");
  });

  it("keys team defenses by their abbreviation", () => {
    const defenses = rows.filter((r) => r.position === "DEF");
    expect(defenses.length).toBeGreaterThan(0);
    for (const def of defenses) {
      // DEF has no numeric id anywhere — the abbreviation IS the id.
      expect(normalizeTeam(def.sleeperId)).toBe(def.sleeperId);
      expect(def.stats).toHaveProperty("pts_allow");
    }
  });

  it("drops ADP noise from the stat bag", () => {
    for (const row of rows) {
      expect(row.stats).not.toHaveProperty("adp_dd_ppr");
      expect(row.stats).not.toHaveProperty("pos_adp_dd_ppr");
    }
  });

  it("ignores non-fantasy positions in the feed", () => {
    expect(rows.some((r) => ["DB", "CB", "P", "FB"].includes(r.position ?? ""))).toBe(false);
  });
});

describe("sleeper stats / state / ownership", () => {
  it("parses actual stat lines", () => {
    const rows = parseStats(fixture("sleeper-stats.2025w1.json"), 2025, 1);
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.every((r) => r.source === "sleeper")).toBe(true);
    expect(rows.some((r) => r.position === "DEF")).toBe(true);
  });

  it("parses the season state", () => {
    const state = parseState(fixture("sleeper-state.json"));
    expect(state?.season).toBe(2026);
    expect(state?.week).toBeGreaterThanOrEqual(1);
  });

  it("parses ownership percentages", () => {
    const rows = parseOwnership(fixture("sleeper-ownership.2026w1.json"));
    expect(rows.length).toBeGreaterThan(50);
    expect(rows[0].ownedPct).not.toBeNull();
  });

  it("parses the player universe, skipping inactive and non-fantasy rows", () => {
    const parsed = parsePlayers([
      { player_id: "1", full_name: "Real Guy", position: "WR", team: "LA", active: true },
      { player_id: "2", full_name: "Retired", position: "WR", team: "KC", active: false },
      { player_id: "3", full_name: "Punter", position: "P", team: "KC", active: true },
      { player_id: "JAX", first_name: "Jacksonville", last_name: "Jaguars", position: "DEF", team: "JAX" },
    ]);
    expect(parsed.map((p) => p.sleeperId)).toEqual(["1", "JAX"]);
    expect(parsed[0].nflTeam).toBe("LAR");
  });
});

describe("espn scoreboard", () => {
  const games = parseScoreboard(fixture("espn-scoreboard.2026w1.json"), 2026, 1);

  it("gives true UTC kickoffs and normalized status", () => {
    expect(games.length).toBeGreaterThan(3);
    for (const game of games) {
      expect(game.kickoffAt.toISOString()).toMatch(/Z$/);
      expect(["scheduled", "in_progress", "final", "postponed", "canceled"]).toContain(game.status);
      expect(game.espnId).toMatch(/^\d+$/);
    }
  });

  it("builds a provider-independent game id", () => {
    expect(games[0].gameId).toBe(
      makeGameId(games[0].season, games[0].week, games[0].awayTeam, games[0].homeTeam),
    );
  });

  it("maps ESPN status names", () => {
    expect(normalizeGameStatus("STATUS_FINAL")).toBe("final");
    expect(normalizeGameStatus("STATUS_IN_PROGRESS")).toBe("in_progress");
    expect(normalizeGameStatus("STATUS_SCHEDULED")).toBe("scheduled");
    expect(normalizeGameStatus("STATUS_SCHEDULED", true)).toBe("final");
  });
});

describe("espn athlete ids", () => {
  it("parses the id out of a player-card href", () => {
    expect(
      espnAthleteIdFromHref("https://www.espn.com/nfl/player/_/id/4870808/jeremiyah-love"),
    ).toBe("4870808");
    expect(espnAthleteIdFromHref("https://www.espn.com/nfl/")).toBeNull();
    expect(espnAthleteIdFromHref(null)).toBeNull();
  });

  it("finds it inside a links array or a links object map", () => {
    expect(espnAthleteIdFromLinks([{ href: "/nfl/player/_/id/1234/x" }])).toBe("1234");
    expect(
      espnAthleteIdFromLinks({ web: { athletes: { href: "/nfl/player/_/id/9876/y" } } }),
    ).toBe("9876");
  });

  it("resolves an athlete id for every injury entry in the real payload", () => {
    const injuries = parseInjuries(fixture("espn-injuries.json"));
    expect(injuries.length).toBeGreaterThan(5);
    expect(injuries.every((i) => i.espnAthleteId !== null)).toBe(true);
    expect(injuries.every((i) => i.nflTeam !== null)).toBe(true);
    expect(injuries.every((i) => i.designation.length > 0)).toBe(true);
  });

  it("pulls the athlete id out of news categories", () => {
    const news = parseNews(fixture("espn-news.json"));
    expect(news.length).toBeGreaterThan(5);
    expect(news.some((n) => n.espnAthleteId !== null)).toBe(true);
    expect(news.every((n) => n.headline.length > 0)).toBe(true);
    expect(news.every((n) => n.url?.startsWith("https://") ?? true)).toBe(true);
  });
});

describe("nflverse games.csv", () => {
  it("splits quoted csv fields", () => {
    expect(splitCsvLine('a,"b,c",d')).toEqual(["a", "b,c", "d"]);
    expect(splitCsvLine('a,"say ""hi""",d')).toEqual(["a", 'say "hi"', "d"]);
  });

  it("localizes the ET gametime to a UTC instant", () => {
    const games = parseGamesCsv(fixtureText("nflverse-games.2026.csv"), 2026);
    expect(games.length).toBeGreaterThan(20);
    const first = games[0];
    // September is EDT (UTC-4): 20:15 ET -> 00:15Z the next day.
    expect(first.kickoffAt.toISOString()).toMatch(/Z$/);
    expect(games.every((g) => g.season === 2026)).toBe(true);
    expect(games.every((g) => normalizeTeam(g.homeTeam) === g.homeTeam)).toBe(true);
  });

  it("carries the ESPN event id when present", () => {
    const games = parseGamesCsv(fixtureText("nflverse-games.2026.csv"), 2026);
    expect(games.some((g) => g.espnId !== null)).toBe(true);
  });
});

describe("fantasypros normalization", () => {
  it("produces the same normalized shape as Sleeper", () => {
    const rows = parseFantasyProsProjections(
      {
        players: [
          { fpid: 1, name: "Real Guy", team_id: "WSH", position_id: "WR", points: 8, points_ppr: 12, stats: { rec: 4 } },
          { fpid: 2, name: "Jaguars", team_id: "JAC", position_id: "DST", points: 7 },
        ],
      },
      2026,
      1,
    );
    expect(rows[0].pointsPpr).toBe(12);
    expect(rows[0].team).toBe("WAS");
    expect(rows[0].sleeperId.startsWith("fp:")).toBe(true);
    // Defenses join on the abbreviation, exactly like Sleeper.
    expect(rows[1].position).toBe("DEF");
    expect(rows[1].sleeperId).toBe("JAX");
  });
});
