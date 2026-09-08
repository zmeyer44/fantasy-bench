import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { agentConfigs, configVersions } from "@/lib/db/schema";
import {
  ConfigForbiddenError,
  ConfigValidationError,
  DEFAULT_HARNESS_SETTINGS,
  applyPendingConfigVersions,
  diffVersions,
  editLockStatusFor,
  getConfigForTeam,
  getCurrentConfigVersion,
  getEditLockStatus,
  listVersions,
  parseHarness,
  saveVersion,
  setNoteToAgent,
} from "@/lib/services/config";
import { createSkill } from "@/lib/services/skills";
import { DEFAULT_EDIT_LOCK } from "@/lib/time";

import { db, truncateAll } from "../setup";
import { FRI_10_ET, TUE_10_ET, makeLeague, makeUser } from "./helpers";

beforeAll(async () => {
  await truncateAll();
});

const BASE = {
  contextMd: "# My agent\n\nStart the best players.",
  modelId: "anthropic/claude-sonnet-4.5",
  harness: DEFAULT_HARNESS_SETTINGS,
  skillIds: [] as string[],
};

describe("parseHarness", () => {
  it("fills defaults for a missing blob", () => {
    expect(parseHarness(undefined)).toEqual(DEFAULT_HARNESS_SETTINGS);
    expect(parseHarness({})).toEqual(DEFAULT_HARNESS_SETTINGS);
  });

  it("clamps out-of-range values and drops unknown reasoning efforts", () => {
    const parsed = parseHarness({
      maxSteps: 900,
      tokenBudget: 1,
      temperature: -4,
      reasoningEffort: "extreme",
      deliberateMode: "yes",
    });
    expect(parsed.maxSteps).toBe(30);
    expect(parsed.tokenBudget).toBe(1_000);
    expect(parsed.temperature).toBe(0);
    expect(parsed.reasoningEffort).toBeNull();
    // Only a real boolean turns deliberate mode on.
    expect(parsed.deliberateMode).toBe(false);
  });
});

describe("saveVersion validation", () => {
  it("rejects a context over the league's character limit", async () => {
    const f = await makeLeague({ contextCharLimit: 200 });
    await expect(
      saveVersion({
        ...BASE,
        teamId: f.team.id,
        userId: f.owner.id,
        contextMd: "x".repeat(201),
        now: TUE_10_ET,
      }),
    ).rejects.toThrow(ConfigValidationError);
  });

  it("rejects a model that is not on the allowlist", async () => {
    const f = await makeLeague({ modelAllowlist: ["anthropic/claude-haiku-4.5"] });
    let caught: ConfigValidationError | undefined;
    try {
      await saveVersion({ ...BASE, teamId: f.team.id, userId: f.owner.id, now: TUE_10_ET });
    } catch (err) {
      caught = err as ConfigValidationError;
    }
    expect(caught).toBeInstanceOf(ConfigValidationError);
    expect(caught!.issues.map((i) => i.field)).toContain("modelId");
  });

  it("rejects max steps above the league cap and above the platform ceiling", async () => {
    const f = await makeLeague({ maxStepsCap: 8 });
    await expect(
      saveVersion({
        ...BASE,
        teamId: f.team.id,
        userId: f.owner.id,
        harness: { ...DEFAULT_HARNESS_SETTINGS, maxSteps: 9 },
        now: TUE_10_ET,
      }),
    ).rejects.toThrow(/8 or fewer/);

    await expect(
      saveVersion({
        ...BASE,
        teamId: f.team.id,
        userId: f.owner.id,
        harness: { ...DEFAULT_HARNESS_SETTINGS, maxSteps: 31 },
        now: TUE_10_ET,
      }),
    ).rejects.toThrow(/between 1 and 30/);
  });

  it("rejects a per-run token budget above the weekly cap", async () => {
    const f = await makeLeague({ weeklyTokenCapPerTeam: 50_000 });
    await expect(
      saveVersion({
        ...BASE,
        teamId: f.team.id,
        userId: f.owner.id,
        harness: { ...DEFAULT_HARNESS_SETTINGS, tokenBudget: 60_000 },
        now: TUE_10_ET,
      }),
    ).rejects.toThrow(/weekly cap/);
  });

  it("rejects a temperature outside 0–2", async () => {
    const f = await makeLeague();
    await expect(
      saveVersion({
        ...BASE,
        teamId: f.team.id,
        userId: f.owner.id,
        harness: { ...DEFAULT_HARNESS_SETTINGS, temperature: 2.5 },
        now: TUE_10_ET,
      }),
    ).rejects.toThrow(/Temperature/);
  });

  it("rejects reasoning effort on a model that does not support it", async () => {
    const f = await makeLeague();
    await expect(
      saveVersion({
        ...BASE,
        teamId: f.team.id,
        userId: f.owner.id,
        modelId: "mock/scripted",
        harness: { ...DEFAULT_HARNESS_SETTINGS, reasoningEffort: "high" },
        now: TUE_10_ET,
      }),
    ).rejects.toThrow(/does not support reasoning/);
  });

  it("accepts reasoning effort on a model that does", async () => {
    const f = await makeLeague();
    const result = await saveVersion({
      ...BASE,
      teamId: f.team.id,
      userId: f.owner.id,
      harness: { ...DEFAULT_HARNESS_SETTINGS, reasoningEffort: "high" },
      now: TUE_10_ET,
    });
    expect(result.version.harness.reasoningEffort).toBe("high");
  });

  it("refuses a save by anyone but the owner or the commissioner", async () => {
    const f = await makeLeague();
    await expect(
      saveVersion({ ...BASE, teamId: f.team.id, userId: f.other.id, now: TUE_10_ET }),
    ).rejects.toThrow(ConfigForbiddenError);

    const stranger = await makeUser("Stranger");
    await expect(
      saveVersion({ ...BASE, teamId: f.team.id, userId: stranger.id, now: TUE_10_ET }),
    ).rejects.toThrow(ConfigForbiddenError);

    // The commissioner may edit any team in their league.
    const asCommish = await saveVersion({
      ...BASE,
      teamId: f.team.id,
      userId: f.commissioner.id,
      now: TUE_10_ET,
    });
    expect(asCommish.applied).toBe(true);
  });
});

describe("edit lock", () => {
  it("applies immediately on Tuesday 10:00 ET", async () => {
    const f = await makeLeague();
    const result = await saveVersion({
      ...BASE,
      teamId: f.team.id,
      userId: f.owner.id,
      changeSummary: "Tuesday edit",
      now: TUE_10_ET,
    });

    expect(result.applied).toBe(true);
    expect(result.queued).toBe(false);
    expect(result.appliesAt).toBeNull();
    expect(result.version.appliedAt).toEqual(TUE_10_ET);

    const config = await db.query.agentConfigs.findFirst({
      where: eq(agentConfigs.teamId, f.team.id),
    });
    expect(config!.currentVersionId).toBe(result.version.id);
    expect(config!.pendingVersionId).toBeNull();

    const current = await getCurrentConfigVersion(f.team.id);
    expect(current!.versionNo).toBe(2);
    expect(current!.changeSummary).toBe("Tuesday edit");
  });

  it("queues on Friday 10:00 ET and leaves the current version untouched", async () => {
    const f = await makeLeague();
    const before = await getCurrentConfigVersion(f.team.id);

    const result = await saveVersion({
      ...BASE,
      teamId: f.team.id,
      userId: f.owner.id,
      now: FRI_10_ET,
    });

    expect(result.applied).toBe(false);
    expect(result.queued).toBe(true);
    expect(result.version.appliedAt).toBeNull();
    expect(result.appliesAt!.getTime()).toBeGreaterThan(FRI_10_ET.getTime());

    const config = await db.query.agentConfigs.findFirst({
      where: eq(agentConfigs.teamId, f.team.id),
    });
    expect(config!.currentVersionId).toBe(before!.id);
    expect(config!.pendingVersionId).toBe(result.version.id);

    // The runtime still sees the old version.
    const current = await getCurrentConfigVersion(f.team.id);
    expect(current!.id).toBe(before!.id);
  });

  it("a second locked save replaces the earlier pending version", async () => {
    const f = await makeLeague();
    const first = await saveVersion({
      ...BASE,
      teamId: f.team.id,
      userId: f.owner.id,
      now: FRI_10_ET,
    });
    const second = await saveVersion({
      ...BASE,
      teamId: f.team.id,
      userId: f.owner.id,
      contextMd: "second attempt",
      now: FRI_10_ET,
    });

    const config = await db.query.agentConfigs.findFirst({
      where: eq(agentConfigs.teamId, f.team.id),
    });
    expect(config!.pendingVersionId).toBe(second.version.id);

    // The superseded version is still in history — versions are immutable.
    const versions = await listVersions(config!.id);
    expect(versions.map((v) => v.id)).toContain(first.version.id);
  });

  it("getEditLockStatus reports open on Tuesday and closed on Friday", async () => {
    const f = await makeLeague();
    const open = await getEditLockStatus(f.league.id, TUE_10_ET);
    expect(open.open).toBe(true);
    // Next change is the Wednesday 03:00 ET lock.
    expect(open.nextChange.getTime()).toBeGreaterThan(TUE_10_ET.getTime());

    const closed = await getEditLockStatus(f.league.id, FRI_10_ET);
    expect(closed.open).toBe(false);
    expect(closed.nextChange.getTime()).toBeGreaterThan(FRI_10_ET.getTime());
  });

  it("editLockStatusFor is pure and honours a custom lock window", () => {
    const lock = { ...DEFAULT_EDIT_LOCK, unlockDay: "thu" as const, lockDay: "fri" as const };
    expect(editLockStatusFor(lock, TUE_10_ET).open).toBe(false);
    expect(editLockStatusFor(DEFAULT_EDIT_LOCK, TUE_10_ET).open).toBe(true);
  });
});

describe("applyPendingConfigVersions", () => {
  it("promotes every queued version in the league and returns the count", async () => {
    const f = await makeLeague();

    const a = await saveVersion({
      ...BASE,
      teamId: f.team.id,
      userId: f.owner.id,
      now: FRI_10_ET,
    });
    const b = await saveVersion({
      ...BASE,
      teamId: f.otherTeam.id,
      userId: f.other.id,
      now: FRI_10_ET,
    });

    const promoted = await applyPendingConfigVersions(f.league.id);
    expect(promoted).toBe(2);

    for (const [teamId, version] of [
      [f.team.id, a.version.id],
      [f.otherTeam.id, b.version.id],
    ] as const) {
      const config = await db.query.agentConfigs.findFirst({
        where: eq(agentConfigs.teamId, teamId),
      });
      expect(config!.currentVersionId).toBe(version);
      expect(config!.pendingVersionId).toBeNull();

      const row = await db.query.configVersions.findFirst({
        where: eq(configVersions.id, version),
      });
      expect(row!.appliedAt).not.toBeNull();
    }

    // Idempotent: a second call finds nothing to do.
    expect(await applyPendingConfigVersions(f.league.id)).toBe(0);
  });
});

describe("note to agent", () => {
  it("is appended to the context on the next save and then cleared", async () => {
    const f = await makeLeague();
    await setNoteToAgent(f.team.id, "You benched Bijan again. Stop doing that.");

    const beforeSave = await getConfigForTeam(f.team.id);
    expect(beforeSave.config.noteToAgent).toMatch(/Bijan/);

    const result = await saveVersion({
      ...BASE,
      teamId: f.team.id,
      userId: f.owner.id,
      contextMd: "# Context\n\nBe bold.",
      now: TUE_10_ET,
    });

    expect(result.noteAppended).toMatch(/Bijan/);
    expect(result.version.contextMd).toContain("Be bold.");
    expect(result.version.contextMd).toContain("Note from my owner");
    expect(result.version.contextMd).toContain("Stop doing that.");

    const after = await getConfigForTeam(f.team.id);
    expect(after.config.noteToAgent).toBeNull();

    // The next save does not re-append it.
    const second = await saveVersion({
      ...BASE,
      teamId: f.team.id,
      userId: f.owner.id,
      contextMd: "# Context\n\nBe bold.",
      now: TUE_10_ET,
    });
    expect(second.noteAppended).toBeNull();
    expect(second.version.contextMd).not.toContain("Note from my owner");
  });

  it("counts the appended note against the context character limit", async () => {
    const f = await makeLeague({ contextCharLimit: 120 });
    await setNoteToAgent(f.team.id, "n".repeat(100));
    await expect(
      saveVersion({
        ...BASE,
        teamId: f.team.id,
        userId: f.owner.id,
        contextMd: "c".repeat(100),
        now: TUE_10_ET,
      }),
    ).rejects.toThrow(/note to agent is appended/);
  });
});

describe("skills on a version", () => {
  it("stores attachment order and returns it from getCurrentConfigVersion", async () => {
    const f = await makeLeague();
    const author = await makeUser("Author");
    const first = await createSkill({
      authorUserId: author.id,
      name: "Zebra strategy",
      bodyMd: "# Zebra",
    });
    const second = await createSkill({
      authorUserId: author.id,
      name: "Alpha strategy",
      bodyMd: "# Alpha",
    });

    await saveVersion({
      ...BASE,
      teamId: f.team.id,
      userId: f.owner.id,
      skillIds: [first.id, second.id],
      now: TUE_10_ET,
    });

    const current = await getCurrentConfigVersion(f.team.id);
    // Injection order, not alphabetical.
    expect(current!.skills.map((s) => s.name)).toEqual(["Zebra strategy", "Alpha strategy"]);
  });

  it("rejects unknown skill ids", async () => {
    const f = await makeLeague();
    await expect(
      saveVersion({
        ...BASE,
        teamId: f.team.id,
        userId: f.owner.id,
        skillIds: ["00000000-0000-4000-8000-000000000000"],
        now: TUE_10_ET,
      }),
    ).rejects.toThrow(/Unknown skill/);
  });
});

describe("diffVersions", () => {
  it("returns context hunks plus structured model / harness / skill diffs", async () => {
    const f = await makeLeague();
    const author = await makeUser("Author");
    const skill = await createSkill({
      authorUserId: author.id,
      name: "Injury reading",
      bodyMd: "# Injuries",
    });

    const a = await saveVersion({
      ...BASE,
      teamId: f.team.id,
      userId: f.owner.id,
      contextMd: "line one\nline two\nline three\n",
      now: TUE_10_ET,
    });

    const b = await saveVersion({
      ...BASE,
      teamId: f.team.id,
      userId: f.owner.id,
      contextMd: "line one\nline TWO\nline three\n",
      modelId: "anthropic/claude-haiku-4.5",
      harness: { ...DEFAULT_HARNESS_SETTINGS, maxSteps: 20, deliberateMode: true },
      skillIds: [skill.id],
      now: TUE_10_ET,
    });

    const diff = await diffVersions(a.version.id, b.version.id);

    expect(diff.changed).toBe(true);
    expect(diff.a.versionNo).toBe(a.version.versionNo);
    expect(diff.b.versionNo).toBe(b.version.versionNo);

    expect(diff.context.changed).toBe(true);
    expect(diff.context.added).toBe(1);
    expect(diff.context.removed).toBe(1);
    expect(diff.context.hunks).toHaveLength(1);
    expect(diff.context.hunks[0].header).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@$/);
    expect(diff.context.hunks[0].lines.some((l) => l.kind === "add" && l.text === "line TWO")).toBe(
      true,
    );
    expect(diff.context.hunks[0].lines.some((l) => l.kind === "del" && l.text === "line two")).toBe(
      true,
    );
    expect(diff.context.unified).toContain("+line TWO");
    expect(diff.context.unified).toContain("-line two");

    expect(diff.model.changed).toBe(true);
    expect(diff.model.from).toBe("Claude Sonnet 4.5");
    expect(diff.model.to).toBe("Claude Haiku 4.5");

    const byField = Object.fromEntries(diff.harness.map((h) => [h.field, h]));
    expect(byField.maxSteps.changed).toBe(true);
    expect(byField.maxSteps.from).toBe("12");
    expect(byField.maxSteps.to).toBe("20");
    expect(byField.deliberateMode.to).toBe("on");
    expect(byField.temperature.changed).toBe(false);

    expect(diff.skills.added.map((s) => s.name)).toEqual(["Injury reading"]);
    expect(diff.skills.removed).toEqual([]);
    expect(diff.skills.changed).toBe(true);
  });

  it("reports no change between a version and itself", async () => {
    const f = await makeLeague();
    const a = await saveVersion({
      ...BASE,
      teamId: f.team.id,
      userId: f.owner.id,
      now: TUE_10_ET,
    });
    const diff = await diffVersions(a.version.id, a.version.id);
    expect(diff.changed).toBe(false);
    expect(diff.context.hunks).toEqual([]);
    expect(diff.skills.reordered).toBe(false);
  });

  it("detects a pure reorder of the same skills", async () => {
    const f = await makeLeague();
    const author = await makeUser("Author");
    const one = await createSkill({ authorUserId: author.id, name: "One", bodyMd: "1" });
    const two = await createSkill({ authorUserId: author.id, name: "Two", bodyMd: "2" });

    const a = await saveVersion({
      ...BASE,
      teamId: f.team.id,
      userId: f.owner.id,
      skillIds: [one.id, two.id],
      now: TUE_10_ET,
    });
    const b = await saveVersion({
      ...BASE,
      teamId: f.team.id,
      userId: f.owner.id,
      skillIds: [two.id, one.id],
      now: TUE_10_ET,
    });

    const diff = await diffVersions(a.version.id, b.version.id);
    expect(diff.skills.reordered).toBe(true);
    expect(diff.skills.added).toEqual([]);
    expect(diff.skills.removed).toEqual([]);
    expect(diff.changed).toBe(true);
  });
});

describe("version history", () => {
  it("is ordered newest-first and flags current and pending", async () => {
    const f = await makeLeague();
    const applied = await saveVersion({
      ...BASE,
      teamId: f.team.id,
      userId: f.owner.id,
      now: TUE_10_ET,
    });
    const queued = await saveVersion({
      ...BASE,
      teamId: f.team.id,
      userId: f.owner.id,
      now: FRI_10_ET,
    });

    const view = await getConfigForTeam(f.team.id);
    expect(view.versions[0].versionNo).toBe(3);
    expect(view.versions.at(-1)!.versionNo).toBe(1);
    expect(view.versions.find((v) => v.id === applied.version.id)!.isCurrent).toBe(true);
    expect(view.versions.find((v) => v.id === queued.version.id)!.isPending).toBe(true);
    expect(view.versions[0].createdByName).toBe("Owner One");
    expect(view.current!.id).toBe(applied.version.id);
    expect(view.pending!.id).toBe(queued.version.id);
  });
});
