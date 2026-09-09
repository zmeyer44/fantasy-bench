import { describe, expect, test, vi, afterEach } from "vitest";
import { internal, api } from "./_generated/api";
import { makeTest, seedFixture, NOW } from "./runtime/fixtures.test";

async function setup() {
  const t = makeTest();
  const fx = await seedFixture(t, { runStatus: "running" });
  await t.run(async (ctx) => {
    await ctx.db.patch("windows", fx.windowId, {
      status: "open",
      closesAt: Date.now() + 3600000,
    });
  });
  const agentCtx = {
    runId: fx.runId,
    windowId: fx.windowId,
    weekNo: 5,
    stepIndex: 0,
    toolCallId: "identity-1",
  };
  return { t, fx, agentCtx };
}

afterEach(() => vi.unstubAllEnvs());

describe("team identity", () => {
  test("renames only the run's team and records exactly one action on replay", async () => {
    const { t, fx, agentCtx } = await setup();
    const args = {
      agentCtx,
      name: "  Lime Lightning  ",
      abbreviation: "lime",
      avatarTemplate: "bolt",
    };
    expect(await t.mutation(internal.team_identity.update, args)).toEqual({
      ok: true,
      status: "updated",
    });
    expect(await t.mutation(internal.team_identity.update, args)).toEqual({
      ok: true,
      status: "updated",
    });
    const team = await t.run((ctx) => ctx.db.get("teams", fx.teamAId));
    expect(team).toMatchObject({
      name: "Lime Lightning",
      abbreviation: "LIME",
      avatarTemplate: "bolt",
      identityRunId: fx.runId,
    });
    expect((await t.run((ctx) => ctx.db.get("teams", fx.teamBId)))?.name).toBe(
      "Team B",
    );
    const actions = await t.run((ctx) =>
      ctx.db
        .query("run_actions")
        .withIndex("by_runId_toolCallId", (q) => q.eq("runId", fx.runId))
        .take(10),
    );
    expect(actions).toHaveLength(1);
  });

  test("invalid identity, spoofed windows and terminal runs cannot change a team", async () => {
    const { t, fx, agentCtx } = await setup();
    expect(
      await t.mutation(internal.team_identity.update, {
        agentCtx,
        avatarTemplate: "unknown",
        name: "Changed",
      }),
    ).toMatchObject({ ok: false });
    expect((await t.run((ctx) => ctx.db.get("teams", fx.teamAId)))?.name).toBe(
      "Team A",
    );
    await t.run((ctx) =>
      ctx.db.patch("runs", fx.runId, { status: "succeeded" }),
    );
    expect(
      await t.mutation(internal.team_identity.update, {
        agentCtx: { ...agentCtx, toolCallId: "terminal" },
        name: "Changed",
      }),
    ).toMatchObject({ ok: false });
    expect(
      await t.mutation(internal.team_identity.update, {
        agentCtx: { ...agentCtx, toolCallId: "wrong-week", weekNo: 6 },
        name: "Changed",
      }),
    ).toMatchObject({ ok: false });
  });

  test("unconfigured generation preserves the previous identity", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "");
    const { t, fx, agentCtx } = await setup();
    expect(
      await t.mutation(internal.team_identity.update, {
        agentCtx,
        name: "Changed",
        avatarPrompt: "A wolf",
      }),
    ).toMatchObject({ ok: false });
    expect((await t.run((ctx) => ctx.db.get("teams", fx.teamAId)))?.name).toBe(
      "Team A",
    );
  });

  test("job claims deduplicate and stale results cannot replace a chosen template", async () => {
    const { t, fx, agentCtx } = await setup();
    await t.run((ctx) =>
      ctx.db.patch("teams", fx.teamAId, {
        avatarRequestKey: "job",
        avatarStatus: "generating",
        avatarRequestedAt: NOW,
      }),
    );
    expect(
      await t.mutation(internal.team_identity.claim, {
        teamId: fx.teamAId,
        requestKey: "job",
      }),
    ).toBe(true);
    expect(
      await t.mutation(internal.team_identity.claim, {
        teamId: fx.teamAId,
        requestKey: "job",
      }),
    ).toBe(false);
    await t.mutation(internal.team_identity.update, {
      agentCtx,
      avatarTemplate: "wolf",
    });
    await t.mutation(internal.team_identity.finish, {
      teamId: fx.teamAId,
      requestKey: "job",
      error: "Old failure",
    });
    expect(await t.run((ctx) => ctx.db.get("teams", fx.teamAId))).toMatchObject(
      { avatarTemplate: "wolf" },
    );
    expect(
      (await t.run((ctx) => ctx.db.get("teams", fx.teamAId)))?.avatarStatus,
    ).toBeUndefined();
  });

  test("available players exclude current rosters even if snapshot ownership is stale", async () => {
    const { t, fx } = await setup();
    const before = await t.query(api.waivers.available, {
      leagueId: fx.leagueId,
    });
    expect(before.players.length).toBeGreaterThan(0);
    const player = before.players[0];
    await t.run(async (ctx) => {
      const id = ctx.db.normalizeId("players", player.id)!;
      await ctx.db.insert("roster_slots", {
        leagueId: fx.leagueId,
        teamId: fx.teamAId,
        playerId: id,
        acquiredAt: NOW,
        acquiredVia: "waiver",
      });
    });
    const after = await t.query(api.waivers.available, {
      leagueId: fx.leagueId,
    });
    expect(after.players.some((row) => row.id === player.id)).toBe(false);
  });
});
