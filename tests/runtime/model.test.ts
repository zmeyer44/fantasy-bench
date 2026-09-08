import { describe, expect, it } from "vitest";

import { isMockModelId, isPinnedModelId, resolveModel } from "@/lib/agent/model";
import { MOCK_MODEL_IDS } from "@/lib/agent/mock-model";

describe("resolveModel", () => {
  it("resolves every scripted mock id without a gateway key", () => {
    for (const id of MOCK_MODEL_IDS) {
      const model = resolveModel(id);
      expect(typeof model).toBe("object");
      expect(isMockModelId(id)).toBe(true);
    }
  });

  it("rejects an unknown mock id rather than silently scripting it", () => {
    expect(() => resolveModel("mock/nonsense")).toThrow(/unknown mock model id/i);
  });

  it("refuses unpinned gateway ids", () => {
    expect(isPinnedModelId("anthropic/claude-sonnet-4.5")).toBe(true);
    expect(isPinnedModelId("anthropic/claude-sonnet-latest")).toBe(false);
    expect(isPinnedModelId("openai/gpt-5:latest")).toBe(false);
    expect(() => resolveModel("anthropic/claude-3-latest")).toThrow(/pinned/i);
  });

  it("requires a provider-qualified id", () => {
    expect(() => resolveModel("gpt-5")).toThrow(/gateway model id/i);
    expect(() => resolveModel("")).toThrow(/required/i);
  });

  it("builds a gateway model for a pinned id", () => {
    const model = resolveModel("anthropic/claude-sonnet-4.5");
    expect(model).toBeTruthy();
  });
});
