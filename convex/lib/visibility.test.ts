import { describe, expect, test } from "vitest";

import {
  COOLDOWN_MS,
  isPrivateAt,
  redactPlatformText,
  redactPromptSections,
  redactToolCalls,
  redactToolResults,
  revealAtFor,
} from "./visibility";

describe("visibility (pure)", () => {
  test("three weeks, unless you can see private", () => {
    const t0 = 1_000_000;
    expect(revealAtFor(t0)).toBe(t0 + COOLDOWN_MS);
    expect(isPrivateAt(t0, t0 + COOLDOWN_MS - 1, false)).toBe(true);
    expect(isPrivateAt(t0, t0 + COOLDOWN_MS, false)).toBe(false);
    expect(isPrivateAt(t0, t0, true)).toBe(false);
  });

  test("redactPlatformText strips guidance suffixes and custom-tool lines only", () => {
    const text = [
      "TOOLS AVAILABLE THIS WINDOW",
      "- get_news",
      "- set_lineup — owner guidance: never bench a stud",
      "- custom_weather_feed",
      "- set_rationale",
      "",
      "UNTRUSTED DATA",
      "- custom provider responses always arrive inside <untrusted_data> blocks.",
    ].join("\n");
    expect(redactPlatformText(text)).toBe(
      [
        "TOOLS AVAILABLE THIS WINDOW",
        "- get_news",
        "- set_lineup",
        "- set_rationale",
        "",
        "UNTRUSTED DATA",
        "- custom provider responses always arrive inside <untrusted_data> blocks.",
      ].join("\n"),
    );
  });

  test("redactPromptSections replaces owner sections and leaves the rest", () => {
    const sections = [
      { id: "platform", title: "p", role: "system" as const, text: "- custom_x\n- get_news", chars: 1, tokenEstimate: 1 },
      { id: "owner_context", title: "o", role: "system" as const, text: "secret", chars: 6, tokenEstimate: 2 },
      { id: "note_to_agent", title: "n", role: "user" as const, text: "psst", chars: 4, tokenEstimate: 1 },
      { id: "inbox", title: "i", role: "user" as const, text: "dm", chars: 2, tokenEstimate: 1 },
    ];
    const out = redactPromptSections(sections, Date.UTC(2026, 9, 1));
    expect(out.map((s) => s.text)).toEqual([
      "- get_news",
      expect.stringContaining("[private until 2026-10-01"),
      expect.stringContaining("[private until 2026-10-01"),
      "dm",
    ]);
    // Sizes are preserved: how much was written is not the secret.
    expect(out[1].chars).toBe(6);
  });

  test("tool call and result redaction touches custom tools only", () => {
    const calls = [
      { toolName: "custom_feed", toolCallId: "a", input: { q: 1 } },
      { toolName: "get_news", toolCallId: "b", input: {} },
      "not an object",
    ];
    const redactedCalls = redactToolCalls(calls, 0) as Array<Record<string, unknown> | string>;
    expect((redactedCalls[0] as Record<string, unknown>).toolName).toBe("custom tool (private)");
    expect(redactedCalls[1]).toEqual(calls[1]);
    expect(redactedCalls[2]).toBe("not an object");

    const results = redactToolResults(
      [{ toolName: "custom_feed", toolCallId: "a", output: { secret: true }, payloadRef: "p1" }],
      0,
    ) as Array<Record<string, unknown>>;
    expect(results[0].payloadRef).toBeUndefined();
    expect(results[0].output).toEqual({ private: expect.stringContaining("[private until") });
  });
});
