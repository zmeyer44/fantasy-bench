/**
 * Model resolution across the two bring-your-own-key vendors, and the cost
 * figure each reports.
 */
import { describe, expect, it } from "vitest";

import { readGatewayCostUsd, resolveModel, type ResolveModelOptions } from "./model";

const KEY = "sk-or-v1-0123456789abcdef0123456789abcdef";

/** `LanguageModel` admits bare id strings; everything here resolves to a model object. */
function resolved(modelId: string, options?: ResolveModelOptions): { modelId: string; provider: string } {
  const model = resolveModel(modelId, options);
  if (typeof model === "string") throw new Error(`expected a model object for ${modelId}`);
  return { modelId: model.modelId, provider: model.provider };
}

describe("resolveModel", () => {
  it("translates the catalog id to OpenRouter's slug on an OpenRouter key", () => {
    const model = resolved("zai/glm-5.3", { apiKey: KEY, keyProvider: "openrouter" });
    expect(model.modelId).toBe("z-ai/glm-5.3");
    expect(model.provider).toMatch(/openrouter/);
  });

  it("keeps the gateway id on a Vercel key and on the league key", () => {
    expect(resolved("zai/glm-5.3", { apiKey: "vck_0123456789abcdef", keyProvider: "vercel" }).modelId).toBe(
      "zai/glm-5.3",
    );
    expect(resolved("zai/glm-5.3").modelId).toBe("zai/glm-5.3");
  });

  it("refuses a model OpenRouter does not serve", () => {
    expect(() =>
      resolveModel("deepseek/deepseek-v4.1-flash-beta", { apiKey: KEY, keyProvider: "openrouter" }),
    ).toThrow(/not available through OpenRouter/);
  });

  it("ignores the vendor without a key, and never routes a mock model anywhere", () => {
    expect(resolved("zai/glm-5.3", { keyProvider: "openrouter" }).modelId).toBe("zai/glm-5.3");
    expect(resolved("mock/scripted", { apiKey: KEY, keyProvider: "openrouter" }).modelId).toBe("mock/scripted");
  });
});

describe("readGatewayCostUsd", () => {
  it("reads the gateway's figure and OpenRouter's usage-accounting figure", () => {
    expect(readGatewayCostUsd({ gateway: { cost: "0.0123" } })).toBe(0.0123);
    expect(readGatewayCostUsd({ openrouter: { usage: { cost: 0.0045, promptTokens: 10 } } })).toBe(0.0045);
    expect(readGatewayCostUsd({ openrouter: { usage: { promptTokens: 10 } } })).toBeNull();
    expect(readGatewayCostUsd({ openrouter: { usage: { cost: "n/a" } } })).toBeNull();
    expect(readGatewayCostUsd(null)).toBeNull();
  });
});
