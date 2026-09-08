/**
 * The skill library (PRD 4, 5.5). Reads are public and cross-league: anyone can
 * see what their opponents are running, and anyone can fork it. Private skills
 * are visible only to their author.
 *
 * `usageCount` is denormalized onto the row (the Postgres version counted
 * `config_version_skills` joined to current configs at query time; §2.3).
 *
 * IMPORTANT — skills are attached by id, not by value: `config_versions.skillIds`
 * points at the live row, so `update` changes the prompt of every team whose
 * *current* version attaches it, retroactively and without a new config version.
 * That is deliberate (authors maintain their skills); the editor surfaces
 * `usageCount` as a warning first.
 */
import { v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { optionalUser, requireUser } from "./lib/auth";
import { appError } from "./lib/errors";
import { slugifySkill } from "./lib/season";
import { skillDoc } from "./lib/validators";
import { skillVisibility } from "./schema";

/** The library index page shows at most this many rows. */
const LIST_LIMIT = 200;

export type SkillWithMeta = Doc<"skills"> & { authorName: string | null };

const skillWithMeta = v.object({ ...skillDoc.fields, authorName: v.union(v.string(), v.null()) });

const skillStamp = v.object({
  _id: v.id("skills"),
  name: v.string(),
  slug: v.string(),
});

/**
 * Library index.
 *
 * `query`      -> `search_name` (the Postgres ILIKE over name/slug/description).
 * `mine`/author-> `by_authorUserId`.
 * neither      -> `by_visibility` public.
 *
 * The viewer's own private skills are always included; everyone else's are not.
 */
export const list = query({
  args: {
    query: v.optional(v.string()),
    authorUserId: v.optional(v.id("users")),
    mine: v.optional(v.boolean()),
  },
  returns: v.array(skillWithMeta),
  handler: async (ctx, args) => {
    const viewer = await optionalUser(ctx);
    const viewerUserId = viewer?.userId ?? null;
    const author = args.mine ? viewerUserId : (args.authorUserId ?? null);

    // `mine` with no session can never match: return nothing rather than everything.
    if (args.mine && !viewerUserId) return [];

    // The Postgres query was `visibility = public OR author = viewer`, narrowed by
    // an optional author and an ILIKE over name/slug/description. Each of those
    // becomes its own indexed read here, unioned and filtered in TS.
    const pool = new Map<string, Doc<"skills">>();
    const add = (rows: Doc<"skills">[]) => {
      for (const row of rows) pool.set(row._id, row);
    };

    const term = args.query?.trim();
    if (term) {
      // The search index only covers `name`; the ILIKE also matched slug and
      // description, so those are filtered in TS over the bounded public page.
      add(
        await ctx.db
          .query("skills")
          .withSearchIndex("search_name", (q) => q.search("name", term))
          .take(LIST_LIMIT),
      );
    }

    if (author) {
      add(
        await ctx.db
          .query("skills")
          .withIndex("by_authorUserId", (q) => q.eq("authorUserId", author))
          .take(LIST_LIMIT),
      );
    } else {
      add(
        await ctx.db
          .query("skills")
          .withIndex("by_visibility", (q) => q.eq("visibility", "public"))
          .take(LIST_LIMIT),
      );
      if (viewerUserId) {
        // The viewer's own private skills are part of their library view.
        add(
          await ctx.db
            .query("skills")
            .withIndex("by_authorUserId", (q) => q.eq("authorUserId", viewerUserId))
            .take(LIST_LIMIT),
        );
      }
    }

    const needle = term?.toLowerCase();
    const rows = [...pool.values()].filter((skill) => {
      const visible =
        skill.visibility === "public" ||
        (viewerUserId !== null && skill.authorUserId === viewerUserId);
      if (!visible) return false;
      if (author && skill.authorUserId !== author) return false;
      if (!needle) return true;
      return (
        skill.name.toLowerCase().includes(needle) ||
        skill.slug.toLowerCase().includes(needle) ||
        (skill.description ?? "").toLowerCase().includes(needle)
      );
    });

    const names = new Map<string, string | null>();
    const out: SkillWithMeta[] = [];
    for (const skill of rows.slice(0, LIST_LIMIT)) {
      let authorName: string | null = null;
      if (skill.authorUserId) {
        if (!names.has(skill.authorUserId)) {
          const user = await ctx.db.get("users", skill.authorUserId);
          names.set(skill.authorUserId, user?.name ?? null);
        }
        authorName = names.get(skill.authorUserId) ?? null;
      }
      out.push({ ...skill, authorName });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  },
});

/** One skill by slug, with its author, usage count and fork lineage. */
export const get = query({
  args: { slug: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      ...skillDoc.fields,
      authorName: v.union(v.string(), v.null()),
      forkedFrom: v.union(skillStamp, v.null()),
      forks: v.array(skillStamp),
    }),
  ),
  handler: async (ctx, { slug }) => {
    const skill = await ctx.db
      .query("skills")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();
    if (!skill) return null;

    const viewer = await optionalUser(ctx);
    if (skill.visibility === "private" && skill.authorUserId !== viewer?.userId) {
      throw appError("FORBIDDEN", "This skill is private.");
    }

    const author = skill.authorUserId ? await ctx.db.get("users", skill.authorUserId) : null;
    const parent = skill.forkedFromSkillId
      ? await ctx.db.get("skills", skill.forkedFromSkillId)
      : null;

    // Forks of a skill are few; the visibility index gives a bounded scan of the
    // public library, from which the children of this skill are picked out.
    const publicRows = await ctx.db
      .query("skills")
      .withIndex("by_visibility", (q) => q.eq("visibility", "public"))
      .take(LIST_LIMIT);
    const forks = publicRows
      .filter((s) => s.forkedFromSkillId === skill._id)
      .sort((a, b) => (b.createdAt ?? b._creationTime) - (a.createdAt ?? a._creationTime))
      .slice(0, 50)
      .map((s) => ({ _id: s._id, name: s.name, slug: s.slug }));

    return {
      ...skill,
      authorName: author?.name ?? null,
      forkedFrom: parent ? { _id: parent._id, name: parent.name, slug: parent.slug } : null,
      forks,
    };
  },
});

// ----------------------------------------------------------------- write paths

export const MAX_SKILL_BODY_CHARS = 20_000;
export const MAX_SKILL_NAME_CHARS = 80;
export const MAX_SKILL_DESCRIPTION_CHARS = 280;
const MIN_SKILL_NAME_CHARS = 3;

/** `SkillValidationError` → BAD_REQUEST, as `lib/trpc/routers/skills.ts` mapped it. */
function validateBody(bodyMd: string): void {
  if (!bodyMd.trim()) throw appError("BAD_REQUEST", "The skill body cannot be empty");
  if (bodyMd.length > MAX_SKILL_BODY_CHARS) {
    throw appError(
      "BAD_REQUEST",
      `Skill markdown is ${bodyMd.length.toLocaleString()} characters; the limit is ${MAX_SKILL_BODY_CHARS.toLocaleString()}`,
    );
  }
}

function validateName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length < MIN_SKILL_NAME_CHARS) {
    throw appError("BAD_REQUEST", "Give the skill a name of at least 3 characters");
  }
  if (trimmed.length > MAX_SKILL_NAME_CHARS) {
    throw appError("BAD_REQUEST", `Names are limited to ${MAX_SKILL_NAME_CHARS} characters`);
  }
  return trimmed;
}

/**
 * First free slug: `foo`, then `foo-2`, `foo-3`, … The Postgres version read
 * every `foo%` row at once; here each candidate is one `by_slug` lookup, capped
 * so the probe loop stays bounded.
 */
const SLUG_PROBES = 64;

async function uniqueSkillSlug(ctx: MutationCtx, base: string): Promise<string> {
  const candidate = slugifySkill(base);
  for (let n = 1; n <= SLUG_PROBES; n++) {
    const slug = n === 1 ? candidate : `${candidate}-${n}`;
    const clash = await ctx.db
      .query("skills")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();
    if (!clash) return slug;
  }
  return `${candidate}-${Date.now()}`;
}

/** Author a new skill. The slug is derived from the name and made unique. */
export const create = mutation({
  args: {
    name: v.string(),
    description: v.optional(v.string()),
    bodyMd: v.string(),
    visibility: v.optional(skillVisibility),
  },
  returns: skillDoc,
  handler: async (ctx, args) => {
    const viewer = await requireUser(ctx);
    const name = validateName(args.name);
    validateBody(args.bodyMd);

    const now = Date.now();
    const skillId = await ctx.db.insert("skills", {
      authorUserId: viewer.userId,
      name,
      slug: await uniqueSkillSlug(ctx, name),
      description: (args.description ?? "").trim().slice(0, MAX_SKILL_DESCRIPTION_CHARS),
      bodyMd: args.bodyMd,
      visibility: args.visibility ?? "public",
      usageCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    const created = await ctx.db.get("skills", skillId);
    if (!created) throw appError("NOT_FOUND", "Skill not found");
    return created;
  },
});

/**
 * Edit a skill in place. Author only, and NOT versioned: the edit takes effect
 * immediately for every config version that attaches this skill, including ones
 * saved months ago. The only record of the change is `updatedAt`.
 */
export const update = mutation({
  args: {
    skillId: v.id("skills"),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    bodyMd: v.optional(v.string()),
    visibility: v.optional(skillVisibility),
  },
  returns: skillDoc,
  handler: async (ctx, args) => {
    const viewer = await requireUser(ctx);
    const existing = await ctx.db.get("skills", args.skillId);
    if (!existing) throw appError("NOT_FOUND", "Skill not found");
    if (existing.authorUserId !== viewer.userId) {
      throw appError("FORBIDDEN", "Only the author may edit this skill");
    }

    if (args.bodyMd !== undefined) validateBody(args.bodyMd);
    const name = args.name !== undefined ? validateName(args.name) : undefined;

    // The slug never moves — attached configs point at the id anyway.
    await ctx.db.patch("skills", args.skillId, {
      ...(name !== undefined ? { name } : {}),
      ...(args.description !== undefined
        ? { description: args.description.trim().slice(0, MAX_SKILL_DESCRIPTION_CHARS) }
        : {}),
      ...(args.bodyMd !== undefined ? { bodyMd: args.bodyMd } : {}),
      ...(args.visibility !== undefined ? { visibility: args.visibility } : {}),
      updatedAt: Date.now(),
    });
    const updated = await ctx.db.get("skills", args.skillId);
    if (!updated) throw appError("NOT_FOUND", "Skill not found");
    return updated;
  },
});

/**
 * Copy a skill into the caller's own library so they can diverge from it. The
 * copy records `forkedFromSkillId`, starts public, and starts at zero usage.
 */
export const fork = mutation({
  args: { slug: v.string() },
  returns: skillDoc,
  handler: async (ctx, { slug }) => {
    const viewer = await requireUser(ctx);
    const source = await ctx.db
      .query("skills")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();
    if (!source) throw appError("NOT_FOUND", `No skill with slug "${slug}"`);

    const now = Date.now();
    const name = `${source.name} (fork)`.slice(0, MAX_SKILL_NAME_CHARS);
    const skillId = await ctx.db.insert("skills", {
      authorUserId: viewer.userId,
      name,
      slug: await uniqueSkillSlug(ctx, name),
      description: source.description,
      bodyMd: source.bodyMd,
      visibility: "public",
      forkedFromSkillId: source._id,
      usageCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    const created = await ctx.db.get("skills", skillId);
    if (!created) throw appError("NOT_FOUND", "Skill not found");
    return created;
  },
});
