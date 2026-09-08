/**
 * CONTRACT STUB — owned by the agent-runtime package, which replaces this file.
 * Other packages may import these signatures today.
 */
import type { LanguageModel } from "ai";

/**
 * Resolve a pinned gateway model id (e.g. `anthropic/claude-sonnet-4.5`) to an AI SDK model.
 * `mock/*` ids resolve to a scripted mock model that needs no API key.
 */
export function resolveModel(_modelId: string): LanguageModel {
  throw new Error("lib/agent/model.resolveModel not implemented yet (runtime package)");
}

export function isMockModelId(modelId: string): boolean {
  return modelId.startsWith("mock/");
}
