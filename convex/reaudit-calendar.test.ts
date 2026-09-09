import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { internal } from "./_generated/api";
import { GAME_WINDOW_TAIL_MS, isKickoffActive } from "./lib/game_calendar";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const openingNight = Date.parse("2026-09-10T00:20:00.000Z");

async function addGame(t: ReturnType<typeof convexTest>, kickoffAt: number) {
  await t.run(async (ctx) => {
    await ctx.db.insert("nfl_games", {
      season: 2026, week: 1, gameId: `calendar-${kickoffAt}`,
      homeTeam: "NE", awayTeam: "NYJ", kickoffAt, status: "scheduled",
    });
  });
}

describe("schedule-aware live work", () => {
  test("allows ingestion and scoring for the Wednesday 2026 opener", async () => {
    const t = convexTest(schema, modules);
    await addGame(t, openingNight);
    expect(await t.mutation(internal.ingest.tick, { mode: "gameday", now: openingNight }))
      .toEqual({ scheduled: true });
    expect(await t.mutation(internal.season.tickAll, { now: openingNight }))
      .toEqual({ leagues: 0, skipped: false });
  });

  test.each([
    ["Friday", "2026-12-25T18:00:00.000Z"],
    ["Saturday", "2026-12-19T21:30:00.000Z"],
  ])("allows a recorded %s game", async (_label, iso) => {
    const t = convexTest(schema, modules);
    const kickoffAt = Date.parse(iso);
    await addGame(t, kickoffAt);
    expect(await t.mutation(internal.ingest.tick, { mode: "gameday", now: kickoffAt }))
      .toEqual({ scheduled: true });
  });

  test("keeps the overnight finalization window bounded", () => {
    expect(isKickoffActive(openingNight, openingNight + GAME_WINDOW_TAIL_MS)).toBe(true);
    expect(isKickoffActive(openingNight, openingNight + GAME_WINDOW_TAIL_MS + 1)).toBe(false);
  });
});
