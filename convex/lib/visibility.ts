/**
 * The customisation cooldown.
 *
 * An owner's edge — context, skills, tool overrides, custom tools — stays private
 * for three weeks and then becomes public, so the league can learn from what
 * worked without anyone being copied the same week they tried something.
 *
 * Two clocks, one rule:
 *  - a config version reveals `COOLDOWN_MS` after it was saved (history pages);
 *  - a run's owner-specific prompt material and custom-tool calls reveal
 *    `COOLDOWN_MS` after the run was created (trace pages). A run always
 *    post-dates its version, so this is never earlier than the version's reveal,
 *    and it also covers custom tools, which are not versioned.
 *
 * The team owner and the league commissioner always see everything. Pure: no
 * Convex context, so the UI shares the same helpers.
 */
import type { PromptSection } from "../runtime/types";

export const COOLDOWN_DAYS = 21;
export const COOLDOWN_MS = COOLDOWN_DAYS * 24 * 60 * 60 * 1000;

/** Epoch ms at which something saved at `createdAt` becomes public. */
export function revealAtFor(createdAt: number): number {
  return createdAt + COOLDOWN_MS;
}

/** True while the cooldown is still running for a viewer without private access. */
export function isPrivateAt(createdAt: number, nowMs: number, canSeePrivate: boolean): boolean {
  if (canSeePrivate) return false;
  return nowMs < revealAtFor(createdAt);
}

/** The placeholder shown wherever redacted text would have been. */
export function privatePlaceholder(revealAt: number): string {
  return `[private until ${new Date(revealAt).toISOString().slice(0, 10)} — the owner's customisations reveal ${COOLDOWN_DAYS} days after they are made]`;
}

/** Prompt section ids that carry owner-authored material. */
export const OWNER_SECTION_IDS = new Set(["owner_context", "skills", "note_to_agent"]);

/** Strip the owner guidance suffixes and custom-tool lines from the tool list. */
export function redactPlatformText(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^- custom_[a-z0-9_-]+/i.test(line))
    .map((line) => line.replace(/^(- [a-z0-9_]+) — owner guidance: .*$/i, "$1"))
    .join("\n");
}

/**
 * The stored prompt sections as a viewer without private access may see them.
 * Sizes stay (how much an owner wrote is not a secret); the words go.
 */
export function redactPromptSections(sections: PromptSection[], revealAt: number): PromptSection[] {
  return sections.map((section) => {
    if (OWNER_SECTION_IDS.has(section.id)) {
      return { ...section, text: privatePlaceholder(revealAt) };
    }
    if (section.id === "platform") {
      return { ...section, text: redactPlatformText(section.text) };
    }
    return section;
  });
}

export const CUSTOM_TOOL_PREFIX = "custom_";
export const PRIVATE_TOOL_NAME = "custom tool (private)";

function isCustomToolName(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(CUSTOM_TOOL_PREFIX);
}

/** Tool calls with custom-tool names and arguments blanked. */
export function redactToolCalls(calls: unknown[], revealAt: number): unknown[] {
  return calls.map((call) => {
    if (!call || typeof call !== "object") return call;
    const record = call as Record<string, unknown>;
    if (!isCustomToolName(record.toolName)) return call;
    return {
      ...record,
      toolName: PRIVATE_TOOL_NAME,
      input: { private: privatePlaceholder(revealAt) },
      args: undefined,
    };
  });
}

/** Tool results for custom tools replaced by the placeholder; payload refs dropped. */
export function redactToolResults(results: unknown[], revealAt: number): unknown[] {
  return results.map((result) => {
    if (!result || typeof result !== "object") return result;
    const record = result as Record<string, unknown>;
    if (!isCustomToolName(record.toolName)) return result;
    return {
      toolCallId: record.toolCallId,
      toolName: PRIVATE_TOOL_NAME,
      output: { private: privatePlaceholder(revealAt) },
    };
  });
}
