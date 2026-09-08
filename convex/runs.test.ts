/**
 * The trace list, search, detail, steps and export.
 *
 * `runs.list` replaces an offset-paged SQL query with cursor pagination over one
 * index per filter; `runs.search` replaces the Postgres `ILIKE` with the
 * `run_search_docs` search index, so the two things worth proving are that a
 * filter still picks the right rows and that a player or tool name written by
 * `upsertSearchDoc` is findable.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const NOW = Date.now();
const SEASON = 2026;
const SONNET = "anthropic/claude-sonnet-4.5";
const HAIKU = "anthropic/claude-haiku-4.5";

const RULES = {
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
  modelAllowlist: [],
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
  reuseSnapshotWithinMs: 60_000,
  draftBudget: 200,
};

async function seed(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: "commish@x.dev" });
    const sessionId = await ctx.db.insert("authSessions", {
      userId,
      expirationTime: NOW + 86_400_000,
    });
    const leagueId = await ctx.db.insert("leagues", {
      name: "Traces",
      slug: `t-${Math.random()}`,
      commissionerUserId: userId,
      season: SEASON,
      teamCount: 2,
      isPublic: true,
      status: "in_season",
      draftType: "snake",
      updatedAt: NOW,
    });
    await ctx.db.insert("league_rules", { leagueId, ...RULES });
    await ctx.db.insert("league_members", { leagueId, userId, role: "commissioner" });

    const mkTeam = (name: string) =>
      ctx.db.insert("teams", {
        leagueId,
        name,
        abbreviation: name.slice(0, 3).toUpperCase(),
        faabRemaining: 100,
        waiverPriority: 1,
        karma: 0,
        draftBudgetRemaining: 200,
      });
    const alpha = await mkTeam("Alpha");
    const bravo = await mkTeam("Bravo");

    const config = await ctx.db.insert("agent_configs", { teamId: alpha, leagueId });
    const version = await ctx.db.insert("config_versions", {
      configId: config,
      teamId: alpha,
      leagueId,
      versionNo: 7,
      contextMd: "ctx",
      modelId: SONNET,
      harness: { maxSteps: 8, tokenBudget: 40_000, temperature: 0.2, deliberateMode: false },
      skillIds: [],
    });

    const window = async (label: string, type: "lineup" | "waiver", weekNo: number) =>
      ctx.db.insert("windows", {
        leagueId,
        type,
        label,
        weekNo,
        roundNo: 1,
        opensAt: NOW - 7_200_000,
        submissionDeadlineAt: NOW - 3_600_000,
        closesAt: NOW - 3_000_000,
        status: "closed",
        scope: {},
        runCount: 2,
        terminalRunCount: 2,
      });
    const lineupWindow = await window("lineup_sun_early", "lineup", 1);
    const waiverWindow = await window("waiver", "waiver", 2);

    const player = await ctx.db.insert("players", {
      sleeperId: "qb1",
      fullName: "Quinn Back",
      position: "QB",
      nflTeam: "KC",
      fantasyPositions: ["QB"],
      externalIds: {},
      updatedAt: NOW,
    });

    return { leagueId, userId, sessionId, alpha, bravo, lineupWindow, waiverWindow, version, player };
  });
}

type Seed = Awaited<ReturnType<typeof seed>>;

async function insertRun(
  t: ReturnType<typeof convexTest>,
  s: Seed,
  over: Partial<{
    teamId: Id<"teams">;
    windowId: Id<"windows">;
    windowType: "lineup" | "waiver";
    windowLabel: string;
    weekNo: number;
    status: "succeeded" | "failed" | "partial";
    modelId: string;
    cost: number;
  }> = {},
) {
  return t.run(async (ctx) =>
    ctx.db.insert("runs", {
      leagueId: s.leagueId,
      windowId: over.windowId ?? s.lineupWindow,
      teamId: over.teamId ?? s.alpha,
      configVersionId: s.version,
      modelId: over.modelId ?? SONNET,
      kind: "team",
      status: over.status ?? "succeeded",
      windowType: over.windowType ?? "lineup",
      windowLabel: over.windowLabel ?? "lineup_sun_early",
      weekNo: over.weekNo ?? 1,
      attempt: 1,
      lastPersistedStep: 1,
      startedAt: NOW - 60_000,
      finishedAt: NOW - 30_000,
      outcome: "Set the lineup",
      rationale: "Started the best available quarterback.",
      totalCostUsd: over.cost ?? 0.5,
      totalInputTokens: 1000,
      totalOutputTokens: 200,
      stepCount: 2,
      committedActionCount: 1,
      rejectedActionCount: 1,
    }),
  );
}

describe("runs.list", () => {
  test("pages newest-first and honours every filter", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const first = await insertRun(t, s, { modelId: SONNET });
    const second = await insertRun(t, s, {
      teamId: s.bravo,
      windowId: s.waiverWindow,
      windowType: "waiver",
      windowLabel: "waiver",
      weekNo: 2,
      status: "failed",
      modelId: HAIKU,
    });

    const page = await t.query(api.runs.list, {
      leagueId: s.leagueId,
      paginationOpts: { numItems: 1, cursor: null },
    });
    expect(page.page).toHaveLength(1);
    expect(page.page[0].id).toBe(second);
    expect(page.isDone).toBe(false);
    expect(page.page[0].windowLabelText).toBe("Waiver");
    expect(page.page[0].modelLabel).toBe("Claude Haiku 4.5");
    expect(page.page[0].actionCount).toBe(2);
    expect(page.page[0].durationMs).toBe(30_000);
    expect(page.page[0].teamName).toBe("Bravo");
    expect(page.page[0].configVersionNo).toBe(7);

    const rest = await t.query(api.runs.list, {
      leagueId: s.leagueId,
      paginationOpts: { numItems: 5, cursor: page.continueCursor },
    });
    expect(rest.page.map((run) => run.id)).toEqual([first]);
    expect(rest.isDone).toBe(true);

    const opts = { numItems: 10, cursor: null };
    const ids = async (filter: Record<string, unknown>) =>
      (
        await t.query(api.runs.list, {
          leagueId: s.leagueId,
          paginationOpts: opts,
          ...filter,
        })
      ).page.map((run) => run.id);

    expect(await ids({ teamId: s.alpha })).toEqual([first]);
    expect(await ids({ modelId: HAIKU })).toEqual([second]);
    expect(await ids({ weekNo: 2 })).toEqual([second]);
    expect(await ids({ windowType: "lineup" })).toEqual([first]);
    expect(await ids({ status: "failed" })).toEqual([second]);
    // Filters combine: the index serves the most selective one, the rest ride along.
    expect(await ids({ teamId: s.alpha, status: "failed" })).toEqual([]);
    expect(await ids({ teamId: s.bravo, windowType: "waiver", weekNo: 2 })).toEqual([second]);
  });
});

describe("runs.search", () => {
  test("finds a run by player name, tool name and rationale text", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const runId = await insertRun(t, s);
    await t.run(async (ctx) => {
      await ctx.db.insert("run_steps", {
        runId,
        leagueId: s.leagueId,
        stepIndex: 0,
        modelId: SONNET,
        text: "Checking the waiver wire.",
        responseMessages: [],
        toolCalls: [{ toolName: "set_lineup", toolCallId: "call-1" }],
        toolResults: [],
        usage: {
          inputTokens: 500,
          outputTokens: 100,
          totalTokens: 600,
          cachedInputTokens: 0,
          reasoningTokens: 0,
        },
        costUsd: 0.25,
        bytes: 100,
      });
      await ctx.db.insert("run_actions", {
        runId,
        leagueId: s.leagueId,
        teamId: s.alpha,
        toolCallId: "call-1",
        stepIndex: 0,
        actionType: "set_lineup",
        payload: { slots: [{ slot: "QB", playerId: s.player }] },
        validationResult: { ok: true },
        committedAt: NOW,
      });
    });
    await t.mutation(internal.runs.upsertSearchDoc, { runId });

    const doc = await t.run(async (ctx) =>
      ctx.db
        .query("run_search_docs")
        .withIndex("by_runId", (q) => q.eq("runId", runId))
        .unique(),
    );
    expect(doc?.text).toContain("Quinn Back");
    expect(doc?.text).toContain("set_lineup");

    const search = async (q: string, extra: Record<string, unknown> = {}) =>
      (
        await t.query(api.runs.search, {
          leagueId: s.leagueId,
          q,
          paginationOpts: { numItems: 10, cursor: null },
          ...extra,
        })
      ).page.map((run) => run.id);

    expect(await search("Quinn")).toEqual([runId]);
    expect(await search("set_lineup")).toEqual([runId]);
    expect(await search("quarterback")).toEqual([runId]);
    // Filter fields ride on the search index.
    expect(await search("Quinn", { teamId: s.bravo })).toEqual([]);
    expect(await search("Quinn", { windowType: "lineup" })).toEqual([runId]);
    expect(await search("   ")).toEqual([]);

    const withPlayers = await t.query(api.runs.search, {
      leagueId: s.leagueId,
      q: "Quinn",
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(withPlayers.matchedPlayers.map((p) => p.fullName)).toEqual(["Quinn Back"]);
  });
});

describe("runs.get / steps / stepPayload / export", () => {
  test("returns the detail, paginated steps and lazily-loaded payloads", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const runId = await insertRun(t, s);
    const payloadId = await t.run(async (ctx) => {
      const payloadId = await ctx.db.insert("run_step_payloads", {
        runId,
        stepIndex: 1,
        toolCallId: "call-2",
        toolName: "get_news",
        payload: { items: ["big news"] },
        bytes: 42,
      });
      const usage = {
        inputTokens: 500,
        outputTokens: 100,
        totalTokens: 600,
        cachedInputTokens: 0,
        reasoningTokens: 0,
      };
      await ctx.db.insert("run_steps", {
        runId,
        leagueId: s.leagueId,
        stepIndex: 0,
        modelId: SONNET,
        text: "step zero",
        responseMessages: [
          { role: "system", content: "You are an agent." },
          { role: "user", content: "Set your lineup." },
        ],
        toolCalls: [],
        toolResults: [],
        usage,
        costUsd: 0.25,
        bytes: 100,
      });
      await ctx.db.insert("run_steps", {
        runId,
        leagueId: s.leagueId,
        stepIndex: 1,
        modelId: SONNET,
        text: "step one",
        responseMessages: [],
        toolCalls: [{ toolName: "get_news", toolCallId: "call-2" }],
        toolResults: [{ toolCallId: "call-2", payloadRef: payloadId, output: { ok: false } }],
        usage,
        costUsd: 0.25,
        bytes: 100,
      });
      await ctx.db.insert("run_actions", {
        runId,
        leagueId: s.leagueId,
        teamId: s.alpha,
        toolCallId: "call-1",
        stepIndex: 0,
        actionType: "set_lineup",
        payload: { slots: [] },
        validationResult: { ok: true },
        committedAt: NOW,
      });
      return payloadId;
    });

    const detail = await t.query(api.runs.get, { runId });
    expect(detail.run.id).toBe(runId);
    expect(detail.window.labelText).toBe("Lineup sun early");
    expect(detail.team?.name).toBe("Alpha");
    expect(detail.configVersion?.versionNo).toBe(7);
    expect(detail.actions.map((action) => action.actionType)).toEqual(["set_lineup"]);
    expect(detail.usage).toMatchObject({ inputTokens: 1000, outputTokens: 200, stepCount: 2 });
    // No `promptSections` on the run, so they are derived from step 0's messages.
    expect(detail.promptSectionsSource).toBe("derived");
    expect(detail.promptSections.map((section) => section.role)).toEqual(["system", "user"]);

    const firstPage = await t.query(api.runs.steps, {
      runId,
      paginationOpts: { numItems: 1, cursor: null },
    });
    expect(firstPage.page.map((step) => step.stepIndex)).toEqual([0]);
    const secondPage = await t.query(api.runs.steps, {
      runId,
      paginationOpts: { numItems: 5, cursor: firstPage.continueCursor },
    });
    expect(secondPage.page[0].hasValidationError).toBe(true);

    const payload = await t.query(api.runs.stepPayload, { payloadId });
    expect(payload.toolName).toBe("get_news");

    const exported = await t.query(api.runs.export, { runId });
    expect(exported.kind).toBe("run");
    expect(exported.trace.steps).toHaveLength(2);
    // The overflowed payload is inlined into the exported tool result.
    expect(
      (exported.trace.steps[1].toolResults[0] as { output: { items: string[] } }).output.items,
    ).toEqual(["big news"]);

    const teamExport = await t.query(api.runs.exportTeamPage, {
      teamId: s.alpha,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(teamExport.kind).toBe("team");
    expect(teamExport.team.name).toBe("Alpha");
    expect(teamExport.page).toHaveLength(1);
  });
});

describe("runs.modelOptions", () => {
  test("comes from the per-league model rollups, not a scan of runs", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run(async (ctx) => {
      const base = {
        leagueId: s.leagueId,
        season: SEASON,
        provider: "anthropic",
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        costUsd: 0,
        computedCostUsd: 0,
        gatewayCostUsd: 0,
        stepCount: 0,
        fallbackCount: 0,
        invalidActionCount: 0,
        updatedAt: NOW,
      };
      await ctx.db.insert("model_week_rollups", {
        ...base,
        modelId: SONNET,
        weekNo: 1,
        runCount: 4,
      });
      await ctx.db.insert("model_week_rollups", {
        ...base,
        modelId: SONNET,
        weekNo: 2,
        runCount: 2,
      });
      await ctx.db.insert("model_week_rollups", {
        ...base,
        modelId: HAIKU,
        weekNo: 1,
        runCount: 5,
      });
    });

    expect(await t.query(api.runs.modelOptions, { leagueId: s.leagueId })).toEqual([
      { modelId: SONNET, label: "Claude Sonnet 4.5", runCount: 6 },
      { modelId: HAIKU, label: "Claude Haiku 4.5", runCount: 5 },
    ]);
  });
});

describe("runs.usageEvents", () => {
  test("pages the run's usage events and exposes both cost figures", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const runId = await insertRun(t, s);
    const otherRunId = await insertRun(t, s, { teamId: s.bravo });

    await t.run(async (ctx) => {
      const base = {
        leagueId: s.leagueId,
        teamId: s.alpha,
        season: SEASON,
        weekNo: 1,
        provider: "anthropic",
        cachedInputTokens: 100,
        reasoningTokens: 25,
        createdAt: NOW,
      };
      await ctx.db.insert("usage_events", {
        ...base,
        runId,
        stepIndex: 0,
        modelId: SONNET,
        inputTokens: 900,
        outputTokens: 120,
        latencyMs: 1400,
        computedCostUsd: 0.004,
        gatewayCostUsd: 0.0042,
        costUsd: 0.0042,
      });
      await ctx.db.insert("usage_events", {
        ...base,
        runId,
        stepIndex: 1,
        modelId: SONNET,
        inputTokens: 1200,
        outputTokens: 80,
        computedCostUsd: 0.005,
        costUsd: 0.005,
      });
      // A different run's events never appear in this run's ledger.
      await ctx.db.insert("usage_events", {
        ...base,
        runId: otherRunId,
        teamId: s.bravo,
        stepIndex: 0,
        modelId: HAIKU,
        inputTokens: 10,
        outputTokens: 10,
        computedCostUsd: 0.001,
        costUsd: 0.001,
      });
    });

    const first = await t.query(api.runs.usageEvents, {
      runId,
      paginationOpts: { numItems: 1, cursor: null },
    });
    expect(first.page).toHaveLength(1);
    expect(first.isDone).toBe(false);
    expect(first.page[0]).toEqual({
      stepIndex: 0,
      modelId: SONNET,
      provider: "anthropic",
      inputTokens: 900,
      outputTokens: 120,
      cachedInputTokens: 100,
      reasoningTokens: 25,
      latencyMs: 1400,
      costUsd: 0.0042,
      computedCostUsd: 0.004,
      gatewayCostUsd: 0.0042,
      createdAt: NOW,
    });

    const rest = await t.query(api.runs.usageEvents, {
      runId,
      paginationOpts: { numItems: 10, cursor: first.continueCursor },
    });
    expect(rest.page.map((event) => event.stepIndex)).toEqual([1]);
    expect(rest.isDone).toBe(true);
    // No gateway figure: the row reports the computed cost and a null gateway cost.
    expect(rest.page[0].gatewayCostUsd).toBeNull();
    expect(rest.page[0].latencyMs).toBeNull();

    expect(
      (
        await t.query(api.runs.usageEvents, {
          runId: otherRunId,
          paginationOpts: { numItems: 10, cursor: null },
        })
      ).page.map((event) => event.modelId),
    ).toEqual([HAIKU]);
  });

  test("carries the run's gateway cost onto the step shape too", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const runId = await insertRun(t, s);
    await t.run(async (ctx) => {
      await ctx.db.insert("run_steps", {
        runId,
        leagueId: s.leagueId,
        stepIndex: 0,
        modelId: SONNET,
        responseMessages: [],
        toolCalls: [],
        toolResults: [],
        usage: {
          inputTokens: 900,
          outputTokens: 120,
          cachedInputTokens: 100,
          reasoningTokens: 25,
          totalTokens: 1145,
        },
        costUsd: 0.004,
        gatewayCostUsd: 0.0042,
        bytes: 128,
      });
    });
    const page = await t.query(api.runs.steps, {
      runId,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(page.page[0].gatewayCostUsd).toBe(0.0042);
  });
});

describe("runs.searchPlayers", () => {
  test("resolves the term against player names and skips an empty term", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("players", {
        sleeperId: "rb1",
        fullName: "Ray Rusher",
        position: "RB",
        fantasyPositions: ["RB"],
        externalIds: {},
        updatedAt: NOW,
      });
    });

    expect(await t.query(api.runs.searchPlayers, { leagueId: s.leagueId, q: "Quinn Back" })).toEqual(
      [{ playerId: s.player, fullName: "Quinn Back", position: "QB", nflTeam: "KC" }],
    );
    // No nflTeam on the row -> null, not undefined.
    expect(await t.query(api.runs.searchPlayers, { leagueId: s.leagueId, q: "Rusher" })).toEqual([
      expect.objectContaining({ fullName: "Ray Rusher", nflTeam: null }),
    ]);
    expect(await t.query(api.runs.searchPlayers, { leagueId: s.leagueId, q: "   " })).toEqual([]);
  });
});
