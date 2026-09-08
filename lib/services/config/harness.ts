/**
 * Harness settings: parse, normalise, validate.
 *
 * Stored versions carry a free-form jsonb blob, so every read goes through
 * `parseHarness`, which is total — it never throws and always yields a complete
 * `HarnessSettings`. Saves go through `validateHarness`, which is strict and
 * reports every violated league bound at once.
 */
import { z } from "zod";

import { DEFAULT_HARNESS, type ReasoningEffort } from "@/lib/db/schema";
import { findModel } from "@/lib/models";

export type HarnessSettings = {
  maxSteps: number;
  tokenBudget: number;
  temperature: number;
  reasoningEffort?: ReasoningEffort | null;
  deliberateMode: boolean;
};

/** Defaults applied to a partial or missing harness blob — the schema's `DEFAULT_HARNESS`. */
export const DEFAULT_HARNESS_SETTINGS: HarnessSettings = { ...DEFAULT_HARNESS };

/** Absolute platform bounds (PRD 5.4). League rules narrow these further. */
export const MAX_STEPS_FLOOR = 1;
export const MAX_STEPS_CEILING = 30;
export const TEMPERATURE_MIN = 0;
export const TEMPERATURE_MAX = 2;
export const TOKEN_BUDGET_MIN = 1_000;
export const TOKEN_BUDGET_MAX = 2_000_000;

export const REASONING_EFFORTS = ["low", "medium", "high"] as const;

/** Strict input schema for the save path. Bounds against league rules happen after. */
export const harnessInputSchema = z.object({
  maxSteps: z.number().int().min(MAX_STEPS_FLOOR).max(MAX_STEPS_CEILING),
  tokenBudget: z.number().int().min(TOKEN_BUDGET_MIN).max(TOKEN_BUDGET_MAX),
  temperature: z.number().min(TEMPERATURE_MIN).max(TEMPERATURE_MAX),
  reasoningEffort: z.enum(REASONING_EFFORTS).nullish(),
  deliberateMode: z.boolean(),
});

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Total: turn whatever is in the jsonb column into a complete, in-bounds
 * `HarnessSettings`. Unknown keys are dropped; out-of-range numbers are clamped.
 */
export function parseHarness(value: unknown): HarnessSettings {
  const raw = (value ?? {}) as Record<string, unknown>;
  const effort = raw.reasoningEffort;
  return {
    maxSteps: Math.round(
      clamp(num(raw.maxSteps, DEFAULT_HARNESS_SETTINGS.maxSteps), MAX_STEPS_FLOOR, MAX_STEPS_CEILING),
    ),
    tokenBudget: Math.round(
      clamp(
        num(raw.tokenBudget, DEFAULT_HARNESS_SETTINGS.tokenBudget),
        TOKEN_BUDGET_MIN,
        TOKEN_BUDGET_MAX,
      ),
    ),
    temperature: clamp(
      num(raw.temperature, DEFAULT_HARNESS_SETTINGS.temperature),
      TEMPERATURE_MIN,
      TEMPERATURE_MAX,
    ),
    reasoningEffort:
      typeof effort === "string" && (REASONING_EFFORTS as readonly string[]).includes(effort)
        ? (effort as ReasoningEffort)
        : null,
    deliberateMode: raw.deliberateMode === true,
  };
}

/** True when the model catalog says this id supports reasoning effort / extended thinking. */
export function modelSupportsReasoning(modelId: string): boolean {
  return findModel(modelId)?.supportsReasoning === true;
}
