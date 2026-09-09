/**
 * Pure view-model helpers for the agent editor's Tools tab: merge a version's
 * overrides onto the catalog, count what is on, and label window scopes.
 * No React, no Convex — unit-tested in `tool-model.test.ts`.
 */
import {
  ALL_WINDOWS,
  TOOL_CATALOG,
  isDefaultOverride,
  type ToolCatalogEntry,
  type ToolOverride,
  type ToolWindow,
} from "@/convex/runtime/tools/catalog";

export type ToolRow = ToolCatalogEntry & {
  enabled: boolean;
  guidance: string;
  /** True when the override differs from the default contract. */
  customized: boolean;
};

const WINDOW_LABELS: Record<ToolWindow, string> = {
  lineup: "Lineup",
  waiver: "Waivers",
  trade: "Trades",
  draft: "Draft",
  forum: "Forum",
  commissioner: "Commissioner",
};

export function windowLabel(window: ToolWindow): string {
  return WINDOW_LABELS[window];
}

/** "All windows", "All team windows" or the explicit list. */
export function availabilityLabel(windows: readonly ToolWindow[]): string {
  if (windows.length === ALL_WINDOWS.length) return "All windows";
  const teamOnly = ALL_WINDOWS.filter((w) => w !== "commissioner");
  if (windows.length === teamOnly.length && teamOnly.every((w) => windows.includes(w))) {
    return "All team windows";
  }
  return windows.map(windowLabel).join(" · ");
}

/** Every default tool with the draft's override applied, in catalog order. */
export function toolRows(overrides: readonly ToolOverride[]): ToolRow[] {
  const byName = new Map(overrides.map((o) => [o.name, o]));
  return TOOL_CATALOG.map((entry) => {
    const override = byName.get(entry.name);
    const enabled = entry.locked ? true : (override?.enabled ?? true);
    const guidance = override?.guidance?.trim() ?? "";
    return {
      ...entry,
      enabled,
      guidance,
      customized: !enabled || guidance.length > 0,
    };
  });
}

/** Replace one tool's override, dropping it when it returns to the default. */
export function setOverride(
  overrides: readonly ToolOverride[],
  next: ToolOverride,
): ToolOverride[] {
  const rest = overrides.filter((o) => o.name !== next.name);
  const guidance = next.guidance?.trim();
  const cleaned: ToolOverride = {
    name: next.name,
    enabled: next.enabled,
    ...(guidance ? { guidance } : {}),
  };
  return isDefaultOverride(cleaned) ? rest : [...rest, cleaned];
}

export type ToolCounts = {
  defaults: number;
  enabled: number;
  disabled: number;
  guided: number;
};

export function toolCounts(overrides: readonly ToolOverride[]): ToolCounts {
  const rows = toolRows(overrides);
  return {
    defaults: rows.length,
    enabled: rows.filter((r) => r.enabled).length,
    disabled: rows.filter((r) => !r.enabled).length,
    guided: rows.filter((r) => r.enabled && r.guidance).length,
  };
}

/** True when two override lists describe the same customisation. */
export function sameOverrides(a: readonly ToolOverride[], b: readonly ToolOverride[]): boolean {
  const key = (list: readonly ToolOverride[]) =>
    [...list]
      .map((o) => `${o.name}|${o.enabled ? 1 : 0}|${o.guidance?.trim() ?? ""}`)
      .sort()
      .join("\n");
  return key(a) === key(b);
}
