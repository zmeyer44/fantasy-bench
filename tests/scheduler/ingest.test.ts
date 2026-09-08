/**
 * Ingestion: vintage retention, id resolution, and dedupe.
 */
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import { injuryDesignations, newsItems, nflGames, players, playerProjections, playerStatsWeekly } from "@/lib/db/schema";
import { parseScoreboard } from "@/lib/providers/espn";
import {
  ingestInjuriesAndNews,
  ingestPlayers,
  ingestProjections,
  ingestSchedule,
  ingestStats,
  loadPlayerIndex,
  nameKey,
} from "@/lib/providers/ingest";
import { parseStats } from "@/lib/providers/sleeper";
import { fullIngestPlan, planFor } from "@/lib/providers/ingest-plan";
import { fromET } from "@/lib/time";

import { truncateAll } from "../setup";
import { fixture, projectionRow } from "./helpers";

const SEASON = 2026;

async function seedTwoPlayers() {
  return db
    .insert(players)
    .values([
      {
        sleeperId: "9221",
        fullName: "Jahmyr Gibbs",
        position: "RB",
        nflTeam: "DET",
        raw: { espn_id: "4429795" },
      },
      { sleeperId: "JAX", fullName: "Jacksonville Jaguars", position: "DEF", nflTeam: "JAX", raw: {} },
    ])
    .returning({ id: players.id, sleeperId: players.sleeperId });
}

describe("player index", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("indexes by sleeper id, espn id and name", async () => {
    await seedTwoPlayers();
    const index = await loadPlayerIndex();
    expect(index.bySleeperId.get("9221")).toBeDefined();
    expect(index.byEspnId.get("4429795")).toBe(index.bySleeperId.get("9221"));
    expect(index.byNameKey.get(nameKey("Jahmyr Gibbs", "DET", "RB"))).toBe(
      index.bySleeperId.get("9221"),
    );
    // Team-less fallback for feeds that do not agree on the abbreviation.
    expect(index.byNameKey.get(nameKey("Jahmyr Gibbs", null, "RB"))).toBeDefined();
  });
});

describe("ingestPlayers", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("upserts from a cache file and keeps cross ids in `raw`", async () => {
    const result = await ingestPlayers({
      cachePath: "scripts/fixtures/players.sample.json",
      cacheTtlMs: 0,
    });
    expect(result.written).toBeGreaterThan(100);
    const gibbs = await db.query.players.findFirst({ where: eq(players.sleeperId, "9221") });
    expect(gibbs!.fullName).toBe("Jahmyr Gibbs");
    expect(gibbs!.raw).toHaveProperty("espn_id");

    // Idempotent: a second pass updates in place.
    const again = await ingestPlayers({
      cachePath: "scripts/fixtures/players.sample.json",
      cacheTtlMs: 0,
    });
    expect(again.written).toBe(result.written);
    const all = await db.select().from(players);
    expect(all).toHaveLength(result.written);
  });
});

describe("ingestProjections", () => {
  beforeEach(async () => {
    await truncateAll();
    await seedTwoPlayers();
  });

  it("writes a row and skips a stale vintage, retaining the old one", async () => {
    const first = new Date("2026-09-08T10:00:00Z");
    const written = await ingestProjections(SEASON, 1, {
      rows: [projectionRow({ sleeperId: "9221", pointsPpr: 20, effectiveAt: first })],
    });
    expect(written.written).toBe(1);

    // Same vintage -> skipped.
    const same = await ingestProjections(SEASON, 1, {
      rows: [projectionRow({ sleeperId: "9221", pointsPpr: 21, effectiveAt: first })],
    });
    expect(same.written).toBe(0);
    expect(same.skipped).toBe(1);

    // Newer vintage -> a NEW row; the old one survives.
    const newer = await ingestProjections(SEASON, 1, {
      rows: [
        projectionRow({
          sleeperId: "9221",
          pointsPpr: 25,
          effectiveAt: new Date("2026-09-08T12:00:00Z"),
        }),
      ],
    });
    expect(newer.written).toBe(1);

    const rows = await db.select().from(playerProjections).orderBy(playerProjections.effectiveAt);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.projectedPointsPpr)).toEqual([20, 25]);
  });

  it("skips rows that do not resolve to a player", async () => {
    const result = await ingestProjections(SEASON, 1, {
      rows: [projectionRow({ sleeperId: "does-not-exist" })],
    });
    expect(result.written).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("joins defenses on the team abbreviation", async () => {
    const result = await ingestProjections(SEASON, 1, {
      rows: [projectionRow({ sleeperId: "JAX", position: "DEF", team: "JAX", pointsPpr: 9 })],
    });
    expect(result.written).toBe(1);
  });
});

describe("ingestStats", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("scores every preset from the stat bag and upserts", async () => {
    await ingestPlayers({ cachePath: "scripts/fixtures/players.sample.json", cacheTtlMs: 0 });
    const rows = parseStats(fixture("sleeper-stats.2025w1.json"), 2025, 1);
    const result = await ingestStats(2025, 1, { rows });
    expect(result.written).toBeGreaterThan(0);

    const stored = await db
      .select()
      .from(playerStatsWeekly)
      .where(and(eq(playerStatsWeekly.season, 2025), eq(playerStatsWeekly.week, 1)));
    expect(stored.length).toBe(result.written);
    for (const row of stored) {
      expect(row.fantasyPointsPpr).not.toBeNull();
      expect(row.fantasyPointsPpr!).toBeGreaterThanOrEqual(row.fantasyPointsStd!);
    }

    const again = await ingestStats(2025, 1, { rows });
    expect(again.written).toBe(result.written);
    const afterSecond = await db.select().from(playerStatsWeekly);
    expect(afterSecond).toHaveLength(stored.length);
  });
});

describe("ingestSchedule", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("upserts games with the ESPN kickoff and event id", async () => {
    const games = parseScoreboard(fixture("espn-scoreboard.2026w1.json"), 2026, 1);
    const result = await ingestSchedule(2026, { games });
    expect(result.written).toBe(games.length);

    const stored = await db.select().from(nflGames);
    expect(stored).toHaveLength(games.length);
    expect(stored.every((g) => g.espnId !== null)).toBe(true);

    const again = await ingestSchedule(2026, { games });
    expect(again.written).toBe(games.length);
    expect(await db.select().from(nflGames)).toHaveLength(games.length);
  });
});

describe("ingestInjuriesAndNews", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("writes a designation only when it changes, and dedupes news", async () => {
    await ingestPlayers({ cachePath: "scripts/fixtures/players.sample.json", cacheTtlMs: 0 });
    const [player] = await db.select().from(players).limit(1);

    const injuries = [
      {
        espnAthleteId: null,
        playerName: player.fullName,
        nflTeam: player.nflTeam,
        designation: "Questionable",
        practiceStatus: null,
        comment: null,
        effectiveAt: new Date("2026-09-08T10:00:00Z"),
        source: "espn",
      },
    ];
    const news = [
      {
        externalId: "1",
        espnAthleteId: null,
        headline: "Something happened",
        body: null,
        url: "https://example.test/1",
        publishedAt: new Date("2026-09-08T10:00:00Z"),
        source: "espn",
        raw: {},
      },
    ];

    const first = await ingestInjuriesAndNews({ season: 2026, week: 1, injuries, news });
    expect(first.injuries.written).toBe(1);
    expect(first.news.written).toBe(1);

    // Unchanged designation and the same url -> nothing new.
    const second = await ingestInjuriesAndNews({ season: 2026, week: 1, injuries, news });
    expect(second.injuries.written).toBe(0);
    expect(second.news.written).toBe(0);
    expect(second.news.skipped).toBe(1);

    // A changed designation IS a new effective-dated row.
    const third = await ingestInjuriesAndNews({
      season: 2026,
      week: 1,
      injuries: [{ ...injuries[0], designation: "Out", effectiveAt: new Date("2026-09-09T10:00:00Z") }],
      news: [],
    });
    expect(third.injuries.written).toBe(1);
    expect(await db.select().from(injuryDesignations)).toHaveLength(2);
    expect(await db.select().from(newsItems)).toHaveLength(1);
  });
});

describe("cron ingest plan", () => {
  it("switches to a stats/news set during game windows", () => {
    // Sunday 2026-09-13 13:00 ET
    const sunday = planFor(fromET({ year: 2026, month: 9, day: 13, hour: 13 }));
    expect(sunday.reason).toBe("game_day");
    expect(sunday.stats).toBe(true);
    expect(sunday.players).toBe(false);

    // Monday 2026-09-14 20:00 ET
    expect(planFor(fromET({ year: 2026, month: 9, day: 14, hour: 20 })).reason).toBe("game_day");
    // Thursday 2026-09-10 20:00 ET
    expect(planFor(fromET({ year: 2026, month: 9, day: 10, hour: 20 })).reason).toBe("game_day");
  });

  it("does the full rebuild on Tuesday morning", () => {
    const plan = planFor(fromET({ year: 2026, month: 9, day: 8, hour: 6 }));
    expect(plan.reason).toBe("weekly_rebuild");
    expect(plan.players).toBe(true);
    expect(plan.ownership).toBe(true);
  });

  it("keeps the routine set cheap otherwise", () => {
    const plan = planFor(fromET({ year: 2026, month: 9, day: 11, hour: 11 }));
    expect(plan.reason).toBe("routine");
    expect(plan.players).toBe(false);
    expect(plan.projections).toBe(true);
  });

  it("turns everything on for a manual run", () => {
    const plan = fullIngestPlan();
    expect(Object.values(plan).filter((v) => v === true)).toHaveLength(6);
  });
});
