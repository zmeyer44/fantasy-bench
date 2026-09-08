/**
 * Ledger arithmetic (PRD §5.9), with no database in it.
 *
 * This is the port of the pure half of `lib/services/ledger/index.ts` plus
 * `getModelPrice`'s catalog fallback from `lib/agent/model.ts`. The database
 * half — resolving the effective `model_prices` row and folding the result into
 * the three rollup tables — lives in `convex/ledger.ts`; everything here is a
 * function of its arguments so the cost math can be unit-tested and reused by
 * the runtime's pre-flight budget check without a `ctx`.
 */
import { findModel } from "../../lib/models";

export type ResolvedModelPrice = {
  modelId: string;
  provider: string;
  displayName: string;
  /** USD per 1M tokens. */
  inputPerM: number;
  outputPerM: number;
  cachedInputPerM: number | null;
  reasoningPerM: number | null;
  supportsReasoning: boolean;
  source: "model_prices" | "catalog" | "unknown";
};

/**
 * The old column was `numeric(14, 8)`; every figure the ledger stores is rounded
 * to 8 decimals so a read of a rollup equals the sum of the writes exactly.
 */
export function round8(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1e8) / 1e8;
}

/** `anthropic/claude-sonnet-4.5` → `anthropic`; unknown shapes → `unknown`. */
export function providerOf(modelId: string, price?: ResolvedModelPrice | null): string {
  if (price?.provider) return price.provider;
  const slash = modelId.indexOf("/");
  return slash > 0 ? modelId.slice(0, slash) : "unknown";
}

/**
 * The catalog price for `modelId`, or a zero price when the model is not
 * catalogued (`mock/*`, a custom provider, a model added since the last deploy).
 *
 * A zero price never aborts a run: the ledger records $0 for the computed figure
 * and the gateway's own number, when it reports one, still wins.
 */
export function catalogPrice(modelId: string): ResolvedModelPrice {
  const entry = findModel(modelId);
  if (entry) {
    return {
      modelId: entry.modelId,
      provider: entry.provider,
      displayName: entry.displayName,
      inputPerM: entry.inputPerM,
      outputPerM: entry.outputPerM,
      cachedInputPerM: entry.cachedInputPerM,
      reasoningPerM: entry.reasoningPerM,
      supportsReasoning: entry.supportsReasoning,
      source: "catalog",
    };
  }
  return {
    modelId,
    provider: providerOf(modelId),
    displayName: "Unknown model",
    inputPerM: 0,
    outputPerM: 0,
    cachedInputPerM: 0,
    reasoningPerM: null,
    supportsReasoning: false,
    source: "unknown",
  };
}

export type CostInput = {
  price: ResolvedModelPrice;
  /** TOTAL input tokens for the step, cached ones included. */
  inputTokens: number;
  outputTokens: number;
  /** Subset of `inputTokens` served from the provider's prompt cache. */
  cachedInputTokens?: number;
  /** Subset of `outputTokens` spent on reasoning, where the provider reports it. */
  reasoningTokens?: number;
};

/**
 * USD for one step from a resolved price book entry.
 *
 * `cachedInputTokens` is billed at the cached rate, falling back to the full
 * input rate when the price book has no cached rate. Reasoning tokens are
 * assumed to be *inside* `outputTokens` — they are only billed separately when
 * the price book carries an explicit `reasoningPerM`, in which case the
 * non-reasoning remainder is billed at the output rate and the reasoning tokens
 * at theirs.
 */
export function computeCostUsd(args: CostInput): number {
  const { price } = args;
  const input = Math.max(0, args.inputTokens);
  const cached = Math.min(Math.max(0, args.cachedInputTokens ?? 0), input);
  const uncached = input - cached;
  const output = Math.max(0, args.outputTokens);
  const reasoning = Math.min(Math.max(0, args.reasoningTokens ?? 0), output);

  const cachedRate = price.cachedInputPerM ?? price.inputPerM;
  let usd = (uncached / 1_000_000) * price.inputPerM + (cached / 1_000_000) * cachedRate;

  if (price.reasoningPerM != null && reasoning > 0) {
    usd += ((output - reasoning) / 1_000_000) * price.outputPerM;
    usd += (reasoning / 1_000_000) * price.reasoningPerM;
  } else {
    usd += (output / 1_000_000) * price.outputPerM;
  }
  return round8(usd);
}

/**
 * Conservative pre-flight estimate for the executor's per-step budget check —
 * the pure replacement for `estimateStepCostUsd`, which used to hit the database
 * for the price on every step. The caller resolves the price once per run
 * (`internal.ledger.remainingBudget` / the run context load) and re-uses it.
 *
 * No cache discount and no reasoning split are assumed: the estimate is meant to
 * be an upper bound on what the next step can cost.
 */
export function estimateNextStepCostUsd(args: {
  price: ResolvedModelPrice;
  inputTokens: number;
  outputTokens: number;
}): number {
  return computeCostUsd({
    price: args.price,
    inputTokens: args.inputTokens,
    outputTokens: args.outputTokens,
  });
}

/** Billable tokens for cap arithmetic: `input + output` (cached/reasoning sit inside them). */
export function billableTokens(usage: { inputTokens: number; outputTokens: number }): number {
  return Math.max(0, Math.round(usage.inputTokens)) + Math.max(0, Math.round(usage.outputTokens));
}
