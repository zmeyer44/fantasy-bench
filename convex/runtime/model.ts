/**
 * Model resolution and the price book.
 *
 * Models are addressed by pinned Vercel AI Gateway id (`anthropic/claude-opus-5`).
 * "latest" aliases are rejected outright — PRD 5.1/7 require a pinned version for
 * the whole season so a mid-season provider change is a visible, logged event.
 *
 * `mock/*` ids resolve to a scripted mock model so dev and tests never need a
 * gateway key.
 *
 * A team on its own key may have brought an OpenRouter key instead of a Vercel
 * one. The catalog id stays the gateway id everywhere (configs, ledger, trace);
 * only here is it translated to OpenRouter's slug (`lib/models.ts`,
 * `openRouterModelId`), and a model OpenRouter does not serve is refused with a
 * message the run's trace can show.
 *
 * What changed in the port: `getModelPrice` no longer exists here. Prices are a
 * database read, and a run resolves them once through
 * `internal.runtime.load.runContext`, which returns a `ResolvedModelPrice` for the
 * run's model (and for the league's fallback model). The pure arithmetic lives in
 * `convex/lib/pricing_pure.ts` and is shared with the ledger, so the executor's
 * pre-step estimate and the ledger's recorded cost can never disagree.
 */
import { createGateway } from "@ai-sdk/gateway";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";

import type { KeyProvider } from "../../lib/key-providers";
import { findModel, openRouterModelIdFor } from "../../lib/models";
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
   * A team owner's own key (bring-your-own-key). When set, the model is created
   * on a client for that key instead of the league's; runs on it bypass spend
   * caps but are metered like every other run.
   */
  apiKey?: string | null;
  /** Which vendor issued `apiKey`. Ignored without one. Default: Vercel AI Gateway. */
  keyProvider?: KeyProvider | null;
  /**
   * The harness's reasoning effort. The gateway takes it as a call option, which
   * the executor passes on every call; OpenRouter's provider only reads it from
   * the model's settings, so it has to be known here.
   */
  reasoningEffort?: "low" | "medium" | "high" | null;
};

/** The OpenRouter client is per-key, like the gateway's BYOK path. */
function openRouterModel(id: string, apiKey: string, reasoningEffort: ResolveModelOptions["reasoningEffort"]): LanguageModel {
  const openRouterId = openRouterModelIdFor(id);
  if (!openRouterId) {
    throw new Error(
      `resolveModel: ${id} is not available through OpenRouter — the team's key is an OpenRouter key; pick a model OpenRouter serves or add a Vercel AI Gateway key instead.`,
    );
  }
  const openrouter = createOpenRouter({
    apiKey,
    appName: "Fantasy Bench",
    // Strict mode is the OpenRouter API proper (as opposed to a compatible third party).
    compatibility: "strict",
  });
  return openrouter.chat(openRouterId, {
    // Usage accounting puts OpenRouter's own cost on the response (`readProviderCostUsd`).
    usage: { include: true },
    ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
  });
}

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
  if (options.apiKey && options.keyProvider === "openrouter") {
    return openRouterModel(id, options.apiKey, options.reasoningEffort ?? null);
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
 * The vendor's own cost figure, when the provider metadata carries one.
 *
 * `GatewayProviderMetadata` is deliberately open (`[key: string]: JSONValue`) so
 * the service can add fields without an SDK release, which means the cost field
 * is not statically typed. Read it defensively across the spellings the gateway
 * has used and ignore anything that is not a finite number. OpenRouter reports
 * its figure under `openrouter.usage.cost` when usage accounting is on, which
 * `resolveModel` always requests.
 */
export function readGatewayCostUsd(providerMetadata: unknown): number | null {
  if (!providerMetadata || typeof providerMetadata !== "object") return null;
  const meta = providerMetadata as Record<string, unknown>;
  const gateway = meta.gateway;
  if (gateway && typeof gateway === "object") {
    const bag = gateway as Record<string, unknown>;
    for (const key of ["cost", "costUSD", "cost_usd", "totalCost", "total_cost_usd", "usageCost"]) {
      const num = finiteNumber(bag[key]);
      if (num !== null) return num;
    }
  }
  const openrouter = meta.openrouter;
  if (openrouter && typeof openrouter === "object") {
    const usage = (openrouter as Record<string, unknown>).usage;
    if (usage && typeof usage === "object") {
      const num = finiteNumber((usage as Record<string, unknown>).cost);
      if (num !== null) return num;
    }
  }
  return null;
}

function finiteNumber(value: unknown): number | null {
  const num = typeof value === "string" ? Number(value) : value;
  return typeof num === "number" && Number.isFinite(num) ? num : null;
}
