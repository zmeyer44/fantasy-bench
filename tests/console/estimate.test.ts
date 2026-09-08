import { beforeAll, describe, expect, it } from "vitest";

import {
  ASSUMED_OUTPUT_TOKENS_PER_STEP,
  ASSUMED_STEPS,
  BASE_PROMPT_TOKENS,
  estimatePromptSize,
  estimateTokens,
} from "@/lib/services/config";
import { createSkill } from "@/lib/services/skills";
import { findModel } from "@/lib/models";

import { truncateAll } from "../setup";
import { makeUser } from "./helpers";

const SONNET = "anthropic/claude-sonnet-4.5";

beforeAll(async () => {
  await truncateAll();
});

describe("estimateTokens", () => {
  it("is the chars/4 fallback until lib/agent/prompt lands", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
});

describe("estimatePromptSize", () => {
  it("is the base allowance plus context plus skills", async () => {
    const author = await makeUser("Author");
    const skill = await createSkill({
      authorUserId: author.id,
      name: "Estimate fixture",
      bodyMd: "x".repeat(4_000),
    });

    const empty = await estimatePromptSize({ contextMd: "", skillIds: [], modelId: SONNET });
    expect(empty.tokens).toBe(BASE_PROMPT_TOKENS);

    const withContext = await estimatePromptSize({
      contextMd: "y".repeat(400),
      skillIds: [],
      modelId: SONNET,
    });
    expect(withContext.tokens).toBe(BASE_PROMPT_TOKENS + 100);

    const withSkill = await estimatePromptSize({
      contextMd: "y".repeat(400),
      skillIds: [skill.id],
      modelId: SONNET,
    });
    expect(withSkill.tokens).toBe(BASE_PROMPT_TOKENS + 100 + 1_000);
    expect(withSkill.breakdown.skills).toEqual([
      { id: skill.id, name: "Estimate fixture", tokens: 1_000 },
    ]);
  });

  it("is monotonic in context length and in attached skills", async () => {
    const author = await makeUser("Author");
    const a = await createSkill({ authorUserId: author.id, name: "Skill A", bodyMd: "a".repeat(800) });
    const b = await createSkill({ authorUserId: author.id, name: "Skill B", bodyMd: "b".repeat(800) });

    let previousTokens = 0;
    let previousCost = 0;
    for (const contextLength of [0, 100, 1_000, 8_000]) {
      const est = await estimatePromptSize({
        contextMd: "c".repeat(contextLength),
        skillIds: [],
        modelId: SONNET,
      });
      expect(est.tokens).toBeGreaterThan(previousTokens);
      expect(est.estimatedCostPerRunUsd).toBeGreaterThan(previousCost);
      previousTokens = est.tokens;
      previousCost = est.estimatedCostPerRunUsd;
    }

    const none = await estimatePromptSize({ contextMd: "ctx", skillIds: [], modelId: SONNET });
    const one = await estimatePromptSize({ contextMd: "ctx", skillIds: [a.id], modelId: SONNET });
    const two = await estimatePromptSize({
      contextMd: "ctx",
      skillIds: [a.id, b.id],
      modelId: SONNET,
    });
    expect(one.tokens).toBeGreaterThan(none.tokens);
    expect(two.tokens).toBeGreaterThan(one.tokens);
    expect(two.estimatedCostPerRunUsd).toBeGreaterThan(one.estimatedCostPerRunUsd);
  });

  it("applies the documented cost formula", async () => {
    const est = await estimatePromptSize({
      contextMd: "z".repeat(4_000),
      skillIds: [],
      modelId: SONNET,
    });
    const model = findModel(SONNET)!;
    const expected =
      ((est.tokens * model.inputPerM) / 1_000_000 +
        (ASSUMED_OUTPUT_TOKENS_PER_STEP * model.outputPerM) / 1_000_000) *
      ASSUMED_STEPS;
    expect(est.estimatedCostPerRunUsd).toBeCloseTo(expected, 8);
  });

  it("costs a free mock model at zero and flags an unknown model", async () => {
    const mock = await estimatePromptSize({
      contextMd: "ctx",
      skillIds: [],
      modelId: "mock/scripted",
    });
    expect(mock.estimatedCostPerRunUsd).toBe(0);
    expect(mock.breakdown.modelKnown).toBe(true);

    const unknown = await estimatePromptSize({
      contextMd: "ctx",
      skillIds: [],
      modelId: "acme/does-not-exist",
    });
    expect(unknown.breakdown.modelKnown).toBe(false);
    expect(unknown.estimatedCostPerRunUsd).toBe(0);
    expect(unknown.tokens).toBeGreaterThan(0);
  });

  it("ignores duplicate skill ids", async () => {
    const author = await makeUser("Author");
    const skill = await createSkill({ authorUserId: author.id, name: "Dupe", bodyMd: "d".repeat(400) });
    const once = await estimatePromptSize({ contextMd: "", skillIds: [skill.id], modelId: SONNET });
    const twice = await estimatePromptSize({
      contextMd: "",
      skillIds: [skill.id, skill.id],
      modelId: SONNET,
    });
    expect(twice.tokens).toBe(once.tokens);
  });
});
