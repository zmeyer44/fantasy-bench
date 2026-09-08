/**
 * The model catalog.
 *
 * IDs are Vercel AI Gateway IDs and are always pinned — "latest" aliases are
 * not permitted (PRD 5.1, 7). `mock/*` runs a scripted mock model so dev and
 * tests never need a gateway key.
 *
 * PRICES ARE ESTIMATES — VERIFY BEFORE PRODUCTION. They are seeded into
 * `model_prices` with an `effective_from` so a correction is just a new row.
 * Cost is computed from this table unless the gateway reports a figure directly.
 */
export type ModelCatalogEntry = {
  modelId: string;
  provider: string;
  displayName: string;
  /** USD per 1M tokens. */
  inputPerM: number;
  outputPerM: number;
  cachedInputPerM: number | null;
  reasoningPerM: number | null;
  supportsReasoning: boolean;
};

export const MODEL_CATALOG: readonly ModelCatalogEntry[] = [
  {
    modelId: "anthropic/claude-sonnet-4.5",
    provider: "anthropic",
    displayName: "Claude Sonnet 4.5",
    inputPerM: 3,
    outputPerM: 15,
    cachedInputPerM: 0.3,
    reasoningPerM: null,
    supportsReasoning: true,
  },
  {
    modelId: "anthropic/claude-opus-4.1",
    provider: "anthropic",
    displayName: "Claude Opus 4.1",
    inputPerM: 15,
    outputPerM: 75,
    cachedInputPerM: 1.5,
    reasoningPerM: null,
    supportsReasoning: true,
  },
  {
    modelId: "anthropic/claude-haiku-4.5",
    provider: "anthropic",
    displayName: "Claude Haiku 4.5",
    inputPerM: 1,
    outputPerM: 5,
    cachedInputPerM: 0.1,
    reasoningPerM: null,
    supportsReasoning: true,
  },
  {
    modelId: "openai/gpt-5",
    provider: "openai",
    displayName: "GPT-5",
    inputPerM: 1.25,
    outputPerM: 10,
    cachedInputPerM: 0.125,
    reasoningPerM: null,
    supportsReasoning: true,
  },
  {
    modelId: "openai/gpt-5-mini",
    provider: "openai",
    displayName: "GPT-5 mini",
    inputPerM: 0.25,
    outputPerM: 2,
    cachedInputPerM: 0.025,
    reasoningPerM: null,
    supportsReasoning: true,
  },
  {
    modelId: "google/gemini-2.5-pro",
    provider: "google",
    displayName: "Gemini 2.5 Pro",
    inputPerM: 1.25,
    outputPerM: 10,
    cachedInputPerM: 0.31,
    reasoningPerM: null,
    supportsReasoning: true,
  },
  {
    modelId: "google/gemini-2.5-flash",
    provider: "google",
    displayName: "Gemini 2.5 Flash",
    inputPerM: 0.3,
    outputPerM: 2.5,
    cachedInputPerM: 0.075,
    reasoningPerM: null,
    supportsReasoning: true,
  },
  {
    modelId: "xai/grok-4",
    provider: "xai",
    displayName: "Grok 4",
    inputPerM: 3,
    outputPerM: 15,
    cachedInputPerM: 0.75,
    reasoningPerM: null,
    supportsReasoning: true,
  },
  {
    modelId: "mock/scripted",
    provider: "mock",
    displayName: "Scripted Mock",
    inputPerM: 0,
    outputPerM: 0,
    cachedInputPerM: 0,
    reasoningPerM: 0,
    supportsReasoning: false,
  },
] as const;

/** Default commissioner allowlist for a new league. */
export const DEFAULT_MODEL_ALLOWLIST: string[] = MODEL_CATALOG.map((m) => m.modelId);

/** The model a fresh agent config starts on. */
export const DEFAULT_MODEL_ID = "anthropic/claude-sonnet-4.5";

/** Cheap, always-available model used when the primary provider fails. */
export const DEFAULT_FALLBACK_MODEL_ID = "anthropic/claude-haiku-4.5";

export function findModel(modelId: string): ModelCatalogEntry | undefined {
  return MODEL_CATALOG.find((m) => m.modelId === modelId);
}
