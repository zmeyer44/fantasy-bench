/**
 * Seed contract + golden-dataset parity.
 *
 * The parity half loads the small golden tables (`tests/golden/postgres-week1`)
 * through `t.run` using the same transformation `scripts/seed-convex.ts` applies,
 * then asserts `leagues.get` and `configs.versions` return exactly what the old
 * tRPC procedures returned for the same rows.
 */
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";

import goldenConfigs from "../tests/golden/postgres-week1/agent_configs.json";
import goldenVersions from "../tests/golden/postgres-week1/config_versions.json";
import goldenMembers from "../tests/golden/postgres-week1/league_members.json";
import goldenRules from "../tests/golden/postgres-week1/league_rules.json";
import goldenLeagues from "../tests/golden/postgres-week1/leagues.json";
import goldenTeams from "../tests/golden/postgres-week1/teams.json";
import goldenUser from "../tests/golden/postgres-week1/users.json";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { BUILTIN_SKILLS } from "./seed/skills";
import schema from "./schema";
import { MODEL_CATALOG } from "@/lib/models";

const modules = import.meta.glob("./**/*.ts");

const SECRET = "test-seed-secret";

afterEach(() => {
  vi.unstubAllEnvs();
});

function newTest() {
  return convexTest(schema, modules);
}

// -------------------------------------------------------------- golden loader

type Row = Record<string, unknown>;

const league = goldenLeagues[0] as Row;
const rules = goldenRules[0] as Row;
const member = goldenMembers[0] as Row;
const teams = goldenTeams as unknown as Row[];
const configs = goldenConfigs as unknown as Row[];
const versions = goldenVersions as unknown as Row[];

function ms(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Insert the golden league exactly as `scripts/seed-convex.ts` does (epoch-ms
 * dates, camelCase fields) and return the id map — the same map that script
 * persists to `.cache/seed-map.<deployment>.json`, since Convex rows carry no id
 * of their own.
 */
async function loadGolden(t: ReturnType<typeof newTest>) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      name: String((goldenUser as Row).name),
      email: String((goldenUser as Row).email),
    });

    const leagueId = await ctx.db.insert("leagues", {
      name: String(league.name),
      slug: String(league.slug),
      commissionerUserId: userId,
      season: Number(league.season),
      teamCount: Number(league.team_count),
      isPublic: league.is_public === true,
      status: "in_season",
      draftType: "snake",
      draftScheduledAt: ms(league.draft_scheduled_at),
      createdAt: ms(league.created_at),
      updatedAt: ms(league.updated_at)!,
    });

    await ctx.db.insert("league_rules", {
      leagueId,
      scoringPreset: "ppr",
      superflex: rules.superflex === true,
      tePremium: rules.te_premium === true,
      rosterSlots: rules.roster_slots as Record<string, number>,
      faabBudget: Number(rules.faab_budget),
      playoffTeams: Number(rules.playoff_teams),
      playoffStartWeek: Number(rules.playoff_start_week),
      regularSeasonWeeks: Number(rules.regular_season_weeks),
      seasonWeeks: Number(rules.season_weeks),
      transparencyMode: "live",
      injectionPolicy: "permitted",
      modelAllowlist: rules.model_allowlist as string[],
      fallbackModelId: String(rules.fallback_model_id),
      contextCharLimit: Number(rules.context_char_limit),
      maxStepsCap: Number(rules.max_steps_cap),
      editLock: rules.edit_lock as {
        unlockDay: string;
        unlockTime: string;
        lockDay: string;
        lockTime: string;
      },
      tradeReviewHours: Number(rules.trade_review_hours),
      fairnessFloor: Number(rules.fairness_floor),
      antiChurnWeeks: Number(rules.anti_churn_weeks),
      maxOpenProposals: Number(rules.max_open_proposals),
      maxMessagesPerRun: Number(rules.max_messages_per_run),
      maxThreadsPerWindow: Number(rules.max_threads_per_window),
      forumPostsPerDay: Number(rules.forum_posts_per_day),
      forumCommentsPerDay: Number(rules.forum_comments_per_day),
      safetyAutopilot: rules.safety_autopilot === true,
      rulesLockedAt: ms(rules.rules_locked_at),
      runWallclockSeconds: Number(rules.run_wallclock_seconds),
      draftPickSeconds: Number(rules.draft_pick_seconds),
      reuseSnapshotWithinMs: Number(rules.reuse_snapshot_within_ms),
      draftBudget: Number(rules.draft_budget),
    });

    await ctx.db.insert("league_members", {
      leagueId,
      userId,
      role: "commissioner",
      createdAt: ms(member.created_at),
    });

    const teamIds: Record<string, Id<"teams">> = {};
    for (const team of teams) {
      teamIds[String(team.id)] = await ctx.db.insert("teams", {
          leagueId,
          ownerUserId: team.owner_user_id ? userId : undefined,
          name: String(team.name),
          abbreviation: String(team.abbreviation),
          faabRemaining: Number(team.faab_remaining),
          waiverPriority: Number(team.waiver_priority),
          karma: Number(team.karma),
          draftBudgetRemaining: Number(team.draft_budget_remaining),
          createdAt: ms(team.created_at),
      });
    }

    const configIds: Record<string, Id<"agent_configs">> = {};
    for (const config of configs) {
      configIds[String(config.id)] = await ctx.db.insert("agent_configs", {
        teamId: teamIds[String(config.team_id)],
        leagueId,
        createdAt: ms(config.created_at),
        updatedAt: ms(config.updated_at),
      });
    }

    const teamByConfig = new Map(configs.map((c) => [String(c.id), String(c.team_id)]));
    const versionIds: Record<string, Id<"config_versions">> = {};
    for (const version of versions) {
      versionIds[String(version.id)] = await ctx.db.insert("config_versions", {
        configId: configIds[String(version.config_id)],
        teamId: teamIds[teamByConfig.get(String(version.config_id))!],
        leagueId,
        versionNo: Number(version.version_no),
        contextMd: String(version.context_md),
        modelId: String(version.model_id),
        harness: version.harness as {
          maxSteps: number;
          tokenBudget: number;
          temperature: number;
          reasoningEffort: null;
          deliberateMode: boolean;
        },
        skillIds: [],
        appliedAt: ms(version.applied_at),
        changeSummary: String(version.change_summary),
        createdAt: ms(version.created_at),
      });
    }

    for (const config of configs) {
      await ctx.db.patch("agent_configs", configIds[String(config.id)], {
        currentVersionId: versionIds[String(config.current_version_id)],
      });
    }

    return { userId, leagueId, teamIds, configIds, versionIds };
  });
}

// -------------------------------------------------------------------- parity

describe("golden parity — leagues.get", () => {
  it("matches the shape the tRPC `league.get` returned for the demo league", async () => {
    const t = newTest();
    const { leagueId, teamIds } = await loadGolden(t);

    const view = await t.query(api.leagues.get, { leagueId });

    expect(view.league.name).toBe(league.name);
    expect(view.league.slug).toBe(league.slug);
    expect(view.league.season).toBe(league.season);
    // Dates are epoch ms in Convex; the golden file has ISO strings.
    expect(view.league.createdAt).toBe(Date.parse(String(league.created_at)));

    // Teams come back in waiver order, exactly as the Drizzle `orderBy` produced.
    const expectedTeams = [...teams].sort(
      (a, b) => Number(a.waiver_priority) - Number(b.waiver_priority),
    );
    expect(view.teams).toHaveLength(expectedTeams.length);
    expect(view.teams.map((team) => team.name)).toEqual(expectedTeams.map((t) => t.name));
    expect(view.teams.map((team) => team._id)).toEqual(
      expectedTeams.map((t) => teamIds[String(t.id)]),
    );

    expect(view.rules).toMatchObject({
      scoringPreset: rules.scoring_preset,
      faabBudget: rules.faab_budget,
      modelAllowlist: rules.model_allowlist,
      seasonWeeks: rules.season_weeks,
    });
    expect(view.rules?.rulesLockedAt).toBe(Date.parse(String(rules.rules_locked_at)));

    // Spectator view: the golden league is public and the caller is signed out.
    expect(view.membership).toBeNull();
    expect(view.isCommissioner).toBe(false);
  });
});

describe("golden parity — configs.versions", () => {
  it("summarises the golden config versions the way `listVersions` did", async () => {
    const t = newTest();
    const { leagueId, teamIds } = await loadGolden(t);

    for (const config of configs) {
      const legacyTeamId = String(config.team_id);
      const teamId = teamIds[legacyTeamId];
      const { versions: summaries } = await t.query(api.configs.versions, { leagueId, teamId });

      const expected = versions
        .filter((version) => String(version.config_id) === String(config.id))
        .sort((a, b) => Number(b.version_no) - Number(a.version_no));

      expect(summaries).toHaveLength(expected.length);
      summaries.forEach((summary, index) => {
        const golden = expected[index];
        expect(summary.versionNo).toBe(Number(golden.version_no));
        expect(summary.contextMd).toBe(golden.context_md);
        expect(summary.modelId).toBe(golden.model_id);
        expect(summary.harness).toEqual(golden.harness);
        expect(summary.changeSummary).toBe(golden.change_summary);
        expect(summary.createdAt).toBe(Date.parse(String(golden.created_at)));
        expect(summary.appliedAt).toBe(Date.parse(String(golden.applied_at)));
        expect(summary.skillCount).toBe(0);
        // The golden dataset has no `created_by_user_id` (the seed created them).
        expect(summary.createdByName).toBeNull();
        expect(summary.isCurrent).toBe(String(golden.id) === String(config.current_version_id));
        expect(summary.isPending).toBe(false);
        // "mock/scripted" is in the catalog, so the display name resolves.
        expect(summary.modelDisplayName).toBe("Scripted Mock");
      });
    }
  });
});

// --------------------------------------------------------------- seed contract

describe("seed.base", () => {
  it("writes the model catalog and the built-in skills, idempotently", async () => {
    const t = newTest();

    const first = await t.mutation(internal.seed.base, {});
    expect(first).toEqual({ modelPrices: MODEL_CATALOG.length, skills: BUILTIN_SKILLS.length });

    await t.mutation(internal.seed.base, {});

    const { prices, skills } = await t.run(async (ctx) => ({
      prices: await ctx.db.query("model_prices").collect(),
      skills: await ctx.db.query("skills").collect(),
    }));
    expect(prices).toHaveLength(MODEL_CATALOG.length);
    expect(skills).toHaveLength(BUILTIN_SKILLS.length);
    expect(skills.map((skill) => skill.slug).sort()).toEqual(
      BUILTIN_SKILLS.map((skill) => skill.slug).sort(),
    );
    // The catalog is the source of truth for prices (PRD 5.9).
    const sonnet = prices.find((p) => p.modelId === "anthropic/claude-sonnet-4.5")!;
    expect(sonnet.inputPerM).toBe(3);
    expect(sonnet.displayName).toBe("Claude Sonnet 4.5");
    expect(new Date(sonnet.effectiveFrom).toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("seed guards", () => {
  it("refuses every seed-only function without SEED_SECRET", async () => {
    const t = newTest();
    vi.stubEnv("SEED_SECRET", "");
    await expect(
      t.mutation(api.seed.importBatch, { secret: SECRET, table: "leagues", rows: [] }),
    ).rejects.toThrow();
    await expect(t.mutation(api.seed.runBase, { secret: SECRET })).rejects.toThrow();
    await expect(t.mutation(internal.seed.reset, {})).rejects.toThrow();
  });

  it("refuses a wrong secret and a table outside the allowlist", async () => {
    const t = newTest();
    vi.stubEnv("SEED_SECRET", SECRET);
    await expect(
      t.mutation(api.seed.importBatch, { secret: "wrong", table: "leagues", rows: [] }),
    ).rejects.toThrow();
    await expect(
      t.mutation(api.seed.importBatch, { secret: SECRET, table: "authAccounts", rows: [] }),
    ).rejects.toThrow();
  });

  it("imports rows, counts them, and clears the table", async () => {
    const t = newTest();
    vi.stubEnv("SEED_SECRET", SECRET);
    const { userId } = await loadGolden(t);

    const { ids } = await t.mutation(api.seed.importBatch, {
      secret: SECRET,
      table: "skills",
      rows: [
        {
          name: "Imported skill",
          slug: "imported-skill",
          bodyMd: "# Imported",
          visibility: "public",
          usageCount: 0,
          authorUserId: userId,
          updatedAt: Date.now(),
        },
      ],
    });
    expect(ids).toHaveLength(1);

    const count = await t.query(api.seed.tableCount, { secret: SECRET, table: "skills" });
    expect(count.count).toBe(1);

    const cleared = await t.mutation(api.seed.clearTable, { secret: SECRET, table: "skills" });
    expect(cleared).toEqual({ deleted: 1, done: true });
    expect((await t.query(api.seed.tableCount, { secret: SECRET, table: "skills" })).count).toBe(0);
  });

  it("patches rows, in the app tables and in `users`", async () => {
    const t = newTest();
    vi.stubEnv("SEED_SECRET", SECRET);
    const { userId, leagueId } = await loadGolden(t);

    await t.mutation(api.seed.patchBatch, {
      secret: SECRET,
      table: "users",
      rows: [{ id: userId, patch: { name: "Patched Owner" } }],
    });
    await t.mutation(api.seed.patchBatch, {
      secret: SECRET,
      table: "leagues",
      rows: [{ id: leagueId, patch: { joinCode: "PATCHED1" } }],
    });

    const { user, patchedLeague } = await t.run(async (ctx) => ({
      user: await ctx.db.get("users", userId),
      patchedLeague: await ctx.db.get("leagues", leagueId),
    }));
    expect(user?.name).toBe("Patched Owner");
    expect(patchedLeague?.joinCode).toBe("PATCHED1");
  });
});
