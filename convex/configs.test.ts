/**
 * Config read models: shapes match `lib/services/config/{queries,diff,estimate}.ts`.
 *
 * Reads are public within the league (PRD 5.5) — a spectator of a public league
 * sees the same config, versions and diffs a member does; only `canEdit` differs.
 */
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  ASSUMED_OUTPUT_TOKENS_PER_STEP,
  ASSUMED_STEPS,
  BASE_PROMPT_TOKENS,
  DEFAULT_HARNESS_SETTINGS,
  estimateTokens,
  parseHarness,
} from "./lib/config_pure";
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
  const { leagueId, teamIds } = await t.mutation(internal.leagues.createLeague, {
    name: "Config League",
    commissionerUserId: commish.userId,
    teamCount: 8,
    season: 2026,
  });
  await owner.session.mutation(api.leagues.join, { leagueId });
  return { t, commish, owner, leagueId, teamId: teamIds[0], otherTeamId: teamIds[1] };
}

/** A second, hand-written version so the history/diff paths have two rows. */
async function addVersion(
  t: T,
  leagueId: Id<"leagues">,
  teamId: Id<"teams">,
  authorId: Id<"users">,
  skillId: Id<"skills">,
) {
  return t.run(async (ctx) => {
    const config = (await ctx.db
      .query("agent_configs")
      .withIndex("by_teamId", (q) => q.eq("teamId", teamId))
      .unique())!;
    const versionId = await ctx.db.insert("config_versions", {
      configId: config._id,
      teamId,
      leagueId,
      versionNo: 2,
      contextMd: "# My agent\n\nStart the best players.\nAlways check injuries.\n",
      modelId: "openai/gpt-5-mini",
      harness: { ...DEFAULT_HARNESS_SETTINGS, maxSteps: 20, temperature: 0.7 },
      skillIds: [skillId],
      createdByUserId: authorId,
      changeSummary: "Tighter lineup rules",
      createdAt: Date.now(),
    });
    await ctx.db.patch("agent_configs", config._id, { currentVersionId: versionId });
    return versionId;
  });
}

async function makeSkill(t: T, name: string, slug: string) {
  return t.run(async (ctx) =>
    ctx.db.insert("skills", {
      name,
      slug,
      description: `${name} description`,
      bodyMd: `# ${name}\n\nBody text for ${name}.`,
      visibility: "public",
      usageCount: 0,
      updatedAt: Date.now(),
    }),
  );
}

describe("configs.get", () => {
  it("is readable by a spectator of a public league, but not editable", async () => {
    const { t, leagueId, teamId } = await fixture();
    const view = await t.query(api.configs.get, { leagueId, teamId });
    expect(view.team._id).toBe(teamId);
    expect(view.league._id).toBe(leagueId);
    expect(view.rules?.scoringPreset).toBe("ppr");
    expect(view.current?.versionNo).toBe(1);
    expect(view.current?.harness).toEqual(DEFAULT_HARNESS_SETTINGS);
    expect(view.current?.skills).toEqual([]);
    expect(view.pending).toBeNull();
    expect(view.versions).toHaveLength(1);
    expect(view.canEdit).toBe(false);
    expect(view.viewerUserId).toBeNull();
    expect(view.lock.lock.unlockDay).toBe("tue");
  });

  it("is editable by the team owner and by the commissioner", async () => {
    const { owner, commish, leagueId, teamId, otherTeamId } = await fixture();
    expect((await owner.session.query(api.configs.get, { leagueId, teamId })).canEdit).toBe(true);
    expect((await commish.session.query(api.configs.get, { leagueId, teamId })).canEdit).toBe(true);
    // Owner of team 1 may not edit team 2.
    expect(
      (await owner.session.query(api.configs.get, { leagueId, teamId: otherTeamId })).canEdit,
    ).toBe(false);
  });

  it("is NOT_FOUND for a team in another league", async () => {
    const { t, commish, leagueId } = await fixture();
    const other = await t.mutation(internal.leagues.createLeague, {
      name: "Other League",
      commissionerUserId: commish.userId,
      teamCount: 8,
      season: 2026,
    });
    expect(
      await errorCode(t.query(api.configs.get, { leagueId, teamId: other.teamIds[0] })),
    ).toBe("NOT_FOUND");
  });

  it("is UNAUTHORIZED signed out on a private league", async () => {
    const { t, leagueId, teamId } = await fixture();
    await t.run(async (ctx) => ctx.db.patch("leagues", leagueId, { isPublic: false }));
    expect(await errorCode(t.query(api.configs.get, { leagueId, teamId }))).toBe("UNAUTHORIZED");
  });
});

describe("configs.versions", () => {
  it("summarises each version newest-first with author, skills and flags", async () => {
    const { t, owner, leagueId, teamId } = await fixture();
    const skillId = await makeSkill(t, "Injury aware", "injury-aware");
    await addVersion(t, leagueId, teamId, owner.userId, skillId);

    const { versions } = await t.query(api.configs.versions, { leagueId, teamId });
    expect(versions.map((version) => version.versionNo)).toEqual([2, 1]);

    const [latest, first] = versions;
    expect(latest.createdByName).toBe("Owner");
    expect(latest.skillCount).toBe(1);
    expect(latest.isCurrent).toBe(true);
    expect(latest.isPending).toBe(false);
    expect(latest.changedThisWeek).toBe(true);
    expect(latest.modelDisplayName).toBe("GPT-5 mini");
    expect(latest.harness.maxSteps).toBe(20);

    expect(first.createdByName).toBeNull();
    expect(first.isCurrent).toBe(false);
    expect(first.modelDisplayName).toBe("Claude Sonnet 4.5");
  });
});

describe("configs.version + configs.diff", () => {
  it("hydrates a version with its skills and its predecessor", async () => {
    const { t, owner, leagueId, teamId } = await fixture();
    const skillId = await makeSkill(t, "Injury aware", "injury-aware");
    const versionId = await addVersion(t, leagueId, teamId, owner.userId, skillId);

    const { version, previous } = await t.query(api.configs.version, { leagueId, versionId });
    expect(version.versionNo).toBe(2);
    expect(version.skills.map((skill) => skill.slug)).toEqual(["injury-aware"]);
    expect(previous?.versionNo).toBe(1);
    expect(previous?.skills).toEqual([]);
  });

  it("diffs context, model, harness and skills", async () => {
    const { t, owner, leagueId, teamId } = await fixture();
    const skillId = await makeSkill(t, "Injury aware", "injury-aware");
    const v2 = await addVersion(t, leagueId, teamId, owner.userId, skillId);
    const v1 = (await t.query(api.configs.versions, { leagueId, teamId })).versions.find(
      (version) => version.versionNo === 1,
    )!._id;

    const diff = await t.query(api.configs.diff, { leagueId, a: v1, b: v2 });
    expect(diff.changed).toBe(true);
    expect(diff.a.versionNo).toBe(1);
    expect(diff.b.versionNo).toBe(2);
    expect(diff.context.changed).toBe(true);
    expect(diff.context.hunks.length).toBeGreaterThan(0);
    expect(diff.context.unified).toContain("@@");
    expect(diff.model).toMatchObject({
      field: "modelId",
      label: "Model",
      from: "Claude Sonnet 4.5",
      to: "GPT-5 mini",
      changed: true,
    });
    expect(diff.harness.find((f) => f.field === "maxSteps")).toMatchObject({
      from: "12",
      to: "20",
      changed: true,
    });
    expect(diff.harness.find((f) => f.field === "deliberateMode")?.changed).toBe(false);
    expect(diff.skills.added.map((s) => s.slug)).toEqual(["injury-aware"]);
    expect(diff.skills.removed).toEqual([]);
    expect(diff.skills.reordered).toBe(false);
  });

  it("is NOT_FOUND for a version outside the league", async () => {
    const { t, leagueId, teamId, owner } = await fixture();
    const skillId = await makeSkill(t, "Injury aware", "injury-aware");
    const versionId = await addVersion(t, leagueId, teamId, owner.userId, skillId);
    const other = await t.mutation(internal.leagues.createLeague, {
      name: "Elsewhere",
      commissionerUserId: owner.userId,
      teamCount: 8,
      season: 2026,
    });
    expect(
      await errorCode(
        t.query(api.configs.version, { leagueId: other.leagueId, versionId }),
      ),
    ).toBe("NOT_FOUND");
  });
});

describe("configs.lockStatus + configs.estimate", () => {
  it("reports the edit window and its next flip", async () => {
    const { t, leagueId } = await fixture();
    const status = await t.query(api.configs.lockStatus, { leagueId });
    expect(status.lock).toEqual({
      unlockDay: "tue",
      unlockTime: "06:00",
      lockDay: "wed",
      lockTime: "03:00",
    });
    expect(status.nextChange).toBeGreaterThan(Date.now());
    expect(typeof status.open).toBe("boolean");
  });

  it("estimates prompt tokens and cost from the context, skills and model", async () => {
    const { t, leagueId } = await fixture();
    const skillId = await makeSkill(t, "Injury aware", "injury-aware");
    const contextMd = "# My agent\n\nStart the best players.";

    const estimate = await t.query(api.configs.estimate, {
      leagueId,
      contextMd,
      skillIds: [skillId, skillId],
      modelId: "anthropic/claude-sonnet-4.5",
    });

    const body = "# Injury aware\n\nBody text for Injury aware.";
    const expectedTokens =
      BASE_PROMPT_TOKENS + estimateTokens(contextMd) + estimateTokens(body);
    expect(estimate.tokens).toBe(expectedTokens);
    // Duplicate ids collapse, exactly as the Postgres `inArray` version did.
    expect(estimate.breakdown.skills).toHaveLength(1);
    expect(estimate.breakdown.baseTokens).toBe(BASE_PROMPT_TOKENS);
    expect(estimate.breakdown.assumedSteps).toBe(ASSUMED_STEPS);
    expect(estimate.breakdown.assumedOutputTokensPerStep).toBe(ASSUMED_OUTPUT_TOKENS_PER_STEP);
    expect(estimate.breakdown.modelKnown).toBe(true);
    expect(estimate.breakdown.inputPerM).toBe(3);
    expect(estimate.breakdown.outputPerM).toBe(15);

    const perStep = (expectedTokens * 3) / 1e6 + (ASSUMED_OUTPUT_TOKENS_PER_STEP * 15) / 1e6;
    expect(estimate.estimatedCostPerRunUsd).toBeCloseTo(perStep * ASSUMED_STEPS, 8);
  });

  it("reports an unknown model rather than failing", async () => {
    const { t, leagueId } = await fixture();
    const estimate = await t.query(api.configs.estimate, {
      leagueId,
      contextMd: "hi",
      skillIds: [],
      modelId: "nope/nope",
    });
    expect(estimate.breakdown.modelKnown).toBe(false);
    expect(estimate.estimatedCostPerRunUsd).toBe(0);
  });
});

describe("parseHarness (pure)", () => {
  it("fills defaults and clamps out-of-range values", () => {
    expect(parseHarness(undefined)).toEqual(DEFAULT_HARNESS_SETTINGS);
    expect(parseHarness({})).toEqual(DEFAULT_HARNESS_SETTINGS);
    const parsed = parseHarness({
      maxSteps: 900,
      tokenBudget: 1,
      temperature: -4,
      reasoningEffort: "extreme",
      deliberateMode: "yes",
    });
    expect(parsed).toEqual({
      maxSteps: 30,
      tokenBudget: 1_000,
      temperature: 0,
      reasoningEffort: null,
      deliberateMode: false,
    });
  });
});
