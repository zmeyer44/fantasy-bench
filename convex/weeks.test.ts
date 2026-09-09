/**
 * `weeks.list` — the week rows the pickers (matchups) and filters (traces) use
 * instead of deriving `1..rules.seasonWeeks`.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { nextUnlockInstant } from "./weeks";

const modules = import.meta.glob("./**/*.ts");

/**
 * A bare `ReturnType<typeof convexTest>` erases the schema, which makes
 * `withIndex` in the helpers below fall back to the system-table indexes.
 * Inferring the type from a concrete call keeps them checked against the real
 * data model.
 */
function harness() {
  return convexTest(schema, modules);
}
type TestHarness = ReturnType<typeof harness>;

const NOW = Date.UTC(2026, 8, 10, 17, 0, 0);
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

async function seed(t: TestHarness, isPublic: boolean) {
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
    const t = harness();
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
    const t = harness();
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
    const t = harness();
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

// =====================================================================
// Phase 5b — the week-rollover chain
// =====================================================================

const ROLLOVER_RULES = {
  scoringPreset: "ppr" as const,
  superflex: false,
  tePremium: false,
  rosterSlots: { QB: 1, RB: 1, WR: 1, BENCH: 1 },
  faabBudget: 100,
  playoffTeams: 4,
  playoffStartWeek: 15,
  regularSeasonWeeks: 14,
  seasonWeeks: 17,
  transparencyMode: "live" as const,
  injectionPolicy: "permitted" as const,
  modelAllowlist: ["anthropic/claude-haiku-4.5"],
  contextCharLimit: 8000,
  maxStepsCap: 12,
  editLock: { unlockDay: "tue", unlockTime: "06:00", lockDay: "wed", lockTime: "03:00" },
  tradeReviewHours: 24,
  antiChurnWeeks: 3,
  maxOpenProposals: 3,
  maxMessagesPerRun: 6,
  maxThreadsPerWindow: 4,
  forumPostsPerDay: 2,
  forumCommentsPerDay: 6,
  safetyAutopilot: true,
  runWallclockSeconds: 300,
  draftPickSeconds: 90,
  reuseSnapshotWithinMs: 600_000,
  draftBudget: 200,
};

/**
 * A league whose week grid starts three days from now, so every window the
 * rollover materialises is genuinely in the future and its job fires at the
 * window's own instant rather than immediately.
 */
async function seedSeason(t: TestHarness, weekCount = 4) {
  const start = Date.now() + 3 * 86_400_000;
  const seeded = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: `r-${Math.random()}@x.dev` });
    const leagueId = await ctx.db.insert("leagues", {
      name: "Rollover",
      slug: `r-${Math.random()}`,
      commissionerUserId: userId,
      season: 2026,
      teamCount: 2,
      isPublic: true,
      status: "in_season",
      draftType: "snake",
      updatedAt: Date.now(),
    });
    await ctx.db.insert("league_rules", { leagueId, ...ROLLOVER_RULES });
    for (let weekNo = 1; weekNo <= weekCount; weekNo++) {
      await ctx.db.insert("weeks", {
        leagueId,
        weekNo,
        startsAt: start + (weekNo - 1) * WEEK_MS,
        endsAt: start + weekNo * WEEK_MS,
        isPlayoff: false,
        status: "upcoming",
      });
    }
    return { leagueId, userId };
  });
  return { ...seeded, start };
}

async function weekRow(t: TestHarness, leagueId: Id<"leagues">, weekNo: number) {
  return t.run(async (ctx) =>
    ctx.db
      .query("weeks")
      .withIndex("by_leagueId_weekNo", (q) => q.eq("leagueId", leagueId).eq("weekNo", weekNo))
      .first(),
  );
}

async function scheduledJobs(t: TestHarness) {
  return t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect());
}

describe("weeks.rollover", () => {
  test("materialises this week and next, and chains the next rollover", async () => {
    const t = harness();
    const s = await seedSeason(t);

    const result = await t.mutation(internal.weeks.rollover, {
      leagueId: s.leagueId,
      weekNo: 1,
      now: s.start,
    });
    // Two weeks of the PRD 5.3 template table.
    expect(result.materialized).toBe(30);
    expect(result.nextRolloverAt).toBe(s.start + WEEK_MS);

    const windows = await t.run(async (ctx) =>
      ctx.db
        .query("windows")
        .withIndex("by_leagueId_opensAt", (q) => q.eq("leagueId", s.leagueId))
        .collect(),
    );
    expect(new Set(windows.map((w) => w.weekNo))).toEqual(new Set([1, 2]));
    expect(windows.every((w) => w.openJobId && w.closeJobId)).toBe(true);

    // The chain is armed on the week it rolls into, at that week's start.
    const week2 = await weekRow(t, s.leagueId, 2);
    expect(week2!.rolloverJobId).toBeDefined();
    const job = (await scheduledJobs(t)).find((j) => j._id === week2!.rolloverJobId)!;
    expect(job.name).toBe("weeks:rollover");
    expect(job.scheduledTime).toBe(s.start + WEEK_MS);
  });

  test("marks the week it rolls into active and every finished week complete", async () => {
    const t = harness();
    const s = await seedSeason(t);
    await t.mutation(internal.weeks.rollover, { leagueId: s.leagueId, weekNo: 1, now: s.start });
    expect((await weekRow(t, s.leagueId, 1))!.status).toBe("active");
    expect((await weekRow(t, s.leagueId, 2))!.status).toBe("upcoming");

    // Two weeks on: week 1 is over.
    await t.mutation(internal.weeks.rollover, {
      leagueId: s.leagueId,
      weekNo: 2,
      now: s.start + WEEK_MS,
    });
    expect((await weekRow(t, s.leagueId, 1))!.status).toBe("complete");
    expect((await weekRow(t, s.leagueId, 2))!.status).toBe("active");
  });

  test("schedules the config unlock at the edit-lock boundary", async () => {
    const t = harness();
    const s = await seedSeason(t);
    const result = await t.mutation(internal.weeks.rollover, {
      leagueId: s.leagueId,
      weekNo: 1,
      now: s.start,
    });

    const week1 = await weekRow(t, s.leagueId, 1);
    expect(week1!.unlockJobId).toBeDefined();
    const job = (await scheduledJobs(t)).find((j) => j._id === week1!.unlockJobId)!;
    expect(job.name).toBe("configs:applyPending");
    // The default lock unlocks Tuesday 06:00 ET; the instant is derived from the
    // week's own start rather than polled for by a cron.
    expect(result.unlockAt).toBe(nextUnlockInstant(week1!.startsAt, ROLLOVER_RULES.editLock));
    expect(job.scheduledTime).toBeGreaterThanOrEqual(result.unlockAt!);
  });

  test("is idempotent — re-running it does not duplicate windows or jobs", async () => {
    const t = harness();
    const s = await seedSeason(t);
    await t.mutation(internal.weeks.rollover, { leagueId: s.leagueId, weekNo: 1, now: s.start });
    const before = await weekRow(t, s.leagueId, 2);

    const again = await t.mutation(internal.weeks.rollover, {
      leagueId: s.leagueId,
      weekNo: 1,
      now: s.start,
    });
    expect(again.materialized).toBe(0);

    const windows = await t.run(async (ctx) =>
      ctx.db
        .query("windows")
        .withIndex("by_leagueId_opensAt", (q) => q.eq("leagueId", s.leagueId))
        .collect(),
    );
    expect(windows).toHaveLength(30);

    // The old chain job was cancelled, not left racing the new one.
    const after = await weekRow(t, s.leagueId, 2);
    expect(after!.rolloverJobId).not.toBe(before!.rolloverJobId);
    const jobs = await scheduledJobs(t);
    expect(jobs.find((j) => j._id === before!.rolloverJobId)!.state.kind).toBe("canceled");
    expect(jobs.filter((j) => j.name === "weeks:rollover" && j.state.kind === "pending")).toHaveLength(1);
  });

  test("stops chaining at the last week of the grid", async () => {
    const t = harness();
    const s = await seedSeason(t, 2);
    const result = await t.mutation(internal.weeks.rollover, {
      leagueId: s.leagueId,
      weekNo: 2,
      now: s.start + WEEK_MS,
    });
    expect(result.nextRolloverAt).toBeNull();
    expect((await scheduledJobs(t)).filter((j) => j.name === "weeks:rollover")).toHaveLength(0);
  });
});

describe("weeks.scheduleSeason", () => {
  test("arms the chain at the first week's start for a season that has not begun", async () => {
    const t = harness();
    const s = await seedSeason(t);
    const result = await t.mutation(internal.weeks.scheduleSeason, { leagueId: s.leagueId });
    expect(result).toEqual({ weekNo: 1, startsAt: s.start });

    const week1 = await weekRow(t, s.leagueId, 1);
    const job = (await scheduledJobs(t)).find((j) => j._id === week1!.rolloverJobId)!;
    expect(job.name).toBe("weeks:rollover");
    expect(job.scheduledTime).toBe(s.start);
  });

  test("arms it for the current week when the season is already underway", async () => {
    const t = harness();
    const s = await seedSeason(t);
    const now = s.start + 2 * WEEK_MS + 3_600_000;
    const result = await t.mutation(internal.weeks.scheduleSeason, {
      leagueId: s.leagueId,
      now,
    });
    expect(result.weekNo).toBe(3);
    // Already past: it runs now rather than at an instant in the past.
    const week3 = await weekRow(t, s.leagueId, 3);
    const job = (await scheduledJobs(t)).find((j) => j._id === week3!.rolloverJobId)!;
    expect(job.scheduledTime).toBeGreaterThanOrEqual(s.start + 2 * WEEK_MS);
  });

  test("is idempotent: the previous chain is cancelled before a new one is armed", async () => {
    const t = harness();
    const s = await seedSeason(t);
    await t.mutation(internal.weeks.scheduleSeason, { leagueId: s.leagueId });
    const first = (await weekRow(t, s.leagueId, 1))!.rolloverJobId;
    await t.mutation(internal.weeks.scheduleSeason, { leagueId: s.leagueId });

    const jobs = await scheduledJobs(t);
    expect(jobs.find((j) => j._id === first)!.state.kind).toBe("canceled");
    expect(jobs.filter((j) => j.name === "weeks:rollover" && j.state.kind === "pending")).toHaveLength(1);
  });

  test("does nothing for a league with no week grid", async () => {
    const t = harness();
    const { leagueId } = await seed(t, true);
    await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("weeks")
        .withIndex("by_leagueId_weekNo", (q) => q.eq("leagueId", leagueId))
        .take(22);
      for (const row of rows) await ctx.db.delete("weeks", row._id);
    });
    expect(await t.mutation(internal.weeks.scheduleSeason, { leagueId })).toEqual({
      weekNo: null,
      startsAt: null,
    });
  });
});
