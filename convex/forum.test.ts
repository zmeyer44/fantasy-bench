/**
 * `convex/forum.ts` — sort orders, flair, hidden visibility, `myVote`, the
 * comment tree and the runtime digest.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import type { ForumPostView } from "./forum";
import { hotScore, startOfEasternDay } from "./lib/social_pure";

const modules = import.meta.glob("./**/*.ts");

const HOUR = 3_600_000;

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
    const commish = await ctx.db.insert("users", { email: "commish@x.dev" });
    const owner = await ctx.db.insert("users", { email: "owner@x.dev" });
    const stranger = await ctx.db.insert("users", { email: "s@x.dev" });
    const sessionOf = (userId: Id<"users">) =>
      ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 86_400_000 });

    const leagueId = await ctx.db.insert("leagues", {
      name: "Test", slug: `t-${Math.random()}`, commissionerUserId: commish, season: 2025,
      teamCount: 2, isPublic: opts.isPublic ?? true, status: "in_season",
      draftType: "snake", updatedAt: Date.now(),
    });
    await ctx.db.insert("league_rules", { leagueId, ...RULES });
    await ctx.db.insert("league_members", { leagueId, userId: commish, role: "commissioner" });
    await ctx.db.insert("league_members", { leagueId, userId: owner, role: "owner" });

    const team = (name: string, ownerUserId: Id<"users">, karma: number) =>
      ctx.db.insert("teams", {
        leagueId, ownerUserId, name, abbreviation: name.slice(0, 3).toUpperCase(),
        faabRemaining: 100, waiverPriority: 1, karma, draftBudgetRemaining: 200,
      });
    const teamA = await team("Alpha", commish, 7);
    const teamB = await team("Bravo", owner, 12);

    return {
      commish, owner, stranger, leagueId, teamA, teamB,
      sessionCommish: await sessionOf(commish),
      sessionOwner: await sessionOf(owner),
      sessionStranger: await sessionOf(stranger),
    };
  });
}

type Seed = Awaited<ReturnType<typeof seed>>;

async function post(
  t: ReturnType<typeof convexTest>,
  s: Seed,
  over: Partial<{
    title: string;
    score: number;
    ageHours: number;
    flair: "trash_talk" | "trade_block" | "analysis" | "announcement";
    hidden: boolean;
    teamId: Id<"teams"> | undefined;
    commentCount: number;
  }> = {},
) {
  return t.run(async (ctx) =>
    ctx.db.insert("forum_posts", {
      leagueId: s.leagueId,
      teamId: "teamId" in over ? over.teamId : s.teamA,
      title: over.title ?? "Post",
      body: "body",
      flair: over.flair ?? "trash_talk",
      score: over.score ?? 0,
      commentCount: over.commentCount ?? 0,
      hidden: over.hidden ?? false,
      createdAt: Date.now() - (over.ageHours ?? 0) * HOUR,
    }),
  );
}

const FIRST_PAGE = { numItems: 25, cursor: null };

describe("forum.list", () => {
  test("hot ranks by decayed score, not raw score", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    // Old but high-scoring vs. fresh and modest: hotScore decides.
    const old = await post(t, s, { title: "old", score: 40, ageHours: 200 });
    const fresh = await post(t, s, { title: "fresh", score: 10, ageHours: 0 });
    expect(hotScore(40, Date.now() - 200 * HOUR, Date.now())).toBeLessThan(
      hotScore(10, Date.now(), Date.now()),
    );

    const hot = await t.query(api.forum.list, {
      leagueId: s.leagueId, sort: "hot", paginationOpts: FIRST_PAGE,
    });
    expect(hot.page.map((p) => p.id)).toEqual([fresh, old]);
    expect(hot.isDone).toBe(true);
    expect(hot.page[0].hotScore).toBeGreaterThan(hot.page[1].hotScore);

    const top = await t.query(api.forum.list, {
      leagueId: s.leagueId, sort: "top", paginationOpts: FIRST_PAGE,
    });
    expect(top.page.map((p) => p.id)).toEqual([old, fresh]);

    const fresher = await t.query(api.forum.list, {
      leagueId: s.leagueId, sort: "new", paginationOpts: FIRST_PAGE,
    });
    expect(fresher.page.map((p) => p.id)).toEqual([fresh, old]);
  });

  test("hot pages through its bounded window with an offset cursor", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    for (let i = 0; i < 3; i++) await post(t, s, { title: `p${i}`, score: 10 - i });

    const first = await t.query(api.forum.list, {
      leagueId: s.leagueId, sort: "hot", paginationOpts: { numItems: 2, cursor: null },
    });
    expect(first.page).toHaveLength(2);
    expect(first.isDone).toBe(false);
    const second = await t.query(api.forum.list, {
      leagueId: s.leagueId, sort: "hot",
      paginationOpts: { numItems: 2, cursor: first.continueCursor },
    });
    expect(second.page).toHaveLength(1);
    expect(second.isDone).toBe(true);
  });

  test("flair narrows the board", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await post(t, s, { title: "talk", flair: "trash_talk" });
    const block = await post(t, s, { title: "block", flair: "trade_block" });

    for (const sort of ["new", "hot", "top"] as const) {
      const page = await t.query(api.forum.list, {
        leagueId: s.leagueId, sort, flair: "trade_block", paginationOpts: FIRST_PAGE,
      });
      expect(page.page.map((p) => p.id)).toEqual([block]);
    }
  });

  test("hidden posts are commissioner-only", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await post(t, s, { title: "visible" });
    await post(t, s, { title: "moderated", hidden: true });

    const anon = await t.query(api.forum.list, {
      leagueId: s.leagueId, sort: "new", paginationOpts: FIRST_PAGE,
    });
    expect(anon.page.map((p) => p.title)).toEqual(["visible"]);

    const asOwner = t.withIdentity({ subject: `${s.owner}|${s.sessionOwner}` });
    const owner = await asOwner.query(api.forum.list, {
      leagueId: s.leagueId, sort: "new", includeHidden: true, paginationOpts: FIRST_PAGE,
    });
    expect(owner.page.map((p) => p.title)).toEqual(["visible"]);

    const asCommish = t.withIdentity({ subject: `${s.commish}|${s.sessionCommish}` });
    const commish = await asCommish.query(api.forum.list, {
      leagueId: s.leagueId, sort: "new", includeHidden: true, paginationOpts: FIRST_PAGE,
    });
    expect(commish.page.map((p) => p.title)).toEqual(["moderated", "visible"]);
    expect(commish.page[0].hidden).toBe(true);
  });

  test("myVote reflects the viewer's own vote only", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const postId = await post(t, s, { score: 1 });
    await t.run(async (ctx) => {
      await ctx.db.insert("forum_votes", {
        leagueId: s.leagueId, targetType: "post", targetId: postId,
        voterUserId: s.owner, direction: 1,
      });
      await ctx.db.insert("forum_votes", {
        leagueId: s.leagueId, targetType: "post", targetId: postId,
        voterUserId: s.commish, direction: -1,
      });
    });

    const anon = await t.query(api.forum.list, {
      leagueId: s.leagueId, sort: "new", paginationOpts: FIRST_PAGE,
    });
    expect(anon.page[0].myVote).toBe(0);

    const asOwner = t.withIdentity({ subject: `${s.owner}|${s.sessionOwner}` });
    expect(
      (await asOwner.query(api.forum.list, {
        leagueId: s.leagueId, sort: "new", paginationOpts: FIRST_PAGE,
      })).page[0].myVote,
    ).toBe(1);

    const asCommish = t.withIdentity({ subject: `${s.commish}|${s.sessionCommish}` });
    expect(
      (await asCommish.query(api.forum.list, {
        leagueId: s.leagueId, sort: "new", paginationOpts: FIRST_PAGE,
      })).page[0].myVote,
    ).toBe(-1);
  });

  test("a private league is forbidden to non-members", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { isPublic: false });
    await post(t, s, {});

    await expect(
      t.query(api.forum.list, { leagueId: s.leagueId, sort: "new", paginationOpts: FIRST_PAGE }),
    ).rejects.toThrow(/private/);

    const asStranger = t.withIdentity({ subject: `${s.stranger}|${s.sessionStranger}` });
    await expect(
      asStranger.query(api.forum.list, {
        leagueId: s.leagueId, sort: "new", paginationOpts: FIRST_PAGE,
      }),
    ).rejects.toThrow(/private/);

    const asOwner = t.withIdentity({ subject: `${s.owner}|${s.sessionOwner}` });
    expect(
      (await asOwner.query(api.forum.list, {
        leagueId: s.leagueId, sort: "new", paginationOpts: FIRST_PAGE,
      })).page,
    ).toHaveLength(1);
  });
});

describe("forum.get", () => {
  async function withComments(t: ReturnType<typeof convexTest>, s: Seed) {
    const postId = await post(t, s, { commentCount: 3 });
    return t.run(async (ctx) => {
      const base = Date.now() - HOUR;
      const root = await ctx.db.insert("forum_comments", {
        postId, leagueId: s.leagueId, teamId: s.teamB, body: "root",
        score: 2, hidden: false, createdAt: base,
      });
      const child = await ctx.db.insert("forum_comments", {
        postId, leagueId: s.leagueId, parentId: root, teamId: s.teamA, body: "child",
        score: 0, hidden: false, createdAt: base + 1000,
      });
      await ctx.db.insert("forum_comments", {
        postId, leagueId: s.leagueId, parentId: child, body: "grandchild",
        score: 0, hidden: false, createdAt: base + 2000,
      });
      const hiddenParent = await ctx.db.insert("forum_comments", {
        postId, leagueId: s.leagueId, teamId: s.teamB, body: "hidden",
        score: 0, hidden: true, createdAt: base + 3000,
      });
      const orphan = await ctx.db.insert("forum_comments", {
        postId, leagueId: s.leagueId, parentId: hiddenParent, teamId: s.teamA,
        body: "orphan", score: 0, hidden: false, createdAt: base + 4000,
      });
      return { postId, root, child, hiddenParent, orphan };
    });
  }

  test("flattens the comment tree in pre-order with depths", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const ids = await withComments(t, s);

    const { post: view, karma } = await t.query(api.forum.get, {
      leagueId: s.leagueId, postId: ids.postId,
    });
    expect(view.comments?.map((c) => [c.body, c.depth])).toEqual([
      ["root", 0],
      ["child", 1],
      ["grandchild", 2],
      // Parent hidden and filtered out: the orphan still renders, at depth 0.
      ["orphan", 0],
    ]);
    // Platform-authored rows get the Commissioner byline.
    expect(view.comments?.find((c) => c.body === "grandchild")?.teamName).toBe(
      "Commissioner",
    );
    expect(view.comments?.[0].teamName).toBe("Bravo");
    expect(karma).toEqual({ [s.teamA]: 7, [s.teamB]: 12 });
  });

  test("the commissioner sees hidden comments, nobody else does", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const ids = await withComments(t, s);
    const asCommish = t.withIdentity({ subject: `${s.commish}|${s.sessionCommish}` });
    const { post: view } = await asCommish.query(api.forum.get, {
      leagueId: s.leagueId, postId: ids.postId,
    });
    expect(view.comments?.map((c) => c.body)).toEqual([
      "root", "child", "grandchild", "hidden", "orphan",
    ]);
    expect(view.comments?.find((c) => c.body === "orphan")?.depth).toBe(1);
  });

  test("myVote is carried on comments", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const ids = await withComments(t, s);
    await t.run(async (ctx) => {
      await ctx.db.insert("forum_votes", {
        leagueId: s.leagueId, targetType: "comment", targetId: ids.root,
        voterUserId: s.owner, direction: -1,
      });
    });
    const asOwner = t.withIdentity({ subject: `${s.owner}|${s.sessionOwner}` });
    const { post: view } = await asOwner.query(api.forum.get, {
      leagueId: s.leagueId, postId: ids.postId,
    });
    expect(view.comments?.find((c) => c.id === ids.root)?.myVote).toBe(-1);
    expect(view.comments?.find((c) => c.id === ids.child)?.myVote).toBe(0);
  });

  test("a hidden post is not found unless you are the commissioner", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const postId = await post(t, s, { hidden: true });
    await expect(
      t.query(api.forum.get, { leagueId: s.leagueId, postId }),
    ).rejects.toThrow(/Post not found/);

    const asCommish = t.withIdentity({ subject: `${s.commish}|${s.sessionCommish}` });
    expect(
      (await asCommish.query(api.forum.get, { leagueId: s.leagueId, postId })).post.hidden,
    ).toBe(true);
  });
});

describe("forum.karma", () => {
  test("returns every team, highest karma first", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    expect(await t.query(api.forum.karma, { leagueId: s.leagueId })).toEqual([
      { teamId: s.teamB, name: "Bravo", karma: 12 },
      { teamId: s.teamA, name: "Alpha", karma: 7 },
    ]);
  });
});

describe("forum internals", () => {
  test("digest returns bounded posts plus karma, and never hidden rows", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await post(t, s, { title: "one", score: 3 });
    await post(t, s, { title: "two", score: 9 });
    await post(t, s, { title: "moderated", hidden: true });

    const digest = await t.query(internal.forum.digest, { leagueId: s.leagueId, limit: 5 });
    expect(digest.posts.map((p: ForumPostView) => p.title)).toEqual(["two", "one"]);
    expect(digest.karma).toEqual({ [s.teamA]: 7, [s.teamB]: 12 });

    const top = await t.query(internal.forum.digest, {
      leagueId: s.leagueId, limit: 1, sort: "top",
    });
    expect(top.posts.map((p: ForumPostView) => p.title)).toEqual(["two"]);
  });

  test("countRecentByTeam counts a team's rows since a watermark", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const since = startOfEasternDay(Date.now());
    await post(t, s, { title: "today" });
    const yesterday = await post(t, s, { title: "yesterday", ageHours: 48 });
    await t.run(async (ctx) => {
      await ctx.db.insert("forum_comments", {
        postId: yesterday, leagueId: s.leagueId, teamId: s.teamA, body: "c",
        score: 0, hidden: false, createdAt: Date.now(),
      });
    });

    expect(await t.query(internal.forum.countRecentByTeam, { teamId: s.teamA, since }))
      .toEqual({ posts: 1, comments: 1 });
    expect(await t.query(internal.forum.countRecentByTeam, { teamId: s.teamB, since }))
      .toEqual({ posts: 0, comments: 0 });
  });

  test("startOfEasternDay lands on an Eastern midnight", async () => {
    // 2026-03-08T12:00:00Z is 07:00 EST; the day started at 05:00Z.
    expect(startOfEasternDay(Date.UTC(2026, 1, 8, 12))).toBe(Date.UTC(2026, 1, 8, 5));
    // After the DST switch the offset is -4h.
    expect(startOfEasternDay(Date.UTC(2026, 6, 8, 12))).toBe(Date.UTC(2026, 6, 8, 4));
  });
});
