import { describe, expect, test } from "vitest";

import { TOOL_CATALOG } from "@/convex/runtime/tools/catalog";

import { availabilityLabel, sameOverrides, setOverride, toolCounts, toolRows } from "./tool-model";

describe("tool-model", () => {
  test("toolRows applies overrides and keeps locked tools on", () => {
    const rows = toolRows([
      { name: "get_news", enabled: false },
      { name: "set_rationale", enabled: false },
      { name: "set_lineup", enabled: true, guidance: " floor over ceiling " },
    ]);
    expect(rows).toHaveLength(TOOL_CATALOG.length);
    const byName = new Map(rows.map((r) => [r.name, r]));
    expect(byName.get("get_news")).toMatchObject({ enabled: false, customized: true });
    expect(byName.get("set_rationale")).toMatchObject({ enabled: true, customized: false });
    expect(byName.get("set_lineup")).toMatchObject({
      enabled: true,
      guidance: "floor over ceiling",
      customized: true,
    });
    expect(byName.get("get_forum")).toMatchObject({ enabled: true, customized: false });
  });

  test("setOverride drops entries that return to the default", () => {
    const start = [{ name: "get_news", enabled: false }];
    expect(setOverride(start, { name: "get_news", enabled: true, guidance: "  " })).toEqual([]);
    expect(setOverride(start, { name: "get_forum", enabled: true, guidance: "read it" })).toEqual([
      { name: "get_news", enabled: false },
      { name: "get_forum", enabled: true, guidance: "read it" },
    ]);
  });

  test("toolCounts and sameOverrides", () => {
    const overrides = [
      { name: "get_news", enabled: false },
      { name: "set_lineup", enabled: true, guidance: "x" },
    ];
    expect(toolCounts(overrides)).toEqual({
      defaults: TOOL_CATALOG.length,
      enabled: TOOL_CATALOG.length - 1,
      disabled: 1,
      guided: 1,
    });
    expect(sameOverrides(overrides, [...overrides].reverse())).toBe(true);
    expect(sameOverrides(overrides, [{ name: "get_news", enabled: false }])).toBe(false);
  });

  test("availabilityLabel", () => {
    expect(availabilityLabel(["lineup", "waiver", "trade", "draft", "forum", "commissioner"])).toBe(
      "All windows",
    );
    expect(availabilityLabel(["lineup", "waiver", "trade", "draft", "forum"])).toBe(
      "All team windows",
    );
    expect(availabilityLabel(["lineup"])).toBe("Lineup");
  });
});
