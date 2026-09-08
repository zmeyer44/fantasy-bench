/**
 * The Commissioner Agent runs a real `generateText` call against a mocked
 * `resolveModel`, so this exercises the whole path: prompt → model → sections →
 * forum posts → run/step/usage trace.
 */
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";

const RECAP_TEXT = [
  "## Week 3 Recap",
  "",
  "Team 1 ran away with it while Team 2 left half its bench points on the table.",
  "",
  "## Power Rankings",
  "",
  "1. Team 1 — the only roster that looks intentional.",
  "2. Team 2 — one good waiver away.",
  "",
  "## Awards",
  "",
  "- **Coach of the week**: Team 1.",
].join("\n");

let modelText = RECAP_TEXT;

vi.mock("@/lib/agent/model", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent/model")>()),
  resolveModel: () =>
    new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: "text" as const, text: modelText }],
        // V3 finish reasons are objects; the SDK flattens them to `unified`.
        finishReason: { unified: "stop" as const, raw: "stop" },
        // LanguageModelV3Usage is nested — the SDK flattens it for `result.usage`.
        usage: {
          inputTokens: { total: 1200, noCache: 1200, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 300, text: 300, reasoning: 0 },
        },
        warnings: [],
      }),
    }),
  isMockModelId: (modelId: string) => modelId.startsWith("mock/"),
}));

const { forumPosts, modelPrices, runSteps, runs, trades, usageEvents } = await import(
  "@/lib/db/schema"
);
const {
  COMMISSIONER_CONFIG,
  flaggedTradesDigest,
  runCommissionerTask,
  runWeeklyCommissionerTasks,
  scoreTradeNarrative,
  splitSections,
  weeklyRecap,
} = await import("@/lib/services/commissioner-agent");
const { proposeTrade, respondToTrade } = await import("@/lib/services/trades");

const { db, truncateAll } = await import("../setup");
const { makeRunContext, seedLeague } = await import("./helpers");

beforeAll(async () => {
  await truncateAll();
  modelText = RECAP_TEXT;
});

describe("COMMISSIONER_CONFIG", () => {
  it("is public, pinned and defaults to Sonnet", () => {
    expect(COMMISSIONER_CONFIG.modelId).toBe(
      process.env.COMMISSIONER_MODEL_ID ?? "anthropic/claude-sonnet-4.5",
    );
    expect(COMMISSIONER_CONFIG.contextMd).toMatch(/never take[s]? roster actions|never takes/i);
    expect(COMMISSIONER_CONFIG.contextMd).toMatch(/direct messages/i);
  });
});

describe("weeklyRecap", () => {
  it("publishes one announcement per section and leaves a priced trace", async () => {
    const seed = await seedLeague();
    await db.insert(modelPrices).values({
      modelId: COMMISSIONER_CONFIG.modelId,
      provider: "anthropic",
      displayName: "Sonnet",
      inputPerM: 3,
      outputPerM: 15,
      effectiveFrom: new Date(Date.now() - 86_400_000),
    });

    const result = await weeklyRecap(seed.leagueId, seed.weekNo);
    expect(result.task).toBe("weekly_recap");
    expect(result.scripted).toBe(false);
    expect(result.postIds).toHaveLength(3);

    const posts = await db
      .select()
      .from(forumPosts)
      .where(eq(forumPosts.leagueId, seed.leagueId));
    expect(posts).toHaveLength(3);
    expect(posts.every((p) => p.teamId === null)).toBe(true);
    expect(posts.every((p) => p.flair === "announcement")).toBe(true);
    expect(posts.every((p) => p.runId === result.runId)).toBe(true);
    expect(posts.map((p) => p.title).sort()).toEqual([
      "Awards",
      "Power Rankings",
      "Week 3 Recap",
    ]);

    // The run trace: one commissioner run, one step, one usage event.
    const [run] = await db.select().from(runs).where(eq(runs.id, result.runId));
    expect(run.kind).toBe("commissioner");
    expect(run.teamId).toBeNull();
    expect(run.status).toBe("succeeded");
    expect(run.modelId).toBe(COMMISSIONER_CONFIG.modelId);
    expect(run.stepCount).toBe(1);
    expect(run.totalInputTokens).toBe(1200);
    expect(run.totalOutputTokens).toBe(300);

    const steps = await db.select().from(runSteps).where(eq(runSteps.runId, result.runId));
    expect(steps).toHaveLength(1);
    expect(steps[0].stepIndex).toBe(0);
    expect(steps[0].text).toBe(RECAP_TEXT);
    expect(steps[0].messages).toHaveLength(2);

    const usage = await db.select().from(usageEvents).where(eq(usageEvents.runId, result.runId));
    expect(usage).toHaveLength(1);
    expect(usage[0].teamId).toBeNull();
    expect(usage[0].provider).toBe("anthropic");
    // 1200 in @ $3/M + 300 out @ $15/M = 0.0036 + 0.0045.
    expect(usage[0].costUsd).toBeCloseTo(0.0081, 6);
    expect(run.totalCostUsd).toBeCloseTo(0.0081, 6);
  });

  it("falls back to deterministic text when the model returns nothing", async () => {
    const seed = await seedLeague();
    modelText = "";
    try {
      const result = await weeklyRecap(seed.leagueId, seed.weekNo);
      expect(result.scripted).toBe(true);
      expect(result.postIds.length).toBeGreaterThan(0);
      expect(result.text).toMatch(/Power Rankings/);
    } finally {
      modelText = RECAP_TEXT;
    }
  });
});

describe("scoreTradeNarrative", () => {
  it("saves prose into fairness_detail without touching the score", async () => {
    const seed = await seedLeague();
    const [a, b] = seed.teams;
    const proposal = await proposeTrade({
      leagueId: seed.leagueId,
      proposerTeamId: a.id,
      toTeamId: b.id,
      give: [seed.roster[a.id][0]],
      receive: [seed.roster[b.id][0]],
      ctx: await makeRunContext(seed, a.id),
    });
    if (!proposal.ok) throw new Error("setup failed");
    await respondToTrade({
      leagueId: seed.leagueId,
      teamId: b.id,
      tradeId: proposal.tradeId,
      action: "accept",
      ctx: await makeRunContext(seed, b.id),
    });

    const [before] = await db.select().from(trades).where(eq(trades.id, proposal.tradeId));
    modelText = "A clean swap of two comparable starters; nobody is being robbed here.";

    const result = await scoreTradeNarrative(proposal.tradeId);
    expect(result?.task).toBe("trade_narrative");
    // A narrative is not an announcement — nothing is published to the board.
    expect(result?.postIds).toHaveLength(0);

    const [after] = await db.select().from(trades).where(eq(trades.id, proposal.tradeId));
    expect(after.fairnessScore).toBe(before.fairnessScore);
    expect(after.flagged).toBe(before.flagged);
    expect(after.fairnessDetail?.narrative).toBe(modelText);
    // The deterministic breakdown survives the merge.
    expect(after.fairnessDetail?.items).toHaveLength(2);

    modelText = RECAP_TEXT;
  });
});

describe("runCommissionerTask", () => {
  it("dispatches by name and runs the weekly bundle", async () => {
    const seed = await seedLeague();
    const dispatched = await runCommissionerTask("flagged_trades_digest", {
      leagueId: seed.leagueId,
    });
    expect(dispatched?.task).toBe("flagged_trades_digest");

    const bundle = await runWeeklyCommissionerTasks(seed.leagueId, seed.weekNo);
    expect(bundle[0].task).toBe("weekly_recap");
    expect(bundle.every((r) => r.runId)).toBe(true);

    const digest = await flaggedTradesDigest(seed.leagueId);
    expect(digest.postIds.length).toBeGreaterThanOrEqual(0);

    await expect(runCommissionerTask("weekly_recap", {})).rejects.toThrow(/leagueId/);
  });
});

describe("splitSections", () => {
  it("splits on ## headings and falls back to a single section", () => {
    const sections = splitSections(RECAP_TEXT, "Fallback");
    expect(sections.map((s) => s.title)).toEqual([
      "Week 3 Recap",
      "Power Rankings",
      "Awards",
    ]);
    expect(sections[0].body).toMatch(/ran away with it/);

    const single = splitSections("Just a paragraph with no headings.", "Fallback");
    expect(single).toEqual([
      { title: "Fallback", body: "Just a paragraph with no headings." },
    ]);
  });
});
