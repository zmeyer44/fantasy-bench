/**
 * League read/write parity + the authorization ladder (`lib/trpc/init.ts`).
 *
 * The ladder under test: a public league is readable signed out (spectators),
 * a private league is UNAUTHORIZED signed out and FORBIDDEN for a signed-in
 * non-member, and members read either.
 */
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

/** The `code` a `ConvexError` from convex/lib/errors.ts carried, or null. */
export async function errorCode(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    const data = (error as { data?: { code?: string } }).data;
    if (data?.code) return data.code;
    const message = error instanceof Error ? error.message : String(error);
    const match = /"code":\s*"([A-Z_]+)"/.exec(message) ?? /\b(UNAUTHORIZED|FORBIDDEN|NOT_FOUND|BAD_REQUEST|CONFLICT)\b/.exec(message);
    return match?.[1] ?? message;
  }
}

/** Preserves the schema generic, so `t.run`'s `ctx.db` stays fully typed. */
function newTest() {
  return convexTest(schema, modules);
}
type T = ReturnType<typeof newTest>;

/** Convex Auth's `subject` is `"<userId>|<sessionId>"` (CONVEX_NOTES §12.6). */
export async function actor(t: T, name: string, email: string) {
  const { userId, sessionId } = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name, email });
    const sessionId = await ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 86_400_000,
    });
    return { userId, sessionId };
  });
  return { userId, session: t.withIdentity({ subject: `${userId}|${sessionId}` }) };
}

async function fixture() {
  const t = newTest();
  const commish = await actor(t, "Commish", "commish@fantasybench.dev");
  const owner = await actor(t, "Owner", "owner@fantasybench.dev");
  const outsider = await actor(t, "Outsider", "outsider@fantasybench.dev");

  const { leagueId, teamIds } = await t.mutation(internal.leagues.createLeague, {
    name: "Test League",
    commissionerUserId: commish.userId,
    teamCount: 8,
    season: 2026,
  });
  return { t, commish, owner, outsider, leagueId, teamIds };
}

async function makePrivate(t: T, leagueId: Id<"leagues">) {
  await t.run(async (ctx) => ctx.db.patch("leagues", leagueId, { isPublic: false }));
}

describe("leagues.get — authorization ladder", () => {
  it("lets anyone read a public league", async () => {
    const { t, leagueId } = await fixture();
    const view = await t.query(api.leagues.get, { leagueId });
    expect(view.league.name).toBe("Test League");
    expect(view.membership).toBeNull();
    expect(view.role).toBeNull();
    expect(view.isCommissioner).toBe(false);
  });

  it("is UNAUTHORIZED signed out on a private league", async () => {
    const { t, leagueId } = await fixture();
    await makePrivate(t, leagueId);
    expect(await errorCode(t.query(api.leagues.get, { leagueId }))).toBe("UNAUTHORIZED");
  });

  it("is FORBIDDEN for a signed-in non-member of a private league", async () => {
    const { t, leagueId, outsider } = await fixture();
    await makePrivate(t, leagueId);
    expect(await errorCode(outsider.session.query(api.leagues.get, { leagueId }))).toBe("FORBIDDEN");
  });

  it("lets a member read a private league", async () => {
    const { t, leagueId, commish } = await fixture();
    await makePrivate(t, leagueId);
    const view = await commish.session.query(api.leagues.get, { leagueId });
    expect(view.role).toBe("commissioner");
    expect(view.isCommissioner).toBe(true);
  });

  it("NOT_FOUND for a league that does not exist", async () => {
    const { t, leagueId } = await fixture();
    const ghost = await t.run(async (ctx) => {
      const id = await ctx.db.insert("leagues", {
        name: "Gone",
        slug: "gone",
        commissionerUserId: (await ctx.db.get("leagues", leagueId))!.commissionerUserId,
        season: 2026,
        teamCount: 8,
        isPublic: true,
        status: "setup",
        draftType: "snake",
        updatedAt: Date.now(),
      });
      await ctx.db.delete("leagues", id);
      return id;
    });
    expect(await errorCode(t.query(api.leagues.get, { leagueId: ghost }))).toBe("NOT_FOUND");
  });
});

describe("leagues.get — shape", () => {
  it("returns the league, its rules and its teams in waiver order", async () => {
    const { t, leagueId } = await fixture();
    const view = await t.query(api.leagues.get, { leagueId });

    expect(view.teams).toHaveLength(8);
    expect(view.teams.map((team) => team.waiverPriority)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(view.teams.map((team) => team.name)).toEqual([
      "Team 1",
      "Team 2",
      "Team 3",
      "Team 4",
      "Team 5",
      "Team 6",
      "Team 7",
      "Team 8",
    ]);
    expect(view.rules?.scoringPreset).toBe("ppr");
    expect(view.rules?.seasonWeeks).toBe(17);
    expect(view.viewerTeamId).toBeNull();
  });

  it("creates 17 weeks anchored on the Tuesday after Labor Day", async () => {
    const { t, leagueId } = await fixture();
    const weeks = await t.run(async (ctx) =>
      ctx.db
        .query("weeks")
        .withIndex("by_leagueId_weekNo", (q) => q.eq("leagueId", leagueId))
        .collect(),
    );
    expect(weeks).toHaveLength(17);
    // 2026: Labor Day is Mon Sep 7, so week 1 opens Tue Sep 8 06:00 ET (10:00 UTC).
    expect(new Date(weeks[0].startsAt).toISOString()).toBe("2026-09-08T10:00:00.000Z");
    expect(weeks[1].startsAt - weeks[0].startsAt).toBe(7 * 24 * 60 * 60 * 1000);
    // playoffStartWeek defaults to regularSeasonWeeks + 1 = 15, so 15/16/17.
    expect(weeks.filter((week) => week.isPlayoff).map((w) => w.weekNo)).toEqual([15, 16, 17]);
  });

  it("gives every team a default agent config on version 1", async () => {
    const { t, leagueId, teamIds } = await fixture();
    const configs = await t.run(async (ctx) =>
      ctx.db
        .query("agent_configs")
        .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
        .collect(),
    );
    expect(configs).toHaveLength(teamIds.length);
    expect(configs.every((config) => config.currentVersionId !== undefined)).toBe(true);

    const version = await t.query(api.configs.get, { leagueId, teamId: teamIds[0] });
    expect(version.current?.versionNo).toBe(1);
    expect(version.current?.changeSummary).toBe("Initial configuration");
  });
});

describe("leagues.listMine / join / joinByCode", () => {
  it("requires a session", async () => {
    const { t } = await fixture();
    expect(await errorCode(t.query(api.leagues.listMine, {}))).toBe("UNAUTHORIZED");
  });

  it("lists the leagues a user belongs to with their role", async () => {
    const { commish, leagueId } = await fixture();
    const mine = await commish.session.query(api.leagues.listMine, {});
    expect(mine).toHaveLength(1);
    expect(mine[0]._id).toBe(leagueId);
    expect(mine[0].role).toBe("commissioner");
    expect(mine[0].teamCountActual).toBe(8);
  });

  it("claims the lowest-priority unowned team and is idempotent", async () => {
    const { owner, leagueId, teamIds } = await fixture();
    const first = await owner.session.mutation(api.leagues.join, { leagueId });
    expect(first.teamId).toBe(teamIds[0]);

    const again = await owner.session.mutation(api.leagues.join, { leagueId });
    expect(again.teamId).toBe(first.teamId);
    expect(again.membershipId).toBe(first.membershipId);

    const view = await owner.session.query(api.leagues.get, { leagueId });
    expect(view.role).toBe("owner");
    expect(view.viewerTeamId).toBe(teamIds[0]);
  });

  it("refuses to join a private league without a code, but honours the code", async () => {
    const { t, owner, leagueId } = await fixture();
    await makePrivate(t, leagueId);
    expect(await errorCode(owner.session.mutation(api.leagues.join, { leagueId }))).toBe("FORBIDDEN");

    await t.run(async (ctx) => ctx.db.patch("leagues", leagueId, { joinCode: "ABCD1234" }));
    const joined = await owner.session.mutation(api.leagues.joinByCode, { code: "abcd1234" });
    expect(joined.leagueId).toBe(leagueId);
    expect(joined.teamId).not.toBeNull();

    const summary = await t.query(api.leagues.byJoinCode, { code: "ABCD1234" });
    expect(summary?.teamCount).toBe(8);
    expect(summary?.openTeamCount).toBe(7);
  });

  it("rejects an unknown invite code", async () => {
    const { owner } = await fixture();
    expect(await errorCode(owner.session.mutation(api.leagues.joinByCode, { code: "NOPE" }))).toBe(
      "BAD_REQUEST",
    );
  });
});

describe("leagues.bySlug", () => {
  it("resolves a slug and applies the same read rule", async () => {
    const { t, leagueId } = await fixture();
    const found = await t.query(api.leagues.bySlug, { slug: "test-league" });
    expect(found?.league._id).toBe(leagueId);
    expect(await t.query(api.leagues.bySlug, { slug: "nope" })).toBeNull();

    await makePrivate(t, leagueId);
    expect(await errorCode(t.query(api.leagues.bySlug, { slug: "test-league" }))).toBe(
      "UNAUTHORIZED",
    );
  });
});
