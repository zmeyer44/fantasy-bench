/**
 * Ingestion: the batched write mutations, the projection vintage gate, and the
 * `ingest_state` bookkeeping the crons read.
 *
 * The parsers are covered by `convex/providers.test.ts` against real payloads;
 * what matters here is what reaches the database — that a ten-minute poll over
 * an unchanged feed writes nothing, that `player_projection_latest` is upserted
 * in the same transaction as the vintage it summarises, and that the feeds with
 * no id (ESPN injuries, FantasyPros) still find their player.
 */
import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";

import { internal } from "./_generated/api";
import { BATCH, NEWS_BATCH, PROJECTION_BATCH, nameKey, planFor } from "./ingest";
import { fromETParts } from "./lib/templates";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

function harness() {
  return convexTest(schema, modules);
}
type TestHarness = ReturnType<typeof harness>;

const SEASON = 2026;
const WEEK = 1;
const T0 = Date.UTC(2026, 8, 8, 12, 0, 0);

function player(overrides: Record<string, unknown> = {}) {
  return {
    sleeperId: "9221",
    gsisId: "00-0038543",
    espnId: "4429795",
    fullName: "Jahmyr Gibbs",
    firstName: "Jahmyr",
    lastName: "Gibbs",
    position: "RB",
    nflTeam: "DET",
    status: "Active",
    injuryStatus: null,
    injuryBodyPart: null,
    injuryNotes: null,
    practiceParticipation: null,
    yearsExp: 3,
    age: 24,
    searchRank: 4,
    fantasyPositions: ["RB"],
    newsUpdated: T0,
    crossIds: { espn_id: "4429795", gsis_id: "00-0038543" },
    ...overrides,
  };
}

function projection(overrides: Record<string, unknown> = {}) {
  return {
    sleeperId: "9221",
    season: SEASON,
    week: WEEK,
    position: "RB",
    team: "DET",
    opponent: "NO",
    gameId: "202610111",
    pointsPpr: 23.68,
    pointsHalf: 21.38,
    pointsStd: 19.08,
    stats: { pts_ppr: 23.68, rush_yd: 90.73, rec: 4.6 },
    effectiveAt: T0,
    source: "sleeper_rotowire",
    ...overrides,
  };
}

async function seedPlayers(t: TestHarness, rows: Array<Record<string, unknown>>) {
  return t.mutation(internal.ingest.upsertPlayers, {
    rows: rows as never,
    now: T0,
  });
}

// --------------------------------------------------------------------- plan

describe("the ingest plan", () => {
  test("pulls the cheap, high-value feeds on the routine poll", () => {
    expect(planFor("regular")).toEqual({
      players: false,
      schedule: false,
      projections: true,
      stats: false,
      news: true,
      ownership: false,
    });
  });

  test("swaps projections for live stats and game status on game day", () => {
    const plan = planFor("gameday");
    expect(plan.stats).toBe(true);
    expect(plan.schedule).toBe(true);
    expect(plan.projections).toBe(false);
    expect(plan.players).toBe(false);
  });

  test("rebuilds everything, including the 14.6 MB player feed, on full", () => {
    expect(Object.values(planFor("full")).every(Boolean)).toBe(true);
  });

  test("batches stay inside the documented per-transaction budgets", () => {
    expect(BATCH).toBeLessThanOrEqual(400);
    // Projections write two documents per row (the vintage + the latest upsert).
    expect(PROJECTION_BATCH * 2).toBeLessThanOrEqual(BATCH * 2);
    // Injuries are read-heavy: up to 13 index ranges each against a 4,096 limit.
    expect(NEWS_BATCH * 13).toBeLessThan(4096);
  });
});

// ------------------------------------------------------------------ players

describe("ingest.upsertPlayers", () => {
  test("inserts, then updates in place, and derives the name join key", async () => {
    const t = harness();
    expect(await seedPlayers(t, [player()])).toEqual({ written: 1, skipped: 0 });

    const first = await t.run(async (ctx) =>
      ctx.db
        .query("players")
        .withIndex("by_sleeperId", (q) => q.eq("sleeperId", "9221"))
        .unique(),
    );
    expect(first?.fullName).toBe("Jahmyr Gibbs");
    expect(first?.nameKey).toBe(nameKey("Jahmyr Gibbs", "DET", "RB"));
    expect(first?.espnId).toBe("4429795");
    expect(first?.externalIds.gsis_id).toBe("00-0038543");

    // A trade: same Sleeper id, new team. One row, new key.
    await seedPlayers(t, [player({ nflTeam: "KC", injuryStatus: "Questionable" })]);
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("players")
        .withIndex("by_sleeperId", (q) => q.eq("sleeperId", "9221"))
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]._id).toBe(first!._id);
    expect(rows[0].nflTeam).toBe("KC");
    expect(rows[0].injuryStatus).toBe("Questionable");
    expect(rows[0].nameKey).toBe(nameKey("Jahmyr Gibbs", "KC", "RB"));
  });

  test("skips a position the app does not carry rather than failing the batch", async () => {
    const t = harness();
    const result = await seedPlayers(t, [
      player(),
      player({ sleeperId: "999", fullName: "Some Punter", position: "P" }),
    ]);
    expect(result).toEqual({ written: 1, skipped: 1 });
  });

  test("folds the practice participation into externalIds", async () => {
    const t = harness();
    await seedPlayers(t, [player({ practiceParticipation: "Limited Participation" })]);
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("players")
        .withIndex("by_sleeperId", (q) => q.eq("sleeperId", "9221"))
        .unique(),
    );
    expect(row?.externalIds.practice_participation).toBe("Limited Participation");
  });
});

// -------------------------------------------------------------- projections

describe("ingest.insertProjections", () => {
  test("appends a vintage and upserts the latest row in one transaction", async () => {
    const t = harness();
    await seedPlayers(t, [player()]);

    expect(await t.mutation(internal.ingest.insertProjections, { rows: [projection()] })).toEqual({
      written: 1,
      skipped: 0,
    });

    const { vintages, latest } = await t.run(async (ctx) => ({
      vintages: await ctx.db.query("player_projections").collect(),
      latest: await ctx.db.query("player_projection_latest").collect(),
    }));
    expect(vintages).toHaveLength(1);
    expect(latest).toHaveLength(1);
    expect(latest[0].projectedPointsPpr).toBeCloseTo(23.68);
    // `player_projection_latest` carries the position the ranked index sorts by.
    expect(latest[0].position).toBe("RB");
  });

  test("skips a vintage that is not strictly newer — the ten-minute poll is free", async () => {
    const t = harness();
    await seedPlayers(t, [player()]);
    await t.mutation(internal.ingest.insertProjections, { rows: [projection()] });

    // Same vintage (the CDN served the same `last_modified`), and an older one.
    expect(
      await t.mutation(internal.ingest.insertProjections, {
        rows: [projection(), projection({ effectiveAt: T0 - 60_000, pointsPpr: 1 })],
      }),
    ).toEqual({ written: 0, skipped: 2 });

    const vintages = await t.run(async (ctx) => ctx.db.query("player_projections").collect());
    expect(vintages).toHaveLength(1);
  });

  test("skips a newer vintage whose numbers did not move", async () => {
    const t = harness();
    await seedPlayers(t, [player()]);
    await t.mutation(internal.ingest.insertProjections, { rows: [projection()] });

    // Sleeper stamps `last_modified` with the request time, so every poll looks
    // newer; only a changed projection is worth a row.
    expect(
      await t.mutation(internal.ingest.insertProjections, {
        rows: [projection({ effectiveAt: T0 + 900_000 })],
      }),
    ).toEqual({ written: 0, skipped: 1 });

    const { vintages, latest } = await t.run(async (ctx) => ({
      vintages: await ctx.db.query("player_projections").collect(),
      latest: await ctx.db.query("player_projection_latest").collect(),
    }));
    expect(vintages).toHaveLength(1);
    // The vintage keeps the instant the value was first seen.
    expect(latest[0].effectiveAt).toBe(T0);

    // A moved stat bag with identical points still counts as a change.
    expect(
      await t.mutation(internal.ingest.insertProjections, {
        rows: [projection({ effectiveAt: T0 + 900_000, stats: { pts_ppr: 23.68, rush_yd: 91 } })],
      }),
    ).toEqual({ written: 1, skipped: 0 });
  });

  test("a newer vintage appends history and replaces the latest row", async () => {
    const t = harness();
    await seedPlayers(t, [player()]);
    await t.mutation(internal.ingest.insertProjections, { rows: [projection()] });
    await t.mutation(internal.ingest.insertProjections, {
      rows: [projection({ effectiveAt: T0 + 600_000, pointsPpr: 9.1, pointsHalf: 8, pointsStd: 7 })],
    });

    const { vintages, latest } = await t.run(async (ctx) => ({
      vintages: await ctx.db.query("player_projections").collect(),
      latest: await ctx.db.query("player_projection_latest").collect(),
    }));
    // History is append-only (PRD 6.5: a snapshot can pin an exact vintage).
    expect(vintages).toHaveLength(2);
    expect(vintages.map((r) => r.projectedPointsPpr).sort((a, b) => a - b)).toEqual([9.1, 23.68]);
    expect(latest).toHaveLength(1);
    expect(latest[0].projectedPointsPpr).toBe(9.1);
    expect(latest[0].effectiveAt).toBe(T0 + 600_000);
  });

  test("joins team defenses on the abbreviation and FantasyPros rows by name", async () => {
    const t = harness();
    await seedPlayers(t, [
      player({
        sleeperId: "JAX",
        espnId: null,
        gsisId: null,
        fullName: "Jacksonville Jaguars",
        position: "DEF",
        nflTeam: "JAX",
        crossIds: {},
      }),
      player({ sleeperId: "77", espnId: null, fullName: "Real Guy", position: "WR", nflTeam: "WAS", crossIds: {} }),
    ]);

    const result = await t.mutation(internal.ingest.insertProjections, {
      rows: [
        projection({ sleeperId: "JAX", position: "DEF", source: "sleeper_rotowire" }),
        projection({
          sleeperId: `fp:${nameKey("Real Guy", "WAS", "WR")}`,
          position: "WR",
          source: "fantasypros",
        }),
        projection({ sleeperId: "fp:nobodyhere||WR", position: "WR", source: "fantasypros" }),
      ],
    });
    expect(result).toEqual({ written: 2, skipped: 1 });
  });

  test("keeps history per source, so a fallback provider never clobbers the default", async () => {
    const t = harness();
    await seedPlayers(t, [player()]);
    await t.mutation(internal.ingest.insertProjections, {
      rows: [projection(), projection({ source: "fantasypros", pointsPpr: 11 })],
    });
    const latest = await t.run(async (ctx) => ctx.db.query("player_projection_latest").collect());
    expect(latest).toHaveLength(2);
    expect(new Set(latest.map((r) => r.source))).toEqual(
      new Set(["sleeper_rotowire", "fantasypros"]),
    );
  });
});

// --------------------------------------------------------------------- stats

describe("ingest.upsertStats", () => {
  test("scores all three presets and upserts by (player, season, week, source)", async () => {
    const t = harness();
    await seedPlayers(t, [player()]);

    const row = {
      sleeperId: "9221",
      season: SEASON,
      week: WEEK,
      position: "RB",
      team: "DET",
      opponent: "NO",
      gameId: "g1",
      stats: { rush_yd: 100, rush_td: 1, rec: 5, rec_yd: 50 },
      effectiveAt: T0,
      source: "sleeper",
    };
    expect(await t.mutation(internal.ingest.upsertStats, { rows: [row] })).toEqual({
      written: 1,
      skipped: 0,
    });

    const stored = await t.run(async (ctx) => ctx.db.query("player_stats_weekly").collect());
    expect(stored).toHaveLength(1);
    // PPR > half > standard by exactly the reception points.
    expect(stored[0].fantasyPointsPpr).toBeGreaterThan(stored[0].fantasyPointsHalf);
    expect(stored[0].fantasyPointsHalf).toBeGreaterThan(stored[0].fantasyPointsStd);
    expect(stored[0].fantasyPointsPpr - stored[0].fantasyPointsStd).toBeCloseTo(5);

    // The same line arriving again updates rather than duplicating.
    await t.mutation(internal.ingest.upsertStats, {
      rows: [{ ...row, stats: { ...row.stats, rush_td: 2 } }],
    });
    const after = await t.run(async (ctx) => ctx.db.query("player_stats_weekly").collect());
    expect(after).toHaveLength(1);
    expect(after[0].fantasyPointsPpr).toBeGreaterThan(stored[0].fantasyPointsPpr);
  });

  test("counts an unresolvable player as skipped instead of throwing", async () => {
    const t = harness();
    expect(
      await t.mutation(internal.ingest.upsertStats, {
        rows: [
          {
            sleeperId: "nobody",
            season: SEASON,
            week: WEEK,
            position: null,
            team: null,
            opponent: null,
            gameId: null,
            stats: {},
            effectiveAt: T0,
            source: "sleeper",
          },
        ],
      }),
    ).toEqual({ written: 0, skipped: 1 });
  });
});

// --------------------------------------------------------------------- games

describe("ingest.upsertGames", () => {
  test("keeps the ESPN id and the scores a later, thinner feed omits", async () => {
    const t = harness();
    const base = {
      season: SEASON,
      week: WEEK,
      gameId: "2026_01_DET_KC",
      espnId: "401772510",
      homeTeam: "KC",
      awayTeam: "DET",
      kickoffAt: T0,
      status: "final",
      homeScore: 21,
      awayScore: 24,
      source: "espn",
    };
    await t.mutation(internal.ingest.upsertGames, { rows: [base] });
    // nflverse re-publishes the row with no espn id and no scores.
    await t.mutation(internal.ingest.upsertGames, {
      rows: [{ ...base, espnId: null, homeScore: null, awayScore: null, source: "nflverse" }],
    });

    const games = await t.run(async (ctx) => ctx.db.query("nfl_games").collect());
    expect(games).toHaveLength(1);
    expect(games[0].espnId).toBe("401772510");
    expect(games[0].homeScore).toBe(21);
    expect(games[0].awayScore).toBe(24);
  });
});

// -------------------------------------------------------- injuries and news

describe("ingest.insertInjuriesAndNews", () => {
  const injury = (overrides: Record<string, unknown> = {}) => ({
    espnAthleteId: "4429795",
    playerName: "Jahmyr Gibbs",
    nflTeam: "DET",
    designation: "Questionable",
    practiceStatus: "Limited",
    comment: "hamstring",
    effectiveAt: T0,
    source: "espn",
    ...overrides,
  });
  const news = (overrides: Record<string, unknown> = {}) => ({
    externalId: "45000001",
    espnAthleteId: "4429795",
    headline: "Gibbs limited in practice",
    body: "The Lions back was limited Wednesday.",
    url: "https://www.espn.com/nfl/story/_/id/45000001/gibbs",
    publishedAt: T0,
    source: "espn",
    ...overrides,
  });

  test("logs a designation only when it actually changed for the week", async () => {
    const t = harness();
    await seedPlayers(t, [player()]);

    const first = await t.mutation(internal.ingest.insertInjuriesAndNews, {
      injuries: [injury()],
      news: [],
      season: SEASON,
      week: WEEK,
      now: T0,
    });
    expect(first.injuries).toEqual({ written: 1, skipped: 0 });

    // Same designation five minutes later: nothing to log.
    const second = await t.mutation(internal.ingest.insertInjuriesAndNews, {
      injuries: [injury({ effectiveAt: T0 + 300_000 })],
      news: [],
      season: SEASON,
      week: WEEK,
      now: T0 + 300_000,
    });
    expect(second.injuries).toEqual({ written: 0, skipped: 1 });

    // He is ruled out: a new row in the log.
    const third = await t.mutation(internal.ingest.insertInjuriesAndNews, {
      injuries: [injury({ designation: "Out", effectiveAt: T0 + 600_000 })],
      news: [],
      season: SEASON,
      week: WEEK,
      now: T0 + 600_000,
    });
    expect(third.injuries).toEqual({ written: 1, skipped: 0 });

    const log = await t.run(async (ctx) => ctx.db.query("injury_designations").collect());
    expect(log.map((r) => r.designation)).toEqual(["Questionable", "Out"]);
  });

  test("resolves an injury by name when the ESPN athlete id does not join", async () => {
    const t = harness();
    await seedPlayers(t, [player({ espnId: null, crossIds: {} })]);
    const result = await t.mutation(internal.ingest.insertInjuriesAndNews, {
      injuries: [injury({ espnAthleteId: "does-not-exist" })],
      news: [],
      season: SEASON,
      week: WEEK,
      now: T0,
    });
    expect(result.injuries).toEqual({ written: 1, skipped: 0 });
  });

  test("dedupes news on the url and attaches the player it names", async () => {
    const t = harness();
    await seedPlayers(t, [player()]);

    const first = await t.mutation(internal.ingest.insertInjuriesAndNews, {
      injuries: [],
      news: [news(), news({ externalId: "2", url: null, headline: "No url here" })],
      season: SEASON,
      week: WEEK,
      now: T0,
    });
    expect(first.news).toEqual({ written: 2, skipped: 0 });

    // The same two articles are still at the top of the feed fifteen minutes on.
    const second = await t.mutation(internal.ingest.insertInjuriesAndNews, {
      injuries: [],
      news: [news(), news({ externalId: "2", url: null, headline: "No url here" })],
      season: SEASON,
      week: WEEK,
      now: T0 + 900_000,
    });
    expect(second.news).toEqual({ written: 0, skipped: 2 });

    const items = await t.run(async (ctx) => ctx.db.query("news_items").collect());
    expect(items).toHaveLength(2);
    const withUrl = items.find((i) => i.url !== undefined)!;
    expect(withUrl.dedupeKey).toBe("https://www.espn.com/nfl/story/_/id/45000001/gibbs");
    expect(withUrl.playerId).toBeDefined();
    // A url-less article still gets a stable key.
    expect(items.find((i) => i.url === undefined)!.dedupeKey).toBe("espn:2");
  });
});

// ---------------------------------------------------------------- ownership

describe("ingest.upsertOwnership", () => {
  test("keeps one row per (season, week, player)", async () => {
    const t = harness();
    await seedPlayers(t, [player()]);
    await t.mutation(internal.ingest.upsertOwnership, {
      rows: [{ sleeperId: "9221", ownedPct: 99.7, startedPct: 98.8 }],
      season: SEASON,
      week: WEEK,
      now: T0,
    });
    await t.mutation(internal.ingest.upsertOwnership, {
      rows: [
        { sleeperId: "9221", ownedPct: 99.9, startedPct: 99.1 },
        { sleeperId: "nobody", ownedPct: 1, startedPct: 0 },
      ],
      season: SEASON,
      week: WEEK,
      now: T0 + 60_000,
    });

    const rows = await t.run(async (ctx) => ctx.db.query("player_ownership").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].ownedPct).toBe(99.9);
  });
});

// -------------------------------------------------------------- ingest_state

describe("ingest_state", () => {
  test("never moves the effective-at high-water mark backwards", async () => {
    const t = harness();
    const key = `projections:${SEASON}:${WEEK}:sleeper_rotowire`;
    await t.mutation(internal.ingest.recordState, {
      key,
      lastRunAt: T0,
      lastEffectiveAt: T0,
      lastCount: 300,
    });
    // A late, stale response must not reopen the gate.
    await t.mutation(internal.ingest.recordState, {
      key,
      lastRunAt: T0 + 900_000,
      lastEffectiveAt: T0 - 600_000,
      lastCount: 300,
    });

    const state = await t.query(internal.ingest.readState, { key });
    expect(state?.lastEffectiveAt).toBe(T0);
    expect(state?.lastRunAt).toBe(T0 + 900_000);
    expect(await t.query(internal.ingest.readState, { key: "never-run" })).toBeNull();
  });
});

// --------------------------------------------------------------------- cron

describe("ingest.tick", () => {
  test("the game-day cron does nothing off a game day", async () => {
    const t = harness();
    const wednesday = fromETParts({ year: 2026, month: 9, day: 16, hour: 12 });
    expect(
      await t.mutation(internal.ingest.tick, { mode: "gameday", now: wednesday }),
    ).toEqual({ scheduled: false });

    const sunday = fromETParts({ year: 2026, month: 9, day: 13, hour: 13 });
    await t.run(async (ctx) => {
      await ctx.db.insert("nfl_games", {
        season: 2026, week: 1, gameId: "ingest-sunday", homeTeam: "BUF", awayTeam: "MIA",
        kickoffAt: sunday, status: "in_progress",
      });
    });
    expect(await t.mutation(internal.ingest.tick, { mode: "gameday", now: sunday })).toEqual({
      scheduled: true,
    });
  });

  test("INGEST_DISABLED mutes every scheduled pull without a deploy", async () => {
    const t = harness();
    vi.stubEnv("INGEST_DISABLED", "1");
    const sunday = fromETParts({ year: 2026, month: 9, day: 13, hour: 13 });
    expect(await t.mutation(internal.ingest.tick, { mode: "gameday", now: sunday })).toEqual({
      scheduled: false,
    });
    expect(await t.mutation(internal.ingest.tick, { mode: "regular", now: sunday })).toEqual({
      scheduled: false,
    });
    vi.unstubAllEnvs();
  });

  test("the routine cron is unguarded — projections and news move all week", async () => {
    const t = harness();
    const wednesday = fromETParts({ year: 2026, month: 9, day: 16, hour: 12 });
    expect(await t.mutation(internal.ingest.tick, { mode: "regular", now: wednesday })).toEqual({
      scheduled: true,
    });
  });
});
