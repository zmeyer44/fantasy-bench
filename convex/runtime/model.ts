/**
 * Model resolution and the price book.
 *
 * Models are addressed by pinned Vercel AI Gateway id (`anthropic/claude-sonnet-4.5`).
 * "latest" aliases are rejected outright — PRD 5.1/7 require a pinned version for
 * the whole season so a mid-season provider change is a visible, logged event.
 *
 * `mock/*` ids resolve to a scripted mock model so dev and tests never need a
 * gateway key.
 *
 * What changed in the port: `getModelPrice` no longer exists here. Prices are a
 * database read, and a run resolves them once through
 * `internal.runtime.load.runContext`, which returns a `ResolvedModelPrice` for the
 * run's model (and for the league's fallback model). The pure arithmetic lives in
 * `convex/lib/pricing_pure.ts` and is shared with the ledger, so the executor's
 * pre-step estimate and the ledger's recorded cost can never disagree.
 */
import { createGateway } from "@ai-sdk/gateway";
import type { LanguageModel } from "ai";

import { findModel } from "../../lib/models";
import { createMockModel, MOCK_MODEL_IDS } from "./mock_model";

export function isMockModelId(modelId: string): boolean {
  return modelId.startsWith("mock/");
}

/** Gateway ids must be pinned; `…-latest` (or a bare `latest` tag) is not a pin. */
export function isPinnedModelId(modelId: string): boolean {
  const tail = modelId.split("/").pop() ?? modelId;
  return !/(^|[-:@])latest$/i.test(tail);
}

let gatewayProvider: ReturnType<typeof createGateway> | null = null;

function getGateway(): ReturnType<typeof createGateway> {
  if (!gatewayProvider) {
    gatewayProvider = createGateway({ apiKey: process.env.AI_GATEWAY_API_KEY });
  }
  return gatewayProvider;
}

/** Test seam: drop the memoised gateway (e.g. after changing the API key). */
export function resetGatewayProvider(): void {
  gatewayProvider = null;
}

export type ResolveModelOptions = {
  /**
   * A team owner's own gateway key (bring-your-own-key). When set, the model is
   * created on a gateway client for that key instead of the league's; runs on it
   * bypass spend caps but are metered like every other run.
   */
  apiKey?: string | null;
};

/**
 * Resolve a model id to an AI SDK `LanguageModel`.
 *
 * @throws when the id is empty, unpinned, or a `mock/*` id we do not script.
 */
export function resolveModel(modelId: string, options: ResolveModelOptions = {}): LanguageModel {
  const id = modelId?.trim();
  if (!id) throw new Error("resolveModel: modelId is required");
  if (isMockModelId(id)) return createMockModel(id);
  if (!isPinnedModelId(id)) {
    throw new Error(
      `resolveModel: refusing unpinned model id "${id}" — model versions are pinned for the season (PRD 5.1).`,
    );
  }
  if (!id.includes("/")) {
    throw new Error(`resolveModel: "${id}" is not a gateway model id (expected "provider/model").`);
  }
  if (options.apiKey) return createGateway({ apiKey: options.apiKey })(id);
  return getGateway()(id);
}

export { MOCK_MODEL_IDS };

/** Whether the model advertises a reasoning-effort knob (catalog metadata). */
export function modelSupportsReasoning(modelId: string): boolean {
  return findModel(modelId)?.supportsReasoning ?? false;
}

/**
 * Gateway cost, when the provider metadata carries one.
 *
 * `GatewayProviderMetadata` is deliberately open (`[key: string]: JSONValue`) so
 * the service can add fields without an SDK release, which means the cost field
 * is not statically typed. Read it defensively across the spellings the gateway
 * has used and ignore anything that is not a finite number.
 */
export function readGatewayCostUsd(providerMetadata: unknown): number | null {
  if (!providerMetadata || typeof providerMetadata !== "object") return null;
  const gateway = (providerMetadata as Record<string, unknown>).gateway;
  if (!gateway || typeof gateway !== "object") return null;
  const bag = gateway as Record<string, unknown>;
  for (const key of ["cost", "costUSD", "cost_usd", "totalCost", "total_cost_usd", "usageCost"]) {
    const value = bag[key];
    const num = typeof value === "string" ? Number(value) : value;
    if (typeof num === "number" && Number.isFinite(num)) return num;
  }
  return null;
}
