/**
 * `convex/trades.ts` — feed filters, detail tally and the agent inbox query.
 */
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import type { TradeSummary } from "./trades";
import { weeklyLineupDeadline } from "./lib/lineup_deadline";

const modules = import.meta.glob("./**/*.ts");

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

async function seed(t: ReturnType<typeof convexTest>, opts: { isPublic?: boolean } = {}) {
  return t.run(async (ctx) => {
    const ownerA = await ctx.db.insert("users", { email: "a@x.dev" });
    const ownerB = await ctx.db.insert("users", { email: "b@x.dev" });
    const stranger = await ctx.db.insert("users", { email: "c@x.dev" });
    const sessionOf = async (userId: Id<"users">) =>
      ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 86_400_000 });

    const leagueId = await ctx.db.insert("leagues", {
      name: "Test", slug: `t-${Math.random()}`, commissionerUserId: ownerA, season: 2025,
      teamCount: 2, isPublic: opts.isPublic ?? true, status: "in_season",
      draftType: "snake", updatedAt: Date.now(),
    });
    await ctx.db.insert("league_rules", { leagueId, ...RULES });
    await ctx.db.insert("league_members", { leagueId, userId: ownerA, role: "commissioner" });
    await ctx.db.insert("league_members", { leagueId, userId: ownerB, role: "owner" });

    const team = async (name: string, ownerUserId: Id<"users">) =>
      ctx.db.insert("teams", {
        leagueId, ownerUserId, name, abbreviation: name.slice(0, 3).toUpperCase(),
        faabRemaining: 100, waiverPriority: 1, karma: 0, draftBudgetRemaining: 200,
      });
    const teamA = await team("Alpha", ownerA);
    const teamB = await team("Bravo", ownerB);

    const player = async (fullName: string, position: "QB" | "RB" | "WR") =>
      ctx.db.insert("players", {
        sleeperId: fullName, fullName, position, nflTeam: "SF",
        fantasyPositions: [position], externalIds: {}, updatedAt: Date.now(),
      });
    const rb = await player("Rick Back", "RB");
    const wr = await player("Wide Rex", "WR");

    return {
      ownerA, ownerB, stranger, leagueId, teamA, teamB, rb, wr,
      sessionA: await sessionOf(ownerA),
      sessionB: await sessionOf(ownerB),
      sessionStranger: await sessionOf(stranger),
    };
  });
}

type Seed = Awaited<ReturnType<typeof seed>>;

async function insertTrade(
  t: ReturnType<typeof convexTest>,
  s: Seed,
  over: Partial<{
    status: "proposed" | "countered" | "in_review" | "completed";
    weekNo: number;
    vetoCount: number;
    approveCount: number;
    threadId: Id<"threads">;
    parentTradeId: Id<"trades">;
    faab: number;
  }> = {},
) {
  return t.run(async (ctx) =>
    ctx.db.insert("trades", {
      leagueId: s.leagueId,
      proposerTeamId: s.teamA,
      recipientTeamId: s.teamB,
      threadId: over.threadId,
      parentTradeId: over.parentTradeId,
      weekNo: over.weekNo ?? 1,
      status: over.status ?? "proposed",
      items: [
        { fromTeamId: s.teamA, toTeamId: s.teamB, playerId: s.rb },
        { fromTeamId: s.teamB, toTeamId: s.teamA, playerId: s.wr },
        ...(over.faab
          ? [{ fromTeamId: s.teamA, toTeamId: s.teamB, faab: over.faab }]
          : []),
      ],
      fairnessScore: 0.82,
      fairnessDetail: { version: 1, narrative: "Close enough.", score: 0.82 },
      flagged: false,
      message: "Deal?",
      vetoCount: over.vetoCount ?? 0,
      approveCount: over.approveCount ?? 0,
    }),
  );
}

describe("trades.list", () => {
  test("returns proposer-oriented summaries with resolved player names", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await insertTrade(t, s, { faab: 5 });

    const rows = await t.query(api.trades.list, { leagueId: s.leagueId });
    expect(rows).toHaveLength(1);
    const [trade] = rows;
    expect(trade.give.map((p) => p.playerName)).toEqual(["Rick Back"]);
    expect(trade.receive.map((p) => p.playerName)).toEqual(["Wide Rex"]);
    expect(trade.give[0].position).toBe("RB");
    expect(trade.faab).toBe(5);
    expect(trade.proposerTeamName).toBe("Alpha");
    expect(trade.recipientTeamName).toBe("Bravo");
    expect(typeof trade.createdAt).toBe("number");
    expect(trade.fairnessScore).toBe(0.82);
  });

  test("filters by status, week and team", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await insertTrade(t, s, { status: "proposed", weekNo: 1 });
    await insertTrade(t, s, { status: "completed", weekNo: 2 });

    expect(await t.query(api.trades.list, { leagueId: s.leagueId })).toHaveLength(2);
    expect(
      await t.query(api.trades.list, { leagueId: s.leagueId, status: "completed" }),
    ).toHaveLength(1);
    expect(
      await t.query(api.trades.list, { leagueId: s.leagueId, weekNo: 2 }),
    ).toHaveLength(1);
    expect(
      await t.query(api.trades.list, { leagueId: s.leagueId, teamId: s.teamA }),
    ).toHaveLength(2);

    // A team that is party to nothing sees nothing.
    const other = await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        leagueId: s.leagueId, name: "Ghost", abbreviation: "GHO", faabRemaining: 0,
        waiverPriority: 3, karma: 0, draftBudgetRemaining: 0,
      }),
    );
    expect(
      await t.query(api.trades.list, { leagueId: s.leagueId, teamId: other }),
    ).toHaveLength(0);
  });

  test("honours the limit and caps it at 100", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    for (let i = 0; i < 3; i++) await insertTrade(t, s);
    expect(await t.query(api.trades.list, { leagueId: s.leagueId, limit: 2 })).toHaveLength(2);
    expect(
      await t.query(api.trades.list, { leagueId: s.leagueId, limit: 1000 }),
    ).toHaveLength(3);
  });
});

describe("trades.get", () => {
  test("returns the timeline, the veto tally and the viewer's own vote", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const tradeId = await insertTrade(t, s, {
      status: "in_review",
      vetoCount: 1,
      approveCount: 1,
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("trade_events", {
        tradeId, leagueId: s.leagueId, type: "proposed",
        fromStatus: "proposed", toStatus: "in_review", actorTeamId: s.teamA,
        payload: { note: "flagged" },
      });
      await ctx.db.insert("trade_votes", { tradeId, userId: s.ownerA, vote: "veto" });
      await ctx.db.insert("trade_votes", { tradeId, userId: s.ownerB, vote: "approve" });
    });

    const asA = t.withIdentity({ subject: `${s.ownerA}|${s.sessionA}` });
    const detail = await asA.query(api.trades.get, { leagueId: s.leagueId, tradeId });

    expect(detail.events).toHaveLength(1);
    expect(detail.events[0].actorTeamName).toBe("Alpha");
    expect(detail.events[0].payload).toEqual({ note: "flagged" });
    expect(typeof detail.events[0].createdAt).toBe("number");
    expect(detail.votes).toHaveLength(2);
    // 2 non-spectator members: threshold 2, one veto does not block.
    expect(detail.tally).toEqual({
      vetoes: 1, approvals: 1, ownerCount: 2, threshold: 2, blocked: false,
    });
    expect(detail.myVote).toBe("veto");
    expect(detail.fairnessDetail?.narrative).toBe("Close enough.");
  });

  test("tally is null outside review and blocks on a majority", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const proposed = await insertTrade(t, s, { status: "proposed" });
    expect(
      (await t.query(api.trades.get, { leagueId: s.leagueId, tradeId: proposed })).tally,
    ).toBeNull();

    const review = await insertTrade(t, s, { status: "in_review", vetoCount: 2 });
    expect(
      (await t.query(api.trades.get, { leagueId: s.leagueId, tradeId: review })).tally?.blocked,
    ).toBe(true);
  });

  test("lists counter-offers and rejects a trade from another league", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const parent = await insertTrade(t, s);
    const counter = await insertTrade(t, s, { status: "countered", parentTradeId: parent });

    const detail = await t.query(api.trades.get, { leagueId: s.leagueId, tradeId: parent });
    expect(detail.counterTradeIds).toEqual([counter]);

    const other = await seed(t);
    await expect(
      t.query(api.trades.get, { leagueId: other.leagueId, tradeId: parent }),
    ).rejects.toThrow(/Trade not found/);
  });

  test("myVote is null for a signed-out viewer", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const tradeId = await insertTrade(t, s, { status: "in_review" });
    const detail = await t.query(api.trades.get, { leagueId: s.leagueId, tradeId });
    expect(detail.myVote).toBeNull();
  });
});

describe("trades auth", () => {
  test("a private league is forbidden to a non-member and unauthorized when signed out", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { isPublic: false });
    await insertTrade(t, s);

    await expect(t.query(api.trades.list, { leagueId: s.leagueId })).rejects.toThrow(
      /private/,
    );
    const asStranger = t.withIdentity({
      subject: `${s.stranger}|${s.sessionStranger}`,
    });
    await expect(asStranger.query(api.trades.list, { leagueId: s.leagueId })).rejects.toThrow(
      /private/,
    );
    const asA = t.withIdentity({ subject: `${s.ownerA}|${s.sessionA}` });
    expect(await asA.query(api.trades.list, { leagueId: s.leagueId })).toHaveLength(1);
  });
});

describe("trades.listOpenForTeam (internal)", () => {
  test("returns proposed and countered trades on both sides, deduped", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const open = await insertTrade(t, s, { status: "proposed" });
    const countered = await insertTrade(t, s, { status: "countered" });
    await insertTrade(t, s, { status: "completed" });

    const rows = await t.query(internal.trades.listOpenForTeam, {
      leagueId: s.leagueId,
      teamId: s.teamB,
    });
    expect(new Set(rows.map((r: TradeSummary) => r.id))).toEqual(new Set([open, countered]));

    // Same result from the proposer's side.
    const fromA = await t.query(internal.trades.listOpenForTeam, {
      leagueId: s.leagueId,
      teamId: s.teamA,
    });
    expect(fromA).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Write path
// ---------------------------------------------------------------------------

/**
 * `convexTest` bound to our schema, so `ctx.db` inside the helpers below keeps
 * its table and index types.
 */
type SchemaTest = TestConvex<typeof schema>;

const SEASON = 2025;
const WEEK = 1;
/** `seasonWeeks (17) - weekNo (1) + 1` — what a weekly projection is multiplied by. */
const REMAINING_WEEKS = 17;

/**
 * A league that can actually trade: three owners (so a veto majority is two),
 * two teams with two rostered players each, a trade window and a run to hang
 * `agentCtx` off.
 */
async function seedTrading(t: SchemaTest) {
  return t.run(async (ctx) => {
    const ownerA = await ctx.db.insert("users", { email: `a-${Math.random()}@x.dev` });
    const ownerB = await ctx.db.insert("users", { email: `b-${Math.random()}@x.dev` });
    const ownerC = await ctx.db.insert("users", { email: `c-${Math.random()}@x.dev` });
    const sessionOf = (userId: Id<"users">) =>
      ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 86_400_000 });

    const leagueId = await ctx.db.insert("leagues", {
      name: "Trade League", slug: `t-${Math.random()}`, commissionerUserId: ownerA,
      season: SEASON, teamCount: 2, isPublic: true, status: "in_season",
      draftType: "snake", updatedAt: Date.now(),
    });
    await ctx.db.insert("league_rules", { leagueId, ...RULES });
    await ctx.db.insert("league_members", { leagueId, userId: ownerA, role: "commissioner" });
    await ctx.db.insert("league_members", { leagueId, userId: ownerB, role: "owner" });
    await ctx.db.insert("league_members", { leagueId, userId: ownerC, role: "owner" });

    const team = (name: string, ownerUserId: Id<"users">) =>
      ctx.db.insert("teams", {
        leagueId, ownerUserId, name, abbreviation: name.slice(0, 3).toUpperCase(),
        faabRemaining: 100, waiverPriority: 1, karma: 0, draftBudgetRemaining: 200,
      });
    const teamA = await team("Alpha", ownerA);
    const teamB = await team("Bravo", ownerB);

    const player = (fullName: string, position: "QB" | "RB" | "WR") =>
      ctx.db.insert("players", {
        sleeperId: `${fullName}-${Math.random()}`, fullName, position, nflTeam: "SF",
        fantasyPositions: [position], externalIds: {}, updatedAt: Date.now(),
      });
    const rbA = await player("Rick Alpha", "RB");
    const wrA = await player("Wide Alpha", "WR");
    const rbB = await player("Rick Bravo", "RB");
    const wrB = await player("Wide Bravo", "WR");

    const roster = (teamId: Id<"teams">, playerId: Id<"players">) =>
      ctx.db.insert("roster_slots", {
        leagueId, teamId, playerId, acquiredAt: Date.now(), acquiredVia: "draft" as const,
      });
    await roster(teamA, rbA);
    await roster(teamA, wrA);
    await roster(teamB, rbB);
    await roster(teamB, wrB);

    const windowId = await ctx.db.insert("windows", {
      leagueId, type: "trade" as const, label: "trade", weekNo: WEEK, roundNo: 1,
      opensAt: Date.now() - 1000, submissionDeadlineAt: Date.now() + 1000,
      closesAt: Date.now() + 2000, status: "open" as const, scope: {},
      runCount: 0, terminalRunCount: 0,
    });
    const runId = await ctx.db.insert("runs", {
      windowId, leagueId, teamId: teamA, modelId: "mock/scripted",
      kind: "team" as const, status: "running" as const, windowType: "trade" as const,
      windowLabel: "trade", weekNo: WEEK, attempt: 1, lastPersistedStep: -1,
      totalCostUsd: 0, totalInputTokens: 0, totalOutputTokens: 0, stepCount: 0,
      committedActionCount: 0, rejectedActionCount: 0,
    });

    return {
      ownerA, ownerB, ownerC, leagueId, teamA, teamB, rbA, wrA, rbB, wrB, windowId, runId,
      sessionA: await sessionOf(ownerA),
      sessionB: await sessionOf(ownerB),
      sessionC: await sessionOf(ownerC),
    };
  });
}

type TradeSeed = Awaited<ReturnType<typeof seedTrading>>;

function ctxFor(s: TradeSeed, toolCallId: string) {
  return { runId: s.runId, stepIndex: 0, toolCallId, windowId: s.windowId, weekNo: WEEK };
}

/** Dial a player's rest-of-season value through `player_projection_latest`. */
async function setProjection(
  t: SchemaTest,
  playerId: Id<"players">,
  points: number,
  position: "QB" | "RB" | "WR" = "RB",
) {
  await t.run(async (ctx) => {
    const existing = await ctx.db
      .query("player_projection_latest")
      .withIndex("by_playerId_season_week_source", (q) =>
        q
          .eq("playerId", playerId)
          .eq("season", SEASON)
          .eq("week", WEEK)
          .eq("source", "sleeper_rotowire"),
      )
      .unique();
    const row = {
      playerId, season: SEASON, week: WEEK, source: "sleeper_rotowire", position,
      projectedPointsPpr: points, projectedPointsHalf: points, projectedPointsStd: points,
      stats: {}, effectiveAt: Date.now(),
    };
    if (existing) await ctx.db.patch("player_projection_latest", existing._id, row);
    else await ctx.db.insert("player_projection_latest", row);
  });
}

/** A team's roster as sorted player ids (a `Set` is not a Convex value). */
async function rosterOf(t: SchemaTest, teamId: Id<"teams">): Promise<string[]> {
  const ids = await t.run(async (ctx) => {
    const slots = await ctx.db
      .query("roster_slots")
      .withIndex("by_teamId", (q) => q.eq("teamId", teamId))
      .collect();
    return slots.map((slot) => slot.playerId as string);
  });
  return ids.sort();
}

function sortedIds(...ids: Id<"players">[]): string[] {
  return ids.map((id) => id as string).sort();
}

async function eventsOf(t: SchemaTest, tradeId: Id<"trades">) {
  return t.run(async (ctx) => {
    const rows = await ctx.db
      .query("trade_events")
      .withIndex("by_tradeId", (q) => q.eq("tradeId", tradeId))
      .collect();
    return rows.map((r) => r.type);
  });
}

describe("trades.propose", () => {
  test("creates the proposal, opens the thread and posts the offer summary", async () => {
    const t = convexTest(schema, modules);
    const s = await seedTrading(t);

    const result = await t.mutation(internal.trades.propose, {
      leagueId: s.leagueId,
      proposerTeamId: s.teamA,
      toTeamId: s.teamB,
      give: [s.rbA],
      receive: [s.rbB],
      faab: 5,
      message: "Straight RB swap.",
      agentCtx: ctxFor(s, "propose-1"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const state = await t.run(async (ctx) => ({
      trade: await ctx.db.get("trades", result.tradeId),
      thread: await ctx.db.get("threads", result.threadId),
      messages: await ctx.db
        .query("messages")
        .withIndex("by_threadId_createdAt", (q) => q.eq("threadId", result.threadId))
        .collect(),
    }));
    expect(state.trade?.status).toBe("proposed");
    expect(state.trade?.weekNo).toBe(WEEK);
    expect(state.trade?.windowId).toBe(s.windowId);
    expect(state.trade?.createdByRunId).toBe(s.runId);
    expect(state.trade?.vetoCount).toBe(0);
    expect(state.trade?.items).toHaveLength(3); // two players + the FAAB leg
    expect(state.thread?.messageCount).toBe(1);
    expect(state.messages[0].body).toContain("Trade offer to Bravo");
    expect(state.messages[0].body).toContain("Plus $5 FAAB");
    expect(state.messages[0].body).toContain("Straight RB swap.");
    expect(await eventsOf(t, result.tradeId)).toEqual(["proposed"]);
  });

  test("rejects players the two sides do not own, and over-budget FAAB", async () => {
    const t = convexTest(schema, modules);
    const s = await seedTrading(t);

    const wrongRoster = await t.mutation(internal.trades.propose, {
      leagueId: s.leagueId, proposerTeamId: s.teamA, toTeamId: s.teamB,
      give: [s.rbB], receive: [s.rbA], faab: 500,
      agentCtx: ctxFor(s, "bad-1"),
    });
    expect(wrongRoster.ok).toBe(false);
    if (wrongRoster.ok) return;
    expect(wrongRoster.errors).toContain("Not on your roster: Rick Bravo");
    expect(wrongRoster.errors).toContain("Not on Bravo's roster: Rick Alpha");
    expect(wrongRoster.errors).toContain(
      "FAAB offer of $500 exceeds your remaining $100",
    );

    expect(
      await t.mutation(internal.trades.propose, {
        leagueId: s.leagueId, proposerTeamId: s.teamA, toTeamId: s.teamA,
        give: [s.rbA], receive: [s.rbA], agentCtx: ctxFor(s, "bad-2"),
      }),
    ).toEqual({ ok: false, errors: ["A team cannot trade with itself"] });

    const empty = await t.mutation(internal.trades.propose, {
      leagueId: s.leagueId, proposerTeamId: s.teamA, toTeamId: s.teamB,
      give: [s.rbA], receive: [], agentCtx: ctxFor(s, "bad-3"),
    });
    expect(empty).toEqual({
      ok: false,
      errors: ["A trade must move at least one player in each direction"],
    });
  });

  test("enforces the open-proposal cap", async () => {
    const t = convexTest(schema, modules);
    const s = await seedTrading(t);
    await t.run(async (ctx) => {
      const rules = await ctx.db
        .query("league_rules")
        .withIndex("by_leagueId", (q) => q.eq("leagueId", s.leagueId))
        .unique();
      await ctx.db.patch("league_rules", rules!._id, { maxOpenProposals: 1 });
    });

    const first = await t.mutation(internal.trades.propose, {
      leagueId: s.leagueId, proposerTeamId: s.teamA, toTeamId: s.teamB,
      give: [s.rbA], receive: [s.rbB], agentCtx: ctxFor(s, "cap-1"),
    });
    expect(first.ok).toBe(true);

    const second = await t.mutation(internal.trades.propose, {
      leagueId: s.leagueId, proposerTeamId: s.teamA, toTeamId: s.teamB,
      give: [s.wrA], receive: [s.wrB], agentCtx: ctxFor(s, "cap-2"),
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.errors[0]).toMatch(/You already have 1 open proposals \(limit 1\)/);
  });

  test("blocks a player being traded straight back (anti-churn)", async () => {
    const t = convexTest(schema, modules);
    const s = await seedTrading(t);
    // A completed trade inside the horizon already moved Rick Alpha B → A.
    await t.run(async (ctx) => {
      await ctx.db.insert("trades", {
        leagueId: s.leagueId, proposerTeamId: s.teamB, recipientTeamId: s.teamA,
        weekNo: WEEK, status: "completed" as const,
        items: [
          { fromTeamId: s.teamB, toTeamId: s.teamA, playerId: s.rbA },
          { fromTeamId: s.teamA, toTeamId: s.teamB, playerId: s.rbB },
        ],
        flagged: false, vetoCount: 0, approveCount: 0,
      });
    });

    const churned = await t.mutation(internal.trades.propose, {
      leagueId: s.leagueId, proposerTeamId: s.teamA, toTeamId: s.teamB,
      give: [s.rbA], receive: [s.rbB], agentCtx: ctxFor(s, "churn-1"),
    });
    expect(churned.ok).toBe(false);
    if (churned.ok) return;
    expect(churned.errors[0]).toMatch(/Anti-churn: Rick Alpha/);

    // A different player is unaffected.
    const clean = await t.mutation(internal.trades.propose, {
      leagueId: s.leagueId, proposerTeamId: s.teamA, toTeamId: s.teamB,
      give: [s.wrA], receive: [s.wrB], agentCtx: ctxFor(s, "churn-2"),
    });
    expect(clean.ok).toBe(true);
  });

  test("replaying the same (runId, toolCallId) returns the stored result", async () => {
    const t = convexTest(schema, modules);
    const s = await seedTrading(t);
    const args = {
      leagueId: s.leagueId, proposerTeamId: s.teamA, toTeamId: s.teamB,
      give: [s.rbA], receive: [s.rbB], agentCtx: ctxFor(s, "replay"),
    };
    const first = await t.mutation(internal.trades.propose, args);
    const second = await t.mutation(internal.trades.propose, args);
    expect(second).toEqual(first);

    const state = await t.run(async (ctx) => ({
      trades: await ctx.db
        .query("trades")
        .withIndex("by_leagueId", (q) => q.eq("leagueId", s.leagueId))
        .collect(),
      run: await ctx.db.get("runs", s.runId),
    }));
    expect(state.trades).toHaveLength(1);
    expect(state.run?.committedActionCount).toBe(1);
  });
});

describe("trades.respond", () => {
  test("propose → counter → accept → review → complete moves the rosters", async () => {
    const t = convexTest(schema, modules);
    const s = await seedTrading(t);
    await setProjection(t, s.rbA, 10);
    await setProjection(t, s.rbB, 10);
    await setProjection(t, s.wrA, 10, "WR");
    await setProjection(t, s.wrB, 10, "WR");

    const proposed = await t.mutation(internal.trades.propose, {
      leagueId: s.leagueId, proposerTeamId: s.teamA, toTeamId: s.teamB,
      give: [s.rbA], receive: [s.rbB], agentCtx: ctxFor(s, "flow-propose"),
    });
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;

    const countered = await t.mutation(internal.trades.respond, {
      leagueId: s.leagueId, teamId: s.teamB, tradeId: proposed.tradeId, action: "counter",
      counter: { give: [s.wrB], receive: [s.wrA] },
      message: "Wide receivers instead.",
      agentCtx: ctxFor(s, "flow-counter"),
    });
    expect(countered.ok).toBe(true);
    if (!countered.ok) return;
    expect(countered.status).toBe("countered");
    const childId = countered.counterTradeId!;

    const child = await t.run(async (ctx) => ctx.db.get("trades", childId));
    expect(child?.parentTradeId).toBe(proposed.tradeId);
    expect(child?.proposerTeamId).toBe(s.teamB);
    expect(child?.threadId).toBe(proposed.threadId);
    expect(await eventsOf(t, proposed.tradeId)).toEqual(["proposed", "countered"]);
    expect(await eventsOf(t, childId)).toEqual(["countered"]);

    const accepted = await t.mutation(internal.trades.respond, {
      leagueId: s.leagueId, teamId: s.teamA, tradeId: childId, action: "accept",
      agentCtx: ctxFor(s, "flow-accept"),
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.status).toBe("in_review");

    const inReview = await t.run(async (ctx) => ctx.db.get("trades", childId));
    expect(inReview?.status).toBe("in_review");
    expect(inReview?.fairnessScore).toBe(1);
    expect(inReview?.flagged).toBe(false);
    expect(inReview?.reviewEndsAt).toBeGreaterThan(Date.now());
    const detail = inReview?.fairnessDetail as { method: string; items: unknown[] };
    expect(detail.method).toBe("ros_projection_v1");
    expect(detail.items).toHaveLength(2);
    expect(await eventsOf(t, childId)).toEqual(["countered", "accepted", "fairness_scored"]);

    const resolved = await t.mutation(internal.trades.processReviews, {
      leagueId: s.leagueId,
      now: inReview!.reviewEndsAt!,
    });
    expect(resolved).toEqual({ resolved: 1 });

    expect(await rosterOf(t, s.teamA)).toEqual(sortedIds(s.rbA, s.wrB));
    expect(await rosterOf(t, s.teamB)).toEqual(sortedIds(s.rbB, s.wrA));

    const done = await t.run(async (ctx) => ({
      trade: await ctx.db.get("trades", childId),
      transactions: await ctx.db
        .query("transactions")
        .withIndex("by_tradeId", (q) => q.eq("tradeId", childId))
        .collect(),
      messages: await ctx.db
        .query("messages")
        .withIndex("by_threadId_createdAt", (q) => q.eq("threadId", proposed.threadId))
        .collect(),
    }));
    expect(done.trade?.status).toBe("completed");
    expect(done.trade?.resolvedAt).toBeGreaterThan(0);
    expect(done.transactions).toHaveLength(2);
    expect(done.transactions.every((row) => row.type === "trade")).toBe(true);
    expect(done.messages.at(-1)?.body).toBe("Trade completed — rosters updated.");
    expect(await eventsOf(t, childId)).toEqual([
      "countered", "accepted", "fairness_scored", "completed",
    ]);
  });

  test("an unlocked completed swap moves active starters and scoring to the receiving teams", async () => {
    const t = convexTest(schema, modules);
    const s = await seedTrading(t);
    const { qbA, qbB } = await t.run(async (ctx) => {
      const makeQb = async (name: string, sleeperId: string, points: number) => {
        const playerId = await ctx.db.insert("players", {
          sleeperId, fullName: name, position: "QB", nflTeam: "SF",
          fantasyPositions: ["QB"], externalIds: {}, updatedAt: Date.now(),
        });
        await ctx.db.insert("player_stats_weekly", {
          playerId, season: SEASON, week: WEEK, source: "sleeper", stats: {},
          fantasyPointsPpr: points, fantasyPointsHalf: points, fantasyPointsStd: points,
          effectiveAt: Date.now(),
        });
        return playerId;
      };
      const qbA = await makeQb("Quarterback Alpha", "qa-qb-a", 31);
      const qbB = await makeQb("Quarterback Bravo", "qa-qb-b", 7);
      for (const [teamId, playerId] of [[s.teamA, qbA], [s.teamB, qbB]] as const) {
        await ctx.db.insert("roster_slots", {
          leagueId: s.leagueId, teamId, playerId, acquiredAt: Date.now(), acquiredVia: "draft",
        });
        await ctx.db.insert("lineups", {
          leagueId: s.leagueId, teamId, weekNo: WEEK, version: 1,
          slots: [{ slot: "QB", playerId }], source: "agent",
        });
      }
      return { qbA, qbB };
    });
    await setProjection(t, qbA, 10, "QB");
    await setProjection(t, qbB, 10, "QB");
    await t.mutation(internal.standings.generateSchedule, { leagueId: s.leagueId });

    const proposed = await t.mutation(internal.trades.propose, {
      leagueId: s.leagueId, proposerTeamId: s.teamA, toTeamId: s.teamB,
      give: [qbA], receive: [qbB], agentCtx: ctxFor(s, "unlocked-score-propose"),
    });
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    const accepted = await t.mutation(internal.trades.respond, {
      leagueId: s.leagueId, teamId: s.teamB, tradeId: proposed.tradeId, action: "accept",
      agentCtx: ctxFor(s, "unlocked-score-accept"),
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    const review = await t.run(async (ctx) => ctx.db.get("trades", proposed.tradeId));
    await t.mutation(internal.trades.processReviews, {
      leagueId: s.leagueId, now: review!.reviewEndsAt!,
    });
    const completed = await t.run(async (ctx) => {
      const events = await ctx.db
        .query("trade_events")
        .withIndex("by_tradeId", (q) => q.eq("tradeId", proposed.tradeId))
        .collect();
      return events.find((event) => event.type === "completed");
    });
    expect(completed?.payload).toMatchObject({ lockedPlayerIds: [] });

    await t.mutation(internal.scoring.scoreLeague, { leagueId: s.leagueId, weekNo: WEEK });
    const scores = await t.run(async (ctx) => {
      const matchup = await ctx.db
        .query("matchups")
        .withIndex("by_leagueId_weekNo", (q) =>
          q.eq("leagueId", s.leagueId).eq("weekNo", WEEK),
        )
        .first();
      const lineupA = await ctx.db
        .query("lineups")
        .withIndex("by_teamId_weekNo_version", (q) => q.eq("teamId", s.teamA).eq("weekNo", WEEK))
        .order("desc")
        .first();
      const lineupB = await ctx.db
        .query("lineups")
        .withIndex("by_teamId_weekNo_version", (q) => q.eq("teamId", s.teamB).eq("weekNo", WEEK))
        .order("desc")
        .first();
      if (!matchup) return null;
      const points = matchup.homeTeamId === s.teamA
        ? { teamA: matchup.homeScore, teamB: matchup.awayScore }
        : { teamA: matchup.awayScore, teamB: matchup.homeScore };
      return {
        ...points,
        starterA: lineupA?.slots.find((slot) => slot.slot === "QB")?.playerId,
        starterB: lineupB?.slots.find((slot) => slot.slot === "QB")?.playerId,
      };
    });

    expect(scores).toEqual({ teamA: 7, teamB: 31, starterA: qbB, starterB: qbA });
  });

  test("a completed swap preserves historical starter IDs when both players are locked", async () => {
    const t = convexTest(schema, modules);
    const s = await seedTrading(t);
    const { qbA, qbB, tradeId, reviewEndsAt } = await t.run(async (ctx) => {
      const makeQb = (name: string) =>
        ctx.db.insert("players", {
          sleeperId: name, fullName: name, position: "QB", nflTeam: "SF",
          fantasyPositions: ["QB"], externalIds: {}, updatedAt: Date.now(),
        });
      const qbA = await makeQb("Locked Alpha");
      const qbB = await makeQb("Locked Bravo");
      for (const [teamId, playerId] of [[s.teamA, qbA], [s.teamB, qbB]] as const) {
        await ctx.db.insert("roster_slots", {
          leagueId: s.leagueId, teamId, playerId, acquiredAt: Date.now(), acquiredVia: "draft",
        });
        await ctx.db.insert("lineups", {
          leagueId: s.leagueId, teamId, weekNo: WEEK, version: 1,
          slots: [{ slot: "QB", playerId }], source: "agent",
        });
      }
      await ctx.db.insert("nfl_games", {
        season: SEASON, week: WEEK, gameId: "locked-game", homeTeam: "SF", awayTeam: "SEA",
        kickoffAt: Date.now() - 60_000, status: "in_progress",
      });
      const reviewEndsAt = Date.now();
      const tradeId = await ctx.db.insert("trades", {
        leagueId: s.leagueId, proposerTeamId: s.teamA, recipientTeamId: s.teamB,
        weekNo: WEEK, status: "in_review", reviewEndsAt,
        items: [
          { fromTeamId: s.teamA, toTeamId: s.teamB, playerId: qbA },
          { fromTeamId: s.teamB, toTeamId: s.teamA, playerId: qbB },
        ],
        flagged: false, vetoCount: 0, approveCount: 0,
      });
      return { qbA, qbB, tradeId, reviewEndsAt };
    });

    expect(
      await t.mutation(internal.trades.processReviews, {
        leagueId: s.leagueId, now: reviewEndsAt,
      }),
    ).toEqual({ resolved: 1 });
    const state = await t.run(async (ctx) => {
      const lineupA = await ctx.db
        .query("lineups")
        .withIndex("by_teamId_weekNo_version", (q) => q.eq("teamId", s.teamA).eq("weekNo", WEEK))
        .order("desc")
        .first();
      const lineupB = await ctx.db
        .query("lineups")
        .withIndex("by_teamId_weekNo_version", (q) => q.eq("teamId", s.teamB).eq("weekNo", WEEK))
        .order("desc")
        .first();
      const events = await ctx.db
        .query("trade_events")
        .withIndex("by_tradeId", (q) => q.eq("tradeId", tradeId))
        .collect();
      return { lineupA, lineupB, completed: events.find((event) => event.type === "completed") };
    });
    expect(state.lineupA).toMatchObject({ version: 1, slots: [{ slot: "QB", playerId: qbA }] });
    expect(state.lineupB).toMatchObject({ version: 1, slots: [{ slot: "QB", playerId: qbB }] });
    expect(state.completed?.payload).toMatchObject({ lockedPlayerIds: [qbA, qbB] });
  });

  test.each([
    { label: "before the weekly deadline", offset: -1, repaired: 2 },
    { label: "at the weekly deadline", offset: 0, repaired: 0 },
    { label: "after the weekly deadline", offset: 86_400_000, repaired: 0 },
  ])("repairs legacy transferred starters $label", async ({ offset, repaired }) => {
    const t = convexTest(schema, modules);
    const s = await seedTrading(t);
    const weekStartsAt = Date.parse("2030-09-10T10:00:00Z");
    const deadline = weeklyLineupDeadline(weekStartsAt);
    const { qbA, qbB } = await t.run(async (ctx) => {
      await ctx.db.insert("weeks", {
        leagueId: s.leagueId, weekNo: WEEK, startsAt: weekStartsAt,
        endsAt: weekStartsAt + 7 * 86_400_000, isPlayoff: false, status: "active",
      });
      const qbA = await ctx.db.insert("players", {
        sleeperId: `repair-a-${offset}`, fullName: "Repair Alpha", position: "QB",
        nflTeam: "SF", fantasyPositions: ["QB"], externalIds: {}, updatedAt: Date.now(),
      });
      const qbB = await ctx.db.insert("players", {
        sleeperId: `repair-b-${offset}`, fullName: "Repair Bravo", position: "QB",
        nflTeam: "SEA", fantasyPositions: ["QB"], externalIds: {}, updatedAt: Date.now(),
      });
      // This is the persisted shape left by the old completion path: rosters
      // moved, while the active lineup still references each outgoing player.
      await ctx.db.insert("roster_slots", {
        leagueId: s.leagueId, teamId: s.teamA, playerId: qbB,
        acquiredAt: deadline - 1_000, acquiredVia: "trade",
      });
      await ctx.db.insert("roster_slots", {
        leagueId: s.leagueId, teamId: s.teamB, playerId: qbA,
        acquiredAt: deadline - 1_000, acquiredVia: "trade",
      });
      await ctx.db.insert("lineups", {
        leagueId: s.leagueId, teamId: s.teamA, weekNo: WEEK, version: 1,
        slots: [{ slot: "QB", playerId: qbA }], source: "agent",
      });
      await ctx.db.insert("lineups", {
        leagueId: s.leagueId, teamId: s.teamB, weekNo: WEEK, version: 1,
        slots: [{ slot: "QB", playerId: qbB }], source: "agent",
      });
      await ctx.db.insert("trades", {
        leagueId: s.leagueId, proposerTeamId: s.teamA, recipientTeamId: s.teamB,
        weekNo: WEEK, status: "completed", resolvedAt: deadline - 1_000,
        items: [
          { fromTeamId: s.teamA, toTeamId: s.teamB, playerId: qbA },
          { fromTeamId: s.teamB, toTeamId: s.teamA, playerId: qbB },
        ],
        flagged: false, vetoCount: 0, approveCount: 0,
      });
      return { qbA, qbB };
    });

    expect(await t.mutation(internal.trades.repairTransferredLineups, {
      leagueId: s.leagueId, weekNo: WEEK, now: deadline + offset,
    })).toEqual({ tradesInspected: 1, lineupsRepaired: repaired });
    const lineups = await t.run(async (ctx) => Promise.all([s.teamA, s.teamB].map((teamId) =>
      ctx.db.query("lineups")
        .withIndex("by_teamId_weekNo_version", (q) => q.eq("teamId", teamId).eq("weekNo", WEEK))
        .order("desc").first(),
    )));
    expect(lineups[0]?.slots[0]?.playerId).toBe(repaired ? qbB : qbA);
    expect(lineups[1]?.slots[0]?.playerId).toBe(repaired ? qbA : qbB);
    if (repaired) {
      expect(await t.mutation(internal.trades.repairTransferredLineups, {
        leagueId: s.leagueId, weekNo: WEEK, now: deadline - 1,
      })).toEqual({ tradesInspected: 1, lineupsRepaired: 0 });
    }
  });

  test("settles FAAB on completion", async () => {
    const t = convexTest(schema, modules);
    const s = await seedTrading(t);
    const proposed = await t.mutation(internal.trades.propose, {
      leagueId: s.leagueId, proposerTeamId: s.teamA, toTeamId: s.teamB,
      give: [s.rbA], receive: [s.rbB], faab: 30, agentCtx: ctxFor(s, "faab-propose"),
    });
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    await t.mutation(internal.trades.respond, {
      leagueId: s.leagueId, teamId: s.teamB, tradeId: proposed.tradeId, action: "accept",
      agentCtx: ctxFor(s, "faab-accept"),
    });
    const trade = await t.run(async (ctx) => ctx.db.get("trades", proposed.tradeId));
    await t.mutation(internal.trades.processReviews, {
      leagueId: s.leagueId, now: trade!.reviewEndsAt!,
    });

    const teams = await t.run(async (ctx) => ({
      a: await ctx.db.get("teams", s.teamA),
      b: await ctx.db.get("teams", s.teamB),
    }));
    expect(teams.a?.faabRemaining).toBe(70);
    expect(teams.b?.faabRemaining).toBe(130);
  });

  test("only the recipient may answer, and only while the offer is open", async () => {
    const t = convexTest(schema, modules);
    const s = await seedTrading(t);
    const proposed = await t.mutation(internal.trades.propose, {
      leagueId: s.leagueId, proposerTeamId: s.teamA, toTeamId: s.teamB,
      give: [s.rbA], receive: [s.rbB], agentCtx: ctxFor(s, "guard-propose"),
    });
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;

    expect(
      await t.mutation(internal.trades.respond, {
        leagueId: s.leagueId, teamId: s.teamA, tradeId: proposed.tradeId, action: "accept",
        agentCtx: ctxFor(s, "guard-wrong-side"),
      }),
    ).toEqual({ ok: false, errors: ["Only the recipient can respond to this proposal"] });

    const rejected = await t.mutation(internal.trades.respond, {
      leagueId: s.leagueId, teamId: s.teamB, tradeId: proposed.tradeId, action: "reject",
      message: "No thanks.", agentCtx: ctxFor(s, "guard-reject"),
    });
    expect(rejected.ok).toBe(true);

    expect(
      await t.mutation(internal.trades.respond, {
        leagueId: s.leagueId, teamId: s.teamB, tradeId: proposed.tradeId, action: "accept",
        agentCtx: ctxFor(s, "guard-late"),
      }),
    ).toEqual({ ok: false, errors: ["This proposal is rejected and cannot be answered"] });
  });

  test("cancels rather than corrupts when a roster moved after acceptance", async () => {
    const t = convexTest(schema, modules);
    const s = await seedTrading(t);
    const proposed = await t.mutation(internal.trades.propose, {
      leagueId: s.leagueId, proposerTeamId: s.teamA, toTeamId: s.teamB,
      give: [s.rbA], receive: [s.rbB], agentCtx: ctxFor(s, "stale-propose"),
    });
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    await t.mutation(internal.trades.respond, {
      leagueId: s.leagueId, teamId: s.teamB, tradeId: proposed.tradeId, action: "accept",
      agentCtx: ctxFor(s, "stale-accept"),
    });

    // Rick Alpha is dropped between acceptance and completion.
    await t.run(async (ctx) => {
      const slot = await ctx.db
        .query("roster_slots")
        .withIndex("by_teamId_playerId", (q) =>
          q.eq("teamId", s.teamA).eq("playerId", s.rbA),
        )
        .unique();
      await ctx.db.delete("roster_slots", slot!._id);
    });

    const trade = await t.run(async (ctx) => ctx.db.get("trades", proposed.tradeId));
    await t.mutation(internal.trades.processReviews, {
      leagueId: s.leagueId, now: trade!.reviewEndsAt!,
    });
    const after = await t.run(async (ctx) => ctx.db.get("trades", proposed.tradeId));
    expect(after?.status).toBe("cancelled");
    expect(await eventsOf(t, proposed.tradeId)).toContain("invalidated");
    // The other side's roster was left alone.
    expect(await rosterOf(t, s.teamB)).toEqual(sortedIds(s.rbB, s.wrB));
  });

  test("a locked player still moves; the swap is recorded as locked", async () => {
    const t = convexTest(schema, modules);
    const s = await seedTrading(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("nfl_games", {
        season: SEASON, week: WEEK, gameId: `g-${Math.random()}`,
        homeTeam: "SF", awayTeam: "SEA", kickoffAt: Date.now() - 60_000, status: "in_progress",
      });
    });
    const proposed = await t.mutation(internal.trades.propose, {
      leagueId: s.leagueId, proposerTeamId: s.teamA, toTeamId: s.teamB,
      give: [s.rbA], receive: [s.rbB], agentCtx: ctxFor(s, "lock-propose"),
    });
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    await t.mutation(internal.trades.respond, {
      leagueId: s.leagueId, teamId: s.teamB, tradeId: proposed.tradeId, action: "accept",
      agentCtx: ctxFor(s, "lock-accept"),
    });
    const trade = await t.run(async (ctx) => ctx.db.get("trades", proposed.tradeId));
    await t.mutation(internal.trades.processReviews, {
      leagueId: s.leagueId, now: trade!.reviewEndsAt!,
    });

    const after = await t.run(async (ctx) => ({
      trade: await ctx.db.get("trades", proposed.tradeId),
      transactions: await ctx.db
        .query("transactions")
        .withIndex("by_tradeId", (q) => q.eq("tradeId", proposed.tradeId))
        .collect(),
    }));
    expect(after.trade?.status).toBe("completed");
    expect(after.transactions.every((row) => row.details?.locked === true)).toBe(true);
    expect(await rosterOf(t, s.teamA)).toEqual(sortedIds(s.rbB, s.wrA));
  });
});

describe("trades fairness", () => {
  test("is monotonic and honours the league's floor", async () => {
    const t = convexTest(schema, modules);
    const s = await seedTrading(t);
    await setProjection(t, s.rbA, 4);
    await setProjection(t, s.wrA, 4, "WR");
    await setProjection(t, s.rbB, 20);

    const thin = await t.query(internal.trades.scoreProposal, {
      leagueId: s.leagueId, proposerTeamId: s.teamA, recipientTeamId: s.teamB,
      weekNo: WEEK, give: [s.rbA], receive: [s.rbB],
    });
    const fatter = await t.query(internal.trades.scoreProposal, {
      leagueId: s.leagueId, proposerTeamId: s.teamA, recipientTeamId: s.teamB,
      weekNo: WEEK, give: [s.rbA, s.wrA], receive: [s.rbB],
    });
    const withFaab = await t.query(internal.trades.scoreProposal, {
      leagueId: s.leagueId, proposerTeamId: s.teamA, recipientTeamId: s.teamB,
      weekNo: WEEK, give: [s.rbA, s.wrA], receive: [s.rbB], faab: 20,
    });
    expect(fatter.score).toBeGreaterThan(thin.score);
    expect(withFaab.score).toBeGreaterThan(fatter.score);
    expect(withFaab.detail.faabPoints).toBeGreaterThan(0);

    // The thin side is well under the default 0.6 floor.
    expect(thin.flagged).toBe(true);
    expect(thin.detail.floor).toBe(0.6);
    expect(thin.detail.method).toBe("ros_projection_v1");
    // Rest-of-season = this week's projection × the weeks that remain.
    expect(thin.detail.items.find((i) => i.playerId === s.rbB)?.baseRos).toBe(
      20 * REMAINING_WEEKS,
    );

    // An even swap clears the default floor but not a strict one.
    await setProjection(t, s.rbA, 20);
    const even = await t.query(internal.trades.scoreProposal, {
      leagueId: s.leagueId, proposerTeamId: s.teamA, recipientTeamId: s.teamB,
      weekNo: WEEK, give: [s.rbA], receive: [s.rbB],
    });
    expect(even.score).toBe(1);
    expect(even.flagged).toBe(false);

    await t.run(async (ctx) => {
      const rules = await ctx.db
        .query("league_rules")
        .withIndex("by_leagueId", (q) => q.eq("leagueId", s.leagueId))
        .unique();
      await ctx.db.patch("league_rules", rules!._id, { fairnessFloor: 0.95 });
    });
    const strict = await t.query(internal.trades.scoreProposal, {
      leagueId: s.leagueId, proposerTeamId: s.teamA, recipientTeamId: s.teamB,
      weekNo: WEEK, give: [s.rbA, s.wrA], receive: [s.rbB],
    });
    expect(strict.detail.floor).toBe(0.95);
    expect(strict.flagged).toBe(true);
  });

  test("scores a trade with no projection data as neutral rather than flagged", async () => {
    const t = convexTest(schema, modules);
    const s = await seedTrading(t);
    const result = await t.query(internal.trades.scoreProposal, {
      leagueId: s.leagueId, proposerTeamId: s.teamA, recipientTeamId: s.teamB,
      weekNo: WEEK, give: [s.rbA], receive: [s.rbB],
    });
    expect(result.score).toBe(1);
    expect(result.flagged).toBe(false);
    expect(result.detail.notes.join(" ")).toMatch(/no projection data/i);
  });
});

describe("trades.castVeto and the veto flow", () => {
  test("a majority veto blocks a flagged trade at the end of review", async () => {
    const t = convexTest(schema, modules);
    const s = await seedTrading(t);
    // Lopsided: Alpha sends a 1-point RB for a 20-point RB.
    await setProjection(t, s.rbA, 1);
    await setProjection(t, s.rbB, 20);

    const proposed = await t.mutation(internal.trades.propose, {
      leagueId: s.leagueId, proposerTeamId: s.teamA, toTeamId: s.teamB,
      give: [s.rbA], receive: [s.rbB], agentCtx: ctxFor(s, "veto-propose"),
    });
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    await t.mutation(internal.trades.respond, {
      leagueId: s.leagueId, teamId: s.teamB, tradeId: proposed.tradeId, action: "accept",
      agentCtx: ctxFor(s, "veto-accept"),
    });

    const flagged = await t.run(async (ctx) => ctx.db.get("trades", proposed.tradeId));
    expect(flagged?.flagged).toBe(true);

    const asA = t.withIdentity({ subject: `${s.ownerA}|${s.sessionA}` });
    const asB = t.withIdentity({ subject: `${s.ownerB}|${s.sessionB}` });
    const asC = t.withIdentity({ subject: `${s.ownerC}|${s.sessionC}` });

    const one = await asA.mutation(api.trades.castVeto, {
      leagueId: s.leagueId, tradeId: proposed.tradeId, vote: "veto",
    });
    expect(one).toEqual({
      ok: true, vetoes: 1, approvals: 0, ownerCount: 3, threshold: 2, blocked: false,
    });

    await asC.mutation(api.trades.castVeto, {
      leagueId: s.leagueId, tradeId: proposed.tradeId, vote: "approve",
    });
    // Changing a vote replaces it rather than adding one.
    const two = await asC.mutation(api.trades.castVeto, {
      leagueId: s.leagueId, tradeId: proposed.tradeId, vote: "veto",
    });
    expect(two.vetoes).toBe(2);
    expect(two.approvals).toBe(0);
    expect(two.blocked).toBe(true);

    const counters = await t.run(async (ctx) => ctx.db.get("trades", proposed.tradeId));
    expect(counters?.vetoCount).toBe(2);
    expect(counters?.approveCount).toBe(0);

    await asB.mutation(api.trades.castVeto, {
      leagueId: s.leagueId, tradeId: proposed.tradeId, vote: "approve",
    });

    await t.mutation(internal.trades.processReviews, {
      leagueId: s.leagueId, now: counters!.reviewEndsAt!,
    });
    const after = await t.run(async (ctx) => ctx.db.get("trades", proposed.tradeId));
    expect(after?.status).toBe("vetoed");
    // Rosters untouched.
    expect(await rosterOf(t, s.teamA)).toEqual(sortedIds(s.rbA, s.wrA));
  });

  test("a flagged trade nobody blocks still completes", async () => {
    const t = convexTest(schema, modules);
    const s = await seedTrading(t);
    await setProjection(t, s.rbA, 1);
    await setProjection(t, s.rbB, 20);
    const proposed = await t.mutation(internal.trades.propose, {
      leagueId: s.leagueId, proposerTeamId: s.teamA, toTeamId: s.teamB,
      give: [s.rbA], receive: [s.rbB], agentCtx: ctxFor(s, "pass-propose"),
    });
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    await t.mutation(internal.trades.respond, {
      leagueId: s.leagueId, teamId: s.teamB, tradeId: proposed.tradeId, action: "accept",
      agentCtx: ctxFor(s, "pass-accept"),
    });
    const trade = await t.run(async (ctx) => ctx.db.get("trades", proposed.tradeId));
    const asA = t.withIdentity({ subject: `${s.ownerA}|${s.sessionA}` });
    await asA.mutation(api.trades.castVeto, {
      leagueId: s.leagueId, tradeId: proposed.tradeId, vote: "veto",
    });

    await t.mutation(internal.trades.processReviews, {
      leagueId: s.leagueId, now: trade!.reviewEndsAt!,
    });
    const after = await t.run(async (ctx) => ctx.db.get("trades", proposed.tradeId));
    expect(after?.status).toBe("completed");
  });

  test("voting is member-only and closed outside review", async () => {
    const t = convexTest(schema, modules);
    const s = await seedTrading(t);
    const proposed = await t.mutation(internal.trades.propose, {
      leagueId: s.leagueId, proposerTeamId: s.teamA, toTeamId: s.teamB,
      give: [s.rbA], receive: [s.rbB], agentCtx: ctxFor(s, "auth-propose"),
    });
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;

    await expect(
      t.mutation(api.trades.castVeto, {
        leagueId: s.leagueId, tradeId: proposed.tradeId, vote: "veto",
      }),
    ).rejects.toThrow(/Sign in/);

    const asA = t.withIdentity({ subject: `${s.ownerA}|${s.sessionA}` });
    await expect(
      asA.mutation(api.trades.castVeto, {
        leagueId: s.leagueId, tradeId: proposed.tradeId, vote: "veto",
      }),
    ).rejects.toThrow(/voting is closed/);

    // A spectator may watch but not vote.
    const spectator = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { email: `spec-${Math.random()}@x.dev` });
      await ctx.db.insert("league_members", {
        leagueId: s.leagueId, userId, role: "spectator" as const,
      });
      const sessionId = await ctx.db.insert("authSessions", {
        userId, expirationTime: Date.now() + 86_400_000,
      });
      return { userId, sessionId };
    });
    await t.mutation(internal.trades.respond, {
      leagueId: s.leagueId, teamId: s.teamB, tradeId: proposed.tradeId, action: "accept",
      agentCtx: ctxFor(s, "auth-accept"),
    });
    const asSpectator = t.withIdentity({
      subject: `${spectator.userId}|${spectator.sessionId}`,
    });
    await expect(
      asSpectator.mutation(api.trades.castVeto, {
        leagueId: s.leagueId, tradeId: proposed.tradeId, vote: "veto",
      }),
    ).rejects.toThrow(/Only league owners may vote/);
  });
});

describe("trades.expireForWindow", () => {
  test("expires the offers left open when the window closes", async () => {
    const t = convexTest(schema, modules);
    const s = await seedTrading(t);
    const open = await t.mutation(internal.trades.propose, {
      leagueId: s.leagueId, proposerTeamId: s.teamA, toTeamId: s.teamB,
      give: [s.rbA], receive: [s.rbB], agentCtx: ctxFor(s, "expire-1"),
    });
    expect(open.ok).toBe(true);
    if (!open.ok) return;
    const settled = await t.mutation(internal.trades.propose, {
      leagueId: s.leagueId, proposerTeamId: s.teamA, toTeamId: s.teamB,
      give: [s.wrA], receive: [s.wrB], agentCtx: ctxFor(s, "expire-2"),
    });
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    await t.mutation(internal.trades.respond, {
      leagueId: s.leagueId, teamId: s.teamB, tradeId: settled.tradeId, action: "reject",
      agentCtx: ctxFor(s, "expire-reject"),
    });

    expect(await t.mutation(internal.trades.expireForWindow, { windowId: s.windowId })).toEqual(
      { expired: 1 },
    );
    const after = await t.run(async (ctx) => ({
      open: await ctx.db.get("trades", open.tradeId),
      settled: await ctx.db.get("trades", settled.tradeId),
    }));
    expect(after.open?.status).toBe("expired");
    expect(after.open?.resolvedAt).toBeGreaterThan(0);
    expect(after.settled?.status).toBe("rejected");
    expect(await eventsOf(t, open.tradeId)).toEqual(["proposed", "expired"]);
  });
});
