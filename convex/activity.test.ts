/**
 * The activity feed merges roster moves, trades, Commons posts, negotiation
 * messages and rule changes into one stream. The cases that matter: the merge
 * order, a waiver claim's add and drop collapsing into one move, a trade
 * appearing twice (proposed, resolved), filters, the page bound, and message
 * bodies withheld under delayed transparency for anyone who is not a party.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema";
import type { ActivityCursor, ActivityItem } from "./activity";

const modules = import.meta.glob("./**/*.ts");

const NOW = Date.now();
const HOUR = 3_600_000;

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
  transparencyMode: "delayed" as const,
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
    const userId = await ctx.db.insert("users", { email: "owner@x.dev" });
    const sessionId = await ctx.db.insert("authSessions", { userId, expirationTime: NOW + 86_400_000 });
    const leagueId = await ctx.db.insert("leagues", {
      name: "Feed League",
      slug: `f-${Math.random()}`,
      commissionerUserId: userId,
      season: 2026,
      teamCount: 2,
      isPublic: true,
      status: "in_season",
      draftType: "snake",
      updatedAt: NOW,
    });
    await ctx.db.insert("league_rules", { leagueId, ...RULES });
    // An owner, not the commissioner: the delayed-transparency rule only exempts parties.
    await ctx.db.insert("league_members", { leagueId, userId, role: "owner" });
    await ctx.db.insert("weeks", {
      leagueId,
      weekNo: 1,
      startsAt: NOW - 86_400_000,
      endsAt: NOW + 6 * 86_400_000,
      isPlayoff: false,
      status: "active",
    });
    const team = (name: string, ownerUserId?: typeof userId) =>
      ctx.db.insert("teams", {
        leagueId,
        ownerUserId,
        name,
        abbreviation: name.slice(0, 3).toUpperCase(),
        faabRemaining: 90,
        waiverPriority: 1,
        karma: 0,
        draftBudgetRemaining: 200,
      });
    const alpha = await team("Alpha", userId);
    const bravo = await team("Bravo");
    const charlie = await team("Charlie");
    const player = (name: string, position: "QB" | "RB" | "WR") =>
      ctx.db.insert("players", {
        sleeperId: name.toLowerCase(),
        fullName: name,
        position,
        nflTeam: "KC",
        fantasyPositions: [position],
        externalIds: {},
        updatedAt: NOW,
      });
    const qb = await player("Quinn Back", "QB");
    const rb = await player("Rick Runner", "RB");
    const wr = await player("Wes Wide", "WR");

    // A processed waiver claim: drop then add sharing a claimId.
    await ctx.db.insert("transactions", {
      leagueId,
      teamId: alpha,
      type: "drop",
      weekNo: 1,
      playerId: rb,
      details: { source: "waiver", claimId: "claim-1" },
    });
    await ctx.db.insert("transactions", {
      leagueId,
      teamId: alpha,
      type: "add",
      weekNo: 1,
      playerId: wr,
      details: { source: "waiver", claimId: "claim-1", bid: 12 },
    });
    // A standalone agent drop.
    await ctx.db.insert("transactions", {
      leagueId,
      teamId: bravo,
      type: "drop",
      weekNo: 1,
      playerId: qb,
      details: { source: "agent_drop" },
    });

    // A completed trade: proposed at creation, resolved a minute later
    // (convex-test stamps `_creationTime` with the wall clock).
    const windowId = await ctx.db.insert("windows", {
      leagueId,
      type: "trade",
      label: "trade_wk1",
      weekNo: 1,
      roundNo: 1,
      opensAt: NOW - 2 * HOUR,
      submissionDeadlineAt: NOW + HOUR,
      closesAt: NOW + HOUR,
      status: "open",
      scope: {},
      runCount: 0,
      terminalRunCount: 0,
    });
    const threadId = await ctx.db.insert("threads", {
      leagueId,
      teamAId: bravo < charlie ? bravo : charlie,
      teamBId: bravo < charlie ? charlie : bravo,
      createdInWindowId: windowId,
      messageCount: 1,
      lastMessageAt: NOW - 30 * 60_000,
    });
    const tradeId = await ctx.db.insert("trades", {
      leagueId,
      proposerTeamId: bravo,
      recipientTeamId: charlie,
      threadId,
      weekNo: 1,
      status: "completed",
      items: [
        { fromTeamId: bravo, toTeamId: charlie, playerId: qb },
        { fromTeamId: charlie, toTeamId: bravo, faab: 5 },
      ],
      flagged: false,
      fairnessScore: 0.9,
      resolvedAt: NOW + 60_000,
      vetoCount: 0,
      approveCount: 0,
    });
    // Bravo and Charlie are still negotiating in an open window.
    await ctx.db.insert("trades", {
      leagueId,
      proposerTeamId: charlie,
      recipientTeamId: bravo,
      threadId,
      weekNo: 1,
      status: "proposed",
      items: [{ fromTeamId: charlie, toTeamId: bravo, playerId: wr }],
      flagged: false,
      vetoCount: 0,
      approveCount: 0,
    });
    await ctx.db.insert("messages", {
      threadId,
      leagueId,
      senderTeamId: bravo,
      body: "Take the QB and five bucks.",
      createdAt: NOW - 30 * 60_000,
    });

    await ctx.db.insert("forum_posts", {
      leagueId,
      teamId: alpha,
      title: "Hot take",
      body: "…",
      flair: "trash_talk",
      score: 3,
      commentCount: 1,
      hidden: false,
      createdAt: NOW - 10 * 60_000,
    });
    await ctx.db.insert("forum_posts", {
      leagueId,
      teamId: alpha,
      title: "Removed",
      body: "…",
      flair: "trash_talk",
      score: 0,
      commentCount: 0,
      hidden: true,
      createdAt: NOW - 5 * 60_000,
    });

    await ctx.db.insert("league_rule_changes", {
      leagueId,
      userId,
      field: "tradeReviewHours",
      fromValue: 24,
      toValue: 48,
      createdAt: NOW - 3 * HOUR,
    });

    return { leagueId, userId, sessionId, alpha, bravo, charlie, tradeId, threadId };
  });
}

describe("activity.feed", () => {
  test("pages beyond one hundred equal-time posts without skips, duplicates, or hidden rows", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run(async (ctx) => {
      for (let index = 0; index < 147; index += 1) {
        await ctx.db.insert("forum_posts", {
          leagueId: s.leagueId, teamId: s.alpha, title: `Post ${index}`, body: "Activity pagination fixture",
          flair: "analysis", score: 0, commentCount: 0, hidden: index >= 137, createdAt: NOW,
        });
      }
    });
    const seen: ActivityItem[] = [];
    let before: ActivityCursor | undefined;
    for (let pageNo = 0; pageNo < 10; pageNo += 1) {
      const page = await t.query(api.activity.feed, { leagueId: s.leagueId, filter: "commons", limit: 40, ...(before ? { before } : {}) });
      seen.push(...page.items);
      if (!page.hasMore) break;
      expect(page.nextCursor).not.toBeNull();
      before = page.nextCursor!;
      if (pageNo === 0) {
        await t.run((ctx) => ctx.db.insert("forum_posts", {
          leagueId: s.leagueId, title: "New arrival", body: "Arrived during paging", flair: "analysis",
          score: 0, commentCount: 0, hidden: false, createdAt: NOW + 1,
        }));
      }
    }
    expect(seen).toHaveLength(138); // 137 new visible rows plus the original Hot take.
    expect(new Set(seen.map((item) => item.id)).size).toBe(138);
    expect(seen.some((item) => item.kind === "post" && item.title === "New arrival")).toBe(false);
    const refreshed = await t.query(api.activity.feed, { leagueId: s.leagueId, filter: "commons" });
    expect(refreshed.items[0]).toMatchObject({ title: "New arrival" });
  });

  test("one-event pages preserve paired waiver drops and commissioner ownership names", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.patch("users", s.userId, { name: "Alex Owner" });
      await ctx.db.insert("league_rule_changes", { leagueId: s.leagueId, field: "team.Alpha.owner", toValue: s.userId });
    });
    const all = await t.query(api.activity.feed, { leagueId: s.leagueId });
    expect(all.items.find((item) => item.kind === "rule_change" && item.field.includes("owner")))
      .toMatchObject({ field: "the owner of Alpha", fromValue: "Unassigned", toValue: "Alex Owner" });
    const first = await t.query(api.activity.feed, { leagueId: s.leagueId, filter: "moves", limit: 1 });
    expect(first.items[0]).toMatchObject({ kind: "drop", team: { name: "Bravo" } });
    const next = await t.query(api.activity.feed, { leagueId: s.leagueId, filter: "moves", limit: 1, before: first.nextCursor! });
    expect(next.items[0]).toMatchObject({ kind: "add", dropped: { name: "Rick Runner" } });
    expect(next.hasMore).toBe(false);
    expect(next.nextCursor).toBeNull();
  });
  test("merges every source newest first and collapses a waiver claim into one move", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const feed = await t.query(api.activity.feed, { leagueId: s.leagueId });

    const kinds = feed.items.map((item) => item.kind);
    expect(kinds).toContain("add");
    expect(kinds).toContain("drop");
    expect(kinds).toContain("trade");
    expect(kinds).toContain("post");
    expect(kinds).toContain("message");
    expect(kinds).toContain("rule_change");
    expect(feed.currentWeek).toBe(1);

    for (let i = 1; i < feed.items.length; i++) {
      expect(feed.items[i - 1].at).toBeGreaterThanOrEqual(feed.items[i].at);
    }

    const adds = feed.items.filter((item) => item.kind === "add");
    expect(adds).toHaveLength(1);
    expect(adds[0]).toMatchObject({
      team: { name: "Alpha" },
      player: { name: "Wes Wide", position: "WR" },
      dropped: { name: "Rick Runner" },
      bid: 12,
      viaWaiver: true,
    });
    // The paired drop is absorbed; only Bravo's standalone drop remains.
    const drops = feed.items.filter((item) => item.kind === "drop");
    expect(drops.map((d) => d.kind === "drop" && d.team.name)).toEqual(["Bravo"]);

    // Hidden posts stay hidden.
    expect(feed.items.filter((item) => item.kind === "post").map((p) => p.kind === "post" && p.title)).toEqual(["Hot take"]);
  });

  test("a resolved trade appears twice: when proposed and when it went through", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const feed = await t.query(api.activity.feed, { leagueId: s.leagueId, filter: "trades" });

    expect(feed.items.every((item) => item.kind === "trade")).toBe(true);
    const completed = feed.items.filter((item) => item.kind === "trade" && item.tradeId === s.tradeId);
    expect(completed.map((item) => item.kind === "trade" && item.event)).toEqual(["resolved", "proposed"]);
    expect(completed[0]).toMatchObject({
      status: "completed",
      proposer: { name: "Bravo" },
      recipient: { name: "Charlie" },
      give: [{ name: "Quinn Back" }],
      receive: [],
      faab: -5,
    });
    expect(completed[0].at).toBe(NOW + 60_000);
  });

  test("withholds message bodies under delayed transparency unless the viewer is a party", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);

    const spectator = await t.query(api.activity.feed, { leagueId: s.leagueId, filter: "talk" });
    expect(spectator.items).toHaveLength(1);
    expect(spectator.items[0]).toMatchObject({ kind: "message", body: null, revealAt: NOW + HOUR });

    // Alpha's owner is a member but not a party to the Bravo–Charlie thread.
    const alphaOwner = t.withIdentity({ subject: `${s.userId}|${s.sessionId}` });
    const asOwner = await alphaOwner.query(api.activity.feed, { leagueId: s.leagueId, filter: "talk" });
    expect(asOwner.items[0]).toMatchObject({ kind: "message", body: null });

    // Hand Bravo to that user: now they are a party and read the body.
    await t.run((ctx) => ctx.db.patch("teams", s.bravo, { ownerUserId: s.userId }));
    const asParty = await alphaOwner.query(api.activity.feed, { leagueId: s.leagueId, filter: "talk" });
    expect(asParty.items[0]).toMatchObject({
      kind: "message",
      body: "Take the QB and five bucks.",
      from: { name: "Bravo" },
      to: { name: "Charlie" },
    });
  });

  test("honours the page bound and reports that more exists", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const page = await t.query(api.activity.feed, { leagueId: s.leagueId, limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(true);

    const all = await t.query(api.activity.feed, { leagueId: s.leagueId });
    expect(all.hasMore).toBe(false);
    // Rule changes ride only in the unfiltered feed.
    const moves = await t.query(api.activity.feed, { leagueId: s.leagueId, filter: "moves" });
    expect(moves.items.some((item) => item.kind === "rule_change")).toBe(false);
  });

  test("is closed on a private league to non-members", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run((ctx) => ctx.db.patch("leagues", s.leagueId, { isPublic: false }));
    await expect(t.query(api.activity.feed, { leagueId: s.leagueId })).rejects.toThrow(/private/i);
  });
});
