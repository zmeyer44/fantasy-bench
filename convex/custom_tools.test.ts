/**
 * Team-scoped custom tools: registration, redaction of header values for
 * non-editors, the `custom_<slug>` naming the runtime uses, and removal.
 */
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { COOLDOWN_MS } from "./lib/visibility";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

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
    name: "Tools League",
    commissionerUserId: commish.userId,
    teamCount: 8,
    season: 2026,
  });
  await owner.session.mutation(api.leagues.join, { leagueId });
  await other.session.mutation(api.leagues.join, { leagueId });
  return { t, commish, owner, other, leagueId, teamId: teamIds[0] as Id<"teams"> };
}

const DRAFT = {
  name: "Weather Feed",
  description: "Game-time weather for every stadium.",
  url: "https://example.com/weather",
  method: "GET" as const,
  headers: [{ name: "X-Api-Key", value: "secret-123" }],
  jsonPath: "data.games",
};

describe("custom_tools", () => {
  it("owner registers a tool; the league sees it, but only editors see header values", async () => {
    const { owner, other, commish, leagueId, teamId, t } = await fixture();
    const toolId = await owner.session.mutation(api.custom_tools.create, { leagueId, teamId, ...DRAFT });

    const mine = await owner.session.query(api.custom_tools.listForTeam, { leagueId, teamId });
    expect(mine.canEdit).toBe(true);
    expect(mine.tools).toHaveLength(1);
    expect(mine.tools[0]).toMatchObject({
      id: toolId,
      toolName: "custom_weather_feed",
      enabled: true,
      inherited: false,
      headers: [{ name: "X-Api-Key", value: "secret-123" }],
      modelDescription: expect.stringContaining("Game-time weather for every stadium."),
    });

    // Another owner sees nothing for three weeks, then the tool minus its header values.
    const hidden = await other.session.query(api.custom_tools.listForTeam, { leagueId, teamId });
    expect(hidden.canEdit).toBe(false);
    expect(hidden.tools).toEqual([]);
    expect(hidden.hidden).toEqual({ count: 1, revealAt: mine.tools[0].revealAt });

    await t.run((ctx) =>
      ctx.db.patch("custom_providers", toolId, { updatedAt: Date.now() - COOLDOWN_MS - 1 }),
    );
    const theirs = await other.session.query(api.custom_tools.listForTeam, { leagueId, teamId });
    expect(theirs.hidden.count).toBe(0);
    expect(theirs.tools[0].headers).toEqual([{ name: "X-Api-Key", value: null }]);

    const commissioners = await commish.session.query(api.custom_tools.listForTeam, { leagueId, teamId });
    expect(commissioners.canEdit).toBe(true);

    // The row is exactly what the runtime loader reads.
    const row = await t.run((ctx) => ctx.db.get("custom_providers", toolId));
    expect(row).toMatchObject({ teamId, leagueId, slug: "weather_feed", enabled: true });
    expect(row?.config).toEqual({
      url: DRAFT.url,
      method: "GET",
      headers: { "X-Api-Key": "secret-123" },
      jsonPath: "data.games",
      description: DRAFT.description,
    });
  });

  it("only the owner or commissioner may write, and names must be unique per team", async () => {
    const { owner, other, commish, leagueId, teamId, t } = await fixture();
    expect(await errorCode(t.mutation(api.custom_tools.create, { leagueId, teamId, ...DRAFT }))).toBe("UNAUTHORIZED");
    expect(await errorCode(other.session.mutation(api.custom_tools.create, { leagueId, teamId, ...DRAFT }))).toBe("FORBIDDEN");

    const toolId = await commish.session.mutation(api.custom_tools.create, { leagueId, teamId, ...DRAFT });
    expect(
      await errorCode(owner.session.mutation(api.custom_tools.create, { leagueId, teamId, ...DRAFT, name: "weather feed!" })),
    ).toBe("CONFLICT");
    expect(
      await errorCode(owner.session.mutation(api.custom_tools.create, { leagueId, teamId, ...DRAFT, name: "Bad", url: "ftp://x" })),
    ).toBe("BAD_REQUEST");
    expect(
      await errorCode(owner.session.mutation(api.custom_tools.create, {
        leagueId,
        teamId,
        ...DRAFT,
        name: "Plain HTTP",
        url: "http://api.example.com/weather",
      })),
    ).toBe("BAD_REQUEST");
    expect(
      await errorCode(owner.session.mutation(api.custom_tools.create, {
        leagueId,
        teamId,
        ...DRAFT,
        name: "Embedded credentials",
        url: "https://user:secret@api.example.com/weather",
      })),
    ).toBe("BAD_REQUEST");
    expect(
      await errorCode(owner.session.mutation(api.custom_tools.create, {
        leagueId,
        teamId,
        ...DRAFT,
        name: "Header newline",
        headers: [{ name: "Authorization", value: "Bearer safe\r\nX-Injected: yes" }],
      })),
    ).toBe("BAD_REQUEST");

    expect(await errorCode(other.session.mutation(api.custom_tools.setEnabled, { toolId, enabled: false }))).toBe("FORBIDDEN");
    await owner.session.mutation(api.custom_tools.setEnabled, { toolId, enabled: false });
    expect((await t.run((ctx) => ctx.db.get("custom_providers", toolId)))?.enabled).toBe(false);
  });

  it("update rewrites the definition and remove deletes the row", async () => {
    const { owner, leagueId, teamId, t } = await fixture();
    const toolId = await owner.session.mutation(api.custom_tools.create, { leagueId, teamId, ...DRAFT });
    await owner.session.mutation(api.custom_tools.update, {
      toolId,
      ...DRAFT,
      name: "Weather v2",
      method: "POST",
      headers: [],
      jsonPath: "",
    });
    const row = await t.run((ctx) => ctx.db.get("custom_providers", toolId));
    expect(row?.slug).toBe("weather_v2");
    expect(row?.config).toEqual({ url: DRAFT.url, method: "POST", description: DRAFT.description });

    await owner.session.mutation(api.custom_tools.remove, { toolId });
    expect(await t.run((ctx) => ctx.db.get("custom_providers", toolId))).toBeNull();
    const list = await owner.session.query(api.custom_tools.listForTeam, { leagueId, teamId });
    expect(list.tools).toEqual([]);
  });

  it("the team page counts enabled custom tools", async () => {
    const { owner, leagueId, teamId, t } = await fixture();
    await owner.session.mutation(api.custom_tools.create, { leagueId, teamId, ...DRAFT });
    const second = await owner.session.mutation(api.custom_tools.create, {
      leagueId,
      teamId,
      ...DRAFT,
      name: "Vegas lines",
    });
    await owner.session.mutation(api.custom_tools.setEnabled, { toolId: second, enabled: false });
    const view = await owner.session.query(api.views.team, { teamId });
    expect(view?.config.customTools).toEqual(["Weather Feed"]);
    // Hidden from the league until each tool's own cooldown passes.
    expect((await t.query(api.views.team, { teamId }))?.config.customTools).toEqual([]);
  });
});
