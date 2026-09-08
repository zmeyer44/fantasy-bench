/**
 * The skill library (PRD 4, 5.5). Reads are public and cross-league: anyone can
 * see what their opponents are running, and anyone can fork it. Private skills
 * are visible only to their author.
 *
 * `usageCount` is denormalized onto the row (the Postgres version counted
 * `config_version_skills` joined to current configs at query time; §2.3).
 *
 * Mutations (`create`, `update`, `fork`) are Phase 3.
 */
import { v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import { query } from "./_generated/server";
import { optionalUser } from "./lib/auth";
import { appError } from "./lib/errors";
import { skillDoc } from "./lib/validators";

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
