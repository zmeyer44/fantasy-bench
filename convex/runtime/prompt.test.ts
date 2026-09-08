/**
 * Prompt assembly — the port of `tests/runtime/prompt.test.ts`.
 *
 * `buildPrompt` is pure, so this needs the fixture's snapshot but no database
 * calls beyond building it.
 */
import { beforeAll, describe, expect, test } from "vitest";

import { emptyDigest } from "../../lib/snapshot/types";
import { DEFAULT_HARNESS } from "../lib/defaults";
import { buildPrompt, estimatePromptTokens, estimateTokens, type PromptInput } from "./prompt";
import { toolsForWindow } from "./tools";

import { NOW, WEEK_NO, makeTest, seedFixture, type Fixture } from "./fixtures.test";

function inputFor(fx: Fixture, over: Partial<PromptInput> = {}): PromptInput {
  return {
    window: {
      id: fx.windowId,
      type: "lineup",
      label: "lineup_sun_early",
      weekNo: WEEK_NO,
      roundNo: 1,
      scope: {},
      opensAt: new Date(NOW - 3_600_000),
      submissionDeadlineAt: new Date(NOW + 3_600_000),
      closesAt: new Date(NOW + 5_400_000),
    },
    snapshot: fx.snapshot,
    digest: { ...emptyDigest(), headline: "Week 5 is here." },
    teamId: fx.teamAId,
    teamName: "Team A",
    contextMd: "Prefer high-floor running backs.",
    skills: [
      { name: "bye-week-audit", bodyMd: "Check every starter's bye week.", description: "Byes" },
    ],
    noteToAgent: "You benched my best receiver last week. Don't.",
    harness: { ...DEFAULT_HARNESS },
    toolNames: toolsForWindow("lineup"),
    budget: {
      teamTokensRemaining: 50_000,
      teamTokensUsed: 1_000,
      teamTokenCap: 51_000,
      leagueUsdRemaining: 12.5,
      leagueUsdUsed: 2.5,
      leagueUsdCap: 15,
      leagueCapReached: false,
    },
    inbox: [],
    forum: { posts: [], karma: {} },
    ...over,
  };
}

describe("buildPrompt", () => {
  let fx: Fixture;
  beforeAll(async () => {
    fx = await seedFixture(makeTest());
  });

  test("emits sections in PRD order with char and token counts", () => {
    const prompt = buildPrompt(inputFor(fx));
    expect(prompt.sections.map((s) => s.id)).toEqual([
      "platform",
      "owner_context",
      "skills",
      "snapshot",
      "inbox",
      "forum",
      "note_to_agent",
    ]);
    for (const section of prompt.sections) {
      expect(section.chars).toBe(section.text.length);
      expect(section.tokenEstimate).toBe(estimateTokens(section.text));
    }
    expect(prompt.sections.filter((s) => s.role === "system").map((s) => s.id)).toEqual([
      "platform",
      "owner_context",
      "skills",
    ]);
  });

  test("is deterministic for the same inputs", () => {
    const a = buildPrompt(inputFor(fx));
    const b = buildPrompt(inputFor(fx));
    expect(a.system).toBe(b.system);
    expect(a.user).toBe(b.user);
  });

  test("states the window, the deadline, the budgets and the lock rule", () => {
    const prompt = buildPrompt(inputFor(fx));
    expect(prompt.system).toContain("WINDOW: lineup_sun_early (lineup)");
    expect(prompt.system).toContain("Submission deadline:");
    expect(prompt.system).toContain("PLAYER LOCKS");
    expect(prompt.system).toContain("50,000 remaining this week");
    expect(prompt.system).toContain("$12.50 remaining");
    expect(prompt.system).toContain("UNTRUSTED DATA");
    expect(prompt.system).toContain("PERMITTED in this league");
    for (const name of toolsForWindow("lineup")) {
      expect(prompt.system).toContain(`- ${name}`);
    }
  });

  test("wraps owner context, skills and the note to agent in their own tags", () => {
    const prompt = buildPrompt(inputFor(fx));
    expect(prompt.system).toContain("<owner_context>");
    expect(prompt.system).toContain('<skill name="bye-week-audit" description="Byes">');
    expect(prompt.user).toContain("<note_to_agent>");
  });

  test("summarises the roster and the matchup on the user side", () => {
    const prompt = buildPrompt(inputFor(fx));
    expect(prompt.user).toContain("YOUR TEAM:");
    expect(prompt.user).toContain("Current starters:");
    expect(prompt.user).toContain("Avery Quick");
    expect(prompt.user).toContain("THIS WEEK'S MATCHUP:");
    expect(prompt.user).toContain("INBOX: no direct messages");
    expect(prompt.user).toContain("THE COMMONS: no posts yet.");
  });

  test("changes the scope note for a trade window", () => {
    const base = inputFor(fx);
    const prompt = buildPrompt(
      inputFor(fx, {
        window: { ...base.window, type: "trade", label: "trade_a" },
        toolNames: toolsForWindow("trade"),
      }),
    );
    expect(prompt.system).toContain("This is a TRADE window");
    expect(prompt.system).toContain("- propose_trade");
    expect(prompt.system).not.toContain("- set_lineup");
  });

  test("estimateTokens is chars over four", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    const prompt = buildPrompt(inputFor(fx));
    expect(estimatePromptTokens(prompt)).toBe(
      estimateTokens(prompt.system) + estimateTokens(prompt.user),
    );
  });
});
