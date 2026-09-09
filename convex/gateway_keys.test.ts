/**
 * Bring-your-own gateway keys: encryption at rest, who may manage a key, what
 * the league can see, and the ledger's team spend cap.
 */
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { DEFAULT_WEEKLY_USD_CAP_PER_TEAM } from "./lib/defaults";
import { decryptSecret, encryptSecret, keyTail } from "./lib/secrets";
import schema from "./schema";

process.env.BYOK_ENCRYPTION_KEY ??= "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
process.env.BYOK_ALLOW_UNVERIFIED = "1";

const modules = import.meta.glob("./**/*.ts");
const newTest = () => convexTest(schema, modules);
type T = ReturnType<typeof newTest>;

async function errorCode(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    const data = (error as { data?: { code?: string } }).data;
    if (data?.code) return data.code;
    const message = error instanceof Error ? error.message : String(error);
    return /\b(UNAUTHORIZED|FORBIDDEN|NOT_FOUND|BAD_REQUEST|CONFLICT)\b/.exec(message)?.[1] ?? message;
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
  const other = await actor(t, "Other", "other@fantasybench.dev");
  const { leagueId, teamIds } = await t.mutation(internal.leagues.createLeague, {
    name: "Keys League",
    commissionerUserId: commish.userId,
    teamCount: 8,
    season: 2026,
  });
  await owner.session.mutation(api.leagues.join, { leagueId });
  await other.session.mutation(api.leagues.join, { leagueId });
  return { t, commish, owner, other, leagueId, teamId: teamIds[0] as Id<"teams"> };
}

const KEY = "vck_live_0123456789abcdefghijklmnop";

describe("secrets (pure)", () => {
  it("round-trips through AES-GCM with a fresh IV every time", async () => {
    const a = await encryptSecret(KEY);
    const b = await encryptSecret(KEY);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(await decryptSecret(a)).toBe(KEY);
    expect(await decryptSecret(b)).toBe(KEY);
    expect(keyTail(KEY)).toBe("mnop");
  });

  it("refuses a tampered ciphertext", async () => {
    const sealed = await encryptSecret(KEY);
    const flipped = sealed.ciphertext.slice(0, -2) + (sealed.ciphertext.endsWith("A=") ? "B=" : "A=");
    await expect(decryptSecret({ ...sealed, ciphertext: flipped })).rejects.toThrow();
  });
});

describe("gateway_keys", () => {
  it("owner sets a key; only owner and commissioner see its tail; the league sees hasKey", async () => {
    const { t, owner, other, commish, leagueId, teamId } = await fixture();
    const before = await other.session.query(api.gateway_keys.status, { leagueId, teamId });
    expect(before).toMatchObject({ hasKey: false, canManage: false, configured: true, last4: null });

    const result = await owner.session.action(api.gateway_keys.set, {
      teamId,
      apiKey: KEY,
      skipVerification: true,
    });
    expect(result).toEqual({ last4: "mnop", verified: false });

    const mine = await owner.session.query(api.gateway_keys.status, { leagueId, teamId });
    expect(mine).toMatchObject({ hasKey: true, canManage: true, last4: "mnop" });
    expect(typeof mine.addedAt).toBe("number");

    const commissioners = await commish.session.query(api.gateway_keys.status, { leagueId, teamId });
    expect(commissioners).toMatchObject({ hasKey: true, canManage: true, last4: "mnop" });

    const theirs = await other.session.query(api.gateway_keys.status, { leagueId, teamId });
    expect(theirs).toMatchObject({ hasKey: true, canManage: false, last4: null, addedAt: null });

    // The stored row holds ciphertext only; the runtime read decrypts to the original.
    const row = await t.run((ctx) =>
      ctx.db
        .query("team_gateway_keys")
        .withIndex("by_teamId", (q) => q.eq("teamId", teamId))
        .unique(),
    );
    expect(row?.ciphertext).not.toContain(KEY);
    expect(JSON.stringify(row)).not.toContain(KEY);
    const runtime = await t.query(internal.gateway_keys.forTeam, { teamId });
    expect(await decryptSecret({ ciphertext: runtime!.ciphertext, iv: runtime!.iv })).toBe(KEY);

    // The team page and the budget read model both report the key.
    expect((await t.query(api.views.team, { teamId }))?.config.ownKey).toBe(true);
  });

  it("rejects other members, signed-out callers and malformed keys; remove clears it", async () => {
    const { t, owner, other, leagueId, teamId } = await fixture();
    expect(
      await errorCode(other.session.action(api.gateway_keys.set, { teamId, apiKey: KEY, skipVerification: true })),
    ).toBe("FORBIDDEN");
    expect(
      await errorCode(t.action(api.gateway_keys.set, { teamId, apiKey: KEY, skipVerification: true })),
    ).toBe("FORBIDDEN");
    expect(
      await errorCode(owner.session.action(api.gateway_keys.set, { teamId, apiKey: "short", skipVerification: true })),
    ).toBe("BAD_REQUEST");

    await owner.session.action(api.gateway_keys.set, { teamId, apiKey: KEY, skipVerification: true });
    // Replacing keeps one row per team.
    await owner.session.action(api.gateway_keys.set, { teamId, apiKey: `${KEY}xyz9`, skipVerification: true });
    const rows = await t.run((ctx) => ctx.db.query("team_gateway_keys").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].last4).toBe("xyz9");

    expect(await errorCode(other.session.mutation(api.gateway_keys.remove, { teamId }))).toBe("FORBIDDEN");
    await owner.session.mutation(api.gateway_keys.remove, { teamId });
    expect((await owner.session.query(api.gateway_keys.status, { leagueId, teamId })).hasKey).toBe(false);
    expect((await t.query(api.views.team, { teamId }))?.config.ownKey).toBe(false);
  });
});

describe("ledger — team weekly spend cap", () => {
  async function remaining(t: T, leagueId: Id<"leagues">, teamId: Id<"teams">) {
    return t.query(internal.ledger.remainingBudget, { leagueId, teamId, weekNo: 1 });
  }

  it("defaults to $2.00, honours the commissioner's figure, and null means no cap", async () => {
    const { t, commish, leagueId, teamId } = await fixture();
    expect(await remaining(t, leagueId, teamId)).toMatchObject({
      teamUsdCap: DEFAULT_WEEKLY_USD_CAP_PER_TEAM,
      teamUsdUsed: 0,
      teamUsdRemaining: DEFAULT_WEEKLY_USD_CAP_PER_TEAM,
      teamCapReached: false,
    });

    await commish.session.mutation(api.commissioner.setBudgets, { leagueId, weeklyUsdCapPerTeam: 5 });
    expect((await remaining(t, leagueId, teamId)).teamUsdCap).toBe(5);

    await commish.session.mutation(api.commissioner.setBudgets, { leagueId, weeklyUsdCapPerTeam: null });
    expect(await remaining(t, leagueId, teamId)).toMatchObject({ teamUsdCap: null, teamCapReached: false });

    expect(
      await errorCode(commish.session.mutation(api.commissioner.setBudgets, { leagueId, weeklyUsdCapPerTeam: -1 })),
    ).toBe("BAD_REQUEST");
  });

  it("reports the cap as reached once the week's rollup meets it", async () => {
    const { t, leagueId, teamId } = await fixture();
    await t.run(async (ctx) => {
      const league = (await ctx.db.get("leagues", leagueId))!;
      await ctx.db.insert("team_week_rollups", {
        leagueId,
        teamId,
        season: league.season,
        weekNo: 1,
        runCount: 3,
        stepCount: 9,
        inputTokens: 1000,
        outputTokens: 200,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        costUsd: 2.25,
        computedCostUsd: 2.25,
        gatewayCostUsd: 0,
        fallbackCount: 0,
        invalidActionCount: 0,
        updatedAt: Date.now(),
      });
    });
    const budget = await remaining(t, leagueId, teamId);
    expect(budget.teamUsdUsed).toBe(2.25);
    expect(budget.teamUsdRemaining).toBe(-0.25);
    expect(budget.teamCapReached).toBe(true);

    // Commissioner runs have no team and therefore no team cap.
    const commissionerRun = await t.query(internal.ledger.remainingBudget, { leagueId, weekNo: 1 });
    expect(commissionerRun.teamUsdCap).toBeNull();
    expect(commissionerRun.teamCapReached).toBe(false);
  });
});
