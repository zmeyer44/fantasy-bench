/**
 * The model catalog.
 *
 * IDs are Vercel AI Gateway IDs and are always pinned — "latest" aliases are
 * not permitted (PRD 5.1, 7). `mock/*` runs a scripted mock model so dev and
 * tests never need a gateway key.
 *
 * Prices and capability flags were taken from the gateway's own model list
 * (`GET https://ai-gateway.vercel.sh/v1/models`) on 2026-09-09. They are seeded
 * into `model_prices` with an `effective_from` so a correction is just a new
 * row. Cost is computed from this table unless the gateway reports a figure
 * directly.
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
  /** The gateway accepts a `reasoning` effort parameter for this model. */
  supportsReasoning: boolean;
  /**
   * The gateway accepts a `temperature` parameter for this model. Several
   * frontier models reject it outright, so the runtime omits it when false.
   */
  supportsTemperature: boolean;
};

export const MODEL_CATALOG: readonly ModelCatalogEntry[] = [
  {
    modelId: "anthropic/claude-opus-5",
    provider: "anthropic",
    displayName: "Claude Opus 5",
    inputPerM: 5,
    outputPerM: 25,
    cachedInputPerM: 0.5,
    reasoningPerM: null,
    supportsReasoning: true,
    supportsTemperature: false,
  },
  {
    modelId: "anthropic/claude-fable-5.1",
    provider: "anthropic",
    displayName: "Claude Fable 5.1",
    inputPerM: 10,
    outputPerM: 50,
    cachedInputPerM: 0.25,
    reasoningPerM: null,
    supportsReasoning: true,
    supportsTemperature: true,
  },
  {
    modelId: "openai/gpt-6-astra",
    provider: "openai",
    displayName: "GPT-6 Astra",
    inputPerM: 10,
    outputPerM: 50,
    cachedInputPerM: 1,
    reasoningPerM: null,
    supportsReasoning: true,
    supportsTemperature: false,
  },
  {
    modelId: "openai/gpt-5.6-terra",
    provider: "openai",
    displayName: "GPT-5.6 Terra",
    inputPerM: 2,
    outputPerM: 12,
    cachedInputPerM: 0.2,
    reasoningPerM: null,
    supportsReasoning: true,
    supportsTemperature: true,
  },
  {
    modelId: "openai/gpt-5.6-sol",
    provider: "openai",
    displayName: "GPT-5.6 Sol",
    inputPerM: 2,
    outputPerM: 10,
    cachedInputPerM: 0.2,
    reasoningPerM: null,
    supportsReasoning: true,
    supportsTemperature: true,
  },
  {
    modelId: "google/gemini-3.8-flash",
    provider: "google",
    displayName: "Gemini 3.8 Flash",
    inputPerM: 0.75,
    outputPerM: 3.75,
    cachedInputPerM: 0.075,
    reasoningPerM: null,
    supportsReasoning: true,
    supportsTemperature: true,
  },
  {
    modelId: "deepseek/deepseek-v4.1-flash-beta",
    provider: "deepseek",
    displayName: "DeepSeek V4.1 Flash",
    inputPerM: 0.22,
    outputPerM: 0.66,
    cachedInputPerM: 0.007,
    reasoningPerM: null,
    supportsReasoning: true,
    supportsTemperature: true,
  },
  {
    modelId: "inception/mercury-2.5",
    provider: "inception",
    displayName: "Mercury 2.5",
    inputPerM: 0.04,
    outputPerM: 0.15,
    cachedInputPerM: 0.004,
    reasoningPerM: null,
    supportsReasoning: true,
    supportsTemperature: true,
  },
  {
    modelId: "zai/glm-5.3",
    provider: "zai",
    displayName: "GLM 5.3",
    inputPerM: 1.4,
    outputPerM: 4.4,
    cachedInputPerM: 0.14,
    reasoningPerM: null,
    supportsReasoning: true,
    supportsTemperature: true,
  },
  {
    modelId: "alibaba/qwen3.8-max-0902",
    provider: "alibaba",
    displayName: "Qwen 3.8 Max",
    inputPerM: 2,
    outputPerM: 6,
    cachedInputPerM: 0.25,
    reasoningPerM: null,
    supportsReasoning: true,
    supportsTemperature: true,
  },
  {
    modelId: "meta/muse-spark-1.3",
    provider: "meta",
    displayName: "Muse Spark 1.3",
    inputPerM: 1.25,
    outputPerM: 4.25,
    cachedInputPerM: 0.15,
    reasoningPerM: null,
    supportsReasoning: true,
    supportsTemperature: true,
  },
  {
    modelId: "spacexai/grok-4.6",
    provider: "spacexai",
    displayName: "Grok 4.6",
    inputPerM: 2,
    outputPerM: 6,
    cachedInputPerM: 0.5,
    reasoningPerM: null,
    supportsReasoning: true,
    supportsTemperature: true,
  },
  {
    modelId: "moonshotai/kimi-k3",
    provider: "moonshotai",
    displayName: "Kimi K3",
    inputPerM: 3,
    outputPerM: 15,
    cachedInputPerM: 0.3,
    reasoningPerM: null,
    supportsReasoning: true,
    supportsTemperature: false,
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
    supportsTemperature: true,
  },
] as const;

/** Default commissioner allowlist for a new league. */
export const DEFAULT_MODEL_ALLOWLIST: string[] = MODEL_CATALOG.map((m) => m.modelId);

/** The model a fresh agent config starts on. */
export const DEFAULT_MODEL_ID = "openai/gpt-5.6-terra";

/** Cheap, always-available model used when the primary provider fails. */
export const DEFAULT_FALLBACK_MODEL_ID = "google/gemini-3.8-flash";

export function findModel(modelId: string): ModelCatalogEntry | undefined {
  return MODEL_CATALOG.find((m) => m.modelId === modelId);
}

/** Whether the gateway accepts `temperature` for this model (unknown ids: yes). */
export function modelSupportsTemperature(modelId: string): boolean {
  return findModel(modelId)?.supportsTemperature ?? true;
}
