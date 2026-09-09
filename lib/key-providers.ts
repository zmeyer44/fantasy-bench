/**
 * The vendors a team may bring its own key from (BYOK).
 *
 * Shared by the Convex functions (validation, verification, model resolution)
 * and the client (the key form and the model picker). Adding a provider means
 * a new entry here, a verification probe in `convex/gateway_keys.ts`, a client
 * factory in `convex/runtime/model.ts`, and per-model ids in `lib/models.ts`.
 */
export type KeyProvider = "vercel" | "openrouter" | "anthropic" | "openai";

export const KEY_PROVIDERS: readonly KeyProvider[] = ["vercel", "openrouter", "anthropic", "openai"];

/** Rows without a `provider` predate OpenRouter support and are Vercel keys. */
export const DEFAULT_KEY_PROVIDER: KeyProvider = "vercel";

export type KeyProviderInfo = {
  id: KeyProvider;
  /** Short name for badges and select options. */
  label: string;
  /** Longer name for form labels and copy. */
  name: string;
  /** What a key from this vendor looks like; shown as the input placeholder. */
  placeholder: string;
  /** Prefix its keys carry today, used only to catch a key pasted into the wrong slot. */
  keyPrefix: string;
  /** Where the owner creates one. */
  consoleUrl: string;
};

export const KEY_PROVIDER_INFO: Record<KeyProvider, KeyProviderInfo> = {
  vercel: {
    id: "vercel",
    label: "Vercel AI Gateway",
    name: "Vercel AI Gateway",
    placeholder: "vck_…",
    keyPrefix: "vck_",
    consoleUrl: "https://vercel.com/ai-gateway",
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    name: "OpenRouter",
    placeholder: "sk-or-v1-…",
    keyPrefix: "sk-or-",
    consoleUrl: "https://openrouter.ai/keys",
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    name: "Anthropic",
    placeholder: "sk-ant-…",
    keyPrefix: "sk-ant-",
    consoleUrl: "https://platform.claude.com/settings/keys",
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    name: "OpenAI",
    placeholder: "sk-proj-…",
    keyPrefix: "sk-",
    consoleUrl: "https://platform.openai.com/api-keys",
  },
};

/** The provider of a stored key row; rows without one predate OpenRouter support. */
export function keyProviderOf(row: { provider?: KeyProvider | null }): KeyProvider {
  return row.provider ?? DEFAULT_KEY_PROVIDER;
}

export function isKeyProvider(value: unknown): value is KeyProvider {
  return typeof value === "string" && (KEY_PROVIDERS as readonly string[]).includes(value);
}

/**
 * The provider whose key prefix the pasted value carries, if it is one we
 * recognise. Used to tell an owner they pasted a Vercel key into the
 * OpenRouter slot (or vice versa) before we bother the vendor with it.
 */
export function keyProviderFromPrefix(apiKey: string): KeyProvider | null {
  // OpenAI's generic sk- prefix overlaps both Anthropic and OpenRouter.
  const providers = Object.values(KEY_PROVIDER_INFO).sort((a, b) => b.keyPrefix.length - a.keyPrefix.length);
  for (const info of providers) {
    if (apiKey.startsWith(info.keyPrefix)) return info.id;
  }
  return null;
}
