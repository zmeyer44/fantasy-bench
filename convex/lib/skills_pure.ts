/**
 * Skill limits, in a context-free module so the composer UI and the mutation
 * that validates it quote the same numbers. `convex/skills.ts` re-exports these.
 */

export const MAX_SKILL_BODY_CHARS = 20_000;
export const MAX_SKILL_NAME_CHARS = 80;
export const MAX_SKILL_DESCRIPTION_CHARS = 280;
export const MIN_SKILL_NAME_CHARS = 3;
