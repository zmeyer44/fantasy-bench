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
    expect(settings.catalog.some((entry) => entry.modelId === "anthropic/claude-opus-5")).toBe(
      true,
    );
    // Every team starts on the first model of the allowlist.
    expect(settings.modelsInUse).toEqual([
      { modelId: "anthropic/claude-opus-5", teamCount: teamIds.length },
    ]);
    // A league in `setup` with no rulesLockedAt is unlocked.
    expect(settings.locked).toBe(false);
  });

  it("carries the roster in waiver-priority order, with owner and model", async () => {
    const { t, commish, owner, leagueId, teamIds } = await fixture();
    // Make the first team the last on waivers: the list is ordered, not inserted.
    await t.run(async (ctx) => ctx.db.patch("teams", teamIds[0], { waiverPriority: 99 }));

    const { teams } = await commish.session.query(api.commissioner.settings, { leagueId });
    expect(teams).toHaveLength(teamIds.length);
    expect(teams.map((team) => team.waiverPriority)).toEqual(
      [...teams.map((team) => team.waiverPriority)].sort((a, b) => a - b),
    );
    expect(teams.at(-1)!.id).toBe(teamIds[0]);

    // `leagues.join` seated the owner on the first open team.
    const seated = teams.find((team) => team.ownerUserId === owner.userId)!;
    expect(seated.ownerName).toBe("Owner");
    expect(seated.ownerEmail).toBe("owner@fantasybench.dev");
    expect(seated.abbreviation.length).toBeGreaterThan(0);
    // Every team starts on the first model of the allowlist, at version 1.
    expect(seated.modelId).toBe("anthropic/claude-opus-5");
    expect(seated.configVersionNo).toBe(1);

    const unowned = teams.filter((team) => team.ownerUserId === null);
    expect(unowned.length).toBe(teamIds.length - 1);
    expect(unowned[0].ownerName).toBeNull();
    expect(unowned[0].ownerEmail).toBeNull();
  });

  it("counts the models teams actually run and reports the lock", async () => {
    const { t, commish, leagueId, teamIds } = await fixture();
    await t.run(async (ctx) => {
      const config = (await ctx.db
        .query("agent_configs")
        .withIndex("by_teamId", (q) => q.eq("teamId", teamIds[0]))
        .unique())!;
      await ctx.db.patch("config_versions", config.currentVersionId!, {
        modelId: "openai/gpt-5.6-sol",
      });
      await ctx.db.patch("leagues", leagueId, { status: "in_season", joinCode: "JOIN1234" });
    });

    const settings = await commish.session.query(api.commissioner.settings, { leagueId });
    expect(settings.modelsInUse).toEqual([
      { modelId: "anthropic/claude-opus-5", teamCount: teamIds.length - 1 },
      { modelId: "openai/gpt-5.6-sol", teamCount: 1 },
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

// ===========================================================================
// Commissioner mutations (Phase 3)
// ===========================================================================

async function rulesOf(t: T, leagueId: Id<"leagues">) {
  return t.run(async (ctx) =>
    ctx.db
      .query("league_rules")
      .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
      .unique(),
  );
}

async function changes(t: T, leagueId: Id<"leagues">) {
  return t.run(async (ctx) =>
    ctx.db
      .query("league_rule_changes")
      .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
      .order("desc")
      .take(200),
  );
}

/** The generated draft board, in overall pick order. */
async function draftPicks(t: T, leagueId: Id<"leagues">) {
  return t.run(async (ctx) =>
    ctx.db
      .query("draft_picks")
      .withIndex("by_leagueId_overallNo", (q) => q.eq("leagueId", leagueId))
      .take(500),
  );
}

async function lockRules(t: T, leagueId: Id<"leagues">) {
  const rules = (await rulesOf(t, leagueId))!;
  await t.run(async (ctx) => ctx.db.patch("league_rules", rules._id, { rulesLockedAt: Date.now() }));
}

describe("commissioner mutations — authorization", () => {
  it("every mutation is UNAUTHORIZED signed out and FORBIDDEN for a plain owner", async () => {
    const { t, owner, leagueId, teamIds } = await fixture();

    const calls: Array<[string, () => Promise<unknown>, () => Promise<unknown>]> = [
      [
        "updateRules",
        () => t.mutation(api.commissioner.updateRules, { leagueId, patch: { faabBudget: 120 } }),
        () =>
          owner.session.mutation(api.commissioner.updateRules, {
            leagueId,
            patch: { faabBudget: 120 },
          }),
      ],
      [
        "setModelAllowlist",
        () =>
          t.mutation(api.commissioner.setModelAllowlist, {
            leagueId,
            modelIds: ["mock/scripted"],
          }),
        () =>
          owner.session.mutation(api.commissioner.setModelAllowlist, {
            leagueId,
            modelIds: ["mock/scripted"],
          }),
      ],
      [
        "setBudgets",
        () => t.mutation(api.commissioner.setBudgets, { leagueId, leagueUsdHardCap: 10 }),
        () => owner.session.mutation(api.commissioner.setBudgets, { leagueId, leagueUsdHardCap: 10 }),
      ],
      [
        "setEditLock",
        () =>
          t.mutation(api.commissioner.setEditLock, {
            leagueId,
            editLock: { unlockDay: "tue", unlockTime: "06:00", lockDay: "wed", lockTime: "03:00" },
          }),
        () =>
          owner.session.mutation(api.commissioner.setEditLock, {
            leagueId,
            editLock: { unlockDay: "tue", unlockTime: "06:00", lockDay: "wed", lockTime: "03:00" },
          }),
      ],
      [
        "setWindowOverrides",
        () => t.mutation(api.commissioner.setWindowOverrides, { leagueId, windowOverrides: null }),
        () =>
          owner.session.mutation(api.commissioner.setWindowOverrides, {
            leagueId,
            windowOverrides: null,
          }),
      ],
      [
        "setTransparency",
        () => t.mutation(api.commissioner.setTransparency, { leagueId, transparencyMode: "delayed" }),
        () =>
          owner.session.mutation(api.commissioner.setTransparency, {
            leagueId,
            transparencyMode: "delayed",
          }),
      ],
      [
        "setInjectionPolicy",
        () =>
          t.mutation(api.commissioner.setInjectionPolicy, {
            leagueId,
            injectionPolicy: "prohibited",
          }),
        () =>
          owner.session.mutation(api.commissioner.setInjectionPolicy, {
            leagueId,
            injectionPolicy: "prohibited",
          }),
      ],
      [
        "setFallbacks",
        () => t.mutation(api.commissioner.setFallbacks, { leagueId, safetyAutopilot: false }),
        () =>
          owner.session.mutation(api.commissioner.setFallbacks, { leagueId, safetyAutopilot: false }),
      ],
      [
        "updateLeague",
        () => t.mutation(api.commissioner.updateLeague, { leagueId, isPublic: false }),
        () => owner.session.mutation(api.commissioner.updateLeague, { leagueId, isPublic: false }),
      ],
      [
        "rotateJoinCode",
        () => t.mutation(api.commissioner.rotateJoinCode, { leagueId }),
        () => owner.session.mutation(api.commissioner.rotateJoinCode, { leagueId }),
      ],
      [
        "startDraft",
        () => t.mutation(api.commissioner.startDraft, { leagueId }),
        () => owner.session.mutation(api.commissioner.startDraft, { leagueId }),
      ],
      [
        "assignOwner",
        () =>
          t.mutation(api.commissioner.assignOwner, { leagueId, teamId: teamIds[2], userId: null }),
        () =>
          owner.session.mutation(api.commissioner.assignOwner, {
            leagueId,
            teamId: teamIds[2],
            userId: null,
          }),
      ],
      [
        "assignOwnerByEmail",
        () =>
          t.mutation(api.commissioner.assignOwnerByEmail, {
            leagueId,
            teamId: teamIds[2],
            email: "owner@fantasybench.dev",
          }),
        () =>
          owner.session.mutation(api.commissioner.assignOwnerByEmail, {
            leagueId,
            teamId: teamIds[2],
            email: "owner@fantasybench.dev",
          }),
      ],
      [
        "renameTeam",
        () => t.mutation(api.commissioner.renameTeam, { leagueId, teamId: teamIds[2], name: "X Y" }),
        () =>
          owner.session.mutation(api.commissioner.renameTeam, {
            leagueId,
            teamId: teamIds[2],
            name: "X Y",
          }),
      ],
      [
        "replaceDeprecatedModel",
        () =>
          t.mutation(api.commissioner.replaceDeprecatedModel, {
            leagueId,
            fromModelId: "anthropic/claude-opus-5",
            toModelId: "google/gemini-3.8-flash",
          }),
        () =>
          owner.session.mutation(api.commissioner.replaceDeprecatedModel, {
            leagueId,
            fromModelId: "anthropic/claude-opus-5",
            toModelId: "google/gemini-3.8-flash",
          }),
      ],
    ];

    for (const [name, anon, asOwner] of calls) {
      expect([name, await errorCode(anon())]).toEqual([name, "UNAUTHORIZED"]);
      expect([name, await errorCode(asOwner())]).toEqual([name, "FORBIDDEN"]);
    }
  });
});

describe("commissioner.updateRules — immutability + change log", () => {
  it("logs every changed field before the lock", async () => {
    const { t, commish, leagueId } = await fixture();
    const result = await commish.session.mutation(api.commissioner.updateRules, {
      leagueId,
      patch: { scoringPreset: "half_ppr", faabBudget: 200 },
    });

    expect(result.changed.sort()).toEqual(["faabBudget", "scoringPreset"]);
    expect(result.rules.scoringPreset).toBe("half_ppr");
    expect(result.rules.faabBudget).toBe(200);
    expect(result.rejected).toEqual([]);

    const rows = await changes(t, leagueId);
    const fields = rows.map((row) => row.field);
    expect(fields).toContain("rules.scoringPreset");
    expect(fields).toContain("rules.faabBudget");

    const scoring = rows.find((row) => row.field === "rules.scoringPreset")!;
    expect(scoring.fromValue).toBe("ppr");
    expect(scoring.toValue).toBe("half_ppr");
    expect(scoring.userId).toBe(commish.userId);
  });

  it("does not log a no-op", async () => {
    const { t, commish, leagueId } = await fixture();
    const result = await commish.session.mutation(api.commissioner.updateRules, {
      leagueId,
      patch: { faabBudget: 100 },
    });
    expect(result.changed).toEqual([]);
    expect(await changes(t, leagueId)).toHaveLength(0);
  });

  it("freezes competitive rules once the draft begins, but not budgets or conduct", async () => {
    const { t, commish, leagueId } = await fixture();
    await lockRules(t, leagueId);

    for (const patch of [{ scoringPreset: "standard" as const }, { faabBudget: 500 }]) {
      let message = "";
      try {
        await commish.session.mutation(api.commissioner.updateRules, { leagueId, patch });
      } catch (error) {
        message = (error as { data?: { message?: string } }).data?.message ?? String(error);
      }
      expect(message).toMatch(/locked/i);
    }

    const budgets = await commish.session.mutation(api.commissioner.updateRules, {
      leagueId,
      patch: {
        leagueUsdHardCap: 25,
        transparencyMode: "delayed",
        injectionPolicy: "prohibited",
      },
    });
    expect(budgets.changed.sort()).toEqual([
      "injectionPolicy",
      "leagueUsdHardCap",
      "transparencyMode",
    ]);

    const capChange = (await changes(t, leagueId)).find(
      (row) => row.field === "rules.leagueUsdHardCap",
    )!;
    expect(capChange.note).toMatch(/after rules lock/);
  });

  it("rejects playoffs that start before the regular season ends", async () => {
    const { commish, leagueId } = await fixture();
    let message = "";
    try {
      await commish.session.mutation(api.commissioner.updateRules, {
        leagueId,
        patch: { regularSeasonWeeks: 14, playoffStartWeek: 12 },
      });
    } catch (error) {
      message = (error as { data?: { message?: string } }).data?.message ?? String(error);
    }
    expect(message).toMatch(/Playoffs must start/);
  });

  it("rejects out-of-range values the Zod schema used to catch", async () => {
    const { commish, leagueId } = await fixture();
    const bad: Array<Record<string, unknown>> = [
      { faabBudget: 1_001 },
      { playoffTeams: 9 },
      { maxStepsCap: 31 },
      { contextCharLimit: 100 },
      { rosterSlots: { QB: 0, RB: 0 } },
      { editLock: { unlockDay: "xyz", unlockTime: "06:00", lockDay: "wed", lockTime: "03:00" } },
      { editLock: { unlockDay: "tue", unlockTime: "6am", lockDay: "wed", lockTime: "03:00" } },
      { fairnessFloor: 3 },
      { modelAllowlist: [] },
    ];
    for (const patch of bad) {
      expect([
        JSON.stringify(patch),
        await errorCode(commish.session.mutation(api.commissioner.updateRules, { leagueId, patch })),
      ]).toEqual([JSON.stringify(patch), "BAD_REQUEST"]);
    }
  });
});

describe("commissioner.setModelAllowlist — pinned ids only", () => {
  it("rejects a `latest` alias, an unknown id and an empty list", async () => {
    const { commish, leagueId } = await fixture();
    const message = async (modelIds: string[]) => {
      try {
        await commish.session.mutation(api.commissioner.setModelAllowlist, { leagueId, modelIds });
        return "";
      } catch (error) {
        return (error as { data?: { message?: string } }).data?.message ?? String(error);
      }
    };
    expect(await message(["anthropic/claude-sonnet-latest"])).toMatch(/alias|pinned/i);
    expect(await message(["openai/gpt-latest"])).toMatch(/alias|pinned/i);
    expect(await message(["acme/does-not-exist"])).toMatch(/not a known model/i);
    expect(await message([])).toMatch(/at least one model/i);
  });

  it("accepts pinned catalog ids and mock ids, de-duplicated, and logs the change", async () => {
    const { t, commish, leagueId } = await fixture();
    const rules = await commish.session.mutation(api.commissioner.setModelAllowlist, {
      leagueId,
      modelIds: ["anthropic/claude-opus-5", "anthropic/claude-opus-5", "mock/scripted"],
    });
    expect(rules.modelAllowlist).toEqual(["anthropic/claude-opus-5", "mock/scripted"]);
    expect((await changes(t, leagueId)).some((row) => row.field === "rules.modelAllowlist")).toBe(
      true,
    );
  });
});

describe("commissioner.setBudgets / setEditLock / setWindowOverrides / setFallbacks", () => {
  it("clears a cap when passed null and round-trips the other setters", async () => {
    const { commish, leagueId } = await fixture();
    await commish.session.mutation(api.commissioner.setBudgets, { leagueId, leagueUsdHardCap: 10 });
    const cleared = await commish.session.mutation(api.commissioner.setBudgets, {
      leagueId,
      leagueUsdHardCap: null,
    });
    expect(cleared.leagueUsdHardCap).toBeUndefined();

    const locked = await commish.session.mutation(api.commissioner.setEditLock, {
      leagueId,
      editLock: { unlockDay: "thu", unlockTime: "07:30", lockDay: "sat", lockTime: "11:00" },
    });
    expect(locked.editLock).toEqual({
      unlockDay: "thu",
      unlockTime: "07:30",
      lockDay: "sat",
      lockTime: "11:00",
    });

    const overrides = await commish.session.mutation(api.commissioner.setWindowOverrides, {
      leagueId,
      windowOverrides: { lineup_sun_early: { enabled: false, rounds: 2 } },
    });
    expect(overrides.windowOverrides).toEqual({ lineup_sun_early: { enabled: false, rounds: 2 } });
    const removed = await commish.session.mutation(api.commissioner.setWindowOverrides, {
      leagueId,
      windowOverrides: null,
    });
    expect(removed.windowOverrides).toBeUndefined();

    const fallbacks = await commish.session.mutation(api.commissioner.setFallbacks, {
      leagueId,
      fallbackModelId: "openai/gpt-5.6-sol",
      safetyAutopilot: false,
    });
    expect(fallbacks.fallbackModelId).toBe("openai/gpt-5.6-sol");
    expect(fallbacks.safetyAutopilot).toBe(false);

    const transparency = await commish.session.mutation(api.commissioner.setTransparency, {
      leagueId,
      transparencyMode: "delayed",
    });
    expect(transparency.transparencyMode).toBe("delayed");
    const injection = await commish.session.mutation(api.commissioner.setInjectionPolicy, {
      leagueId,
      injectionPolicy: "prohibited",
    });
    expect(injection.injectionPolicy).toBe("prohibited");
  });

  it("refuses an unpinned fallback model", async () => {
    const { commish, leagueId } = await fixture();
    expect(
      await errorCode(
        commish.session.mutation(api.commissioner.setFallbacks, {
          leagueId,
          fallbackModelId: "anthropic/claude-sonnet-latest",
        }),
      ),
    ).toBe("BAD_REQUEST");
  });
});

describe("commissioner.updateLeague", () => {
  it("renames, flips visibility and logs each field", async () => {
    const { t, commish, leagueId } = await fixture();
    const updated = await commish.session.mutation(api.commissioner.updateLeague, {
      leagueId,
      name: "  Renamed League  ",
      isPublic: false,
    });
    expect(updated.name).toBe("Renamed League");
    expect(updated.isPublic).toBe(false);

    const fields = (await changes(t, leagueId)).map((row) => row.field);
    expect(fields).toContain("league.name");
    expect(fields).toContain("league.isPublic");
  });

  it("rejects a name outside 3-60 characters and freezes the draft format after the lock", async () => {
    const { commish, leagueId } = await fixture();
    expect(
      await errorCode(commish.session.mutation(api.commissioner.updateLeague, { leagueId, name: "ab" })),
    ).toBe("BAD_REQUEST");

    await commish.session.mutation(api.commissioner.updateLeague, {
      leagueId,
      draftType: "auction",
    });
    await commish.session.mutation(api.commissioner.startDraft, { leagueId });

    let message = "";
    try {
      await commish.session.mutation(api.commissioner.updateLeague, {
        leagueId,
        draftType: "snake",
      });
    } catch (error) {
      message = (error as { data?: { message?: string } }).data?.message ?? String(error);
    }
    expect(message).toMatch(/draft format cannot change/i);
  });
});

describe("commissioner.rotateJoinCode + leagues.joinByCode", () => {
  it("mints a code where there is none, rotates it, and the code joins a league", async () => {
    const { t, commish, outsider, leagueId, teamIds } = await fixture();
    expect((await commish.session.query(api.commissioner.inviteLink, { leagueId })).code).toBeNull();

    const first = await commish.session.mutation(api.commissioner.rotateJoinCode, { leagueId });
    expect(first.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(first.url).toContain(`/leagues/join/${first.code}`);
    expect((await commish.session.query(api.commissioner.inviteLink, { leagueId })).code).toBe(
      first.code,
    );

    const second = await commish.session.mutation(api.commissioner.rotateJoinCode, { leagueId });
    expect(second.code).not.toBe(first.code);
    // The old link is dead.
    expect(await t.query(api.leagues.byJoinCode, { code: first.code })).toBeNull();

    // Team 1 is already claimed by `owner`, so the newcomer gets team 2.
    const joined = await outsider.session.mutation(api.leagues.joinByCode, { code: second.code });
    expect(joined.leagueId).toBe(leagueId);
    expect(joined.teamId).toBe(teamIds[1]);

    // Idempotent: joining twice returns the same team, not a second membership.
    const again = await outsider.session.mutation(api.leagues.joinByCode, { code: second.code });
    expect(again.teamId).toBe(joined.teamId);
    expect(again.membershipId).toBe(joined.membershipId);

    const rotations = (await changes(t, leagueId)).filter((row) => row.field === "league.joinCode");
    expect(rotations).toHaveLength(2);
    expect(rotations[0].toValue).toBe("(rotated)");
  });
});

describe("commissioner team management", () => {
  it("assigns and unassigns an owner, logging both, and refuses two teams per user", async () => {
    const { t, commish, outsider, leagueId, teamIds } = await fixture();

    await commish.session.mutation(api.commissioner.assignOwner, {
      leagueId,
      teamId: teamIds[2],
      userId: outsider.userId,
    });
    expect((await t.run(async (ctx) => ctx.db.get("teams", teamIds[2])))?.ownerUserId).toBe(
      outsider.userId,
    );

    let message = "";
    try {
      await commish.session.mutation(api.commissioner.assignOwner, {
        leagueId,
        teamId: teamIds[3],
        userId: outsider.userId,
      });
    } catch (error) {
      message = (error as { data?: { message?: string } }).data?.message ?? String(error);
    }
    expect(message).toMatch(/already owns/i);

    await commish.session.mutation(api.commissioner.assignOwner, {
      leagueId,
      teamId: teamIds[2],
      userId: null,
    });
    expect(
      (await t.run(async (ctx) => ctx.db.get("teams", teamIds[2])))?.ownerUserId,
    ).toBeUndefined();

    expect((await changes(t, leagueId)).filter((row) => row.field.endsWith(".owner"))).toHaveLength(
      2,
    );
  });

  it("assigns by email and explains an unknown address", async () => {
    const { t, commish, outsider, leagueId, teamIds } = await fixture();
    const assigned = await commish.session.mutation(api.commissioner.assignOwnerByEmail, {
      leagueId,
      teamId: teamIds[2],
      email: "  Outsider@fantasybench.dev ",
    });
    expect(assigned.ownerUserId).toBe(outsider.userId);

    let message = "";
    try {
      await commish.session.mutation(api.commissioner.assignOwnerByEmail, {
        leagueId,
        teamId: teamIds[3],
        email: "nobody@fantasybench.dev",
      });
    } catch (error) {
      message = (error as { data?: { message?: string } }).data?.message ?? String(error);
    }
    expect(message).toMatch(/No Fantasy Bench account/);
    expect(await t.run(async (ctx) => ctx.db.get("teams", teamIds[3]))).toMatchObject({
      name: "Team 4",
    });
  });

  it("renames a team, uppercases the abbreviation, and rejects a duplicate name", async () => {
    const { commish, leagueId, teamIds } = await fixture();
    const renamed = await commish.session.mutation(api.commissioner.renameTeam, {
      leagueId,
      teamId: teamIds[0],
      name: "  The Gradient Descenders ",
      abbreviation: "grad",
    });
    expect(renamed.name).toBe("The Gradient Descenders");
    expect(renamed.abbreviation).toBe("GRAD");

    let message = "";
    try {
      await commish.session.mutation(api.commissioner.renameTeam, {
        leagueId,
        teamId: teamIds[1],
        name: "The Gradient Descenders",
      });
    } catch (error) {
      message = (error as { data?: { message?: string } }).data?.message ?? String(error);
    }
    expect(message).toMatch(/already has that name/i);
  });

  it("refuses a team from another league", async () => {
    const { commish, leagueId, t } = await fixture();
    const elsewhere = await t.mutation(internal.leagues.createLeague, {
      name: "Elsewhere",
      commissionerUserId: commish.userId,
      teamCount: 8,
      season: 2026,
    });
    expect(
      await errorCode(
        commish.session.mutation(api.commissioner.renameTeam, {
          leagueId,
          teamId: elsewhere.teamIds[0],
          name: "Poached",
        }),
      ),
    ).toBe("NOT_FOUND");
  });
});

describe("commissioner.startDraft", () => {
  it("generates the board, locks the rules, flips the status and logs it; a second call is refused", async () => {
    const { t, commish, leagueId, teamIds } = await fixture();
    const result = await commish.session.mutation(api.commissioner.startDraft, { leagueId });
    expect(result.status).toBe("drafting");
    expect(result.scheduledAt).toBeGreaterThan(0);

    // `internal.draft.start` (package G) wrote the board: one `draft_picks` row
    // per (team, roster slot), i.e. teams x roster size, numbered 1..N overall.
    const rules = (await rulesOf(t, leagueId))!;
    const rosterSize = Object.values(rules.rosterSlots).reduce((sum, n) => sum + n, 0);
    const picks = await draftPicks(t, leagueId);
    expect(result.boardGenerated).toBe(true);
    expect(picks).toHaveLength(teamIds.length * rosterSize);
    expect(result.pickCount).toBe(teamIds.length * rosterSize);
    expect(result.orderCount).toBe(teamIds.length);
    expect(picks.map((pick) => pick.overallNo)).toEqual(
      picks.map((_, index) => index + 1),
    );
    // Every team drafts once per round.
    expect(new Set(picks.filter((pick) => pick.round === 1).map((pick) => pick.teamId)).size).toBe(
      teamIds.length,
    );

    const league = await t.run(async (ctx) => ctx.db.get("leagues", leagueId));
    expect(league?.status).toBe("drafting");
    expect(league?.draftScheduledAt).toBe(result.scheduledAt);
    expect((await rulesOf(t, leagueId))?.rulesLockedAt).not.toBeUndefined();

    const statusChange = (await changes(t, leagueId)).find((row) => row.field === "league.status")!;
    expect(statusChange.toValue).toBe("drafting");
    expect(statusChange.note).toMatch(/unowned team|rules locked/);

    let message = "";
    try {
      await commish.session.mutation(api.commissioner.startDraft, { leagueId });
    } catch (error) {
      message = (error as { data?: { message?: string } }).data?.message ?? String(error);
    }
    expect(message).toMatch(/already started/i);

    let locked = "";
    try {
      await commish.session.mutation(api.commissioner.updateRules, {
        leagueId,
        patch: { superflex: true },
      });
    } catch (error) {
      locked = (error as { data?: { message?: string } }).data?.message ?? String(error);
    }
    expect(locked).toMatch(/locked/i);
  });

  it("honours an explicit scheduledAt", async () => {
    const { commish, leagueId } = await fixture();
    const when = Date.UTC(2026, 8, 10, 18, 0, 0);
    const result = await commish.session.mutation(api.commissioner.startDraft, {
      leagueId,
      scheduledAt: when,
    });
    expect(result.scheduledAt).toBe(when);
  });
});

describe("commissioner.replaceDeprecatedModel", () => {
  it("creates a new immutable version per affected team and logs league-wide", async () => {
    const { t, commish, leagueId, teamIds } = await fixture();
    const before = await t.query(internal.configs.currentForTeam, { teamId: teamIds[0] });
    const fromModelId = before!.modelId;
    const toModelId = "google/gemini-3.8-flash";
    expect(fromModelId).not.toBe(toModelId);

    const result = await commish.session.mutation(api.commissioner.replaceDeprecatedModel, {
      leagueId,
      fromModelId,
      toModelId,
    });
    expect(result.teamsUpdated).toHaveLength(teamIds.length);
    expect(result.allowlistUpdated).toBe(true);

    for (const teamId of teamIds) {
      const version = await t.query(internal.configs.currentForTeam, { teamId });
      expect(version?.modelId).toBe(toModelId);
      expect(version?.versionNo).toBe(2);
      expect(version?.changeSummary).toBe("commissioner replacement");
      expect(version?.contextMd).toBe(before!.contextMd);
      expect(version?.appliedAt).not.toBeUndefined();
    }

    const rules = (await rulesOf(t, leagueId))!;
    expect(rules.modelAllowlist).not.toContain(fromModelId);
    expect(rules.modelAllowlist).toContain(toModelId);

    const swap = (await changes(t, leagueId)).find(
      (row) => row.field === "models.replaceDeprecated",
    )!;
    expect(swap.fromValue).toBe(fromModelId);
    expect(swap.toValue).toBe(toModelId);
    expect(swap.note).toMatch(/commissioner replacement/);

    // Version 1 is untouched — config versions are immutable.
    const v1 = await t.run(async (ctx) =>
      ctx.db
        .query("config_versions")
        .withIndex("by_configId_versionNo", (q) => q.eq("configId", before!.configId).eq("versionNo", 1))
        .unique(),
    );
    expect(v1?.modelId).toBe(fromModelId);
  });

  it("rejects an unpinned replacement and a no-op swap", async () => {
    const { commish, leagueId } = await fixture();
    const message = async (fromModelId: string, toModelId: string) => {
      try {
        await commish.session.mutation(api.commissioner.replaceDeprecatedModel, {
          leagueId,
          fromModelId,
          toModelId,
        });
        return "";
      } catch (error) {
        return (error as { data?: { message?: string } }).data?.message ?? String(error);
      }
    };
    expect(await message("anthropic/claude-opus-5", "anthropic/claude-sonnet-latest")).toMatch(
      /alias|pinned/i,
    );
    expect(await message("mock/scripted", "mock/scripted")).toMatch(/different replacement/i);
  });

  it("leaves teams on other models alone", async () => {
    const { t, commish, leagueId, teamIds } = await fixture();
    const result = await commish.session.mutation(api.commissioner.replaceDeprecatedModel, {
      leagueId,
      fromModelId: "spacexai/grok-4.6",
      toModelId: "openai/gpt-5.6-sol",
    });
    expect(result.teamsUpdated).toHaveLength(0);
    const version = await t.query(internal.configs.currentForTeam, { teamId: teamIds[0] });
    expect(version?.versionNo).toBe(1);
  });
});

describe("commissioner.assignOwner membership", () => {
  it("makes an assigned owner a league member so owner-only paths accept them", async () => {
    const { t, commish, outsider, leagueId, teamIds } = await fixture();
    await commish.session.mutation(api.commissioner.assignOwner, {
      leagueId,
      teamId: teamIds[3],
      userId: outsider.userId,
    });
    const membership = await t.run(async (ctx) =>
      ctx.db
        .query("league_members")
        .withIndex("by_leagueId_userId", (q) => q.eq("leagueId", leagueId).eq("userId", outsider.userId))
        .unique(),
    );
    expect(membership?.role).toBe("owner");
    // The new owner can now read their config through the member-gated path.
    const me = await outsider.session.query(api.users.me, {});
    expect(me?.memberships.some((m) => m.leagueId === leagueId && m.teamId === teamIds[3])).toBe(true);
    // Re-assigning does not duplicate the membership.
    await commish.session.mutation(api.commissioner.assignOwner, {
      leagueId,
      teamId: teamIds[3],
      userId: outsider.userId,
    });
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("league_members")
        .withIndex("by_leagueId_userId", (q) => q.eq("leagueId", leagueId).eq("userId", outsider.userId))
        .collect(),
    );
    expect(rows).toHaveLength(1);
  });
});
