/**
 * `convex/trades.ts` — feed filters, detail tally and the agent inbox query.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import type { TradeSummary } from "./trades";

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
