/**
 * League read/write parity + the authorization ladder (`lib/trpc/init.ts`).
 *
 * The ladder under test: a public league is readable signed out (spectators),
 * a private league is UNAUTHORIZED signed out and FORBIDDEN for a signed-in
 * non-member, and members read either.
 */
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { DEFAULT_AGENT_CONTEXT, DEFAULT_HARNESS } from "./lib/defaults";
import schema from "./schema";
import goldenRules from "../tests/golden/postgres-week1/league_rules.json";
import goldenTeams from "../tests/golden/postgres-week1/teams.json";
import goldenVersions from "../tests/golden/postgres-week1/config_versions.json";
import goldenWeeks from "../tests/golden/postgres-week1/weeks.json";

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

// ===========================================================================
// leagues.create (Phase 3)
// ===========================================================================

/** Only `Date` is faked: convex-test's own awaits still need real timers. */
function freeze(at: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(at));
}

describe("leagues.create — authorization + validation", () => {
  afterEach(() => vi.useRealTimers());

  it("is UNAUTHORIZED signed out", async () => {
    const t = newTest();
    expect(await errorCode(t.mutation(api.leagues.create, { name: "Nobody's League" }))).toBe(
      "UNAUTHORIZED",
    );
  });

  it("rejects a short name, a bad team count and an out-of-range FAAB budget", async () => {
    const t = newTest();
    const me = await actor(t, "Founder", "founder@fantasybench.dev");
    expect(await errorCode(me.session.mutation(api.leagues.create, { name: "ab" }))).toBe(
      "BAD_REQUEST",
    );
    expect(
      await errorCode(me.session.mutation(api.leagues.create, { name: "Fine", teamCount: 7 })),
    ).toBe("BAD_REQUEST");
    expect(
      await errorCode(me.session.mutation(api.leagues.create, { name: "Fine", teamCount: 15 })),
    ).toBe("BAD_REQUEST");
    expect(
      await errorCode(me.session.mutation(api.leagues.create, { name: "Fine", faabBudget: 2_000 })),
    ).toBe("BAD_REQUEST");
  });
});

describe("leagues.create — the skeleton", () => {
  afterEach(() => vi.useRealTimers());

  it("creates league, rules, membership, weeks, teams and default configs", async () => {
    freeze("2026-09-08T14:00:00.000Z");
    const t = newTest();
    const me = await actor(t, "Founder", "founder@fantasybench.dev");

    const { leagueId, slug } = await me.session.mutation(api.leagues.create, {
      name: "My Cool League",
      teamCount: 10,
      scoringPreset: "half_ppr",
      draftType: "auction",
      isPublic: false,
      superflex: true,
      tePremium: true,
      faabBudget: 250,
    });
    expect(slug).toBe("my-cool-league");

    const view = await me.session.query(api.leagues.get, { leagueId });
    expect(view.league).toMatchObject({
      name: "My Cool League",
      slug: "my-cool-league",
      season: 2026,
      teamCount: 10,
      isPublic: false,
      status: "setup",
      draftType: "auction",
      commissionerUserId: me.userId,
    });
    expect(view.role).toBe("commissioner");
    expect(view.isCommissioner).toBe(true);

    expect(view.rules).toMatchObject({
      scoringPreset: "half_ppr",
      superflex: true,
      tePremium: true,
      faabBudget: 250,
      seasonWeeks: 17,
      regularSeasonWeeks: 14,
      playoffStartWeek: 15,
      fallbackModelId: "anthropic/claude-haiku-4.5",
    });

    expect(view.teams).toHaveLength(10);
    expect(view.teams.map((team) => team.waiverPriority)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    expect(view.teams.every((team) => team.faabRemaining === 250)).toBe(true);
    expect(view.teams.every((team) => team.ownerUserId === undefined)).toBe(true);

    const { weeks, configs, versions } = await t.run(async (ctx) => ({
      weeks: await ctx.db
        .query("weeks")
        .withIndex("by_leagueId_weekNo", (q) => q.eq("leagueId", leagueId))
        .collect(),
      configs: await ctx.db
        .query("agent_configs")
        .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
        .collect(),
      versions: await ctx.db
        .query("config_versions")
        .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
        .collect(),
    }));

    expect(weeks).toHaveLength(17);
    expect(configs).toHaveLength(10);
    expect(versions).toHaveLength(10);
    expect(versions.every((row) => row.versionNo === 1)).toBe(true);
    // The starting model is the first entry of the league's allowlist.
    expect(new Set(versions.map((row) => row.modelId))).toEqual(
      new Set([view.rules!.modelAllowlist[0]]),
    );
    expect(configs.every((c) => c.currentVersionId !== undefined)).toBe(true);
  });

  it("mints an invite code the join page can resolve", async () => {
    const t = newTest();
    const me = await actor(t, "Founder", "founder@fantasybench.dev");
    const joiner = await actor(t, "Joiner", "joiner@fantasybench.dev");

    const { leagueId } = await me.session.mutation(api.leagues.create, {
      name: "Coded League",
      teamCount: 8,
      isPublic: false,
    });
    const league = await t.run(async (ctx) => ctx.db.get("leagues", leagueId));
    expect(league?.joinCode).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);

    const summary = await t.query(api.leagues.byJoinCode, { code: league!.joinCode! });
    expect(summary?.leagueId).toBe(leagueId);
    expect(summary?.openTeamCount).toBe(8);

    const joined = await joiner.session.mutation(api.leagues.joinByCode, {
      code: league!.joinCode!,
    });
    expect(joined.teamId).not.toBeNull();
  });

  it("suffixes a slug that is already taken", async () => {
    const t = newTest();
    const a = await actor(t, "A", "a@fantasybench.dev");
    const b = await actor(t, "B", "b@fantasybench.dev");
    expect((await a.session.mutation(api.leagues.create, { name: "Same Name" })).slug).toBe(
      "same-name",
    );
    expect((await b.session.mutation(api.leagues.create, { name: "Same Name" })).slug).toBe(
      "same-name-2",
    );
  });
});

// ---------------------------------------------------------------------------
// Golden-dataset parity: a fresh league's deterministic rows must match the
// skeleton `scripts/seed-demo.ts` produced in Postgres, field for field. Fields
// the demo seed overrode afterwards (team names, the narrowed model allowlist,
// the demo's own model id, rulesLockedAt) are excluded and listed below.
// ---------------------------------------------------------------------------

type GoldenRules = Record<string, unknown>;
const rulesRow = (goldenRules as GoldenRules[])[0];

describe("leagues.create — golden-league parity", () => {
  afterEach(() => vi.useRealTimers());

  it("produces rules, teams, weeks and config versions identical to the golden league", async () => {
    freeze("2026-09-08T14:00:00.000Z");
    const t = newTest();
    const me = await actor(t, "Demo", "demo@fantasybench.dev");
    const { leagueId } = await me.session.mutation(api.leagues.create, { name: "Demo League" });

    const view = await me.session.query(api.leagues.get, { leagueId });
    const rules = view.rules!;

    // --- league_rules -------------------------------------------------------
    expect(rules.scoringPreset).toBe(rulesRow.scoring_preset);
    expect(rules.superflex).toBe(rulesRow.superflex);
    expect(rules.tePremium).toBe(rulesRow.te_premium);
    expect(rules.rosterSlots).toEqual(rulesRow.roster_slots);
    expect(rules.faabBudget).toBe(rulesRow.faab_budget);
    expect(rules.playoffTeams).toBe(rulesRow.playoff_teams);
    expect(rules.playoffStartWeek).toBe(rulesRow.playoff_start_week);
    expect(rules.regularSeasonWeeks).toBe(rulesRow.regular_season_weeks);
    expect(rules.seasonWeeks).toBe(rulesRow.season_weeks);
    expect(rules.transparencyMode).toBe(rulesRow.transparency_mode);
    expect(rules.injectionPolicy).toBe(rulesRow.injection_policy);
    expect(rules.fallbackModelId).toBe(rulesRow.fallback_model_id);
    expect(rules.weeklyTokenCapPerTeam ?? null).toBe(rulesRow.weekly_token_cap_per_team);
    expect(rules.leagueUsdHardCap ?? null).toBe(rulesRow.league_usd_hard_cap);
    expect(rules.contextCharLimit).toBe(rulesRow.context_char_limit);
    expect(rules.maxStepsCap).toBe(rulesRow.max_steps_cap);
    expect(rules.editLock).toEqual(rulesRow.edit_lock);
    expect(rules.windowOverrides ?? null).toBe(rulesRow.window_overrides);
    expect(rules.tradeReviewHours).toBe(rulesRow.trade_review_hours);
    expect(rules.fairnessFloor).toBe(rulesRow.fairness_floor);
    expect(rules.antiChurnWeeks).toBe(rulesRow.anti_churn_weeks);
    expect(rules.maxOpenProposals).toBe(rulesRow.max_open_proposals);
    expect(rules.maxMessagesPerRun).toBe(rulesRow.max_messages_per_run);
    expect(rules.maxThreadsPerWindow).toBe(rulesRow.max_threads_per_window);
    expect(rules.forumPostsPerDay).toBe(rulesRow.forum_posts_per_day);
    expect(rules.forumCommentsPerDay).toBe(rulesRow.forum_comments_per_day);
    expect(rules.safetyAutopilot).toBe(rulesRow.safety_autopilot);
    expect(rules.runWallclockSeconds).toBe(rulesRow.run_wallclock_seconds);
    expect(rules.draftPickSeconds).toBe(rulesRow.draft_pick_seconds);
    expect(rules.reuseSnapshotWithinMs).toBe(rulesRow.reuse_snapshot_within_ms);
    expect(rules.draftBudget).toBe(rulesRow.draft_budget);

    // --- teams --------------------------------------------------------------
    // The golden rows are a week-1 snapshot, so `faabRemaining`/`karma` have
    // moved since creation; the creation-time invariants are the budgets the
    // rules hand out and the waiver order.
    const goldenTeamRows: Array<{ waiver_priority: number }> = goldenTeams;
    expect(view.teams).toHaveLength(goldenTeamRows.length);
    const goldenPriorities = goldenTeamRows
      .map((row) => row.waiver_priority)
      .sort((a, b) => a - b);
    expect(view.teams.map((team) => team.waiverPriority)).toEqual(goldenPriorities);
    for (const team of view.teams) {
      expect(team.faabRemaining).toBe(rulesRow.faab_budget);
      expect(team.draftBudgetRemaining).toBe(rulesRow.draft_budget);
      expect(team.karma).toBe(0);
      expect(team.ownerUserId ?? null).toBeNull();
    }

    // --- weeks --------------------------------------------------------------
    const weeks = await t.run(async (ctx) =>
      ctx.db
        .query("weeks")
        .withIndex("by_leagueId_weekNo", (q) => q.eq("leagueId", leagueId))
        .collect(),
    );
    const goldenWeekRows = [...(goldenWeeks as Array<Record<string, string | number | boolean>>)].sort(
      (a, b) => (a.week_no as number) - (b.week_no as number),
    );
    expect(weeks).toHaveLength(goldenWeekRows.length);
    weeks.forEach((week, i) => {
      const golden = goldenWeekRows[i];
      expect(week.weekNo).toBe(golden.week_no);
      expect(week.startsAt).toBe(new Date(golden.starts_at as string).getTime());
      expect(week.endsAt).toBe(new Date(golden.ends_at as string).getTime());
      expect(week.isPlayoff).toBe(golden.is_playoff);
      expect(week.status).toBe(golden.status);
    });

    // --- config_versions ----------------------------------------------------
    const versions = await t.run(async (ctx) =>
      ctx.db
        .query("config_versions")
        .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
        .collect(),
    );
    const goldenVersionRows = goldenVersions as Array<Record<string, unknown>>;
    expect(versions).toHaveLength(goldenVersionRows.length);
    const goldenVersion = goldenVersionRows[0];
    for (const version of versions) {
      expect(version.versionNo).toBe(goldenVersion.version_no);
      expect(version.contextMd).toBe(goldenVersion.context_md);
      expect(version.contextMd).toBe(DEFAULT_AGENT_CONTEXT);
      expect(version.harness).toEqual(goldenVersion.harness);
      expect(version.harness).toEqual(DEFAULT_HARNESS);
      expect(version.changeSummary).toBe(goldenVersion.change_summary);
      expect(version.appliedAt).not.toBeUndefined();
      expect(version.skillIds).toEqual([]);
    }
  });
});
