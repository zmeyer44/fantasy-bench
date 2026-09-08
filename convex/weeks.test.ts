/**
 * `weeks.list` — the week rows the pickers (matchups) and filters (traces) use
 * instead of deriving `1..rules.seasonWeeks`.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const NOW = Date.UTC(2026, 8, 10, 17, 0, 0);
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

async function seed(t: ReturnType<typeof convexTest>, isPublic: boolean) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: "commish@fantasybench.dev" });
    const leagueId = await ctx.db.insert("leagues", {
      name: "Weeks",
      slug: `w-${Math.random()}`,
      commissionerUserId: userId,
      season: 2026,
      teamCount: 2,
      isPublic,
      status: "in_season",
      draftType: "snake",
      updatedAt: NOW,
    });
    // Inserted out of order on purpose: the index, not the insert order, sorts them.
    for (const weekNo of [3, 1, 2, 15]) {
      await ctx.db.insert("weeks", {
        leagueId,
        weekNo,
        startsAt: NOW + weekNo * WEEK_MS,
        endsAt: NOW + (weekNo + 1) * WEEK_MS,
        isPlayoff: weekNo >= 15,
        status: weekNo === 1 ? "active" : "upcoming",
      });
    }
    return { leagueId, userId };
  });
}

describe("weeks.list", () => {
  test("returns one row per week, ascending, with playoff and status flags", async () => {
    const t = convexTest(schema, modules);
    const { leagueId } = await seed(t, true);

    const weeks = await t.query(api.weeks.list, { leagueId });
    expect(weeks.map((week) => week.weekNo)).toEqual([1, 2, 3, 15]);
    expect(weeks[0]).toEqual({
      weekNo: 1,
      startsAt: NOW + WEEK_MS,
      endsAt: NOW + 2 * WEEK_MS,
      status: "active",
      isPlayoff: false,
    });
    expect(weeks.at(-1)).toMatchObject({ weekNo: 15, isPlayoff: true, status: "upcoming" });
  });

  test("is empty for a league with no week rows and refuses a private league", async () => {
    const t = convexTest(schema, modules);
    const { leagueId } = await seed(t, false);
    await t.run(async (ctx) => {
      // Wipe the rows: a league whose weeks are not materialised yet lists none.
      const rows = await ctx.db
        .query("weeks")
        .withIndex("by_leagueId_weekNo", (q) => q.eq("leagueId", leagueId))
        .take(22);
      for (const row of rows) await ctx.db.delete("weeks", row._id);
    });

    await expect(t.query(api.weeks.list, { leagueId })).rejects.toThrow(/private/i);

    const publicLeague = await seed(t, true);
    await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("weeks")
        .withIndex("by_leagueId_weekNo", (q) => q.eq("leagueId", publicLeague.leagueId))
        .take(22);
      for (const row of rows) await ctx.db.delete("weeks", row._id);
    });
    expect(await t.query(api.weeks.list, { leagueId: publicLeague.leagueId })).toEqual([]);
  });

  test("does not leak another league's weeks", async () => {
    const t = convexTest(schema, modules);
    const a = await seed(t, true);
    const b = await seed(t, true);
    await t.run(async (ctx) => {
      await ctx.db.insert("weeks", {
        leagueId: b.leagueId as Id<"leagues">,
        weekNo: 9,
        startsAt: NOW,
        endsAt: NOW + WEEK_MS,
        isPlayoff: false,
        status: "complete",
      });
    });
    expect((await t.query(api.weeks.list, { leagueId: a.leagueId })).map((w) => w.weekNo)).toEqual([
      1, 2, 3, 15,
    ]);
    expect((await t.query(api.weeks.list, { leagueId: b.leagueId })).map((w) => w.weekNo)).toEqual([
      1, 2, 3, 9, 15,
    ]);
  });
});
