import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const NOW = Date.now();

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
  contextCharLimit: 8_000,
  maxStepsCap: 12,
  editLock: {
    unlockDay: "tue",
    unlockTime: "06:00",
    lockDay: "sun",
    lockTime: "12:00",
  },
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

async function fixture() {
  const t = convexTest(schema, modules);
  return {
    t,
    ...(await t.run(async (ctx) => {
      const user = (email: string) => ctx.db.insert("users", { email });
      const commissioner = await user("commissioner@visibility.test");
      const owner = await user("owner@visibility.test");
      const outsider = await user("outsider@visibility.test");
      const session = (userId: Id<"users">) =>
        ctx.db.insert("authSessions", {
          userId,
          expirationTime: NOW + 86_400_000,
        });
      const commissionerSession = await session(commissioner);
      const ownerSession = await session(owner);
      const outsiderSession = await session(outsider);
      const leagueId = await ctx.db.insert("leagues", {
        name: "Visibility",
        slug: `visibility-${Math.random()}`,
        commissionerUserId: commissioner,
        season: 2026,
        teamCount: 3,
        isPublic: true,
        status: "in_season",
        draftType: "snake",
        updatedAt: NOW,
      });
      await ctx.db.insert("league_rules", { leagueId, ...RULES });
      await ctx.db.insert("league_members", {
        leagueId,
        userId: commissioner,
        role: "commissioner",
      });
      for (const userId of [owner, outsider]) {
        await ctx.db.insert("league_members", {
          leagueId,
          userId,
          role: "owner",
        });
      }
      const team = (name: string, ownerUserId?: Id<"users">) =>
        ctx.db.insert("teams", {
          leagueId,
          ownerUserId,
          name,
          abbreviation: name.slice(0, 3).toUpperCase(),
          faabRemaining: 100,
          waiverPriority: 1,
          karma: 0,
          draftBudgetRemaining: 200,
        });
      const teamA = await team("Alpha", owner);
      const teamB = await team("Bravo");
      const windowId = await ctx.db.insert("windows", {
        leagueId,
        type: "trade",
        label: "trade",
        weekNo: 1,
        roundNo: 1,
        opensAt: NOW - 1_000,
        submissionDeadlineAt: NOW + 30_000,
        closesAt: NOW + 60_000,
        status: "open",
        scope: {},
        runCount: 0,
        terminalRunCount: 0,
      });
      const threadId = await ctx.db.insert("threads", {
        leagueId,
        teamAId: teamA,
        teamBId: teamB,
        createdInWindowId: windowId,
        messageCount: 1,
      });
      const messageId = await ctx.db.insert("messages", {
        threadId,
        leagueId,
        senderTeamId: teamA,
        body: "A currently private negotiation",
        createdAt: NOW,
      });
      const postId = await ctx.db.insert("forum_posts", {
        leagueId,
        teamId: teamA,
        title: "Visible post",
        body: "body",
        flair: "analysis",
        score: 0,
        commentCount: 0,
        hidden: false,
        createdAt: NOW,
      });
      const foreignLeagueId = await ctx.db.insert("leagues", {
        name: "Foreign visibility",
        slug: `foreign-visibility-${Math.random()}`,
        commissionerUserId: commissioner,
        season: 2026,
        teamCount: 1,
        isPublic: true,
        status: "in_season",
        draftType: "snake",
        updatedAt: NOW,
      });
      const foreignTeamId = await ctx.db.insert("teams", {
        leagueId: foreignLeagueId,
        name: "Foreign",
        abbreviation: "FOR",
        faabRemaining: 100,
        waiverPriority: 1,
        karma: 0,
        draftBudgetRemaining: 200,
      });
      const foreignPostId = await ctx.db.insert("forum_posts", {
        leagueId: foreignLeagueId,
        teamId: foreignTeamId,
        title: "Foreign post",
        body: "must stay masked",
        flair: "analysis",
        score: 0,
        commentCount: 0,
        hidden: false,
        createdAt: NOW,
      });
      return {
        commissioner,
        commissionerSession,
        owner,
        ownerSession,
        outsider,
        outsiderSession,
        leagueId,
        teamA,
        messageId,
        postId,
        foreignPostId,
      };
    })),
  };
}

describe("activity_visibility.current", () => {
  test("forum visibility follows hide and unhide without trusting the requested id", async () => {
    const fx = await fixture();
    const postEvent = `forum_posts/${fx.postId}`;
    const foreignPostEvent = `forum_posts/${fx.foreignPostId}`;
    expect(await fx.t.query(api.activity_visibility.current, {
      leagueId: fx.leagueId,
      ids: [
        postEvent,
        foreignPostEvent,
        "forum_posts/not-an-id",
        "trades/not-sensitive",
      ],
    })).toEqual([
      { id: postEvent, visible: true, body: null },
      { id: foreignPostEvent, visible: false, body: null },
      { id: "forum_posts/not-an-id", visible: false, body: null },
      { id: "trades/not-sensitive", visible: false, body: null },
    ]);

    await fx.t.run((ctx) => ctx.db.patch("forum_posts", fx.postId, { hidden: true }));
    expect((await fx.t.query(api.activity_visibility.current, {
      leagueId: fx.leagueId,
      ids: [postEvent],
    }))[0]).toEqual({ id: postEvent, visible: false, body: null });

    await fx.t.run((ctx) => ctx.db.patch("forum_posts", fx.postId, { hidden: false }));
    expect((await fx.t.query(api.activity_visibility.current, {
      leagueId: fx.leagueId,
      ids: [postEvent],
    }))[0].visible).toBe(true);
  });

  test("message bodies redact immediately when a party loses team ownership", async () => {
    const fx = await fixture();
    const messageEvent = `messages/${fx.messageId}`;
    const asOwner = fx.t.withIdentity({
      subject: `${fx.owner}|${fx.ownerSession}`,
    });
    const asCommissioner = fx.t.withIdentity({
      subject: `${fx.commissioner}|${fx.commissionerSession}`,
    });

    expect((await asOwner.query(api.activity_visibility.current, {
      leagueId: fx.leagueId,
      ids: [messageEvent],
    }))[0].body).toBe("A currently private negotiation");
    expect((await asCommissioner.query(api.activity_visibility.current, {
      leagueId: fx.leagueId,
      ids: [messageEvent],
    }))[0].body).toBe("A currently private negotiation");

    await fx.t.run((ctx) =>
      ctx.db.patch("teams", fx.teamA, { ownerUserId: fx.outsider }),
    );
    expect((await asOwner.query(api.activity_visibility.current, {
      leagueId: fx.leagueId,
      ids: [messageEvent],
    }))[0]).toEqual({ id: messageEvent, visible: true, body: null });

    const asNewOwner = fx.t.withIdentity({
      subject: `${fx.outsider}|${fx.outsiderSession}`,
    });
    expect((await asNewOwner.query(api.activity_visibility.current, {
      leagueId: fx.leagueId,
      ids: [messageEvent],
    }))[0].body).toBe("A currently private negotiation");
  });

  test("bounds the subscription payload", async () => {
    const fx = await fixture();
    await expect(fx.t.query(api.activity_visibility.current, {
      leagueId: fx.leagueId,
      ids: Array.from({ length: 101 }, (_, index) => `messages/${index}`),
    })).rejects.toThrow(/At most 100/);
  });
});
