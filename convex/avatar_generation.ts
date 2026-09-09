"use node";

import { generateImage } from "ai";
import { createGateway } from "@ai-sdk/gateway";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { readGatewayCostUsd } from "./runtime/model";

export const generate = internalAction({
  args: {
    teamId: v.id("teams"),
    requestKey: v.string(),
    name: v.string(),
    prompt: v.string(),
    runId: v.id("runs"),
    stepIndex: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (
      !(await ctx.runMutation(internal.team_identity.claim, {
        teamId: args.teamId,
        requestKey: args.requestKey,
      }))
    )
      return null;
    try {
      const modelId = process.env.AVATAR_IMAGE_MODEL;
      if (!modelId || !process.env.AI_GATEWAY_API_KEY)
        throw new Error("Avatar generation is not configured");
      const gateway = createGateway({ apiKey: process.env.AI_GATEWAY_API_KEY });
      const result = await generateImage({
        model: gateway.imageModel(modelId),
        n: 1,
        aspectRatio: "1:1",
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(120_000),
        prompt: `Create one original fantasy football team avatar for ${JSON.stringify(args.name)}. A bold, legible sports crest with a centered silhouette and generous crop-safe margins. Near-black background, lime #c8ff00, blue #2b47ff and white. No text, lettering, or real team logos. Team's creative brief: ${JSON.stringify(args.prompt)}`,
      });
      const costs = result.calls.map((call) =>
        readGatewayCostUsd(call.providerMetadata),
      );
      const cost =
        costs.length && costs.every((value) => value !== null)
          ? costs.reduce<number>((sum, value) => sum + (value ?? 0), 0)
          : Number(process.env.AVATAR_IMAGE_COST_USD || "0.10");
      // Negative indices are reserved for image calls so they cannot collide with language steps.
      await ctx.runMutation(internal.ledger.recordStep, {
        runId: args.runId,
        stepIndex: -1 - args.stepIndex,
        modelId,
        usage: {
          inputTokens: result.usage.inputTokens ?? 0,
          outputTokens: result.usage.outputTokens ?? 0,
        },
        gatewayCostUsd: cost,
      });
      const image = result.image;
      if (
        !["image/png", "image/jpeg", "image/webp"].includes(image.mediaType) ||
        image.uint8Array.byteLength > 5_000_000
      )
        throw new Error("Unsupported image output");
      const storageId = await ctx.storage.store(
        new Blob([new Uint8Array(image.uint8Array)], { type: image.mediaType }),
      );
      await ctx.runMutation(internal.team_identity.finish, {
        teamId: args.teamId,
        requestKey: args.requestKey,
        storageId,
      });
    } catch {
      await ctx.runMutation(internal.team_identity.finish, {
        teamId: args.teamId,
        requestKey: args.requestKey,
        error:
          "The avatar could not be generated. Your previous avatar is still available. Your agent can choose a template or try again after 24 hours.",
      });
    }
    return null;
  },
});
