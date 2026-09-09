/**
 * Bounds tests: the caps that keep every public read inside Convex's transaction
 * limits (`docs/CONVEX_NOTES.md` §4 — 32 000 documents, 16 MiB, 4 096 index ranges,
 * 1 s of query time).
 *
 * This is the companion to `scripts/limits-check.ts`. That script proves the
 * queries *do not* blow a limit on a real 50-league deployment; it cannot prove
 * they never will, because the load-test data is uniform and none of it is
 * pathological. `convex-test` is a mock and enforces no limits at all
 * (`docs/CONVEX_NOTES.md` §9), so a test here cannot observe a limit either.
 *
 * What it can do — and what this file does — is build **one deliberately oversized
 * league** and assert that each read comes back *capped*: 900 waiver claims in a
 * week yield at most `MAX_CLAIMS_PER_WEEK` rows, 700 posts yield at most a
 * `HOT_WINDOW` ranking, a 300-step run pages instead of inlining, and so on. If
 * somebody later removes a `.take(...)` or turns a bounded range into a
 * `.collect()`, the result stops being capped and the assertion fails — which is
 * the failure mode the limits work exists to prevent.
 *
 * The expected caps are the constants in the query modules; they are restated here
 * as literals on purpose, so changing a cap is a deliberate two-file edit.
 */
import { convexTest } from "convex-test";
import { beforeAll, describe, expect, test } from "vitest";

import { api } from "./_generated/api";
import type { DataModel, Id } from "./_generated/dataModel";
import type { GenericMutationCtx } from "convex/server";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

type Ctx = GenericMutationCtx<DataModel>;

/** The caps the query modules declare. */
const CAPS = {
  /** `convex/waivers.ts#MAX_CLAIMS_PER_WEEK` */
  claimsPerWeek: 200,
  /** `convex/forum.ts#HOT_WINDOW` */
  hotWindow: 200,
  /** `convex/forum.ts#MAX_COMMENTS` */
  comments: 500,
  /** `convex/messaging.ts#MAX_THREADS` */
  threads: 100,
  /** `convex/trades.ts#MAX_FEED` */
  tradeFeed: 100,
  /** `convex/draft.ts#MAX_PICKS` */
  draftPicks: 300,
  /** `convex/ledger.ts#EXPENSIVE_RUN_SCAN` and its `limit` cap */
  expensiveRuns: 50,
  /** `convex/runs.ts#TEAM_EXPORT_RUN_LIMIT` */
  teamExportRuns: 200,
  /** `convex/runs.ts#MAX_STEPS_PER_RUN` */
  exportSteps: 64,
} as const;

/** Deliberately larger than every cap above. */
const OVERSIZED = {
  teams: 14,
  weeks: 22,
  claims: 900,
  posts: 700,
  comments: 900,
  threads: 400,
  trades: 400,
  picks: 600,
  runs: 500,
  stepsInBigRun: 300,
} as const;

const NOW = Date.parse("2026-12-01T12:00:00.000Z");
const SEASON = 2026;

const RULES = {
  scoringPreset: "ppr" as const,
  superflex: false,
  tePremium: false,
  rosterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DEF: 1, BENCH: 6 },
  faabBudget: 100,
  playoffTeams: 6,
  playoffStartWeek: 15,
  regularSeasonWeeks: 14,
  seasonWeeks: 17,
  transparencyMode: "live" as const,
  injectionPolicy: "permitted" as const,
  modelAllowlist: [],
  contextCharLimit: 8_000,
  maxStepsCap: 30,
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
  draftPickSeconds: 240,
  reuseSnapshotWithinMs: 600_000,
  draftBudget: 200,
};

type Fixture = {
  t: ReturnType<typeof convexTest>;
  identity: ReturnType<ReturnType<typeof convexTest>["withIdentity"]>;
  leagueId: Id<"leagues">;
  teamId: Id<"teams">;
  postId: Id<"forum_posts">;
  threadId: Id<"threads">;
  bigRunId: Id<"runs">;
};

let fx: Fixture;

async function build(ctx: Ctx): Promise<Omit<Fixture, "t" | "identity">> {
  const userId = await ctx.db.insert("users", { email: "commish@limits.dev" });
  const leagueId = await ctx.db.insert("leagues", {
    name: "Oversized League",
    slug: "oversized",
    commissionerUserId: userId,
    season: SEASON,
    teamCount: OVERSIZED.teams,
    isPublic: true,
    status: "in_season",
    draftType: "snake",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await ctx.db.insert("league_rules", { leagueId, ...RULES });
  await ctx.db.insert("league_members", { leagueId, userId, role: "commissioner", createdAt: NOW });

  const teamIds: Id<"teams">[] = [];
  for (let t = 0; t < OVERSIZED.teams; t += 1) {
    teamIds.push(
      await ctx.db.insert("teams", {
        leagueId,
        ownerUserId: t === 0 ? userId : undefined,
        name: `Team ${t}`,
        abbreviation: `T${t}`,
        faabRemaining: 100,
        waiverPriority: t + 1,
        karma: 0,
        draftBudgetRemaining: 0,
        createdAt: NOW,
      }),
    );
    await ctx.db.insert("team_standings", {
      leagueId,
      teamId: teamIds[t],
      season: SEASON,
      wins: 0,
      losses: 0,
      ties: 0,
      pointsFor: 0,
      pointsAgainst: 0,
      streak: "",
      updatedAt: NOW,
    });
  }

  for (let w = 1; w <= OVERSIZED.weeks; w += 1) {
    await ctx.db.insert("weeks", {
      leagueId,
      weekNo: w,
      startsAt: NOW - (OVERSIZED.weeks - w) * 86_400_000,
      endsAt: NOW - (OVERSIZED.weeks - w - 1) * 86_400_000,
      isPlayoff: false,
      status: "complete",
    });
  }

  const windowId = await ctx.db.insert("windows", {
    leagueId,
    type: "waiver",
    label: "waiver",
    weekNo: 1,
    roundNo: 1,
    opensAt: NOW - 86_400_000,
    submissionDeadlineAt: NOW - 80_000_000,
    closesAt: NOW - 79_000_000,
    status: "closed",
    scope: {},
    runCount: 0,
    terminalRunCount: 0,
  });

  const playerId = await ctx.db.insert("players", {
    sleeperId: "p1",
    fullName: "Bounded Player",
    position: "RB",
    fantasyPositions: ["RB"],
    externalIds: {},
    updatedAt: NOW,
  });

  // Waiver claims: one week, far past MAX_CLAIMS_PER_WEEK.
  for (let c = 0; c < OVERSIZED.claims; c += 1) {
    await ctx.db.insert("waiver_claims", {
      leagueId,
      teamId: teamIds[c % OVERSIZED.teams],
      windowId,
      weekNo: 1,
      addPlayerId: playerId,
      bid: c % 50,
      priority: (c % OVERSIZED.teams) + 1,
      status: "lost",
    });
  }

  // Draft picks past MAX_PICKS.
  for (let p = 0; p < OVERSIZED.picks; p += 1) {
    await ctx.db.insert("draft_picks", {
      leagueId,
      round: Math.floor(p / OVERSIZED.teams) + 1,
      pickNo: (p % OVERSIZED.teams) + 1,
      overallNo: p + 1,
      teamId: teamIds[p % OVERSIZED.teams],
      playerId,
      auto: false,
      madeAt: NOW - 1_000_000,
    });
  }

  // Forum: more posts than HOT_WINDOW, more comments on one post than MAX_COMMENTS.
  let postId: Id<"forum_posts"> | null = null;
  for (let p = 0; p < OVERSIZED.posts; p += 1) {
    const id = await ctx.db.insert("forum_posts", {
      leagueId,
      teamId: teamIds[p % OVERSIZED.teams],
      title: `Post ${p}`,
      body: "body",
      flair: "analysis",
      score: p % 37,
      commentCount: 0,
      hidden: false,
      createdAt: NOW - p * 1_000,
    });
    if (p === 0) postId = id;
  }
  for (let c = 0; c < OVERSIZED.comments; c += 1) {
    await ctx.db.insert("forum_comments", {
      postId: postId!,
      leagueId,
      teamId: teamIds[c % OVERSIZED.teams],
      body: `comment ${c}`,
      score: 0,
      hidden: false,
      createdAt: NOW - OVERSIZED.comments * 1_000 + c * 1_000,
    });
  }
  await ctx.db.patch("forum_posts", postId!, { commentCount: OVERSIZED.comments });

  // Threads past MAX_THREADS, trades past MAX_FEED.
  let threadId: Id<"threads"> | null = null;
  for (let n = 0; n < OVERSIZED.threads; n += 1) {
    const id = await ctx.db.insert("threads", {
      leagueId,
      teamAId: teamIds[n % OVERSIZED.teams],
      teamBId: teamIds[(n + 1) % OVERSIZED.teams],
      lastMessageAt: NOW - n * 1_000,
      messageCount: 0,
      flaggedCount: 0,
    });
    if (n === 0) threadId = id;
  }
  for (let n = 0; n < OVERSIZED.trades; n += 1) {
    await ctx.db.insert("trades", {
      leagueId,
      proposerTeamId: teamIds[n % OVERSIZED.teams],
      recipientTeamId: teamIds[(n + 1) % OVERSIZED.teams],
      weekNo: 1,
      status: "proposed",
      items: [],
      flagged: false,
      vetoCount: 0,
      approveCount: 0,
    });
  }

  // Runs: many small ones plus one with far more steps than a page.
  let bigRunId: Id<"runs"> | null = null;
  for (let r = 0; r < OVERSIZED.runs; r += 1) {
    const runId = await ctx.db.insert("runs", {
      windowId,
      leagueId,
      teamId: teamIds[r % OVERSIZED.teams],
      modelId: "mock/scripted",
      kind: "team",
      status: "succeeded",
      windowType: "waiver",
      windowLabel: "waiver",
      weekNo: 1,
      attempt: 1,
      lastPersistedStep: 0,
      totalCostUsd: (r % 17) / 100,
      totalInputTokens: 100,
      totalOutputTokens: 10,
      stepCount: 1,
      committedActionCount: 0,
      rejectedActionCount: 0,
      startedAt: NOW - r * 1_000,
      finishedAt: NOW - r * 1_000 + 500,
    });
    if (r === 0) bigRunId = runId;
  }
  for (let s = 0; s < OVERSIZED.stepsInBigRun; s += 1) {
    await ctx.db.insert("run_steps", {
      runId: bigRunId!,
      leagueId,
      stepIndex: s,
      modelId: "mock/scripted",
      text: `step ${s}`,
      responseMessages: [],
      toolCalls: [],
      toolResults: [],
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
        cachedInputTokens: 0,
        reasoningTokens: 0,
      },
      costUsd: 0,
      bytes: 64,
    });
  }
  await ctx.db.patch("runs", bigRunId!, {
    stepCount: OVERSIZED.stepsInBigRun,
    lastPersistedStep: OVERSIZED.stepsInBigRun - 1,
  });

  return { leagueId, teamId: teamIds[0], postId: postId!, threadId: threadId!, bigRunId: bigRunId! };
}

beforeAll(async () => {
  const t = convexTest(schema, modules);
  const built = await t.run(async (ctx) => {
    const result = await build(ctx as Ctx);
    const userId = (
      await (ctx as Ctx).db
        .query("users")
        .withIndex("email", (q) => q.eq("email", "commish@limits.dev"))
        .unique()
    )!._id;
    const sessionId = await (ctx as Ctx).db.insert("authSessions", {
      userId,
      expirationTime: NOW + 86_400_000,
    });
    return { ...result, subject: `${userId}|${sessionId}` };
  });
  fx = { t, identity: t.withIdentity({ subject: built.subject }), ...built };
}, 600_000);

describe("read bounds on an oversized league", () => {
  test("waivers.results caps the week's claims", async () => {
    const view = await fx.identity.query(api.waivers.results, {
      leagueId: fx.leagueId,
      weekNo: 1,
    });
    expect(view.results.length).toBeLessThanOrEqual(CAPS.claimsPerWeek);
    expect(view.results.length).toBe(CAPS.claimsPerWeek);
    // The cap is a real truncation, so `pendingCount`/`weeksWithClaims` are derived
    // from the same capped window rather than a full count.
    expect(view.weeksWithClaims).toEqual([1]);
  });

  test("draft.board caps the picks it renders", async () => {
    const board = await fx.identity.query(api.draft.board, { leagueId: fx.leagueId });
    expect(board?.picks.length).toBeLessThanOrEqual(CAPS.draftPicks);
    expect(board?.picks.length).toBe(CAPS.draftPicks);
  });

  test("forum.list ranks a bounded window and pages", async () => {
    const first = await fx.identity.query(api.forum.list, {
      leagueId: fx.leagueId,
      sort: "hot",
      paginationOpts: { numItems: 25, cursor: null },
    });
    expect(first.page.length).toBeLessThanOrEqual(25);
    // `hot` is a ranking over the newest HOT_WINDOW posts, not a full-table sort:
    // paging past that window ends, it does not walk all 700 posts.
    let seen = first.page.length;
    let cursor = first.continueCursor;
    let done = first.isDone;
    for (let guard = 0; guard < 40 && !done; guard += 1) {
      const next = await fx.identity.query(api.forum.list, {
        leagueId: fx.leagueId,
        sort: "hot",
        paginationOpts: { numItems: 25, cursor },
      });
      seen += next.page.length;
      cursor = next.continueCursor;
      done = next.isDone;
    }
    expect(done).toBe(true);
    expect(seen).toBeLessThanOrEqual(CAPS.hotWindow);
    expect(seen).toBe(CAPS.hotWindow);
  });

  test("forum.get caps the comment tree", async () => {
    const view = await fx.identity.query(api.forum.get, {
      leagueId: fx.leagueId,
      postId: fx.postId,
    });
    expect(view.post?.comments?.length).toBeLessThanOrEqual(CAPS.comments);
    expect(view.post?.comments?.length).toBe(CAPS.comments);
  });

  test("messaging.listThreads caps the feed", async () => {
    const all = await fx.identity.query(api.messaging.listThreads, { leagueId: fx.leagueId });
    expect(all.length).toBeLessThanOrEqual(CAPS.threads);
    // An oversized `limit` is clamped, not honoured.
    const asked = await fx.identity.query(api.messaging.listThreads, {
      leagueId: fx.leagueId,
      limit: 5_000,
    });
    expect(asked.length).toBeLessThanOrEqual(CAPS.threads);
  });

  test("trades.list caps the feed", async () => {
    const all = await fx.identity.query(api.trades.list, { leagueId: fx.leagueId });
    expect(all.length).toBeLessThanOrEqual(CAPS.tradeFeed);
    const asked = await fx.identity.query(api.trades.list, { leagueId: fx.leagueId, limit: 5_000 });
    expect(asked.length).toBeLessThanOrEqual(CAPS.tradeFeed);
  });

  test("runs.get does not inline the steps of a 300-step run", async () => {
    const detail = await fx.identity.query(api.runs.get, { runId: fx.bigRunId });
    expect(detail.run.stepCount).toBe(OVERSIZED.stepsInBigRun);
    expect("steps" in detail).toBe(false);
    const page = await fx.identity.query(api.runs.steps, {
      runId: fx.bigRunId,
      paginationOpts: { numItems: 25, cursor: null },
    });
    expect(page.page.length).toBe(25);
    expect(page.isDone).toBe(false);
  });

  test("runs.export caps the steps it inlines", async () => {
    const dump = await fx.identity.query(api.runs.export, { runId: fx.bigRunId });
    expect(dump.trace.steps.length).toBeLessThanOrEqual(CAPS.exportSteps);
    // A silent truncation: the export is bounded by `MAX_STEPS_PER_RUN`, justified
    // by `league_rules.maxStepsCap` being <= 31 in every shipped config. A run that
    // somehow exceeded 64 steps would export incompletely with no marker.
    expect(dump.trace.steps.length).toBe(CAPS.exportSteps);
    expect(dump.trace.run.stepCount).toBe(OVERSIZED.stepsInBigRun);
  });

  test("runs.list pages rather than returning 500 runs", async () => {
    const page = await fx.identity.query(api.runs.list, {
      leagueId: fx.leagueId,
      paginationOpts: { numItems: 25, cursor: null },
    });
    expect(page.page.length).toBe(25);
    expect(page.isDone).toBe(false);
  });

  test("runs.exportTeamPage pages the team's runs", async () => {
    const page = await fx.identity.query(api.runs.exportTeamPage, {
      teamId: fx.teamId,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(page.page.length).toBeLessThanOrEqual(CAPS.teamExportRuns);
    expect(page.page.length).toBe(10);
  });

  test("ledger.leagueDashboard caps the expensive-run list", async () => {
    const dashboard = await fx.identity.query(api.ledger.leagueDashboard, {
      leagueId: fx.leagueId,
      limit: 5_000,
    });
    expect(dashboard.expensive.length).toBeLessThanOrEqual(CAPS.expensiveRuns);
    expect(dashboard.byTeam.length).toBe(OVERSIZED.teams);
  });

  test("views.home and views.standings stay team-sized", async () => {
    const home = await fx.identity.query(api.views.home, { leagueId: fx.leagueId });
    expect(home?.standings.length).toBe(OVERSIZED.teams);
    expect(home?.forumPosts.length).toBeLessThanOrEqual(5);
    expect(home?.trades.length).toBeLessThanOrEqual(5);
    const table = await fx.identity.query(api.views.standings, { leagueId: fx.leagueId });
    expect(table.length).toBe(OVERSIZED.teams);
  });
});
