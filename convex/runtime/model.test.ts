/**
 * Model resolution across the bring-your-own-key vendors, and the cost
 * figure each reports.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateText } from "ai";
import { modelAvailableOnKeyProvider } from "../../lib/models";

afterEach(() => vi.unstubAllGlobals());

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

  it.each([
    ["anthropic", "anthropic/claude-opus-5", "claude-opus-5", "anthropic.messages"],
    ["anthropic", "anthropic/claude-fable-5.1", "claude-fable-5-1", "anthropic.messages"],
    ["openai", "openai/gpt-6-astra", "gpt-6-astra", "openai.responses"],
    ["openai", "openai/gpt-5.6-terra", "gpt-5.6-terra", "openai.responses"],
  ] as const)("routes %s keys directly for %s", (keyProvider, catalogId, nativeId, provider) => {
    expect(resolved(catalogId, { apiKey: "test-owner-key", keyProvider })).toEqual({ modelId: nativeId, provider });
    expect(modelAvailableOnKeyProvider(catalogId, keyProvider)).toBe(true);
  });

  it.each(["anthropic", "openai"] as const)("refuses another vendor's model on a %s key", (keyProvider) => {
    expect(modelAvailableOnKeyProvider("google/gemini-3.8-flash", keyProvider)).toBe(false);
    expect(modelAvailableOnKeyProvider("unknown/model", keyProvider)).toBe(false);
    expect(() => resolveModel("google/gemini-3.8-flash", { apiKey: KEY, keyProvider })).toThrow(/not available through/);
    expect(resolved("mock/scripted", { apiKey: KEY, keyProvider }).modelId).toBe("mock/scripted");
  });

  it.each([
    ["anthropic", "anthropic/claude-fable-5.1", "https://api.anthropic.com/v1/messages", "claude-fable-5-1"],
    ["openai", "openai/gpt-6-astra", "https://api.openai.com/v1/responses", "gpt-6-astra"],
  ] as const)("sends the owner's %s key and reasoning setting to its native API", async (keyProvider, modelId, url, nativeId) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(generateText({ model: resolveModel(modelId, { apiKey: "owner-secret", keyProvider }), prompt: "hello", reasoning: "high", maxRetries: 0 })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [actualUrl, request] = fetchMock.mock.calls[0];
    expect(actualUrl).toBe(url);
    const headers = new Headers(request.headers);
    expect(headers.get(keyProvider === "anthropic" ? "x-api-key" : "authorization")).toBe(keyProvider === "anthropic" ? "owner-secret" : "Bearer owner-secret");
    const body = JSON.parse(request.body);
    expect(body.model).toBe(nativeId);
    if (keyProvider === "anthropic") {
      expect(body.output_config.effort).toBe("high");
      expect(body.thinking.type).toBe("adaptive");
    } else {
      expect(body.reasoning.effort).toBe("high");
    }
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
