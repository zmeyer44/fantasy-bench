/**
 * Commissioner console reads. Every function is commissioner-only: an owner of a
 * team in the same league gets FORBIDDEN, matching `commissionerProcedure`.
 */
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

/** Preserves the schema generic, so `t.run`'s `ctx.db` stays fully typed. */
function newTest() {
  return convexTest(schema, modules);
}
type T = ReturnType<typeof newTest>;

async function errorCode(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    const data = (error as { data?: { code?: string } }).data;
    if (data?.code) return data.code;
    const message = error instanceof Error ? error.message : String(error);
    return /\b(UNAUTHORIZED|FORBIDDEN|NOT_FOUND|BAD_REQUEST)\b/.exec(message)?.[1] ?? message;
  }
}

async function actor(t: T, name: string, email: string) {
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
    name: "Console League",
    commissionerUserId: commish.userId,
    teamCount: 8,
    season: 2026,
  });
  await owner.session.mutation(api.leagues.join, { leagueId });
  return { t, commish, owner, outsider, leagueId, teamIds };
}

async function logChange(t: T, leagueId: Id<"leagues">, userId: Id<"users">, field: string) {
  await t.run(async (ctx) =>
    ctx.db.insert("league_rule_changes", {
      leagueId,
      userId,
      field,
      fromValue: "ppr",
      toValue: "half_ppr",
      createdAt: Date.now(),
    }),
  );
}

describe("commissioner.settings — authorization", () => {
  it("is UNAUTHORIZED signed out", async () => {
    const { t, leagueId } = await fixture();
    expect(await errorCode(t.query(api.commissioner.settings, { leagueId }))).toBe("UNAUTHORIZED");
  });

  it("is FORBIDDEN for a team owner in the league", async () => {
    const { owner, leagueId } = await fixture();
    expect(await errorCode(owner.session.query(api.commissioner.settings, { leagueId }))).toBe(
      "FORBIDDEN",
    );
  });

  it("is FORBIDDEN for a non-member even on a public league", async () => {
    const { outsider, leagueId } = await fixture();
    expect(await errorCode(outsider.session.query(api.commissioner.settings, { leagueId }))).toBe(
      "FORBIDDEN",
    );
  });
});

describe("commissioner.settings — shape", () => {
  it("returns rules, invite link, change log, models in use and the catalog", async () => {
    const { t, commish, leagueId, teamIds } = await fixture();
    await logChange(t, leagueId, commish.userId, "scoringPreset");

    const settings = await commish.session.query(api.commissioner.settings, { leagueId });
    expect(settings.league._id).toBe(leagueId);
    expect(settings.rules.scoringPreset).toBe("ppr");
    // A league with no code yet reports null; Phase 3's rotateJoinCode mints one.
    expect(settings.invite).toEqual({ code: null, url: null });
    expect(settings.changes).toHaveLength(1);
    expect(settings.changes[0]).toMatchObject({ field: "scoringPreset", userName: "Commish" });
    expect(settings.catalog.some((entry) => entry.modelId === "anthropic/claude-sonnet-4.5")).toBe(
      true,
    );
    // Every team starts on the first model of the allowlist.
    expect(settings.modelsInUse).toEqual([
      { modelId: "anthropic/claude-sonnet-4.5", teamCount: teamIds.length },
    ]);
    // A league in `setup` with no rulesLockedAt is unlocked.
    expect(settings.locked).toBe(false);
  });

  it("counts the models teams actually run and reports the lock", async () => {
    const { t, commish, leagueId, teamIds } = await fixture();
    await t.run(async (ctx) => {
      const config = (await ctx.db
        .query("agent_configs")
        .withIndex("by_teamId", (q) => q.eq("teamId", teamIds[0]))
        .unique())!;
      await ctx.db.patch("config_versions", config.currentVersionId!, {
        modelId: "openai/gpt-5-mini",
      });
      await ctx.db.patch("leagues", leagueId, { status: "in_season", joinCode: "JOIN1234" });
    });

    const settings = await commish.session.query(api.commissioner.settings, { leagueId });
    expect(settings.modelsInUse).toEqual([
      { modelId: "anthropic/claude-sonnet-4.5", teamCount: teamIds.length - 1 },
      { modelId: "openai/gpt-5-mini", teamCount: 1 },
    ]);
    expect(settings.locked).toBe(true);
    expect(settings.invite.code).toBe("JOIN1234");
    expect(settings.invite.url).toContain("/leagues/join/JOIN1234");
  });
});

describe("commissioner.inviteLink + changeLog", () => {
  it("pages the change log newest-first", async () => {
    const { t, commish, owner, leagueId } = await fixture();
    for (const field of ["a", "b", "c"]) await logChange(t, leagueId, commish.userId, field);

    const first = await commish.session.query(api.commissioner.changeLog, {
      leagueId,
      paginationOpts: { numItems: 2, cursor: null },
    });
    expect(first.page).toHaveLength(2);
    expect(first.page.map((row) => row.field)).toEqual(["c", "b"]);
    expect(first.isDone).toBe(false);

    const second = await commish.session.query(api.commissioner.changeLog, {
      leagueId,
      paginationOpts: { numItems: 2, cursor: first.continueCursor },
    });
    expect(second.page.map((row) => row.field)).toEqual(["a"]);
    expect(second.isDone).toBe(true);

    expect(
      await errorCode(
        owner.session.query(api.commissioner.changeLog, {
          leagueId,
          paginationOpts: { numItems: 2, cursor: null },
        }),
      ),
    ).toBe("FORBIDDEN");
  });

  it("exposes the invite link to the commissioner only", async () => {
    const { t, commish, owner, leagueId } = await fixture();
    await t.run(async (ctx) => ctx.db.patch("leagues", leagueId, { joinCode: "ZZZZ9999" }));
    expect((await commish.session.query(api.commissioner.inviteLink, { leagueId })).code).toBe(
      "ZZZZ9999",
    );
    expect(await errorCode(owner.session.query(api.commissioner.inviteLink, { leagueId }))).toBe(
      "FORBIDDEN",
    );
  });
});
