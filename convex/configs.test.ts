/**
 * Config read models: the team config view, its version history, the diff and the estimate.
 *
 * Reads are public within the league (PRD 5.5) — a spectator of a public league
 * sees the same config, versions and diffs a member does; only `canEdit` differs.
 */
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";

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
import { COOLDOWN_MS } from "./lib/visibility";
import schema from "./schema";
import { fromET } from "@/lib/time";

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
    // A version saved moments ago is inside the three-week cooldown for a spectator.
    expect(view.current?.redacted).toBe(true);
    expect(view.current?.contextMd).toBe("");
    expect(view.visibility).toEqual({ canSeePrivate: false, cooldownMs: COOLDOWN_MS });
    expect(view.latestPublic).toBeNull();
  });

  it("reveals a version to the league once its cooldown has passed, owners always", async () => {
    const { t, owner, other, leagueId, teamId } = await writeFixture();
    const before = await owner.session.query(api.configs.get, { leagueId, teamId });
    expect(before.current?.redacted).toBe(false);
    expect(before.current?.contextMd).not.toBe("");
    expect(before.current?.revealAt).toBe((before.current?.createdAt ?? 0) + COOLDOWN_MS);

    // Another owner in the league sees a redacted current version and nothing public yet.
    const hidden = await other.session.query(api.configs.get, { leagueId, teamId });
    expect(hidden.current?.redacted).toBe(true);
    expect(hidden.current?.skills).toEqual([]);
    expect(hidden.current?.changeSummary).toBeUndefined();
    expect(hidden.latestPublic).toBeNull();

    // Backdate the version past the cooldown: it is public to everyone.
    await t.run(async (ctx) => {
      const version = (await ctx.db.get("config_versions", hidden.current!._id))!;
      await ctx.db.patch("config_versions", version._id, {
        createdAt: Date.now() - COOLDOWN_MS - 60_000,
      });
    });
    const revealed = await other.session.query(api.configs.get, { leagueId, teamId });
    expect(revealed.current?.redacted).toBe(false);
    expect(revealed.current?.contextMd).toBe(before.current?.contextMd);
  });

  it("offers the latest public version while the current one is still private", async () => {
    at(TUE_10_ET);
    const { t, owner, other, leagueId, teamId } = await writeFixture();
    // v1 (seeded) is old enough to be public; v2 is saved now and private.
    await t.run(async (ctx) => {
      const rows = await ctx.db.query("config_versions").collect();
      for (const row of rows) {
        if (row.teamId === teamId) {
          await ctx.db.patch("config_versions", row._id, { createdAt: Date.now() - COOLDOWN_MS - 1 });
        }
      }
    });
    await owner.session.mutation(api.configs.save, {
      ...BASE,
      leagueId,
      teamId,
      contextMd: "# Secret sauce",
      changeSummary: "Secret",
    });
    const view = await other.session.query(api.configs.get, { leagueId, teamId });
    expect(view.current?.versionNo).toBe(2);
    expect(view.current?.redacted).toBe(true);
    expect(view.current?.contextMd).toBe("");
    expect(view.latestPublic?.versionNo).toBe(1);
    expect(view.latestPublic?.redacted).toBe(false);
    expect(view.latestPublic?.contextMd).toContain("You manage a fantasy football team");
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

    const { versions } = await owner.session.query(api.configs.versions, { leagueId, teamId });
    expect(versions.map((version) => version.versionNo)).toEqual([2, 1]);
    expect(versions.every((version) => version.redacted === false)).toBe(true);

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

  it("redacts a cooling version's content in the history for everyone else", async () => {
    const { t, owner, leagueId, teamId } = await fixture();
    const skillId = await makeSkill(t, "Injury aware", "injury-aware");
    await addVersion(t, leagueId, teamId, owner.userId, skillId);

    const { versions } = await t.query(api.configs.versions, { leagueId, teamId });
    const [latest] = versions;
    expect(latest.redacted).toBe(true);
    expect(latest.revealAt).toBe(latest.createdAt! + COOLDOWN_MS);
    expect(latest.contextMd).toBe("");
    expect(latest.skillIds).toEqual([]);
    expect(latest.skillCount).toBe(0);
    expect(latest.changeSummary).toBeUndefined();
    // Metadata the league may still see: the model, the number, the author, the dates.
    expect(latest.modelDisplayName).toBe("GPT-5 mini");
    expect(latest.createdByName).toBe("Owner");
    expect(latest.isCurrent).toBe(true);
  });
});

describe("configs.version + configs.diff", () => {
  it("hydrates a version with its skills and its predecessor", async () => {
    const { t, owner, leagueId, teamId } = await fixture();
    const skillId = await makeSkill(t, "Injury aware", "injury-aware");
    const versionId = await addVersion(t, leagueId, teamId, owner.userId, skillId);

    const { version, previous } = await owner.session.query(api.configs.version, {
      leagueId,
      versionId,
    });
    expect(version.versionNo).toBe(2);
    expect(version.skills.map((skill) => skill.slug)).toEqual(["injury-aware"]);
    expect(previous?.versionNo).toBe(1);
    expect(previous?.skills).toEqual([]);

    // A spectator gets the envelope but not the content, and no diff at all.
    const spectator = await t.query(api.configs.version, { leagueId, versionId });
    expect(spectator.version.redacted).toBe(true);
    expect(spectator.version.contextMd).toBe("");
    expect(spectator.version.skills).toEqual([]);
    expect(await errorCode(t.query(api.configs.diff, { leagueId, a: previous!._id, b: versionId }))).toBe(
      "FORBIDDEN",
    );
  });

  it("diffs context, model, harness and skills", async () => {
    const { t, owner, leagueId, teamId } = await fixture();
    const skillId = await makeSkill(t, "Injury aware", "injury-aware");
    const v2 = await addVersion(t, leagueId, teamId, owner.userId, skillId);
    const v1 = (await t.query(api.configs.versions, { leagueId, teamId })).versions.find(
      (version) => version.versionNo === 1,
    )!._id;

    const diff = await owner.session.query(api.configs.diff, { leagueId, a: v1, b: v2 });
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

// ===========================================================================
// configs.save / setNote / applyPending / currentForTeam (Phase 3)
// ===========================================================================

/** Tuesday 2026-09-08 10:00 ET — inside the default window (Tue 06:00 → Wed 03:00). */
const TUE_10_ET = fromET({ year: 2026, month: 9, day: 8, hour: 10 });
/** Friday 2026-09-11 10:00 ET — outside it. */
const FRI_10_ET = fromET({ year: 2026, month: 9, day: 11, hour: 10 });

/** Only `Date` is faked: convex-test's own awaits still need real timers. */
function at(instant: Date) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(instant);
}

const BASE = {
  contextMd: "# My agent\n\nStart the best players.",
  modelId: "anthropic/claude-sonnet-4.5",
  harness: {
    maxSteps: 12,
    tokenBudget: 60_000,
    temperature: 0.3,
    reasoningEffort: null,
    deliberateMode: false,
  },
  skillIds: [] as Id<"skills">[],
};

/** The read fixture plus a second owner (team 2) and an outsider. */
async function writeFixture() {
  const base = await fixture();
  const other = await actor(base.t, "Owner Two", "owner2@fantasybench.dev");
  const outsider = await actor(base.t, "Outsider", "outsider@fantasybench.dev");
  await other.session.mutation(api.leagues.join, { leagueId: base.leagueId });
  return { ...base, other, outsider };
}

async function setRules(t: T, leagueId: Id<"leagues">, patch: Record<string, unknown>) {
  await t.run(async (ctx) => {
    const rules = (await ctx.db
      .query("league_rules")
      .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
      .unique())!;
    await ctx.db.patch("league_rules", rules._id, patch);
  });
}

async function configRow(t: T, teamId: Id<"teams">) {
  return t.run(async (ctx) =>
    ctx.db
      .query("agent_configs")
      .withIndex("by_teamId", (q) => q.eq("teamId", teamId))
      .unique(),
  );
}

describe("configs.save — authorization", () => {
  afterEach(() => vi.useRealTimers());

  it("is UNAUTHORIZED signed out", async () => {
    const { t, leagueId, teamId } = await writeFixture();
    expect(await errorCode(t.mutation(api.configs.save, { ...BASE, leagueId, teamId }))).toBe(
      "UNAUTHORIZED",
    );
  });

  it("is FORBIDDEN for a member who does not own the team", async () => {
    const { other, leagueId, teamId } = await writeFixture();
    expect(
      await errorCode(other.session.mutation(api.configs.save, { ...BASE, leagueId, teamId })),
    ).toBe("FORBIDDEN");
  });

  it("is FORBIDDEN for a non-member", async () => {
    const { outsider, leagueId, teamId } = await writeFixture();
    expect(
      await errorCode(outsider.session.mutation(api.configs.save, { ...BASE, leagueId, teamId })),
    ).toBe("FORBIDDEN");
  });

  it("lets the owner and the commissioner save", async () => {
    at(TUE_10_ET);
    const { commish, owner, leagueId, teamId } = await writeFixture();
    expect((await owner.session.mutation(api.configs.save, { ...BASE, leagueId, teamId })).applied)
      .toBe(true);
    expect((await commish.session.mutation(api.configs.save, { ...BASE, leagueId, teamId })).applied)
      .toBe(true);
  });

  it("NOT_FOUND when the team is not in the league in the input", async () => {
    const { t, owner, teamId, commish } = await writeFixture();
    const otherLeague = await t.mutation(internal.leagues.createLeague, {
      name: "Elsewhere",
      commissionerUserId: commish.userId,
      teamCount: 8,
      season: 2026,
    });
    expect(
      await errorCode(
        owner.session.mutation(api.configs.save, {
          ...BASE,
          leagueId: otherLeague.leagueId,
          teamId,
        }),
      ),
    ).toBe("NOT_FOUND");
  });
});

describe("configs.save — validation against league rules", () => {
  afterEach(() => vi.useRealTimers());

  async function expectIssue(
    promise: Promise<unknown>,
    field: string,
    pattern: RegExp,
  ): Promise<void> {
    let data: { code?: string; message?: string; issues?: Array<{ field: string; message: string }> } | undefined;
    try {
      await promise;
    } catch (error) {
      data = (error as { data?: typeof data }).data;
    }
    expect(data?.code).toBe("BAD_REQUEST");
    expect(data?.issues?.map((i) => i.field)).toContain(field);
    expect(data?.message).toMatch(pattern);
  }

  it("rejects a context over the league's character limit", async () => {
    at(TUE_10_ET);
    const { t, owner, leagueId, teamId } = await writeFixture();
    await setRules(t, leagueId, { contextCharLimit: 200 });
    await expectIssue(
      owner.session.mutation(api.configs.save, {
        ...BASE,
        leagueId,
        teamId,
        contextMd: "x".repeat(201),
      }),
      "contextMd",
      /league limit is 200/,
    );
  });

  it("rejects a model that is not on the allowlist", async () => {
    at(TUE_10_ET);
    const { t, owner, leagueId, teamId } = await writeFixture();
    await setRules(t, leagueId, { modelAllowlist: ["anthropic/claude-haiku-4.5"] });
    await expectIssue(
      owner.session.mutation(api.configs.save, { ...BASE, leagueId, teamId }),
      "modelId",
      /not on this league's model allowlist/,
    );
  });

  it("rejects max steps above the league cap and above the platform ceiling", async () => {
    at(TUE_10_ET);
    const { t, owner, leagueId, teamId } = await writeFixture();
    await setRules(t, leagueId, { maxStepsCap: 8 });
    await expectIssue(
      owner.session.mutation(api.configs.save, {
        ...BASE,
        leagueId,
        teamId,
        harness: { ...BASE.harness, maxSteps: 9 },
      }),
      "harness.maxSteps",
      /8 or fewer/,
    );
    await expectIssue(
      owner.session.mutation(api.configs.save, {
        ...BASE,
        leagueId,
        teamId,
        harness: { ...BASE.harness, maxSteps: 31 },
      }),
      "harness.maxSteps",
      /between 1 and 30/,
    );
  });

  it("rejects a per-run token budget above the weekly cap", async () => {
    at(TUE_10_ET);
    const { t, owner, leagueId, teamId } = await writeFixture();
    await setRules(t, leagueId, { weeklyTokenCapPerTeam: 50_000 });
    await expectIssue(
      owner.session.mutation(api.configs.save, {
        ...BASE,
        leagueId,
        teamId,
        harness: { ...BASE.harness, tokenBudget: 60_000 },
      }),
      "harness.tokenBudget",
      /weekly cap/,
    );
  });

  it("rejects a temperature outside 0-2", async () => {
    at(TUE_10_ET);
    const { owner, leagueId, teamId } = await writeFixture();
    await expectIssue(
      owner.session.mutation(api.configs.save, {
        ...BASE,
        leagueId,
        teamId,
        harness: { ...BASE.harness, temperature: 2.5 },
      }),
      "harness.temperature",
      /Temperature/,
    );
  });

  it("rejects reasoning effort on a model that does not support it, accepts it where it works", async () => {
    at(TUE_10_ET);
    const { t, owner, leagueId, teamId } = await writeFixture();
    await setRules(t, leagueId, {
      modelAllowlist: ["mock/scripted", "anthropic/claude-sonnet-4.5"],
    });
    await expectIssue(
      owner.session.mutation(api.configs.save, {
        ...BASE,
        leagueId,
        teamId,
        modelId: "mock/scripted",
        harness: { ...BASE.harness, reasoningEffort: "high" as const },
      }),
      "harness.reasoningEffort",
      /does not support reasoning/,
    );

    const ok = await owner.session.mutation(api.configs.save, {
      ...BASE,
      leagueId,
      teamId,
      harness: { ...BASE.harness, reasoningEffort: "high" as const },
    });
    const version = await t.run(async (ctx) => ctx.db.get("config_versions", ok.versionId));
    expect(version?.harness.reasoningEffort).toBe("high");
  });

  it("rejects unknown skill ids and more than twelve attachments", async () => {
    at(TUE_10_ET);
    const { t, owner, leagueId, teamId } = await writeFixture();

    const ghost = await t.run(async (ctx) => {
      const id = await ctx.db.insert("skills", {
        name: "Gone",
        slug: "gone",
        bodyMd: "# gone",
        visibility: "public",
        usageCount: 0,
        updatedAt: Date.now(),
      });
      await ctx.db.delete("skills", id);
      return id;
    });
    await expectIssue(
      owner.session.mutation(api.configs.save, { ...BASE, leagueId, teamId, skillIds: [ghost] }),
      "skillIds",
      /Unknown skill/,
    );

    const many = await t.run(async (ctx) => {
      const ids: Id<"skills">[] = [];
      for (let i = 0; i < 13; i++) {
        ids.push(
          await ctx.db.insert("skills", {
            name: `Skill ${i}`,
            slug: `skill-${i}`,
            bodyMd: "# s",
            visibility: "public",
            usageCount: 0,
            updatedAt: Date.now(),
          }),
        );
      }
      return ids;
    });
    await expectIssue(
      owner.session.mutation(api.configs.save, { ...BASE, leagueId, teamId, skillIds: many }),
      "skillIds",
      /at most 12 skills/,
    );
  });
});

describe("configs.save — the edit lock", () => {
  afterEach(() => vi.useRealTimers());

  it("applies immediately on Tuesday 10:00 ET", async () => {
    at(TUE_10_ET);
    const { t, owner, leagueId, teamId } = await writeFixture();
    const result = await owner.session.mutation(api.configs.save, {
      ...BASE,
      leagueId,
      teamId,
      changeSummary: "Tuesday edit",
    });

    expect(result).toMatchObject({ applied: true, queued: false, appliesAt: null, versionNo: 2 });

    const config = await configRow(t, teamId);
    expect(config?.currentVersionId).toBe(result.versionId);
    expect(config?.pendingVersionId).toBeUndefined();

    const current = await t.query(internal.configs.currentForTeam, { teamId });
    expect(current?.versionNo).toBe(2);
    expect(current?.changeSummary).toBe("Tuesday edit");
    expect(current?.appliedAt).toBe(TUE_10_ET.getTime());
  });

  it("queues on Friday 10:00 ET and leaves the current version untouched", async () => {
    at(FRI_10_ET);
    const { t, owner, leagueId, teamId } = await writeFixture();
    const before = await configRow(t, teamId);

    const result = await owner.session.mutation(api.configs.save, { ...BASE, leagueId, teamId });
    expect(result.applied).toBe(false);
    expect(result.queued).toBe(true);
    expect(result.appliesAt!).toBeGreaterThan(FRI_10_ET.getTime());

    const config = await configRow(t, teamId);
    expect(config?.currentVersionId).toBe(before?.currentVersionId);
    expect(config?.pendingVersionId).toBe(result.versionId);

    // The runtime still sees the old version.
    const current = await t.query(internal.configs.currentForTeam, { teamId });
    expect(current?._id).toBe(before?.currentVersionId);
    const queued = await t.run(async (ctx) => ctx.db.get("config_versions", result.versionId));
    expect(queued?.appliedAt).toBeUndefined();
  });

  it("a second locked save replaces the earlier pending version, which stays in history", async () => {
    at(FRI_10_ET);
    const { t, owner, leagueId, teamId } = await writeFixture();
    const first = await owner.session.mutation(api.configs.save, { ...BASE, leagueId, teamId });
    const second = await owner.session.mutation(api.configs.save, {
      ...BASE,
      leagueId,
      teamId,
      contextMd: "second attempt",
    });

    const config = await configRow(t, teamId);
    expect(config?.pendingVersionId).toBe(second.versionId);

    const history = await t.query(api.configs.versions, { leagueId, teamId });
    expect(history.versions.map((v) => v._id)).toContain(first.versionId);
    expect(history.versions.map((v) => v.versionNo)).toEqual([3, 2, 1]);
  });
});

describe("configs.applyPending", () => {
  afterEach(() => vi.useRealTimers());

  it("promotes every queued version in the league, then is idempotent", async () => {
    at(FRI_10_ET);
    const { t, owner, other, leagueId, teamId, otherTeamId } = await writeFixture();
    const a = await owner.session.mutation(api.configs.save, {
      ...BASE,
      leagueId,
      teamId,
    });
    const b = await other.session.mutation(api.configs.save, {
      ...BASE,
      leagueId,
      teamId: otherTeamId,
    });

    expect(await t.mutation(internal.configs.applyPending, { leagueId })).toBe(2);

    for (const [subject, versionId] of [
      [teamId, a.versionId],
      [otherTeamId, b.versionId],
    ] as const) {
      const config = await configRow(t, subject);
      expect(config?.currentVersionId).toBe(versionId);
      expect(config?.pendingVersionId).toBeUndefined();
      const row = await t.run(async (ctx) => ctx.db.get("config_versions", versionId));
      expect(row?.appliedAt).not.toBeUndefined();
    }

    expect(await t.mutation(internal.configs.applyPending, { leagueId })).toBe(0);
  });
});

describe("configs.setNote", () => {
  afterEach(() => vi.useRealTimers());

  it("is owner-or-commissioner only", async () => {
    const { t, other, outsider, leagueId, teamId } = await writeFixture();
    expect(await errorCode(t.mutation(api.configs.setNote, { leagueId, teamId, text: "hi" }))).toBe(
      "UNAUTHORIZED",
    );
    expect(
      await errorCode(other.session.mutation(api.configs.setNote, { leagueId, teamId, text: "hi" })),
    ).toBe("FORBIDDEN");
    expect(
      await errorCode(
        outsider.session.mutation(api.configs.setNote, { leagueId, teamId, text: "hi" }),
      ),
    ).toBe("FORBIDDEN");
  });

  it("is appended to the context on the next save and then cleared", async () => {
    at(TUE_10_ET);
    const { t, owner, leagueId, teamId } = await writeFixture();
    await owner.session.mutation(api.configs.setNote, {
      leagueId,
      teamId,
      text: "You benched Bijan again. Stop doing that.",
    });
    expect((await configRow(t, teamId))?.noteToAgent).toMatch(/Bijan/);

    const result = await owner.session.mutation(api.configs.save, {
      ...BASE,
      leagueId,
      teamId,
      contextMd: "# Context\n\nBe bold.",
    });
    expect(result.noteAppended).toMatch(/Bijan/);

    const version = await t.run(async (ctx) => ctx.db.get("config_versions", result.versionId));
    expect(version?.contextMd).toContain("Be bold.");
    expect(version?.contextMd).toContain("Note from my owner");
    expect(version?.contextMd).toContain("Stop doing that.");
    expect((await configRow(t, teamId))?.noteToAgent).toBeUndefined();

    // The next save does not re-append it.
    const second = await owner.session.mutation(api.configs.save, {
      ...BASE,
      leagueId,
      teamId,
      contextMd: "# Context\n\nBe bold.",
    });
    expect(second.noteAppended).toBeNull();
    const secondVersion = await t.run(async (ctx) =>
      ctx.db.get("config_versions", second.versionId),
    );
    expect(secondVersion?.contextMd).not.toContain("Note from my owner");
  });

  it("counts the appended note against the context character limit", async () => {
    at(TUE_10_ET);
    const { t, owner, leagueId, teamId } = await writeFixture();
    await setRules(t, leagueId, { contextCharLimit: 120 });
    await owner.session.mutation(api.configs.setNote, {
      leagueId,
      teamId,
      text: "n".repeat(100),
    });
    const failure = await errorCode(
      owner.session.mutation(api.configs.save, {
        ...BASE,
        leagueId,
        teamId,
        contextMd: "c".repeat(100),
      }),
    );
    expect(failure).toBe("BAD_REQUEST");
  });

  it("clears the note when passed null", async () => {
    const { t, owner, leagueId, teamId } = await writeFixture();
    await owner.session.mutation(api.configs.setNote, { leagueId, teamId, text: "  spaced  " });
    expect((await configRow(t, teamId))?.noteToAgent).toBe("spaced");
    const cleared = await owner.session.mutation(api.configs.setNote, {
      leagueId,
      teamId,
      text: null,
    });
    expect(cleared.noteToAgent).toBeNull();
  });
});

describe("configs.save — skills", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps injection order and maintains skills.usageCount across teams", async () => {
    at(TUE_10_ET);
    const { t, owner, other, leagueId, teamId, otherTeamId } = await writeFixture();
    const author = await actor(t, "Author", "author@fantasybench.dev");

    const zebra = await author.session.mutation(api.skills.create, {
      name: "Zebra strategy",
      bodyMd: "# Zebra",
    });
    const alpha = await author.session.mutation(api.skills.create, {
      name: "Alpha strategy",
      bodyMd: "# Alpha",
    });

    await owner.session.mutation(api.configs.save, {
      ...BASE,
      leagueId,
      teamId,
      skillIds: [zebra._id, alpha._id],
    });

    const current = await t.query(internal.configs.currentForTeam, { teamId });
    // Injection order, not alphabetical.
    expect(current?.skills.map((s) => s.name)).toEqual(["Zebra strategy", "Alpha strategy"]);
    expect(current?.harness).toEqual(BASE.harness);

    const usage = async (slug: string) =>
      (await t.query(api.skills.get, { slug }))?.usageCount ?? -1;
    expect(await usage("zebra-strategy")).toBe(1);
    expect(await usage("alpha-strategy")).toBe(1);

    // A second team runs only Zebra…
    await other.session.mutation(api.configs.save, {
      ...BASE,
      leagueId,
      teamId: otherTeamId,
      skillIds: [zebra._id],
    });
    expect(await usage("zebra-strategy")).toBe(2);

    // …and the first team drops Alpha, which falls back to zero.
    await owner.session.mutation(api.configs.save, {
      ...BASE,
      leagueId,
      teamId,
      skillIds: [zebra._id],
    });
    expect(await usage("zebra-strategy")).toBe(2);
    expect(await usage("alpha-strategy")).toBe(0);
  });

  it("only counts a skill once its version becomes current", async () => {
    at(FRI_10_ET);
    const { t, owner, leagueId, teamId } = await writeFixture();
    const author = await actor(t, "Author", "author@fantasybench.dev");
    const skill = await author.session.mutation(api.skills.create, {
      name: "Queued skill",
      bodyMd: "# q",
    });

    await owner.session.mutation(api.configs.save, {
      ...BASE,
      leagueId,
      teamId,
      skillIds: [skill._id],
    });
    expect((await t.query(api.skills.get, { slug: "queued-skill" }))?.usageCount).toBe(0);

    await t.mutation(internal.configs.applyPending, { leagueId });
    expect((await t.query(api.skills.get, { slug: "queued-skill" }))?.usageCount).toBe(1);
  });
});

// ===========================================================================
// configs.save — tool overrides
// ===========================================================================

describe("configs.save — tool overrides", () => {
  afterEach(() => vi.useRealTimers());

  it("stores only the deltas from the default contract and serves them to the runtime", async () => {
    at(TUE_10_ET);
    const { t, owner, leagueId, teamId } = await writeFixture();
    const result = await owner.session.mutation(api.configs.save, {
      ...BASE,
      leagueId,
      teamId,
      toolOverrides: [
        { name: "get_news", enabled: false },
        { name: "search_players", enabled: true, guidance: "  Prefer free agents under 40% owned. " },
        { name: "get_forum", enabled: true, guidance: "" },
      ],
    });
    const version = await t.run((ctx) => ctx.db.get("config_versions", result.versionId));
    expect(version?.toolOverrides).toEqual([
      { name: "get_news", enabled: false },
      { name: "search_players", enabled: true, guidance: "Prefer free agents under 40% owned." },
    ]);
    const current = await t.query(internal.configs.currentForTeam, { teamId });
    expect(current?.toolOverrides).toEqual(version?.toolOverrides);

    const view = await owner.session.query(api.views.team, { teamId });
    expect(view?.config.privateUntil).toBeNull();
    expect(view?.config.toolsDisabled).toBe(1);
    expect(view?.config.toolsGuided).toBe(1);

    // The rest of the league sees counts only after the cooldown.
    const spectator = await t.query(api.views.team, { teamId });
    expect(spectator?.config.privateUntil).toBe((version?.createdAt ?? 0) + COOLDOWN_MS);
    expect(spectator?.config.toolsDisabled).toBe(0);
    expect(spectator?.config.toolsGuided).toBe(0);
    expect(spectator?.config.contextExcerpt).toBe("");
    expect(spectator?.config.harness).toBeNull();
  });

  it("omits the field entirely when every tool is at its default", async () => {
    at(TUE_10_ET);
    const { t, owner, leagueId, teamId } = await writeFixture();
    const result = await owner.session.mutation(api.configs.save, {
      ...BASE,
      leagueId,
      teamId,
      toolOverrides: [{ name: "get_news", enabled: true }],
    });
    const version = await t.run((ctx) => ctx.db.get("config_versions", result.versionId));
    expect(version?.toolOverrides).toBeUndefined();
  });

  it("rejects disabling set_rationale and unknown tool names as BAD_REQUEST issues", async () => {
    at(TUE_10_ET);
    const { owner, leagueId, teamId } = await writeFixture();
    let issues: Array<{ field: string }> = [];
    try {
      await owner.session.mutation(api.configs.save, {
        ...BASE,
        leagueId,
        teamId,
        toolOverrides: [
          { name: "set_rationale", enabled: false },
          { name: "teleport", enabled: false },
        ],
      });
    } catch (error) {
      issues = (error as { data?: { issues?: Array<{ field: string }> } }).data?.issues ?? [];
    }
    expect(issues.map((i) => i.field).sort()).toEqual([
      "toolOverrides.set_rationale",
      "toolOverrides.teleport",
    ]);
  });
});

describe("configs.saveToolOverride", () => {
  afterEach(() => vi.useRealTimers());

  const GUIDED = { name: "set_lineup", enabled: true, guidance: "Favor floor over ceiling." };

  it("appends a version that copies the newest one with a single override changed", async () => {
    at(TUE_10_ET);
    const { owner, leagueId, teamId } = await writeFixture();
    const full = await owner.session.mutation(api.configs.save, {
      ...BASE,
      leagueId,
      teamId,
      toolOverrides: [{ name: "get_news", enabled: false }],
    });

    const result = await owner.session.mutation(api.configs.saveToolOverride, {
      leagueId,
      teamId,
      override: GUIDED,
      changeSummary: "Guide the lineup tool",
    });
    expect(result.applied).toBe(true);
    expect(result.versionNo).toBe(full.versionNo + 1);
    expect(result.noteAppended).toBeNull();

    const view = await owner.session.query(api.configs.get, { leagueId, teamId });
    expect(view.current?._id).toBe(result.versionId);
    expect(view.current?.contextMd).toBe(BASE.contextMd);
    expect(view.current?.modelId).toBe(BASE.modelId);
    expect(view.current?.harness.maxSteps).toBe(BASE.harness.maxSteps);
    expect(view.current?.toolOverrides).toEqual([{ name: "get_news", enabled: false }, GUIDED]);
    expect(view.current?.changeSummary).toBe("Guide the lineup tool");
  });

  it("drops the override once the tool is back at its default", async () => {
    at(TUE_10_ET);
    const { owner, leagueId, teamId } = await writeFixture();
    await owner.session.mutation(api.configs.save, {
      ...BASE,
      leagueId,
      teamId,
      toolOverrides: [{ name: "get_news", enabled: false }, GUIDED],
    });
    await owner.session.mutation(api.configs.saveToolOverride, {
      leagueId,
      teamId,
      override: { name: "set_lineup", enabled: true, guidance: "   " },
    });
    const view = await owner.session.query(api.configs.get, { leagueId, teamId });
    expect(view.current?.toolOverrides).toEqual([{ name: "get_news", enabled: false }]);
  });

  it("starts from the platform defaults when the team has no version", async () => {
    at(TUE_10_ET);
    const { t, other, leagueId, otherTeamId } = await writeFixture();
    // Joining seeds a first version; detach it so neither a live nor a queued one exists.
    await t.run(async (ctx) => {
      const config = (await ctx.db
        .query("agent_configs")
        .withIndex("by_teamId", (q) => q.eq("teamId", otherTeamId))
        .unique())!;
      await ctx.db.patch("agent_configs", config._id, {
        currentVersionId: undefined,
        pendingVersionId: undefined,
      });
    });
    expect((await configRow(t, otherTeamId))?.currentVersionId).toBeUndefined();

    const result = await other.session.mutation(api.configs.saveToolOverride, {
      leagueId,
      teamId: otherTeamId,
      override: { name: "get_news", enabled: false },
    });
    expect(result.applied).toBe(true);
    const view = await other.session.query(api.configs.get, { leagueId, teamId: otherTeamId });
    expect(view.current?._id).toBe(result.versionId);
    expect(view.current?.contextMd.length).toBeGreaterThan(0);
    expect(view.current?.modelId.length).toBeGreaterThan(0);
    expect(view.current?.toolOverrides).toEqual([{ name: "get_news", enabled: false }]);
  });

  it("refuses to switch off a locked tool", async () => {
    at(TUE_10_ET);
    const { owner, leagueId, teamId } = await writeFixture();
    expect(
      await errorCode(
        owner.session.mutation(api.configs.saveToolOverride, {
          leagueId,
          teamId,
          override: { name: "set_rationale", enabled: false },
        }),
      ),
    ).toBe("BAD_REQUEST");
  });

  it("queues outside the edit window and leaves the owner's note for the next full save", async () => {
    at(TUE_10_ET);
    const { t, owner, leagueId, teamId } = await writeFixture();
    await owner.session.mutation(api.configs.save, { ...BASE, leagueId, teamId });
    await owner.session.mutation(api.configs.setNote, { leagueId, teamId, text: "Bench the rookie." });

    at(FRI_10_ET);
    const result = await owner.session.mutation(api.configs.saveToolOverride, {
      leagueId,
      teamId,
      override: GUIDED,
    });
    expect(result.queued).toBe(true);
    expect(result.appliesAt).not.toBeNull();

    const row = await configRow(t, teamId);
    expect(row?.pendingVersionId).toBe(result.versionId);
    expect(row?.noteToAgent).toBe("Bench the rookie.");
    // The queued version's context is untouched by the note.
    const view = await owner.session.query(api.configs.get, { leagueId, teamId });
    expect(view.pending?.contextMd).toBe(BASE.contextMd);
  });

  it("is FORBIDDEN for another owner", async () => {
    at(TUE_10_ET);
    const { other, leagueId, teamId } = await writeFixture();
    expect(
      await errorCode(
        other.session.mutation(api.configs.saveToolOverride, {
          leagueId,
          teamId,
          override: GUIDED,
        }),
      ),
    ).toBe("FORBIDDEN");
  });
});
