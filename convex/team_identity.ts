import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { agentCtxValidator, fail, withAgentAction } from "./lib/agent_action";
import { budgetStatus } from "./ledger";

export const AVATAR_TEMPLATES = [
  "bolt",
  "helmet",
  "orbit",
  "crown",
  "wolf",
  "shield",
] as const;
const outcome = v.union(
  v.object({ ok: v.literal(true), status: v.string() }),
  v.object({ ok: v.literal(false), errors: v.array(v.string()) }),
);

/** Team identity is agent-owned. No public write accepts a caller-supplied team id. */
export const update = internalMutation({
  args: {
    agentCtx: agentCtxValidator,
    name: v.optional(v.string()),
    abbreviation: v.optional(v.string()),
    avatarTemplate: v.optional(v.string()),
    avatarPrompt: v.optional(v.string()),
  },
  returns: outcome,
  handler: async (ctx, args) =>
    withAgentAction(
      ctx,
      args.agentCtx,
      {
        actionType: "update_team_identity",
        payload: { ...args, agentCtx: undefined },
      },
      async () => {
        const run = await ctx.db.get("runs", args.agentCtx.runId);
        if (!run?.teamId)
          return fail("Only a team agent can customize a team.");
        const team = await ctx.db.get("teams", run.teamId);
        const window = await ctx.db.get("windows", run.windowId);
        if (
          !team ||
          team.leagueId !== run.leagueId ||
          run.windowId !== args.agentCtx.windowId ||
          run.weekNo !== args.agentCtx.weekNo
        )
          return fail("Run does not belong to this team and window.");
        if (
          run.status !== "running" ||
          !window ||
          window.status !== "open" ||
          Date.now() >= window.closesAt
        )
          return fail(
            "Team identity can only change during an active agent run.",
          );
        const name = args.name?.trim();
        const abbreviation = args.abbreviation?.trim().toUpperCase();
        const prompt = args.avatarPrompt?.trim();
        if (
          name !== undefined &&
          (name.length < 2 || name.length > 40 || /[\p{Cc}\p{Cf}]/u.test(name))
        )
          return fail("Team names must be 2–40 printable characters.");
        if (abbreviation !== undefined && !/^[A-Z0-9]{2,5}$/.test(abbreviation))
          return fail("Abbreviations must be 2–5 letters or numbers.");
        if (
          args.avatarTemplate !== undefined &&
          !AVATAR_TEMPLATES.some((item) => item === args.avatarTemplate)
        )
          return fail(
            "Unknown avatar template. Choose bolt, helmet, orbit, crown, wolf, or shield.",
          );
        if (args.avatarPrompt !== undefined && (!prompt || prompt.length > 600))
          return fail("Avatar descriptions must be 1–600 characters.");
        if (
          name === undefined &&
          abbreviation === undefined &&
          args.avatarTemplate === undefined &&
          prompt === undefined
        )
          return fail(
            "Supply a name, abbreviation, template, or avatar description.",
          );
        if (name) {
          const duplicate = await ctx.db
            .query("teams")
            .withIndex("by_leagueId_name", (q) =>
              q.eq("leagueId", team.leagueId).eq("name", name),
            )
            .first();
          if (duplicate && duplicate._id !== team._id)
            return fail("Another team already uses that name.");
        }
        const now = Date.now();
        if (prompt) {
          if (
            !process.env.AI_GATEWAY_API_KEY ||
            !process.env.AVATAR_IMAGE_MODEL
          )
            return fail(
              "Custom avatar generation is not configured. Choose a template instead.",
            );
          if (
            team.avatarRequestedAt &&
            now - team.avatarRequestedAt < 86_400_000
          )
            return fail(
              "Custom avatars are limited to one request per team every 24 hours. Templates can be changed anytime.",
            );
          const estimate = Number(process.env.AVATAR_IMAGE_COST_USD || "0.10");
          if (!Number.isFinite(estimate) || estimate <= 0)
            return fail(
              "Avatar image cost is not configured correctly. Choose a template instead.",
            );
          const league = await ctx.db.get("leagues", team.leagueId);
          if (!league) return fail("League not found.");
          const budget = await budgetStatus(
            ctx,
            team,
            league.season,
            run.weekNo,
          );
          if (
            budget.overUsdCap ||
            budget.overTokenCap ||
            (budget.leagueUsdRemaining !== null &&
              budget.leagueUsdRemaining < estimate)
          )
            return fail("The team's generation budget is exhausted.");
        }
        const requestKey = `${run._id}:${args.agentCtx.toolCallId}`;
        if (args.avatarTemplate && !prompt && team.avatarStorageId)
          await ctx.storage.delete(team.avatarStorageId);
        await ctx.db.patch("teams", team._id, {
          ...(name === undefined ? {} : { name }),
          ...(abbreviation === undefined ? {} : { abbreviation }),
          ...(args.avatarTemplate === undefined
            ? {}
            : { avatarTemplate: args.avatarTemplate }),
          identityRunId: run._id,
          ...(args.avatarTemplate && !prompt
            ? {
                avatarStorageId: undefined,
                avatarStatus: undefined,
                avatarError: undefined,
                avatarRequestKey: undefined,
              }
            : {}),
          ...(prompt
            ? {
                avatarStatus: "generating" as const,
                avatarRequestKey: requestKey,
                avatarRequestedAt: now,
                avatarError: undefined,
              }
            : {}),
        });
        if (prompt)
          await ctx.scheduler.runAfter(0, internal.avatar_generation.generate, {
            teamId: team._id,
            requestKey,
            prompt,
            name: name ?? team.name,
            runId: run._id,
            stepIndex: args.agentCtx.stepIndex,
          });
        if (prompt)
          await ctx.scheduler.runAfter(180_000, internal.team_identity.finish, {
            teamId: team._id,
            requestKey,
            error:
              "Avatar generation timed out. Your previous avatar is still available.",
          });
        return { ok: true as const, status: prompt ? "generating" : "updated" };
      },
    ),
});

/** Claim the job before any provider call; concurrent delivery cannot generate twice. */
export const claim = internalMutation({
  args: { teamId: v.id("teams"), requestKey: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { teamId, requestKey }) => {
    const team = await ctx.db.get("teams", teamId);
    if (
      !team ||
      team.avatarRequestKey !== requestKey ||
      team.avatarStatus !== "generating"
    )
      return false;
    await ctx.db.patch("teams", teamId, {
      avatarRequestKey: `${requestKey}:claimed`,
    });
    return true;
  },
});

export const finish = internalMutation({
  args: {
    teamId: v.id("teams"),
    requestKey: v.string(),
    storageId: v.optional(v.id("_storage")),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const team = await ctx.db.get("teams", args.teamId);
    if (args.storageId && team?.avatarStorageId === args.storageId) return null;
    if (
      !team ||
      team.avatarStatus !== "generating" ||
      (team.avatarRequestKey !== `${args.requestKey}:claimed` &&
        team.avatarRequestKey !== args.requestKey)
    ) {
      if (args.storageId) await ctx.storage.delete(args.storageId);
      return null;
    }
    if (args.storageId && team.avatarStorageId)
      await ctx.storage.delete(team.avatarStorageId);
    await ctx.db.patch("teams", team._id, {
      ...(args.storageId ? { avatarStorageId: args.storageId } : {}),
      avatarStatus: args.storageId ? "ready" : "failed",
      avatarError: args.error,
    });
    return null;
  },
});
