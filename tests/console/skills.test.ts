import { beforeAll, describe, expect, it } from "vitest";

import {
  MAX_SKILL_BODY_CHARS,
  SkillForbiddenError,
  SkillValidationError,
  createSkill,
  forkSkill,
  getSkill,
  listSkills,
  skillUsageCounts,
  slugifySkill,
  updateSkill,
} from "@/lib/services/skills";
import { DEFAULT_HARNESS_SETTINGS, saveVersion } from "@/lib/services/config";

import { truncateAll } from "../setup";
import { TUE_10_ET, makeLeague, makeUser } from "./helpers";

beforeAll(async () => {
  await truncateAll();
});

describe("slugs", () => {
  it("derives a slug from the name", () => {
    expect(slugifySkill("  Injury-aware Lineups!! ")).toBe("injury-aware-lineups");
    expect(slugifySkill("???")).toBe("skill");
  });

  it("suffixes on collision rather than failing", async () => {
    const author = await makeUser("Author");
    const a = await createSkill({ authorUserId: author.id, name: "Streaming DEF", bodyMd: "# a" });
    const b = await createSkill({ authorUserId: author.id, name: "Streaming DEF", bodyMd: "# b" });
    const c = await createSkill({ authorUserId: author.id, name: "streaming def", bodyMd: "# c" });

    expect(a.slug).toBe("streaming-def");
    expect(b.slug).toBe("streaming-def-2");
    expect(c.slug).toBe("streaming-def-3");
    expect(new Set([a.slug, b.slug, c.slug]).size).toBe(3);
  });
});

describe("createSkill", () => {
  it("rejects an over-long body", async () => {
    const author = await makeUser("Author");
    await expect(
      createSkill({
        authorUserId: author.id,
        name: "Too long",
        bodyMd: "x".repeat(MAX_SKILL_BODY_CHARS + 1),
      }),
    ).rejects.toThrow(SkillValidationError);
  });

  it("rejects an empty body and a short name", async () => {
    const author = await makeUser("Author");
    await expect(
      createSkill({ authorUserId: author.id, name: "Fine name", bodyMd: "   " }),
    ).rejects.toThrow(/cannot be empty/);
    await expect(
      createSkill({ authorUserId: author.id, name: "ab", bodyMd: "# ok" }),
    ).rejects.toThrow(/at least 3/);
  });
});

describe("updateSkill", () => {
  it("is author-only and bumps updated_at", async () => {
    const author = await makeUser("Author");
    const stranger = await makeUser("Stranger");
    const skill = await createSkill({
      authorUserId: author.id,
      name: "Bye week planning",
      bodyMd: "# v1",
    });

    await expect(
      updateSkill({ skillId: skill.id, userId: stranger.id, bodyMd: "# hijack" }),
    ).rejects.toThrow(SkillForbiddenError);

    const updated = await updateSkill({ skillId: skill.id, userId: author.id, bodyMd: "# v2" });
    expect(updated.bodyMd).toBe("# v2");
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(skill.updatedAt.getTime());
    // The slug never moves — attached configs point at the id anyway.
    expect(updated.slug).toBe(skill.slug);
  });
});

describe("forkSkill", () => {
  it("copies the body under a new slug owned by the forker", async () => {
    const author = await makeUser("Author");
    const forker = await makeUser("Forker");
    const source = await createSkill({
      authorUserId: author.id,
      name: "Value based drafting",
      description: "VOR",
      bodyMd: "# VOR\n\nDraft by value over replacement.",
    });

    const fork = await forkSkill(source.slug, forker.id);
    expect(fork.id).not.toBe(source.id);
    expect(fork.authorUserId).toBe(forker.id);
    expect(fork.bodyMd).toBe(source.bodyMd);
    expect(fork.forkedFromSkillId).toBe(source.id);
    expect(fork.slug).toBe("value-based-drafting-fork");

    const detail = await getSkill(source.slug);
    expect(detail!.forks.map((f) => f.id)).toContain(fork.id);
  });
});

describe("listSkills", () => {
  it("searches name, slug and description and hides other people's private skills", async () => {
    const author = await makeUser("Author");
    const other = await makeUser("Other");
    await createSkill({
      authorUserId: author.id,
      name: "Waiver FAAB curves",
      description: "How to spend FAAB",
      bodyMd: "# FAAB",
    });
    const secret = await createSkill({
      authorUserId: author.id,
      name: "Secret sauce",
      bodyMd: "# secret",
      visibility: "private",
    });

    const found = await listSkills({ query: "faab" });
    expect(found.map((s) => s.name)).toContain("Waiver FAAB curves");

    const asStranger = await listSkills({ viewerUserId: other.id });
    expect(asStranger.map((s) => s.id)).not.toContain(secret.id);

    const asAuthor = await listSkills({ viewerUserId: author.id });
    expect(asAuthor.map((s) => s.id)).toContain(secret.id);

    const mine = await listSkills({ authorUserId: author.id, viewerUserId: author.id });
    expect(mine.every((s) => s.authorUserId === author.id)).toBe(true);
    expect(mine[0].authorName).toBe("Author");
  });
});

describe("skillUsageCounts", () => {
  it("counts only current config versions", async () => {
    const f = await makeLeague();
    const author = await makeUser("Author");
    const attached = await createSkill({
      authorUserId: author.id,
      name: "Attached skill",
      bodyMd: "# a",
    });
    const dropped = await createSkill({
      authorUserId: author.id,
      name: "Dropped skill",
      bodyMd: "# d",
    });

    const base = {
      contextMd: "ctx",
      modelId: "anthropic/claude-sonnet-4.5",
      harness: DEFAULT_HARNESS_SETTINGS,
      userId: f.owner.id,
      now: TUE_10_ET,
    };

    // v2 attaches both; v3 keeps only one. Only v3 is current.
    await saveVersion({ ...base, teamId: f.team.id, skillIds: [attached.id, dropped.id] });
    await saveVersion({ ...base, teamId: f.team.id, skillIds: [attached.id] });

    // A second team also runs the attached skill.
    await saveVersion({
      ...base,
      userId: f.other.id,
      teamId: f.otherTeam.id,
      skillIds: [attached.id],
    });

    const counts = await skillUsageCounts();
    expect(counts.get(attached.id)).toBe(2);
    expect(counts.get(dropped.id) ?? 0).toBe(0);

    const listed = await listSkills({ query: "Attached skill" });
    expect(listed[0].usageCount).toBe(2);
  });
});
