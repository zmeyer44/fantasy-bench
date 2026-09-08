/**
 * `users.me` — the viewer's identity and memberships.
 *
 * Also pins the Convex Auth identity contract: `subject` is `"<userId>|<sessionId>"`,
 * so a bare `t.withIdentity({ name })` must NOT resolve to a user (CONVEX_NOTES §12.6/12.8).
 */
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

function newTest() {
  return convexTest(schema, modules);
}

async function actor(t: ReturnType<typeof newTest>, name: string, email: string) {
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

describe("users.me", () => {
  it("is null when signed out", async () => {
    const t = newTest();
    expect(await t.query(api.users.me, {})).toBeNull();
  });

  it("is null for an identity whose subject is not a real user id", async () => {
    const t = newTest();
    const stranger = t.withIdentity({ name: "Sarah" });
    expect(await stranger.query(api.users.me, {})).toBeNull();
  });

  it("reports every membership with its role and owned team", async () => {
    const t = newTest();
    const commish = await actor(t, "Commish", "commish@fantasybench.dev");
    const owner = await actor(t, "Owner", "owner@fantasybench.dev");

    const first = await t.mutation(internal.leagues.createLeague, {
      name: "Alpha League",
      commissionerUserId: commish.userId,
      teamCount: 8,
      season: 2026,
    });
    const second = await t.mutation(internal.leagues.createLeague, {
      name: "Beta League",
      commissionerUserId: commish.userId,
      teamCount: 8,
      season: 2026,
    });

    await owner.session.mutation(api.leagues.join, { leagueId: first.leagueId });

    const asCommish = await commish.session.query(api.users.me, {});
    expect(asCommish?.email).toBe("commish@fantasybench.dev");
    expect(asCommish?.name).toBe("Commish");
    expect(asCommish?.memberships.map((m) => m.leagueName).sort()).toEqual([
      "Alpha League",
      "Beta League",
    ]);
    expect(asCommish?.memberships.every((m) => m.role === "commissioner")).toBe(true);
    expect(asCommish?.memberships.every((m) => m.teamId === null)).toBe(true);

    const asOwner = await owner.session.query(api.users.me, {});
    expect(asOwner?.memberships).toHaveLength(1);
    expect(asOwner?.memberships[0]).toMatchObject({
      leagueId: first.leagueId,
      leagueName: "Alpha League",
      slug: "alpha-league",
      role: "owner",
      teamId: first.teamIds[0],
    });
    expect(second.leagueId).not.toBe(first.leagueId);
  });
});

describe("users.byEmailPublic", () => {
  it("refuses without the seed secret", async () => {
    const t = newTest();
    await actor(t, "Demo Owner", "demo@fantasybench.dev");
    await expect(
      t.query(api.users.byEmailPublic, { secret: "nope", email: "demo@fantasybench.dev" }),
    ).rejects.toThrow();
  });
});
