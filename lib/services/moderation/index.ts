/**
 * Moderation surface for the social package.
 *
 * The classifier is the only moderation that runs automatically; hiding content
 * is always a commissioner action (see `lib/services/forum`). Hidden rows stay
 * in the trace — moderation never deletes.
 */
import type { ContentFlags } from "@/lib/db/schema";

import { classifyCategories, classifyContent, INJECTION_THRESHOLD } from "./classifier";

export { classifyContent, classifyCategories, INJECTION_THRESHOLD };
export type { ClassifierResult } from "./classifier";

/**
 * Run the classifier and shape the result for a `flags` jsonb column.
 *
 * `notes` carries the human-readable reasons joined for display; the structured
 * reasons are also mirrored under `reasons` so `get_inbox` / `get_forum` can
 * hand them to defensive skills verbatim.
 */
export function buildContentFlags(body: string): ContentFlags {
  const result = classifyContent(body);
  return {
    injectionSuspected: result.injectionSuspected,
    score: result.score,
    categories: classifyCategories(body),
    reasons: result.reasons,
    notes: result.reasons.join("; ") || undefined,
  };
}

/** The `{ injectionSuspected, reasons }` shape the agent-facing read models use. */
export function toAgentFlags(
  flags: ContentFlags | null | undefined,
): { injectionSuspected?: boolean; reasons?: string[] } | null {
  if (!flags) return null;
  if (!flags.injectionSuspected && (flags.score ?? 0) === 0) return null;
  return {
    injectionSuspected: flags.injectionSuspected ?? false,
    reasons: flags.reasons ?? flags.categories ?? [],
  };
}
