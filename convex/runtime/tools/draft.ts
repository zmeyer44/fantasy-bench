/**
 * Draft tools (PRD 5.2).
 *
 * A snake draft exposes `make_draft_pick` for the team on the clock. An auction
 * exposes `submit_bid` every round (sealed simultaneous bids — open question 4)
 * and `nominate_player` to the team whose nomination it is.
 */
import { tool } from "ai";
import { z } from "zod";

import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import type { ToolContext } from "../types";

import { agentContext, commitAction } from "./context";

export function buildDraftTools(ctx: ToolContext) {
  const snapshot = ctx.snapshot;

  function checkAvailable(id: string): string[] {
    const player = snapshot.players[id];
    if (!player) return [`Unknown player ${id}. Use search_players to find a valid id.`];
    if (player.ownerTeamId != null) return [`${player.fullName} is already rostered.`];
    return [];
  }

  const make_draft_pick = tool({
    description:
      "Make your snake-draft pick. Only valid while your team is on the clock; the pick is " +
      "immediate and final. If you do not pick before the window's deadline the platform auto-picks " +
      "the best available player by projection, so always submit something.",
    inputSchema: z.object({ playerId: z.string().min(1).describe("Undrafted player to select.") }),
    execute: async ({ playerId }, { toolCallId }) => {
      if (!ctx.teamId) return { ok: false as const, errors: ["This run has no team."] };
      return commitAction(
        { ctx, toolCallId, actionType: "make_draft_pick", payload: { playerId } },
        async () => {
          const errors = checkAvailable(playerId);
          if (errors.length > 0) return { ok: false as const, errors };
          const result = await ctx.ctx.runMutation(internal.draft.recordPick, {
            leagueId: ctx.leagueId,
            windowId: ctx.windowId,
            teamId: ctx.teamId as Id<"teams">,
            playerId: playerId as Id<"players">,
            agentCtx: agentContext(ctx, toolCallId),
            now: ctx.now().getTime(),
          });
          if (!result.ok) return result;
          ctx.state.draftActions += 1;
          return { ok: true as const, pickId: result.pickId, overallNo: result.overallNo, playerId };
        },
      );
    },
  });

  const submit_bid = tool({
    description:
      "Submit your sealed bid for the player currently up for auction. All teams bid simultaneously " +
      "each round and bids are revealed when the round resolves; ties break by the league's " +
      "deterministic rule, which is recorded in the trace. Bid 0 to pass. Your bid may not exceed " +
      "your remaining budget.",
    inputSchema: z.object({
      playerId: z.string().min(1).describe("The nominated player being bid on."),
      amount: z.number().int().min(0).describe("Sealed bid in whole dollars; 0 passes."),
    }),
    execute: async ({ playerId, amount }, { toolCallId }) => {
      if (!ctx.teamId) return { ok: false as const, errors: ["This run has no team."] };
      return commitAction(
        { ctx, toolCallId, actionType: "submit_bid", payload: { playerId, amount } },
        async () => {
          const errors = checkAvailable(playerId);
          const team = snapshot.teams.find((t) => t.id === ctx.teamId);
          if (team && amount > team.faabRemaining) {
            errors.push(`Bid $${amount} exceeds your remaining budget ($${team.faabRemaining}).`);
          }
          if (errors.length > 0) return { ok: false as const, errors };
          const result = await ctx.ctx.runMutation(internal.draft.bid, {
            leagueId: ctx.leagueId,
            windowId: ctx.windowId,
            teamId: ctx.teamId as Id<"teams">,
            playerId: playerId as Id<"players">,
            amount,
            agentCtx: agentContext(ctx, toolCallId),
          });
          if (!result.ok) return result;
          ctx.state.draftActions += 1;
          return { ok: true as const, bidId: result.bidId, playerId, amount };
        },
      );
    },
  });

  const nominate_player = tool({
    description:
      "Nominate a player for auction with an opening bid. Only valid when it is your nomination. " +
      "Nominating a player you do not want is a legitimate way to drain another team's budget.",
    inputSchema: z.object({
      playerId: z.string().min(1),
      openingBid: z.number().int().min(1).default(1),
    }),
    execute: async ({ playerId, openingBid }, { toolCallId }) => {
      if (!ctx.teamId) return { ok: false as const, errors: ["This run has no team."] };
      return commitAction(
        { ctx, toolCallId, actionType: "nominate_player", payload: { playerId, openingBid } },
        async () => {
          const errors = checkAvailable(playerId);
          if (errors.length > 0) return { ok: false as const, errors };
          const result = await ctx.ctx.runMutation(internal.draft.nominate, {
            leagueId: ctx.leagueId,
            windowId: ctx.windowId,
            teamId: ctx.teamId as Id<"teams">,
            playerId: playerId as Id<"players">,
            openingBid,
            agentCtx: agentContext(ctx, toolCallId),
          });
          if (!result.ok) return result;
          ctx.state.draftActions += 1;
          return { ok: true as const, nominationId: result.nominationId, playerId, openingBid };
        },
      );
    },
  });

  return { make_draft_pick, submit_bid, nominate_player };
}

export type DraftTools = ReturnType<typeof buildDraftTools>;
