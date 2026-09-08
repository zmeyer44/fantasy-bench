/**
 * Live prompt-size and cost estimate for the config editor (PRD 5.5).
 *
 * ## Assumptions (all exported so the UI can show its working)
 *
 * - `BASE_PROMPT_TOKENS = 2500` — the platform base prompt: rules of engagement,
 *   tool schemas, window + deadline framing, and the snapshot digest header that
 *   `lib/agent/prompt.ts` prepends to every run. It does NOT include the snapshot
 *   body, which varies per window and is not knowable from the editor.
 * - `ASSUMED_OUTPUT_TOKENS_PER_STEP = 1500` — a typical step: some reasoning text
 *   plus one or two tool calls.
 * - `ASSUMED_STEPS = 4` — a typical lineup run. The harness `maxSteps` is a
 *   ceiling, not an expectation, so estimating at the ceiling would be misleading.
 * - Input is charged at the full (uncached) rate on every step. Prompt caching
 *   makes the real figure lower, so this estimate is deliberately pessimistic.
 * - Reasoning tokens are billed as output by every model in the catalog
 *   (`reasoningPerM` is null throughout), so they are folded into the output term.
 *
 * ## Token counting
 *
 * `estimateTokens` is re-exported from `lib/agent/prompt.ts` (runtime package) so
 * the live preview, the per-step budget check and the trace viewer all quote the
 * same number. It is chars/4 — crude, but crude *consistently*.
 */
import { asc, inArray } from "drizzle-orm";

import { estimateTokens } from "@/lib/agent/prompt";
import { db, type DbOrTx } from "@/lib/db";
import { skills } from "@/lib/db/schema";
import { findModel } from "@/lib/models";

export const BASE_PROMPT_TOKENS = 2_500;
export const ASSUMED_OUTPUT_TOKENS_PER_STEP = 1_500;
export const ASSUMED_STEPS = 4;
/** Roughly one token per four characters of English prose / markdown. */
export const CHARS_PER_TOKEN = 4;

export { estimateTokens };

export type PromptEstimate = {
  tokens: number;
  estimatedCostPerRunUsd: number;
  breakdown: {
    baseTokens: number;
    contextTokens: number;
    skillTokens: number;
    /** Per-skill contribution, in attachment order. */
    skills: Array<{ id: string; name: string; tokens: number }>;
    assumedSteps: number;
    assumedOutputTokensPerStep: number;
    inputPerM: number | null;
    outputPerM: number | null;
    modelId: string;
    modelKnown: boolean;
  };
};

export type EstimateInput = {
  contextMd: string;
  skillIds: string[];
  modelId: string;
};

/**
 * Estimated prompt size and per-run cost.
 *
 *   tokens = BASE_PROMPT_TOKENS + tokens(context) + sum(tokens(skill bodies))
 *   cost   = (tokens x input$/M + ASSUMED_OUTPUT_TOKENS_PER_STEP x output$/M)
 *            x ASSUMED_STEPS
 *
 * Monotonic in both context length and attached skills.
 */
export async function estimatePromptSize(
  input: EstimateInput,
  executor: DbOrTx = db,
): Promise<PromptEstimate> {
  const ids = [...new Set(input.skillIds)];
  const rows = ids.length
    ? await executor
        .select({ id: skills.id, name: skills.name, bodyMd: skills.bodyMd })
        .from(skills)
        .where(inArray(skills.id, ids))
        .orderBy(asc(skills.name))
    : [];

  // Preserve the caller's ordering rather than the query's.
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = ids.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => !!r);

  const perSkill = ordered.map((s) => ({
    id: s.id,
    name: s.name,
    tokens: estimateTokens(s.bodyMd),
  }));
  const skillTokens = perSkill.reduce((sum, s) => sum + s.tokens, 0);
  const contextTokens = estimateTokens(input.contextMd);
  const tokens = BASE_PROMPT_TOKENS + contextTokens + skillTokens;

  const model = findModel(input.modelId);
  const inputPerM = model?.inputPerM ?? null;
  const outputPerM = model?.outputPerM ?? null;

  const perStepUsd =
    ((tokens * (inputPerM ?? 0)) / 1_000_000) +
    ((ASSUMED_OUTPUT_TOKENS_PER_STEP * (outputPerM ?? 0)) / 1_000_000);

  return {
    tokens,
    estimatedCostPerRunUsd: round8(perStepUsd * ASSUMED_STEPS),
    breakdown: {
      baseTokens: BASE_PROMPT_TOKENS,
      contextTokens,
      skillTokens,
      skills: perSkill,
      assumedSteps: ASSUMED_STEPS,
      assumedOutputTokensPerStep: ASSUMED_OUTPUT_TOKENS_PER_STEP,
      inputPerM,
      outputPerM,
      modelId: input.modelId,
      modelKnown: model !== undefined,
    },
  };
}

function round8(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}
