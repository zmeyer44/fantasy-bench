/**
 * Commissioner console mutations (PRD 5.1, 5.2, 7).
 *
 * Every procedure is `commissionerProcedure` (membership + role). Domain logic
 * lives in `lib/services/league/rules.ts`; these are thin wrappers that turn a
 * `RulesError` into a `BAD_REQUEST` carrying the offending field so the settings
 * forms can show the message inline.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { MODEL_CATALOG } from "@/lib/models";
import {
  assignOwner,
  editLockSchema,
  findUserByEmail,
  getRules,
  inviteLink,
  listRuleChanges,
  modelsInUse,
  renameTeam,
  replaceDeprecatedModel,
  rotateJoinCode,
  RulesError,
  rulesPatchSchema,
  setBudgets,
  setEditLock,
  setFallbacks,
  setInjectionPolicy,
  setModelAllowlist,
  setTransparency,
  setWindowOverrides,
  startDraft,
  updateLeague,
  updateRules,
  windowOverridesSchema,
} from "@/lib/services/league/rules";
import { commissionerProcedure, protectedProcedure, router } from "@/lib/trpc/init";
import { joinByCode } from "@/lib/services/league/rules";

/** `RulesError` → a 400 whose message the form renders next to the field. */
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof RulesError) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: error.field ? `${error.field}: ${error.message}` : error.message,
        cause: error,
      });
    }
    throw error;
  }
}

export const commissionerRouter = router({
  /** Everything the settings console renders on first paint. */
  settings: commissionerProcedure.query(async ({ ctx }) => {
    const rules = await getRules(ctx.league.id);
    const [invite, changes, inUse] = await Promise.all([
      inviteLink(ctx.league.id),
      listRuleChanges(ctx.league.id, 200),
      modelsInUse(ctx.league.id),
    ]);
    return {
      league: ctx.league,
      rules,
      invite,
      changes,
      modelsInUse: inUse,
      catalog: MODEL_CATALOG,
      locked: rules.rulesLockedAt !== null || ctx.league.status !== "setup",
    };
  }),

  updateRules: commissionerProcedure
    .input(z.object({ patch: rulesPatchSchema }))
    .mutation(async ({ ctx, input }) =>
      guard(() => updateRules(ctx.league.id, ctx.user.id, input.patch)),
    ),

  setModelAllowlist: commissionerProcedure
    .input(z.object({ modelIds: z.array(z.string().min(1)).min(1) }))
    .mutation(async ({ ctx, input }) =>
      guard(() => setModelAllowlist(ctx.league.id, ctx.user.id, input.modelIds)),
    ),

  setBudgets: commissionerProcedure
    .input(
      z.object({
        weeklyTokenCapPerTeam: z.number().int().min(0).nullable().optional(),
        leagueUsdHardCap: z.number().min(0).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) =>
      guard(() => setBudgets(ctx.league.id, ctx.user.id, input)),
    ),

  setEditLock: commissionerProcedure
    .input(z.object({ editLock: editLockSchema }))
    .mutation(async ({ ctx, input }) =>
      guard(() => setEditLock(ctx.league.id, ctx.user.id, input.editLock)),
    ),

  setWindowOverrides: commissionerProcedure
    .input(z.object({ windowOverrides: windowOverridesSchema.nullable() }))
    .mutation(async ({ ctx, input }) =>
      guard(() => setWindowOverrides(ctx.league.id, ctx.user.id, input.windowOverrides)),
    ),

  setTransparency: commissionerProcedure
    .input(z.object({ transparencyMode: z.enum(["live", "delayed"]) }))
    .mutation(async ({ ctx, input }) =>
      guard(() => setTransparency(ctx.league.id, ctx.user.id, input.transparencyMode)),
    ),

  setInjectionPolicy: commissionerProcedure
    .input(z.object({ injectionPolicy: z.enum(["permitted", "prohibited"]) }))
    .mutation(async ({ ctx, input }) =>
      guard(() => setInjectionPolicy(ctx.league.id, ctx.user.id, input.injectionPolicy)),
    ),

  setFallbacks: commissionerProcedure
    .input(
      z.object({
        fallbackModelId: z.string().min(1).nullable().optional(),
        safetyAutopilot: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) =>
      guard(() => setFallbacks(ctx.league.id, ctx.user.id, input)),
    ),

  updateLeague: commissionerProcedure
    .input(
      z.object({
        name: z.string().min(3).max(60).optional(),
        isPublic: z.boolean().optional(),
        draftType: z.enum(["snake", "auction"]).optional(),
        draftScheduledAt: z.date().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) =>
      guard(() => updateLeague(ctx.league.id, ctx.user.id, input)),
    ),

  inviteLink: commissionerProcedure.query(async ({ ctx }) => inviteLink(ctx.league.id)),

  rotateJoinCode: commissionerProcedure.mutation(async ({ ctx }) =>
    guard(() => rotateJoinCode(ctx.league.id, ctx.user.id)),
  ),

  /** Not commissioner-scoped: anyone signed in can redeem a code. */
  joinByCode: protectedProcedure
    .input(z.object({ code: z.string().min(4).max(24) }))
    .mutation(async ({ ctx, input }) =>
      guard(() => joinByCode(input.code.trim().toUpperCase(), ctx.user.id)),
    ),

  startDraft: commissionerProcedure
    .input(z.object({ scheduledAt: z.date().nullable().optional() }))
    .mutation(async ({ ctx, input }) =>
      guard(() => startDraft(ctx.league.id, ctx.user.id, { scheduledAt: input.scheduledAt })),
    ),

  assignOwner: commissionerProcedure
    .input(z.object({ teamId: z.uuid(), userId: z.string().min(1).nullable() }))
    .mutation(async ({ ctx, input }) =>
      guard(() => assignOwner(input.teamId, input.userId, ctx.user.id)),
    ),

  /** Assign by email — the console's actual affordance (PRD 5.1 team management). */
  assignOwnerByEmail: commissionerProcedure
    .input(z.object({ teamId: z.uuid(), email: z.email() }))
    .mutation(async ({ ctx, input }) =>
      guard(async () => {
        const owner = await findUserByEmail(input.email);
        if (!owner) {
          throw new RulesError(
            `No Fantasy Bench account for ${input.email}. Send them the invite link instead.`,
            "email",
          );
        }
        return assignOwner(input.teamId, owner.id, ctx.user.id);
      }),
    ),

  renameTeam: commissionerProcedure
    .input(
      z.object({
        teamId: z.uuid(),
        name: z.string().min(2).max(40),
        abbreviation: z.string().min(2).max(5).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) =>
      guard(() =>
        renameTeam(input.teamId, input.name, ctx.user.id, {
          abbreviation: input.abbreviation,
        }),
      ),
    ),

  replaceDeprecatedModel: commissionerProcedure
    .input(z.object({ fromModelId: z.string().min(1), toModelId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) =>
      guard(() =>
        replaceDeprecatedModel(ctx.league.id, ctx.user.id, input.fromModelId, input.toModelId),
      ),
    ),

  changeLog: commissionerProcedure
    .input(z.object({ limit: z.number().int().min(1).max(500).default(200) }))
    .query(async ({ ctx, input }) => listRuleChanges(ctx.league.id, input.limit)),
});
