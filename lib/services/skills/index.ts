/**
 * The skill library (PRD 4, 5.5).
 *
 * A skill is a markdown document injected into an agent's context. The library
 * is public across leagues: anyone can read what their opponents are running,
 * and anyone can fork it.
 *
 * IMPORTANT — skills are attached by id, not by value. `config_version_skills`
 * points at the live `skills` row, so editing a skill changes the prompt of
 * every team whose *current* version attaches it, retroactively and without a
 * new config version. That is deliberate (authors maintain their skills), but it
 * means `updateSkill` is a league-wide side effect. The editor surfaces the
 * usage count as a warning before an author saves.
 */
import { and, asc, desc, eq, ilike, inArray, isNotNull, or, sql } from "drizzle-orm";

import { db, withTransaction, type DbOrTx } from "@/lib/db";
import { agentConfigs, configVersionSkills, skills, user } from "@/lib/db/schema";
import type { Skill, SkillVisibility } from "@/lib/db/types";

export const MAX_SKILL_BODY_CHARS = 20_000;
export const MAX_SKILL_NAME_CHARS = 80;
export const MAX_SKILL_DESCRIPTION_CHARS = 280;

export class SkillValidationError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = "SkillValidationError";
    this.field = field;
  }
}

export class SkillForbiddenError extends Error {
  constructor(message = "Only the author may edit this skill") {
    super(message);
    this.name = "SkillForbiddenError";
  }
}

export class SkillNotFoundError extends Error {
  constructor(message = "Skill not found") {
    super(message);
    this.name = "SkillNotFoundError";
  }
}

export type SkillWithMeta = Skill & {
  authorName: string | null;
  /** How many *current* config versions attach this skill. */
  usageCount: number;
};

/** `Injury-aware lineups` → `injury-aware-lineups`. */
export function slugifySkill(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/[\s_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "skill"
  );
}

/** First free slug: `foo`, then `foo-2`, `foo-3`, … */
async function uniqueSlug(base: string, executor: DbOrTx): Promise<string> {
  const candidate = slugifySkill(base);
  const taken = new Set(
    (
      await executor
        .select({ slug: skills.slug })
        .from(skills)
        .where(
          sql`${skills.slug} = ${candidate} or ${skills.slug} like ${`${candidate}-%`}`,
        )
    ).map((r) => r.slug),
  );
  if (!taken.has(candidate)) return candidate;
  for (let n = 2; n < 1_000; n++) {
    const next = `${candidate}-${n}`;
    if (!taken.has(next)) return next;
  }
  return `${candidate}-${Date.now()}`;
}

/**
 * How many *current* config versions attach each skill.
 *
 * Keyed by skill id. Skills nobody runs are absent from the map, not zero —
 * callers should use `?? 0`.
 */
export async function skillUsageCounts(executor: DbOrTx = db): Promise<Map<string, number>> {
  const rows = await executor
    .select({ skillId: configVersionSkills.skillId, count: sql<number>`count(*)::int` })
    .from(configVersionSkills)
    .innerJoin(agentConfigs, eq(agentConfigs.currentVersionId, configVersionSkills.configVersionId))
    .where(isNotNull(agentConfigs.currentVersionId))
    .groupBy(configVersionSkills.skillId);

  return new Map(rows.map((r) => [r.skillId, r.count]));
}

export type ListSkillsArgs = {
  /** Matches name, slug or description, case-insensitively. */
  query?: string;
  authorUserId?: string;
  /** Include this user's own private skills in the result. */
  viewerUserId?: string | null;
  limit?: number;
};

/** The library index. Public skills always; the viewer's private skills too. */
export async function listSkills(
  args: ListSkillsArgs = {},
  executor: DbOrTx = db,
): Promise<SkillWithMeta[]> {
  const filters = [];

  const visible = args.viewerUserId
    ? or(eq(skills.visibility, "public"), eq(skills.authorUserId, args.viewerUserId))
    : eq(skills.visibility, "public");
  filters.push(visible);

  if (args.authorUserId) filters.push(eq(skills.authorUserId, args.authorUserId));

  const q = args.query?.trim();
  if (q) {
    const like = `%${q}%`;
    filters.push(
      or(ilike(skills.name, like), ilike(skills.slug, like), ilike(skills.description, like)),
    );
  }

  const rows = await executor
    .select({ skill: skills, authorName: user.name })
    .from(skills)
    .leftJoin(user, eq(user.id, skills.authorUserId))
    .where(and(...filters))
    .orderBy(asc(skills.name))
    .limit(args.limit ?? 200);

  const counts = await skillUsageCounts(executor);

  return rows.map(({ skill, authorName }) => ({
    ...skill,
    authorName: authorName ?? null,
    usageCount: counts.get(skill.id) ?? 0,
  }));
}

/** Load several skills by id, preserving the caller's ordering. */
export async function getSkillsByIds(ids: string[], executor: DbOrTx = db): Promise<Skill[]> {
  if (ids.length === 0) return [];
  const rows = await executor.select().from(skills).where(inArray(skills.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((s): s is Skill => s !== undefined);
}

export type SkillDetail = SkillWithMeta & {
  forkedFrom: { id: string; name: string; slug: string } | null;
  forks: Array<{ id: string; name: string; slug: string }>;
};

export async function getSkill(slug: string, executor: DbOrTx = db): Promise<SkillDetail | null> {
  const [row] = await executor
    .select({ skill: skills, authorName: user.name })
    .from(skills)
    .leftJoin(user, eq(user.id, skills.authorUserId))
    .where(eq(skills.slug, slug))
    .limit(1);
  if (!row) return null;

  const counts = await skillUsageCounts(executor);

  const parent = row.skill.forkedFromSkillId
    ? ((
        await executor
          .select({ id: skills.id, name: skills.name, slug: skills.slug })
          .from(skills)
          .where(eq(skills.id, row.skill.forkedFromSkillId))
          .limit(1)
      )[0] ?? null)
    : null;

  const forks = await executor
    .select({ id: skills.id, name: skills.name, slug: skills.slug })
    .from(skills)
    .where(eq(skills.forkedFromSkillId, row.skill.id))
    .orderBy(desc(skills.createdAt))
    .limit(50);

  return {
    ...row.skill,
    authorName: row.authorName ?? null,
    usageCount: counts.get(row.skill.id) ?? 0,
    forkedFrom: parent,
    forks,
  };
}

export type CreateSkillInput = {
  authorUserId: string;
  name: string;
  description?: string;
  bodyMd: string;
  visibility?: SkillVisibility;
};

function validateBody(bodyMd: string): void {
  if (!bodyMd.trim()) throw new SkillValidationError("bodyMd", "The skill body cannot be empty");
  if (bodyMd.length > MAX_SKILL_BODY_CHARS) {
    throw new SkillValidationError(
      "bodyMd",
      `Skill markdown is ${bodyMd.length.toLocaleString()} characters; the limit is ${MAX_SKILL_BODY_CHARS.toLocaleString()}`,
    );
  }
}

function validateName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length < 3) {
    throw new SkillValidationError("name", "Give the skill a name of at least 3 characters");
  }
  if (trimmed.length > MAX_SKILL_NAME_CHARS) {
    throw new SkillValidationError("name", `Names are limited to ${MAX_SKILL_NAME_CHARS} characters`);
  }
  return trimmed;
}

/** Author a new skill. The slug is derived from the name and made unique. */
export async function createSkill(
  input: CreateSkillInput,
  executor: DbOrTx = db,
): Promise<Skill> {
  const name = validateName(input.name);
  validateBody(input.bodyMd);
  const description = (input.description ?? "").trim().slice(0, MAX_SKILL_DESCRIPTION_CHARS);

  return withTransaction(async (tx) => {
    const slug = await uniqueSlug(name, tx);
    const [created] = await tx
      .insert(skills)
      .values({
        authorUserId: input.authorUserId,
        name,
        slug,
        description,
        bodyMd: input.bodyMd,
        visibility: input.visibility ?? "public",
      })
      .returning();
    return created;
  }, executor);
}

export type UpdateSkillInput = {
  skillId: string;
  userId: string;
  name?: string;
  description?: string;
  bodyMd?: string;
  visibility?: SkillVisibility;
};

/**
 * Edit a skill in place. Author only.
 *
 * Skills are NOT versioned: an edit takes effect immediately for every config
 * version that attaches this skill, including versions saved months ago. The
 * only record of the change is `updated_at`, which the library surfaces.
 */
export async function updateSkill(
  input: UpdateSkillInput,
  executor: DbOrTx = db,
): Promise<Skill> {
  const existing = await executor.query.skills.findFirst({ where: eq(skills.id, input.skillId) });
  if (!existing) throw new SkillNotFoundError();
  if (existing.authorUserId !== input.userId) throw new SkillForbiddenError();

  if (input.bodyMd !== undefined) validateBody(input.bodyMd);
  const name = input.name !== undefined ? validateName(input.name) : undefined;

  const [updated] = await executor
    .update(skills)
    .set({
      ...(name !== undefined ? { name } : {}),
      ...(input.description !== undefined
        ? { description: input.description.trim().slice(0, MAX_SKILL_DESCRIPTION_CHARS) }
        : {}),
      ...(input.bodyMd !== undefined ? { bodyMd: input.bodyMd } : {}),
      ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
      updatedAt: new Date(),
    })
    .where(eq(skills.id, input.skillId))
    .returning();

  return updated;
}

/**
 * Copy a skill into the caller's own library so they can diverge from it.
 * The copy records `forked_from_skill_id` and starts public.
 */
export async function forkSkill(
  slug: string,
  userId: string,
  executor: DbOrTx = db,
): Promise<Skill> {
  return withTransaction(async (tx) => {
    const source = await tx.query.skills.findFirst({ where: eq(skills.slug, slug) });
    if (!source) throw new SkillNotFoundError(`No skill with slug "${slug}"`);

    const name = `${source.name} (fork)`.slice(0, MAX_SKILL_NAME_CHARS);
    const newSlug = await uniqueSlug(name, tx);

    const [created] = await tx
      .insert(skills)
      .values({
        authorUserId: userId,
        name,
        slug: newSlug,
        description: source.description,
        bodyMd: source.bodyMd,
        visibility: "public",
        forkedFromSkillId: source.id,
      })
      .returning();
    return created;
  }, executor);
}
