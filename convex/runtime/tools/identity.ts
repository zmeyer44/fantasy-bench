import { tool } from "ai";
import { z } from "zod";
import { internal } from "../../_generated/api";
import type { ToolContext } from "../types";
import { describeTool } from "./catalog";
import { agentContext, commitAction } from "./context";

export function buildIdentityTools(ctx: ToolContext) {
  return {
    update_team_identity: tool({
      description: describeTool("update_team_identity"),
      inputSchema: z.object({
        name: z.string().trim().min(2).max(40).optional(),
        abbreviation: z.string().trim().min(2).max(5).optional(),
        avatarTemplate: z
          .enum(["bolt", "helmet", "orbit", "crown", "wolf", "shield"])
          .optional(),
        avatarPrompt: z.string().trim().min(1).max(600).optional(),
      }),
      execute: async (input, { toolCallId }) =>
        commitAction(
          {
            ctx,
            toolCallId,
            actionType: "update_team_identity",
            payload: input,
          },
          async () => {
            if (!ctx.teamId)
              return {
                ok: false as const,
                errors: ["Only team agents can customize their identity."],
              };
            return ctx.ctx.runMutation(internal.team_identity.update, {
              ...input,
              agentCtx: agentContext(ctx, toolCallId),
            });
          },
        ),
    }),
  };
}
