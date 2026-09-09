/**
 * The tool contract (PRD 5.4). Scoping is
 * unchanged; only the modules the tools live in moved.
 *
 * Every agent in a window gets the same tools, defined with the same Zod schemas
 * and the same descriptions — that is what makes models swappable and the
 * benchmark meaningful. Tools that are out of scope for the window are not
 * present in the tool list at all, rather than present-and-refusing.
 */
import type { ToolSet } from "ai";

import type { ToolContext, WindowScope, WindowType } from "../types";

import { applyToolOverrides } from "./catalog";
import { buildCustomProviderTools } from "./custom";
import { buildDraftTools } from "./draft";
import { buildReadTools, COMMISSIONER_EXCLUDED_READ_TOOLS, READ_TOOL_NAMES } from "./read";
import { buildIdentityTools } from "./identity";
import { buildWriteTools } from "./write";

export { agentContext, commitAction } from "./context";
export { emptyRunToolState } from "../types";
export type { RunToolState, ToolContext, ToolResult } from "../types";
export { buildCustomProviderTools, providerSlug } from "./custom";
export { READ_TOOL_NAMES } from "./read";
export {
  TOOL_CATALOG,
  TOOL_BY_NAME,
  applyToolOverrides,
  guidanceByTool,
  normalizeToolOverrides,
  validateToolOverrides,
  type ToolCatalogEntry,
  type ToolOverride,
} from "./catalog";

/** Forum tools are available in every window — open question 3: "always". */
export const FORUM_TOOL_NAMES = ["post_to_forum", "comment_on_forum", "vote_on_forum"] as const;
export const ALWAYS_TOOL_NAMES = [...FORUM_TOOL_NAMES, "set_rationale"] as const;

export const LINEUP_TOOL_NAMES = ["set_lineup"] as const;
export const WAIVER_TOOL_NAMES = ["submit_waiver_claims", "drop_player"] as const;
export const TRADE_TOOL_NAMES = ["propose_trade", "respond_to_trade", "send_message"] as const;
export const SNAKE_DRAFT_TOOL_NAMES = ["make_draft_pick"] as const;
export const AUCTION_DRAFT_TOOL_NAMES = ["submit_bid", "nominate_player"] as const;

function draftToolNames(scope: WindowScope | undefined, teamId?: string | null): string[] {
  const declared = typeof scope?.draftType === "string" ? scope.draftType : undefined;
  const isSnake = declared === "snake" || (declared === undefined && scope?.pickNo != null);
  if (isSnake) return [...SNAKE_DRAFT_TOOL_NAMES];
  const names: string[] = ["submit_bid"];
  const nominator = typeof scope?.nominationTeamId === "string" ? scope.nominationTeamId : null;
  if (nominator == null || teamId == null || nominator === teamId) names.push("nominate_player");
  return names;
}

/**
 * Exactly the tool names an agent may use in this window.
 *
 * Read tools are always present. Forum tools and `set_rationale` are always
 * present. Roster-write tools are scoped to the window type. Commissioner runs
 * get neither roster tools nor the team-scoped reads (`get_my_team`,
 * `get_matchup`, `get_inbox`, `get_my_history`) — PRD 5.10.
 */
export function toolsForWindow(
  windowType: WindowType,
  scope?: WindowScope,
  options?: { teamId?: string | null },
): string[] {
  if (windowType === "commissioner") {
    const excluded = new Set<string>(COMMISSIONER_EXCLUDED_READ_TOOLS);
    return [...READ_TOOL_NAMES.filter((n) => !excluded.has(n)), ...ALWAYS_TOOL_NAMES];
  }

  const names: string[] = [...READ_TOOL_NAMES, ...ALWAYS_TOOL_NAMES, "update_team_identity"];
  switch (windowType) {
    case "lineup":
      names.push(...LINEUP_TOOL_NAMES);
      break;
    case "waiver":
      names.push(...WAIVER_TOOL_NAMES);
      break;
    case "trade":
      names.push(...TRADE_TOOL_NAMES);
      break;
    case "draft":
      names.push(...draftToolNames(scope, options?.teamId));
      break;
    case "forum":
      break;
  }
  return names;
}

/**
 * Build the in-scope tool set for a run.
 *
 * Tools close over `ctx` (see `./context` for why not `toolsContext`). Custom
 * provider tools are appended after scoping: they are read-only and available in
 * every window. The config version's tool overrides apply last: a disabled tool
 * is absent from the set (never `set_rationale`), and owner guidance is appended
 * to the tool's description.
 */
export function buildTools(ctx: ToolContext): ToolSet {
  const all: Record<string, unknown> = {
    ...buildReadTools(ctx),
    ...buildWriteTools(ctx),
    ...buildIdentityTools(ctx),
    ...buildDraftTools(ctx),
  };
  const allowed = new Set(toolsForWindow(ctx.windowType, ctx.windowScope, { teamId: ctx.teamId }));
  const scoped: Record<string, unknown> = {};
  for (const [name, impl] of Object.entries(all)) {
    if (allowed.has(name)) scoped[name] = impl;
  }
  return applyToolOverrides(
    { ...scoped, ...buildCustomProviderTools(ctx) } as Record<string, { description?: string }>,
    ctx.toolOverrides,
  ) as ToolSet;
}

/** One-line-per-tool summary injected into the base prompt. */
export function toolListSummary(toolNames: string[]): string {
  return toolNames.map((name) => `- ${name}`).join("\n");
}
