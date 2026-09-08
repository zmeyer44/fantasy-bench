/**
 * The skill library. Reads are public and cross-league; private skills are
 * visible only to their author.
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

// ===========================================================================
// skills.create / update / fork (Phase 3)
// ===========================================================================

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

describe("skills.create", () => {
  it("requires a session", async () => {
    const { t } = await library();
    expect(await errorCode(t.mutation(api.skills.create, { name: "Anon", bodyMd: "# a" }))).toBe(
      "UNAUTHORIZED",
    );
  });

  it("derives a slug from the name and suffixes on collision", async () => {
    const { ada } = await library();
    const a = await ada.session.mutation(api.skills.create, {
      name: "  Streaming DEF!! ",
      bodyMd: "# a",
    });
    const b = await ada.session.mutation(api.skills.create, { name: "Streaming DEF", bodyMd: "# b" });
    const c = await ada.session.mutation(api.skills.create, { name: "streaming def", bodyMd: "# c" });

    expect(a.slug).toBe("streaming-def");
    expect(b.slug).toBe("streaming-def-2");
    expect(c.slug).toBe("streaming-def-3");
    expect(new Set([a.slug, b.slug, c.slug]).size).toBe(3);
    expect(a.name).toBe("Streaming DEF!!");
    expect(a.usageCount).toBe(0);
    expect(a.visibility).toBe("public");
    expect(a.authorUserId).toBe(ada.userId);
  });

  it("rejects an over-long body, an empty body and a short name", async () => {
    const { ada } = await library();
    expect(
      await errorCode(
        ada.session.mutation(api.skills.create, {
          name: "Too long",
          bodyMd: "x".repeat(20_001),
        }),
      ),
    ).toBe("BAD_REQUEST");
    expect(
      await errorCode(ada.session.mutation(api.skills.create, { name: "Fine name", bodyMd: "   " })),
    ).toBe("BAD_REQUEST");
    expect(
      await errorCode(ada.session.mutation(api.skills.create, { name: "ab", bodyMd: "# ok" })),
    ).toBe("BAD_REQUEST");
    expect(
      await errorCode(
        ada.session.mutation(api.skills.create, { name: "n".repeat(81), bodyMd: "# ok" }),
      ),
    ).toBe("BAD_REQUEST");
  });

  it("trims a long description to the 280-character cap", async () => {
    const { ada } = await library();
    const created = await ada.session.mutation(api.skills.create, {
      name: "Described",
      description: `  ${"d".repeat(400)}  `,
      bodyMd: "# d",
    });
    expect(created.description).toHaveLength(280);
  });
});

describe("skills.update", () => {
  it("is author-only, bumps updatedAt and never moves the slug", async () => {
    const { t, ada, bob, vbd } = await library();
    const before = await t.run(async (ctx) => ctx.db.get("skills", vbd));

    expect(await errorCode(t.mutation(api.skills.update, { skillId: vbd, bodyMd: "# hijack" }))).toBe(
      "UNAUTHORIZED",
    );
    expect(
      await errorCode(bob.session.mutation(api.skills.update, { skillId: vbd, bodyMd: "# hijack" })),
    ).toBe("FORBIDDEN");

    const updated = await ada.session.mutation(api.skills.update, {
      skillId: vbd,
      name: "Value-based drafting v2",
      bodyMd: "# v2",
      visibility: "private",
    });
    expect(updated.bodyMd).toBe("# v2");
    expect(updated.name).toBe("Value-based drafting v2");
    expect(updated.visibility).toBe("private");
    expect(updated.slug).toBe(before!.slug);
    expect(updated.updatedAt).toBeGreaterThanOrEqual(before!.updatedAt);
    // Edits are retroactive: usage is untouched by a body edit.
    expect(updated.usageCount).toBe(before!.usageCount);
  });

  it("rejects an over-long body on update and NOT_FOUND for a deleted skill", async () => {
    const { t, ada, vbd } = await library();
    expect(
      await errorCode(
        ada.session.mutation(api.skills.update, { skillId: vbd, bodyMd: "x".repeat(20_001) }),
      ),
    ).toBe("BAD_REQUEST");

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
    expect(await errorCode(ada.session.mutation(api.skills.update, { skillId: ghost }))).toBe(
      "NOT_FOUND",
    );
  });
});

describe("skills.fork", () => {
  it("copies the body under a new slug owned by the forker", async () => {
    const { t, bob, vbd } = await library();
    const source = await t.run(async (ctx) => ctx.db.get("skills", vbd));

    const fork = await bob.session.mutation(api.skills.fork, { slug: "value-based-drafting" });
    expect(fork._id).not.toBe(vbd);
    expect(fork.authorUserId).toBe(bob.userId);
    expect(fork.bodyMd).toBe(source!.bodyMd);
    expect(fork.description).toBe(source!.description);
    expect(fork.forkedFromSkillId).toBe(vbd);
    expect(fork.visibility).toBe("public");
    expect(fork.slug).toBe("value-based-drafting-fork");
    // A fork starts unused even when its parent is widely attached.
    expect(fork.usageCount).toBe(0);

    const detail = await t.query(api.skills.get, { slug: "value-based-drafting" });
    expect(detail?.forks.map((f) => f._id)).toContain(fork._id);

    // Forking twice suffixes rather than failing.
    const second = await bob.session.mutation(api.skills.fork, { slug: "value-based-drafting" });
    expect(second.slug).toBe("value-based-drafting-fork-2");
  });

  it("requires a session and NOT_FOUND for an unknown slug", async () => {
    const { t, bob } = await library();
    expect(await errorCode(t.mutation(api.skills.fork, { slug: "value-based-drafting" }))).toBe(
      "UNAUTHORIZED",
    );
    expect(await errorCode(bob.session.mutation(api.skills.fork, { slug: "nope" }))).toBe(
      "NOT_FOUND",
    );
  });
});
