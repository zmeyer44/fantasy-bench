/**
 * Agent config: read models are public within the league (PRD 5.5/7), so they
 * ride `leagueReadProcedure`. Writes require membership plus an ownership check
 * inside the service (`assertMayEdit`).
 */
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import type { Db } from "@/lib/db";
import { teams } from "@/lib/db/schema";
import {
  ConfigForbiddenError,
  ConfigNotFoundError,
  ConfigValidationError,
  assertMayEdit,
  diffVersions,
  estimatePromptSize,
  getConfigForTeam,
  getEditLockStatus,
  getPreviousVersion,
  getVersion,
  harnessInputSchema,
  saveVersion,
  setNoteToAgent,
} from "@/lib/services/config";
import { leagueMemberProcedure, leagueReadProcedure, router } from "@/lib/trpc/init";

const teamInput = z.object({ teamId: z.uuid() });

/** Map service errors onto tRPC codes once, rather than at every call site. */
function toTRPCError(err: unknown): never {
  if (err instanceof ConfigValidationError) {
    throw new TRPCError({ code: "BAD_REQUEST", message: err.message, cause: err });
  }
  if (err instanceof ConfigForbiddenError) {
    throw new TRPCError({ code: "FORBIDDEN", message: err.message, cause: err });
  }
  if (err instanceof ConfigNotFoundError) {
    throw new TRPCError({ code: "NOT_FOUND", message: err.message, cause: err });
  }
  throw err;
}

/** The team must actually belong to the league in the input. */
async function assertTeamInLeague(db: Db, teamId: string, leagueId: string) {
  const team = await db.query.teams.findFirst({ where: eq(teams.id, teamId) });
  if (!team || team.leagueId !== leagueId) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Team not found in this league" });
  }
}

export const configRouter = router({
  /** Everything the config editor needs, including lock status and viewer rights. */
  get: leagueReadProcedure.input(teamInput).query(async ({ ctx, input }) => {
    await assertTeamInLeague(ctx.db, input.teamId, ctx.league.id);
    try {
      const view = await getConfigForTeam(input.teamId, ctx.db);
      const lock = await getEditLockStatus(ctx.league.id, new Date(), ctx.db);
      const canEdit =
        !!ctx.user &&
        (view.team.ownerUserId === ctx.user.id || ctx.membership?.role === "commissioner");
      return { ...view, lock, canEdit, viewerUserId: ctx.user?.id ?? null };
    } catch (err) {
      return toTRPCError(err);
    }
  }),

  /** Version history. Public within the league — no ownership check. */
  versions: leagueReadProcedure.input(teamInput).query(async ({ ctx, input }) => {
    await assertTeamInLeague(ctx.db, input.teamId, ctx.league.id);
    const view = await getConfigForTeam(input.teamId, ctx.db);
    return { config: view.config, team: view.team, versions: view.versions };
  }),

  /** One version, hydrated with its skills, plus the version before it. */
  version: leagueReadProcedure
    .input(z.object({ versionId: z.uuid() }))
    .query(async ({ ctx, input }) => {
      const version = await getVersion(input.versionId, ctx.db);
      if (!version) throw new TRPCError({ code: "NOT_FOUND", message: "Version not found" });
      const previous = await getPreviousVersion(version, ctx.db);
      return { version, previous };
    }),

  /** Context diff + structured model/harness/skill diffs between two versions. */
  diff: leagueReadProcedure
    .input(z.object({ a: z.uuid(), b: z.uuid() }))
    .query(async ({ ctx, input }) => {
      try {
        return await diffVersions(input.a, input.b, ctx.db);
      } catch (err) {
        return toTRPCError(err);
      }
    }),

  /** Create a new immutable version. Applies now or queues, per the edit lock. */
  save: leagueMemberProcedure
    .input(
      z.object({
        teamId: z.uuid(),
        contextMd: z.string().max(200_000),
        modelId: z.string().min(1),
        harness: harnessInputSchema,
        skillIds: z.array(z.uuid()).max(50),
        changeSummary: z.string().max(200).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertTeamInLeague(ctx.db, input.teamId, ctx.league.id);
      try {
        return await saveVersion(
          {
            teamId: input.teamId,
            userId: ctx.user.id,
            contextMd: input.contextMd,
            modelId: input.modelId,
            harness: input.harness,
            skillIds: input.skillIds,
            changeSummary: input.changeSummary ?? null,
          },
          ctx.db,
        );
      } catch (err) {
        return toTRPCError(err);
      }
    }),

  /** The owner scratchpad, folded into the context on the next save. */
  setNote: leagueMemberProcedure
    .input(z.object({ teamId: z.uuid(), text: z.string().max(4_000).nullable() }))
    .mutation(async ({ ctx, input }) => {
      await assertTeamInLeague(ctx.db, input.teamId, ctx.league.id);
      const team = await ctx.db.query.teams.findFirst({ where: eq(teams.id, input.teamId) });
      if (!team) throw new TRPCError({ code: "NOT_FOUND", message: "Team not found" });
      try {
        await assertMayEdit(
          { userId: ctx.user.id, team, leagueId: ctx.league.id },
          ctx.db,
        );
        return await setNoteToAgent(input.teamId, input.text, ctx.db);
      } catch (err) {
        return toTRPCError(err);
      }
    }),

  /** Is the edit window open, and when does that flip? */
  lockStatus: leagueReadProcedure.query(async ({ ctx }) => {
    return getEditLockStatus(ctx.league.id, new Date(), ctx.db);
  }),

  /** Live preview: prompt tokens + estimated cost per run for a draft config. */
  estimate: leagueReadProcedure
    .input(
      z.object({
        contextMd: z.string().max(200_000),
        skillIds: z.array(z.uuid()).max(50),
        modelId: z.string().min(1),
      }),
    )
    .query(async ({ ctx, input }) => {
      return estimatePromptSize(input, ctx.db);
    }),
});
