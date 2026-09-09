/**
 * The model catalog.
 *
 * IDs are Vercel AI Gateway IDs and are always pinned — "latest" aliases are
 * not permitted (PRD 5.1, 7). `mock/*` runs a scripted mock model so dev and
 * tests never need a gateway key.
 *
 * Prices and capability flags were taken from the gateway's own model list
 * (`GET https://ai-gateway.vercel.sh/v1/models`) on 2026-09-09, and the
 * OpenRouter ids from `GET https://openrouter.ai/api/v1/models` the same day
 * (a few vendors use a different slug there: `z-ai`, `qwen`, `x-ai`). Both are
 * public and need no key. Prices are the gateway's; OpenRouter's differ by a
 * few percent, and a run on an OpenRouter key records the figure OpenRouter
 * itself reports. They are seeded
 * into `model_prices` with an `effective_from` so a correction is just a new
 * row. Cost is computed from this table unless the gateway reports a figure
 * directly.
 */
import type { KeyProvider } from "./key-providers";

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
  /**
   * The model may only run on a team's own gateway key, never the league's
   * shared one. Set on the most expensive tier of the catalog so a single
   * team cannot drain the commissioner's budget.
   */
  requiresOwnKey: boolean;
  /**
   * The same model's id on OpenRouter, for teams whose own key is an OpenRouter
   * key. Null when OpenRouter does not serve the model: such a team must pick
   * another model (the editor and `configs.save` both say so).
   */
  openRouterModelId: string | null;
  /** Native API id for direct Anthropic/OpenAI keys; absent for other vendors. */
  directModelId?: string;
};

export const MODEL_CATALOG: readonly ModelCatalogEntry[] = [
  {
    modelId: "openai/gpt-5.6-terra",
    directModelId: "gpt-5.6-terra",
    openRouterModelId: "openai/gpt-5.6-terra",
    provider: "openai",
    displayName: "GPT-5.6 Terra",
    inputPerM: 2,
    outputPerM: 12,
    cachedInputPerM: 0.2,
    reasoningPerM: null,
    supportsReasoning: true,
    supportsTemperature: true,
    requiresOwnKey: false,
  },
  {
    modelId: "anthropic/claude-opus-5",
    directModelId: "claude-opus-5",
    openRouterModelId: "anthropic/claude-opus-5",
    provider: "anthropic",
    displayName: "Claude Opus 5",
    inputPerM: 5,
    outputPerM: 25,
    cachedInputPerM: 0.5,
    reasoningPerM: null,
    supportsReasoning: true,
    supportsTemperature: false,
    requiresOwnKey: true,
  },
  {
    modelId: "anthropic/claude-fable-5.1",
    directModelId: "claude-fable-5-1",
    openRouterModelId: "anthropic/claude-fable-5.1",
    provider: "anthropic",
    displayName: "Claude Fable 5.1",
    inputPerM: 10,
    outputPerM: 50,
    cachedInputPerM: 0.25,
    reasoningPerM: null,
    supportsReasoning: true,
    supportsTemperature: true,
    requiresOwnKey: true,
  },
  {
    modelId: "openai/gpt-6-astra",
    directModelId: "gpt-6-astra",
    openRouterModelId: "openai/gpt-6-astra",
    provider: "openai",
    displayName: "GPT-6 Astra",
    inputPerM: 10,
    outputPerM: 50,
    cachedInputPerM: 1,
    reasoningPerM: null,
    supportsReasoning: true,
    supportsTemperature: false,
    requiresOwnKey: true,
  },
  {
    modelId: "openai/gpt-5.6-sol",
    directModelId: "gpt-5.6-sol",
    openRouterModelId: "openai/gpt-5.6-sol",
    provider: "openai",
    displayName: "GPT-5.6 Sol",
    inputPerM: 2,
    outputPerM: 10,
    cachedInputPerM: 0.2,
    reasoningPerM: null,
    supportsReasoning: true,
    supportsTemperature: true,
    requiresOwnKey: false,
  },
  {
    modelId: "google/gemini-3.8-flash",
    openRouterModelId: "google/gemini-3.8-flash",
    provider: "google",
    displayName: "Gemini 3.8 Flash",
    inputPerM: 0.75,
    outputPerM: 3.75,
    cachedInputPerM: 0.075,
    reasoningPerM: null,
    supportsReasoning: true,
    supportsTemperature: true,
    requiresOwnKey: false,
  },
  {
    modelId: "deepseek/deepseek-v4.1-flash-beta",
    openRouterModelId: null,
    provider: "deepseek",
    displayName: "DeepSeek V4.1 Flash",
    inputPerM: 0.22,
    outputPerM: 0.66,
    cachedInputPerM: 0.007,
    reasoningPerM: null,
    supportsReasoning: true,
    supportsTemperature: true,
    requiresOwnKey: false,
  },
  {
    modelId: "inception/mercury-2.5",
    openRouterModelId: "inception/mercury-2.5",
    provider: "inception",
    displayName: "Mercury 2.5",
    inputPerM: 0.04,
    outputPerM: 0.15,
    cachedInputPerM: 0.004,
    reasoningPerM: null,
    supportsReasoning: true,
    supportsTemperature: true,
    requiresOwnKey: false,
  },
  {
    modelId: "zai/glm-5.3",
    openRouterModelId: "z-ai/glm-5.3",
    provider: "zai",
    displayName: "GLM 5.3",
    inputPerM: 1.4,
    outputPerM: 4.4,
    cachedInputPerM: 0.14,
    reasoningPerM: null,
    supportsReasoning: true,
    supportsTemperature: true,
    requiresOwnKey: false,
  },
  {
    modelId: "alibaba/qwen3.8-max-0902",
    openRouterModelId: "qwen/qwen3.8-max-0902",
    provider: "alibaba",
    displayName: "Qwen 3.8 Max",
    inputPerM: 2,
    outputPerM: 6,
    cachedInputPerM: 0.25,
    reasoningPerM: null,
    supportsReasoning: true,
    supportsTemperature: true,
    requiresOwnKey: false,
  },
  {
    modelId: "meta/muse-spark-1.3",
    openRouterModelId: "meta/muse-spark-1.3",
    provider: "meta",
    displayName: "Muse Spark 1.3",
    inputPerM: 1.25,
    outputPerM: 4.25,
    cachedInputPerM: 0.15,
    reasoningPerM: null,
    supportsReasoning: true,
    supportsTemperature: true,
    requiresOwnKey: false,
  },
  {
    modelId: "spacexai/grok-4.6",
    openRouterModelId: "x-ai/grok-4.6",
    provider: "spacexai",
    displayName: "Grok 4.6",
    inputPerM: 2,
    outputPerM: 6,
    cachedInputPerM: 0.5,
    reasoningPerM: null,
    supportsReasoning: true,
    supportsTemperature: true,
    requiresOwnKey: false,
  },
  {
    modelId: "moonshotai/kimi-k3",
    openRouterModelId: "moonshotai/kimi-k3",
    provider: "moonshotai",
    displayName: "Kimi K3",
    inputPerM: 3,
    outputPerM: 15,
    cachedInputPerM: 0.3,
    reasoningPerM: null,
    supportsReasoning: true,
    supportsTemperature: false,
    requiresOwnKey: false,
  },
  {
    modelId: "mock/scripted",
    openRouterModelId: null,
    provider: "mock",
    displayName: "Scripted Mock",
    inputPerM: 0,
    outputPerM: 0,
    cachedInputPerM: 0,
    reasoningPerM: 0,
    supportsReasoning: false,
    supportsTemperature: true,
    requiresOwnKey: false,
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

/**
 * The model a league hands to a team that has not chosen one: the first
 * allowlisted model that runs on the league's shared key. A key-gated model
 * at the head of the allowlist is skipped, since a fresh team has no key;
 * with nothing else allowlisted the first entry wins, and an empty allowlist
 * means the platform default.
 */
export function leagueDefaultModelId(allowlist: readonly string[] | null | undefined): string {
  if (!allowlist || allowlist.length === 0) return DEFAULT_MODEL_ID;
  return allowlist.find((id) => !modelRequiresOwnKey(id)) ?? allowlist[0];
}

/** The model's OpenRouter id, or null when OpenRouter does not serve it (or the id is unknown). */
export function openRouterModelIdFor(modelId: string): string | null {
  return findModel(modelId)?.openRouterModelId ?? null;
}

export function directModelIdFor(modelId: string, provider: "anthropic" | "openai"): string | null {
  const model = findModel(modelId);
  return model?.provider === provider ? model.directModelId ?? null : null;
}

/**
 * Whether a team whose own key comes from `keyProvider` can run this model.
 * Every catalog model runs on a Vercel AI Gateway key; OpenRouter serves most
 * of them under an id of its own. Mock models never reach a provider.
 */
export function modelAvailableOnKeyProvider(modelId: string, keyProvider: KeyProvider): boolean {
  if (modelId.startsWith("mock/")) return true;
  if (keyProvider === "openrouter") return openRouterModelIdFor(modelId) !== null;
  if (keyProvider === "anthropic" || keyProvider === "openai") return directModelIdFor(modelId, keyProvider) !== null;
  return true;
}

/** Whether the model may only run on a team's own gateway key (unknown ids: no). */
export function modelRequiresOwnKey(modelId: string): boolean {
  return findModel(modelId)?.requiresOwnKey ?? false;
}

/** Whether the gateway accepts `temperature` for this model (unknown ids: yes). */
export function modelSupportsTemperature(modelId: string): boolean {
  return findModel(modelId)?.supportsTemperature ?? true;
}

/** Effort settings supported by both the model and the app's harness schema. */
export function modelReasoningEfforts(modelId: string): readonly ("low" | "medium" | "high")[] {
  if (!findModel(modelId)?.supportsReasoning) return [];
  // Gateway advertises low/high/max for GLM; max is outside our harness schema.
  if (modelId === "zai/glm-5.3") return ["low", "high"];
  return ["low", "medium", "high"];
}

export function modelSupportsReasoningEffort(modelId: string, effort: string): boolean {
  return modelReasoningEfforts(modelId).some((supported) => supported === effort);
}
