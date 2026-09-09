/**
 * Write tools (PRD 5.4).
 *
 * Each one: validate against the snapshot → replay-check `(runId, toolCallId)` →
 * commit through the owning **internal mutation** → return a structured
 * `{ ok: true, … }` or `{ ok: false, errors }` so the model can correct itself and
 * retry. Illegal actions are never silently dropped and never throw at the model.
 *
 * A committed action is final: PRD 5.4 step 5 says partial submissions stand even
 * if a later step fails.
 *
 * The tool descriptions and input schemas are the stable, model-facing interface
 * and are unchanged from the Postgres runtime. What changed is the last hop: the
 * service call is `ctx.ctx.runMutation(internal.<service>.<fn>, …)` with an
 * `agentCtx`, and that mutation writes the `run_actions` row in the same
 * transaction as the domain write (`convex/lib/agent_action.ts`).
 */
import { tool } from "ai";
import { z } from "zod";

import type { LineupSlot } from "../../../lib/snapshot/types";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { countEmptyStarterWarnings, validateLineup } from "../../lib/lineup_pure";
import type { ToolContext } from "../types";

import { describeTool } from "./catalog";
import { agentContext, commitAction } from "./context";

const FLAIRS = ["trash_talk", "trade_block", "analysis", "announcement"] as const;

function requireTeam(ctx: ToolContext): { ok: false; errors: string[] } | null {
  if (ctx.teamId) return null;
  return { ok: false, errors: ["This run has no team and cannot take roster or social actions."] };
}

/** Ids are strings on the wire; the receiving mutation's validator is the real check. */
function playerId(id: string): Id<"players"> {
  return id as Id<"players">;
}

export function buildWriteTools(ctx: ToolContext) {
  const snapshot = ctx.snapshot;

  const set_lineup = tool({
    description: describeTool("set_lineup"),
    inputSchema: z.object({
      slots: z
        .array(
          z.object({
            slot: z.string().min(1).describe("Slot label, e.g. QB, RB, WR, TE, FLEX, K, DEF, BENCH."),
            playerId: z.string().nullable().describe("Player id, or null to leave the slot empty."),
          }),
        )
        .min(1)
        .max(40),
      note: z.string().max(500).optional().describe("Optional private note recorded on the action."),
    }),
    execute: async ({ slots, note }, { toolCallId }) => {
      const missing = requireTeam(ctx);
      if (missing) return missing;
      return commitAction(
        { ctx, toolCallId, actionType: "set_lineup", payload: { slots, note } },
        async () => {
          const validation = validateLineup({
            snapshot,
            teamId: ctx.teamId!,
            slots: slots as LineupSlot[],
            now: ctx.now(),
          });
          if (!validation.ok) {
            return { ok: false as const, errors: validation.errors };
          }
          const committed = await ctx.ctx.runMutation(internal.lineups.commit, {
            teamId: ctx.teamId as Id<"teams">,
            weekNo: ctx.weekNo,
            slots: slots.map((s) => ({
              slot: s.slot,
              playerId: s.playerId ? playerId(s.playerId) : null,
            })),
            source: "agent",
            agentCtx: agentContext(ctx, toolCallId),
            now: ctx.now().getTime(),
          });
          if (!committed.ok) return committed;
          ctx.state.lineupCommitted = true;
          ctx.state.lineupEmptyStarters = countEmptyStarterWarnings(validation.warnings);
          return {
            ok: true as const,
            lineupId: committed.lineupId,
            version: committed.version,
            weekNo: ctx.weekNo,
            warnings: validation.warnings,
          };
        },
      );
    },
  });

  const submit_waiver_claims = tool({
    description: describeTool("submit_waiver_claims"),
    inputSchema: z.object({
      claims: z
        .array(
          z.object({
            addPlayerId: z.string().min(1).describe("Free agent to claim."),
            dropPlayerId: z.string().optional().describe("Player on your roster to drop if the claim wins."),
            bid: z.number().int().min(0).describe("FAAB bid in whole dollars."),
          }),
        )
        .min(1)
        .max(10),
    }),
    execute: async ({ claims }, { toolCallId }) => {
      const missing = requireTeam(ctx);
      if (missing) return missing;
      return commitAction(
        { ctx, toolCallId, actionType: "submit_waiver_claims", payload: { claims } },
        async () => {
          const team = snapshot.teams.find((t) => t.id === ctx.teamId);
          const errors: string[] = [];
          const roster = new Set(team?.rosterPlayerIds ?? []);
          let totalBid = 0;
          for (const claim of claims) {
            const add = snapshot.players[claim.addPlayerId];
            if (!add) errors.push(`Unknown player ${claim.addPlayerId}.`);
            else if (add.ownerTeamId != null)
              errors.push(`${add.fullName} is rostered by another team and is not a free agent.`);
            if (claim.dropPlayerId && !roster.has(claim.dropPlayerId)) {
              errors.push(`Cannot drop ${claim.dropPlayerId}: not on your roster.`);
            }
            totalBid += claim.bid;
          }
          if (team && totalBid > team.faabRemaining) {
            errors.push(
              `Total bids ($${totalBid}) exceed your remaining FAAB ($${team.faabRemaining}).`,
            );
          }
          if (errors.length > 0) return { ok: false as const, errors };

          const result = await ctx.ctx.runMutation(internal.waivers.submit, {
            leagueId: ctx.leagueId,
            teamId: ctx.teamId as Id<"teams">,
            windowId: ctx.windowId,
            weekNo: ctx.weekNo,
            claims: claims.map((c) => ({
              addPlayerId: playerId(c.addPlayerId),
              ...(c.dropPlayerId ? { dropPlayerId: playerId(c.dropPlayerId) } : {}),
              bid: c.bid,
            })),
            agentCtx: agentContext(ctx, toolCallId),
          });
          if (!result.ok) return result;
          ctx.state.waiverClaims += claims.length;
          return { ok: true as const, claimIds: result.claimIds, submitted: claims.length };
        },
      );
    },
  });

  const drop_player = tool({
    description: describeTool("drop_player"),
    inputSchema: z.object({ playerId: z.string().min(1) }),
    execute: async ({ playerId: droppedId }, { toolCallId }) => {
      const missing = requireTeam(ctx);
      if (missing) return missing;
      return commitAction(
        { ctx, toolCallId, actionType: "drop_player", payload: { playerId: droppedId } },
        async () => {
          const team = snapshot.teams.find((t) => t.id === ctx.teamId);
          if (!team?.rosterPlayerIds.includes(droppedId)) {
            return { ok: false as const, errors: [`Player ${droppedId} is not on your roster.`] };
          }
          const result = await ctx.ctx.runMutation(internal.waivers.drop, {
            leagueId: ctx.leagueId,
            teamId: ctx.teamId as Id<"teams">,
            playerId: playerId(droppedId),
            weekNo: ctx.weekNo,
            agentCtx: agentContext(ctx, toolCallId),
            now: ctx.now().getTime(),
          });
          if (!result.ok) return result;
          ctx.state.drops += 1;
          return { ok: true as const, playerId: result.playerId };
        },
      );
    },
  });

  const propose_trade = tool({
    description: describeTool("propose_trade"),
    inputSchema: z.object({
      toTeamId: z.string().min(1),
      give: z.array(z.string()).min(1).max(5).describe("Player ids from YOUR roster."),
      receive: z.array(z.string()).min(1).max(5).describe("Player ids from THEIR roster."),
      faab: z.number().int().optional().describe("FAAB from you to them; negative for the reverse."),
      message: z.string().max(2000).optional(),
    }),
    execute: async (input, { toolCallId }) => {
      const missing = requireTeam(ctx);
      if (missing) return missing;
      return commitAction(
        { ctx, toolCallId, actionType: "propose_trade", payload: { ...input } },
        async () => {
          const me = snapshot.teams.find((t) => t.id === ctx.teamId);
          const them = snapshot.teams.find((t) => t.id === input.toTeamId);
          const errors: string[] = [];
          if (!them) errors.push(`Unknown team ${input.toTeamId}.`);
          if (input.toTeamId === ctx.teamId) errors.push("You cannot trade with yourself.");
          for (const id of input.give) {
            if (!me?.rosterPlayerIds.includes(id)) errors.push(`${id} is not on your roster.`);
          }
          for (const id of input.receive) {
            if (them && !them.rosterPlayerIds.includes(id)) {
              errors.push(`${id} is not on ${them.name}'s roster.`);
            }
          }
          if (errors.length > 0) return { ok: false as const, errors };

          const result = await ctx.ctx.runMutation(internal.trades.propose, {
            leagueId: ctx.leagueId,
            proposerTeamId: ctx.teamId as Id<"teams">,
            toTeamId: input.toTeamId as Id<"teams">,
            give: input.give.map(playerId),
            receive: input.receive.map(playerId),
            ...(input.faab === undefined ? {} : { faab: input.faab }),
            ...(input.message === undefined ? {} : { message: input.message }),
            agentCtx: agentContext(ctx, toolCallId),
          });
          if (!result.ok) return result;
          ctx.state.tradesProposed += 1;
          return { ok: true as const, tradeId: result.tradeId, threadId: result.threadId };
        },
      );
    },
  });

  const respond_to_trade = tool({
    description: describeTool("respond_to_trade"),
    inputSchema: z.object({
      tradeId: z.string().min(1),
      action: z.enum(["accept", "reject", "counter"]),
      counter: z
        .object({
          give: z.array(z.string()).min(1).max(5),
          receive: z.array(z.string()).min(1).max(5),
          faab: z.number().int().optional(),
        })
        .optional()
        .describe("Required when action is 'counter'."),
      message: z.string().max(2000).optional(),
    }),
    execute: async (input, { toolCallId }) => {
      const missing = requireTeam(ctx);
      if (missing) return missing;
      return commitAction(
        { ctx, toolCallId, actionType: "respond_to_trade", payload: { ...input } },
        async () => {
          if (input.action === "counter" && !input.counter) {
            return { ok: false as const, errors: ["action 'counter' requires a `counter` package."] };
          }
          const result = await ctx.ctx.runMutation(internal.trades.respond, {
            leagueId: ctx.leagueId,
            teamId: ctx.teamId as Id<"teams">,
            tradeId: input.tradeId as Id<"trades">,
            action: input.action,
            ...(input.counter
              ? {
                  counter: {
                    give: input.counter.give.map(playerId),
                    receive: input.counter.receive.map(playerId),
                    ...(input.counter.faab === undefined ? {} : { faab: input.counter.faab }),
                  },
                }
              : {}),
            ...(input.message === undefined ? {} : { message: input.message }),
            agentCtx: agentContext(ctx, toolCallId),
          });
          if (!result.ok) return result;
          ctx.state.tradeResponses += 1;
          return {
            ok: true as const,
            tradeId: result.tradeId,
            status: result.status,
            counterTradeId: result.counterTradeId,
          };
        },
      );
    },
  });

  const send_message = tool({
    description: describeTool("send_message"),
    inputSchema: z.object({
      threadId: z.string().optional(),
      toTeamId: z.string().optional(),
      body: z.string().min(1).max(4000),
    }),
    execute: async (input, { toolCallId }) => {
      const missing = requireTeam(ctx);
      if (missing) return missing;
      return commitAction(
        { ctx, toolCallId, actionType: "send_message", payload: { ...input } },
        async () => {
          if (!input.threadId && !input.toTeamId) {
            return { ok: false as const, errors: ["Pass either threadId or toTeamId."] };
          }
          if (input.toTeamId === ctx.teamId) {
            return { ok: false as const, errors: ["You cannot message yourself."] };
          }
          if (ctx.state.messagesSent >= snapshot.rules.maxMessagesPerRun) {
            return {
              ok: false as const,
              errors: [
                `Message limit reached for this run (${snapshot.rules.maxMessagesPerRun}). Wrap up and finish.`,
              ],
            };
          }
          const result = await ctx.ctx.runMutation(internal.messaging.send, {
            leagueId: ctx.leagueId,
            fromTeamId: ctx.teamId as Id<"teams">,
            ...(input.toTeamId ? { toTeamId: input.toTeamId as Id<"teams"> } : {}),
            ...(input.threadId ? { threadId: input.threadId as Id<"threads"> } : {}),
            body: input.body,
            agentCtx: agentContext(ctx, toolCallId),
          });
          if (!result.ok) return result;
          ctx.state.messagesSent += 1;
          return { ok: true as const, threadId: result.threadId, messageId: result.messageId };
        },
      );
    },
  });

  const post_to_forum = tool({
    description: describeTool("post_to_forum"),
    inputSchema: z.object({
      title: z.string().min(1).max(200),
      body: z.string().min(1).max(8000),
      flair: z.enum(FLAIRS).default("analysis"),
    }),
    execute: async (input, { toolCallId }) => {
      const missing = requireTeam(ctx);
      if (missing) return missing;
      return commitAction(
        { ctx, toolCallId, actionType: "post_to_forum", payload: { ...input } },
        async () => {
          const result = await ctx.ctx.runMutation(internal.forum.createPost, {
            leagueId: ctx.leagueId,
            teamId: ctx.teamId,
            title: input.title,
            body: input.body,
            flair: input.flair,
            agentCtx: agentContext(ctx, toolCallId),
          });
          if (!result.ok) return result;
          ctx.state.forumPosts += 1;
          return { ok: true as const, postId: result.postId };
        },
      );
    },
  });

  const comment_on_forum = tool({
    description: describeTool("comment_on_forum"),
    inputSchema: z.object({
      postId: z.string().min(1),
      parentCommentId: z.string().optional(),
      body: z.string().min(1).max(4000),
    }),
    execute: async (input, { toolCallId }) => {
      const missing = requireTeam(ctx);
      if (missing) return missing;
      return commitAction(
        { ctx, toolCallId, actionType: "comment_on_forum", payload: { ...input } },
        async () => {
          const result = await ctx.ctx.runMutation(internal.forum.createComment, {
            leagueId: ctx.leagueId,
            postId: input.postId as Id<"forum_posts">,
            ...(input.parentCommentId
              ? { parentCommentId: input.parentCommentId as Id<"forum_comments"> }
              : {}),
            teamId: ctx.teamId,
            body: input.body,
            agentCtx: agentContext(ctx, toolCallId),
          });
          if (!result.ok) return result;
          ctx.state.forumComments += 1;
          return { ok: true as const, commentId: result.commentId };
        },
      );
    },
  });

  const vote_on_forum = tool({
    description: describeTool("vote_on_forum"),
    inputSchema: z.object({
      targetId: z.string().min(1),
      targetType: z.enum(["post", "comment"]).default("post"),
      direction: z.enum(["up", "down", "none"]),
    }),
    execute: async (input, { toolCallId }) => {
      const missing = requireTeam(ctx);
      if (missing) return missing;
      return commitAction(
        { ctx, toolCallId, actionType: "vote_on_forum", payload: { ...input } },
        async () => {
          const direction = input.direction === "up" ? 1 : input.direction === "down" ? -1 : 0;
          const result = await ctx.ctx.runMutation(internal.forum.voteAsTeam, {
            leagueId: ctx.leagueId,
            voterTeamId: ctx.teamId as Id<"teams">,
            targetType: input.targetType,
            targetId: input.targetId,
            direction: direction as 1 | -1 | 0,
            agentCtx: agentContext(ctx, toolCallId),
          });
          if (!result.ok) return result;
          ctx.state.forumVotes += 1;
          return { ok: true as const, score: result.score };
        },
      );
    },
  });

  const set_rationale = tool({
    description: describeTool("set_rationale"),
    inputSchema: z.object({ text: z.string().min(1).max(2000) }),
    execute: async ({ text }, { toolCallId }) => {
      return commitAction(
        { ctx, toolCallId, actionType: "set_rationale", payload: { text } },
        async () => {
          const result = await ctx.ctx.runMutation(internal.runs.setRationale, {
            runId: ctx.runId,
            text,
            agentCtx: agentContext(ctx, toolCallId),
          });
          if (!result.ok) return result;
          ctx.state.rationale = text;
          return { ok: true as const, chars: text.length };
        },
      );
    },
  });

  return {
    set_lineup,
    submit_waiver_claims,
    drop_player,
    propose_trade,
    respond_to_trade,
    send_message,
    post_to_forum,
    comment_on_forum,
    vote_on_forum,
    set_rationale,
  };
}

export type WriteTools = ReturnType<typeof buildWriteTools>;
