/**
 * Model resolution and the price book.
 *
 * Models are addressed by pinned Vercel AI Gateway id (`anthropic/claude-sonnet-4.5`).
 * "latest" aliases are rejected outright — PRD 5.1/7 require a pinned version for
 * the whole season so a mid-season provider change is a visible, logged event.
 *
 * `mock/*` ids resolve to a scripted mock model so dev and tests never need a
 * gateway key.
 */
import { createGateway } from "@ai-sdk/gateway";
import { and, desc, eq, lte } from "drizzle-orm";
import type { LanguageModel } from "ai";

import { db, type DbOrTx } from "@/lib/db";
import { modelPrices } from "@/lib/db/schema";
import { findModel } from "@/lib/models";
import { env } from "@/lib/env";

import { createMockModel, MOCK_MODEL_IDS } from "./mock-model";

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
    gatewayProvider = createGateway({ apiKey: env.AI_GATEWAY_API_KEY });
  }
  return gatewayProvider;
}

/** Test seam: drop the memoised gateway (e.g. after changing the API key). */
export function resetGatewayProvider(): void {
  gatewayProvider = null;
}

/**
 * Resolve a model id to an AI SDK `LanguageModel`.
 *
 * @throws when the id is empty, unpinned, or a `mock/*` id we do not script.
 */
export function resolveModel(modelId: string): LanguageModel {
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
  return getGateway()(id);
}

export { MOCK_MODEL_IDS };

export type ResolvedModelPrice = {
  modelId: string;
  provider: string;
  displayName: string;
  /** USD per 1M tokens. */
  inputPerM: number;
  outputPerM: number;
  cachedInputPerM: number | null;
  reasoningPerM: number | null;
  supportsReasoning: boolean;
  source: "model_prices" | "catalog" | "unknown";
};

const ZERO_PRICE: Omit<ResolvedModelPrice, "modelId" | "provider"> = {
  displayName: "Unknown model",
  inputPerM: 0,
  outputPerM: 0,
  cachedInputPerM: 0,
  reasoningPerM: null,
  supportsReasoning: false,
  source: "unknown",
};

/**
 * Price for `modelId` in effect at `at` (default: now).
 *
 * Reads the `model_prices` row with the greatest `effective_from <= at`, falling
 * back to `MODEL_CATALOG`, and finally to a zero price so an unknown model can
 * never abort a run (the ledger simply records $0 and the gateway figure, when
 * present, still wins).
 */
export async function getModelPrice(
  modelId: string,
  at: Date = new Date(),
  executor: DbOrTx = db,
): Promise<ResolvedModelPrice> {
  try {
    const [row] = await executor
      .select()
      .from(modelPrices)
      .where(and(eq(modelPrices.modelId, modelId), lte(modelPrices.effectiveFrom, at)))
      .orderBy(desc(modelPrices.effectiveFrom))
      .limit(1);
    if (row) {
      return {
        modelId: row.modelId,
        provider: row.provider,
        displayName: row.displayName,
        inputPerM: row.inputPerM,
        outputPerM: row.outputPerM,
        cachedInputPerM: row.cachedInputPerM,
        reasoningPerM: row.reasoningPerM,
        supportsReasoning: row.supportsReasoning,
        source: "model_prices",
      };
    }
  } catch {
    // A price lookup must never take a run down; fall through to the catalog.
  }

  const catalog = findModel(modelId);
  if (catalog) {
    return {
      modelId: catalog.modelId,
      provider: catalog.provider,
      displayName: catalog.displayName,
      inputPerM: catalog.inputPerM,
      outputPerM: catalog.outputPerM,
      cachedInputPerM: catalog.cachedInputPerM,
      reasoningPerM: catalog.reasoningPerM,
      supportsReasoning: catalog.supportsReasoning,
      source: "catalog",
    };
  }

  const provider = modelId.includes("/") ? modelId.slice(0, modelId.indexOf("/")) : "unknown";
  return { modelId, provider, ...ZERO_PRICE };
}

/** Whether the model advertises a reasoning-effort knob (catalog metadata). */
export function modelSupportsReasoning(modelId: string): boolean {
  return findModel(modelId)?.supportsReasoning ?? false;
}
