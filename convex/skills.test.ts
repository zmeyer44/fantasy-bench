/**
 * The skill library. Reads are public and cross-league; private skills are
 * visible only to their author (`lib/trpc/routers/skills.ts` + `lib/services/skills`).
 */
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

/** Preserves the schema generic, so `t.run`'s `ctx.db` stays fully typed. */
function newTest() {
  return convexTest(schema, modules);
}
type T = ReturnType<typeof newTest>;

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

async function makeSkill(
  t: T,
  skill: {
    name: string;
    slug: string;
    description?: string;
    visibility?: "public" | "private";
    authorUserId?: Id<"users">;
    forkedFromSkillId?: Id<"skills">;
    usageCount?: number;
  },
) {
  return t.run(async (ctx) =>
    ctx.db.insert("skills", {
      name: skill.name,
      slug: skill.slug,
      description: skill.description,
      bodyMd: `# ${skill.name}\n\nBody.`,
      visibility: skill.visibility ?? "public",
      authorUserId: skill.authorUserId,
      forkedFromSkillId: skill.forkedFromSkillId,
      usageCount: skill.usageCount ?? 0,
      updatedAt: Date.now(),
    }),
  );
}

async function library() {
  const t = newTest();
  const ada = await actor(t, "Ada", "ada@fantasybench.dev");
  const bob = await actor(t, "Bob", "bob@fantasybench.dev");

  const vbd = await makeSkill(t, {
    name: "Value-based drafting",
    slug: "value-based-drafting",
    description: "Draft by points above replacement.",
    authorUserId: ada.userId,
    usageCount: 3,
  });
  await makeSkill(t, {
    name: "Injury-aware lineups",
    slug: "injury-aware-lineups",
    description: "Read designations correctly.",
    authorUserId: bob.userId,
  });
  await makeSkill(t, {
    name: "Secret sauce",
    slug: "secret-sauce",
    description: "Nobody else sees this.",
    authorUserId: ada.userId,
    visibility: "private",
  });
  return { t, ada, bob, vbd };
}

describe("skills.list", () => {
  it("returns the public library, alphabetically, with author names", async () => {
    const { t } = await library();
    const rows = await t.query(api.skills.list, {});
    expect(rows.map((row) => row.slug)).toEqual([
      "injury-aware-lineups",
      "value-based-drafting",
    ]);
    expect(rows.find((row) => row.slug === "value-based-drafting")).toMatchObject({
      authorName: "Ada",
      usageCount: 3,
    });
  });

  it("includes the viewer's own private skills", async () => {
    const { ada, bob } = await library();
    const asAda = await ada.session.query(api.skills.list, {});
    expect(asAda.map((row) => row.slug)).toContain("secret-sauce");

    const asBob = await bob.session.query(api.skills.list, {});
    expect(asBob.map((row) => row.slug)).not.toContain("secret-sauce");
  });

  it("searches names, slugs and descriptions", async () => {
    const { t } = await library();
    expect((await t.query(api.skills.list, { query: "injury" })).map((r) => r.slug)).toEqual([
      "injury-aware-lineups",
    ]);
    // Description-only match (the Postgres ILIKE covered name, slug and description).
    expect(
      (await t.query(api.skills.list, { query: "replacement" })).map((r) => r.slug),
    ).toEqual(["value-based-drafting"]);
    expect(await t.query(api.skills.list, { query: "nothingmatches" })).toEqual([]);
  });

  it("narrows to one author, and `mine` needs a session", async () => {
    const { t, ada } = await library();
    const byAda = await t.query(api.skills.list, { authorUserId: ada.userId });
    expect(byAda.map((r) => r.slug)).toEqual(["value-based-drafting"]);

    const mine = await ada.session.query(api.skills.list, { mine: true });
    expect(mine.map((r) => r.slug).sort()).toEqual(["secret-sauce", "value-based-drafting"]);

    // Signed out, `mine` matches nobody rather than everybody.
    expect(await t.query(api.skills.list, { mine: true })).toEqual([]);
  });
});

describe("skills.get", () => {
  it("returns the skill with its author and fork lineage", async () => {
    const { t, ada, bob, vbd } = await library();
    await makeSkill(t, {
      name: "Value-based drafting (fork)",
      slug: "value-based-drafting-fork",
      authorUserId: bob.userId,
      forkedFromSkillId: vbd,
    });

    const parent = await t.query(api.skills.get, { slug: "value-based-drafting" });
    expect(parent).toMatchObject({ authorName: "Ada", usageCount: 3, forkedFrom: null });
    expect(parent?.forks.map((fork) => fork.slug)).toEqual(["value-based-drafting-fork"]);

    const fork = await t.query(api.skills.get, { slug: "value-based-drafting-fork" });
    expect(fork?.forkedFrom).toMatchObject({ _id: vbd, slug: "value-based-drafting" });
    expect(fork?.forks).toEqual([]);
    expect(ada.userId).not.toBe(bob.userId);
  });

  it("is null for an unknown slug and FORBIDDEN for someone else's private skill", async () => {
    const { t, ada, bob } = await library();
    expect(await t.query(api.skills.get, { slug: "nope" })).toBeNull();
    expect((await ada.session.query(api.skills.get, { slug: "secret-sauce" }))?.slug).toBe(
      "secret-sauce",
    );
    await expect(bob.session.query(api.skills.get, { slug: "secret-sauce" })).rejects.toThrow();
    await expect(t.query(api.skills.get, { slug: "secret-sauce" })).rejects.toThrow();
  });
});
