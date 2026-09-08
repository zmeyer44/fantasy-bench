/**
 * The skill library. Reads are public (the library is cross-league, PRD 5.5);
 * authoring, editing and forking need a session.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  MAX_SKILL_BODY_CHARS,
  MAX_SKILL_DESCRIPTION_CHARS,
  MAX_SKILL_NAME_CHARS,
  SkillForbiddenError,
  SkillNotFoundError,
  SkillValidationError,
  createSkill,
  forkSkill,
  getSkill,
  listSkills,
  updateSkill,
} from "@/lib/services/skills";
import { protectedProcedure, publicProcedure, router } from "@/lib/trpc/init";

function toTRPCError(err: unknown): never {
  if (err instanceof SkillValidationError) {
    throw new TRPCError({ code: "BAD_REQUEST", message: err.message, cause: err });
  }
  if (err instanceof SkillForbiddenError) {
    throw new TRPCError({ code: "FORBIDDEN", message: err.message, cause: err });
  }
  if (err instanceof SkillNotFoundError) {
    throw new TRPCError({ code: "NOT_FOUND", message: err.message, cause: err });
  }
  throw err;
}

const bodySchema = z.string().min(1).max(MAX_SKILL_BODY_CHARS);
const nameSchema = z.string().min(3).max(MAX_SKILL_NAME_CHARS);
const descriptionSchema = z.string().max(MAX_SKILL_DESCRIPTION_CHARS);

export const skillsRouter = router({
  /** Library index with usage counts. `mine` narrows to the signed-in author. */
  list: publicProcedure
    .input(
      z
        .object({
          query: z.string().max(120).optional(),
          authorUserId: z.string().optional(),
          mine: z.boolean().optional(),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      return listSkills(
        {
          query: input?.query,
          authorUserId: input?.mine ? (ctx.user?.id ?? "__none__") : input?.authorUserId,
          viewerUserId: ctx.user?.id ?? null,
        },
        ctx.db,
      );
    }),

  get: publicProcedure.input(z.object({ slug: z.string().min(1) })).query(async ({ ctx, input }) => {
    const skill = await getSkill(input.slug, ctx.db);
    if (!skill) throw new TRPCError({ code: "NOT_FOUND", message: "Skill not found" });
    if (skill.visibility === "private" && skill.authorUserId !== ctx.user?.id) {
      throw new TRPCError({ code: "FORBIDDEN", message: "This skill is private" });
    }
    return skill;
  }),

  create: protectedProcedure
    .input(
      z.object({
        name: nameSchema,
        description: descriptionSchema.optional(),
        bodyMd: bodySchema,
        visibility: z.enum(["public", "private"]).default("public"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await createSkill({ ...input, authorUserId: ctx.user.id }, ctx.db);
      } catch (err) {
        return toTRPCError(err);
      }
    }),

  /** Author only. Edits are retroactive for every team running the skill. */
  update: protectedProcedure
    .input(
      z.object({
        skillId: z.uuid(),
        name: nameSchema.optional(),
        description: descriptionSchema.optional(),
        bodyMd: bodySchema.optional(),
        visibility: z.enum(["public", "private"]).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await updateSkill({ ...input, userId: ctx.user.id }, ctx.db);
      } catch (err) {
        return toTRPCError(err);
      }
    }),

  fork: protectedProcedure
    .input(z.object({ slug: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await forkSkill(input.slug, ctx.user.id, ctx.db);
      } catch (err) {
        return toTRPCError(err);
      }
    }),
});
