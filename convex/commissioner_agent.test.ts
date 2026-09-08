/**
 * `convex/commissioner_agent.ts` — the platform agent's tasks.
 *
 * Runs against `mock/scripted`, so no gateway key is needed and the text is
 * deterministic; what is exercised is the whole shape of a commissioner task:
 * brief → run row → step → ledger + rollups → published announcements.
 */
import { convexTest, type TestConvex } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { splitSections } from "./commissioner_agent";

const modules = import.meta.glob("./**/*.ts");

type SchemaTest = TestConvex<typeof schema>;

const SEASON = 2025;

const RULES = {
  scoringPreset: "ppr" as const,
  superflex: false,
  tePremium: false,
  rosterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DEF: 1, BN: 6 },
  faabBudget: 100,
  playoffTeams: 4,
  playoffStartWeek: 15,
  regularSeasonWeeks: 14,
  seasonWeeks: 17,
  transparencyMode: "live" as const,
  injectionPolicy: "permitted" as const,
  modelAllowlist: [],
  contextCharLimit: 8000,
  maxStepsCap: 12,
  editLock: { unlockDay: "tue", unlockTime: "06:00", lockDay: "sun", lockTime: "12:00" },
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
  reuseSnapshotWithinMs: 60_000,
  draftBudget: 200,
};

async function seed(t: SchemaTest) {
  return t.run(async (ctx) => {
    const commish = await ctx.db.insert("users", { email: `c-${Math.random()}@x.dev` });
    const leagueId = await ctx.db.insert("leagues", {
      name: "Bench League", slug: `t-${Math.random()}`, commissionerUserId: commish,
      season: SEASON, teamCount: 2, isPublic: true, status: "in_season",
      draftType: "snake", updatedAt: Date.now(),
    });
    await ctx.db.insert("league_rules", { leagueId, ...RULES });
    await ctx.db.insert("league_members", { leagueId, userId: commish, role: "commissioner" });

    const team = (name: string) =>
      ctx.db.insert("teams", {
        leagueId, name, abbreviation: name.slice(0, 3).toUpperCase(),
        faabRemaining: 100, waiverPriority: 1, karma: 0, draftBudgetRemaining: 200,
      });
    const teamA = await team("Alpha");
    const teamB = await team("Bravo");

    await ctx.db.insert("matchups", {
      leagueId, weekNo: 1, homeTeamId: teamA, awayTeamId: teamB,
      homeScore: 120.5, awayScore: 98.25, isFinal: true,
    });
    const standing = (teamId: Id<"teams">, wins: number, pointsFor: number) =>
      ctx.db.insert("team_standings", {
        leagueId, teamId, season: SEASON, wins, losses: 1 - wins, ties: 0,
        pointsFor, pointsAgainst: 0, streak: wins ? "W1" : "L1", updatedAt: Date.now(),
      });
    await standing(teamA, 1, 120.5);
    await standing(teamB, 0, 98.25);

    await ctx.db.insert("model_prices", {
      modelId: "mock/scripted", provider: "mock", displayName: "Scripted",
      inputPerM: 3, outputPerM: 15, supportsReasoning: false,
      effectiveFrom: Date.now() - 86_400_000,
    });

    return { commish, leagueId, teamA, teamB };
  });
}

beforeEach(() => {
  vi.stubEnv("COMMISSIONER_MODEL_ID", "mock/scripted");
  return () => vi.unstubAllEnvs();
});

describe("splitSections", () => {
  test("splits on `##` headings and falls back to one section", () => {
    expect(splitSections("## A\n\nbody a\n\n## B —\n\nbody b", "Fallback")).toEqual([
      { title: "A", body: "body a" },
      { title: "B", body: "body b" },
    ]);
    expect(splitSections("no headings here", "Fallback")).toEqual([
      { title: "Fallback", body: "no headings here" },
    ]);
  });
});

describe("commissioner_agent.weeklyRecap", () => {
  test("publishes one announcement per section and leaves a priced trace", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);

    const result = await t.action(internal.commissioner_agent.weeklyRecap, {
      leagueId: s.leagueId,
      weekNo: 1,
    });
    expect(result.task).toBe("weekly_recap");
    expect(result.scripted).toBe(true);
    expect(result.postIds).toHaveLength(3);
    expect(result.text).toContain("Alpha 120.5 — 98.25 Bravo");

    const state = await t.run(async (ctx) => ({
      posts: await ctx.db
        .query("forum_posts")
        .withIndex("by_leagueId_createdAt", (q) => q.eq("leagueId", s.leagueId))
        .collect(),
      run: await ctx.db.get("runs", result.runId),
      steps: await ctx.db
        .query("run_steps")
        .withIndex("by_runId_stepIndex", (q) => q.eq("runId", result.runId))
        .collect(),
      usage: await ctx.db
        .query("usage_events")
        .withIndex("by_runId_stepIndex", (q) => q.eq("runId", result.runId))
        .collect(),
      actions: await ctx.db
        .query("run_actions")
        .withIndex("by_runId_toolCallId", (q) => q.eq("runId", result.runId))
        .collect(),
      searchDocs: await ctx.db
        .query("run_search_docs")
        .withIndex("by_runId", (q) => q.eq("runId", result.runId))
        .collect(),
    }));

    expect(state.posts).toHaveLength(3);
    expect(state.posts.every((p) => p.teamId === undefined)).toBe(true);
    expect(state.posts.every((p) => p.flair === "announcement")).toBe(true);
    expect(state.posts.every((p) => p.runId === result.runId)).toBe(true);
    expect(state.posts.map((p) => p.title).sort()).toEqual([
      "Awards",
      "Power Rankings",
      "Week 1 Recap",
    ]);

    expect(state.run?.kind).toBe("commissioner");
    expect(state.run?.teamId).toBeUndefined();
    expect(state.run?.status).toBe("succeeded");
    expect(state.run?.modelId).toBe("mock/scripted");
    expect(state.run?.stepCount).toBe(1);
    expect(state.run?.outcome).toBe("weekly_recap:3_posts");
    expect(state.run?.committedActionCount).toBe(3);

    expect(state.steps).toHaveLength(1);
    expect(state.steps[0].finishReason).toBe("scripted");
    expect(state.steps[0].text).toContain("Power Rankings");
    expect(state.usage).toHaveLength(1);
    expect(state.usage[0].modelId).toBe("mock/scripted");
    expect(state.usage[0].season).toBe(SEASON);
    expect(state.usage[0].weekNo).toBe(1);
    expect(state.actions).toHaveLength(3);
    expect(state.actions.every((a) => a.actionType === "post_to_forum")).toBe(true);
    expect(state.searchDocs).toHaveLength(1);
  });

  test("hangs the run off a reused commissioner window and fills the rollups", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);

    const first = await t.action(internal.commissioner_agent.weeklyRecap, {
      leagueId: s.leagueId, weekNo: 1,
    });
    const second = await t.action(internal.commissioner_agent.weeklyRecap, {
      leagueId: s.leagueId, weekNo: 1,
    });
    expect(second.runId).not.toBe(first.runId);

    const state = await t.run(async (ctx) => ({
      windows: await ctx.db
        .query("windows")
        .withIndex("by_leagueId_status", (q) => q.eq("leagueId", s.leagueId))
        .collect(),
      modelRollups: await ctx.db.query("model_week_rollups").collect(),
      leagueRollups: await ctx.db
        .query("league_week_rollups")
        .withIndex("by_leagueId_season_weekNo", (q) =>
          q.eq("leagueId", s.leagueId).eq("season", SEASON).eq("weekNo", 1),
        )
        .collect(),
    }));

    // One window per (league, label, week), reused across runs.
    expect(state.windows).toHaveLength(1);
    expect(state.windows[0].type).toBe("commissioner");
    expect(state.windows[0].label).toBe("commissioner_weekly_1");
    expect(state.windows[0].status).toBe("closed");
    expect(state.windows[0].runCount).toBe(2);
    expect(state.windows[0].terminalRunCount).toBe(2);

    // A per-league row and a cross-league benchmark row.
    expect(state.modelRollups).toHaveLength(2);
    expect(state.modelRollups.filter((r) => r.leagueId === undefined)).toHaveLength(1);
    expect(state.modelRollups.every((r) => r.runCount === 2 && r.stepCount === 2)).toBe(true);
    expect(state.leagueRollups).toHaveLength(1);
    expect(state.leagueRollups[0].stepCount).toBe(2);
  });
});

describe("commissioner_agent.tradeNarrative", () => {
  test("writes the paragraph into fairnessDetail without touching the score", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const tradeId = await t.run(async (ctx) =>
      ctx.db.insert("trades", {
        leagueId: s.leagueId, proposerTeamId: s.teamA, recipientTeamId: s.teamB,
        weekNo: 1, status: "in_review" as const,
        items: [{ fromTeamId: s.teamA, toTeamId: s.teamB }],
        fairnessScore: 0.42,
        fairnessDetail: { version: 1, method: "ros_projection_v1", score: 0.42 },
        flagged: true, vetoCount: 0, approveCount: 0,
      }),
    );

    const result = await t.action(internal.commissioner_agent.tradeNarrative, { tradeId });
    expect(result).not.toBeNull();
    expect(result!.postIds).toHaveLength(0);

    const trade = await t.run(async (ctx) => ctx.db.get("trades", tradeId));
    const detail = trade?.fairnessDetail as { score: number; narrative: string };
    expect(trade?.fairnessScore).toBe(0.42);
    expect(detail.score).toBe(0.42);
    expect(detail.narrative).toContain("0.42");
    expect(detail.narrative).toMatch(/flagged/);

    const run = await t.run(async (ctx) => ctx.db.get("runs", result!.runId));
    expect(run?.kind).toBe("commissioner");
    expect(run?.windowLabel).toMatch(/^commissioner_trade_/);
  });

  test("is a no-op for a trade that no longer exists", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const tradeId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("trades", {
        leagueId: s.leagueId, proposerTeamId: s.teamA, recipientTeamId: s.teamB,
        weekNo: 1, status: "proposed" as const, items: [], flagged: false,
        vetoCount: 0, approveCount: 0,
      });
      await ctx.db.delete("trades", id);
      return id;
    });
    expect(
      await t.action(internal.commissioner_agent.tradeNarrative, { tradeId }),
    ).toBeNull();
  });
});

describe("commissioner_agent.runWeekly", () => {
  test("publishes the recap and skips a digest with nothing to say", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);

    const results = await t.action(internal.commissioner_agent.runWeekly, {
      leagueId: s.leagueId, weekNo: 1,
    });
    // The digest publishes a "nothing is flagged" section, so both tasks run.
    expect(results.map((r) => r.task)).toEqual(["weekly_recap", "flagged_trades_digest"]);

    const posts = await t.run(async (ctx) =>
      ctx.db
        .query("forum_posts")
        .withIndex("by_leagueId_createdAt", (q) => q.eq("leagueId", s.leagueId))
        .collect(),
    );
    expect(posts).toHaveLength(4);
    expect(posts.some((p) => p.title === "Flagged Trades")).toBe(true);
  });
});

describe("commissioner_agent.draftRecap / seasonAwards", () => {
  test("both publish announcements from the scripted text", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);

    const draft = await t.action(internal.commissioner_agent.draftRecap, {
      leagueId: s.leagueId,
    });
    expect(draft.postIds).toHaveLength(2);

    const awards = await t.action(internal.commissioner_agent.seasonAwards, {
      leagueId: s.leagueId,
    });
    expect(awards.postIds).toHaveLength(1);

    const titles = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("forum_posts")
          .withIndex("by_leagueId_createdAt", (q) => q.eq("leagueId", s.leagueId))
          .collect()
      ).map((p) => p.title),
    );
    expect(titles.sort()).toEqual([
      "Best and Worst Picks",
      "Draft Recap",
      "Season Awards",
    ]);
  });
});
