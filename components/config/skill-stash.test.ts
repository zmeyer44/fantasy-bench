import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_HARNESS } from "@/convex/lib/defaults";

import type { AttachedSkill } from "./skill-picker";
import {
  type ConfigDraft,
  skillStashKey,
  stashConfigDraft,
  stashPublishedSkill,
  takeStashedConfigDraft,
} from "./skill-stash";

function skill(id: string): AttachedSkill {
  return { id, name: id, slug: id, description: "", bodyMd: `# ${id}` };
}

beforeEach(() => {
  const items = new Map<string, string>();
  vi.stubGlobal("window", {
    sessionStorage: {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => items.set(key, value),
      removeItem: (key: string) => items.delete(key),
    },
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("config draft handoff through the skill composer", () => {
  it.each(["cancel", "publish"])("restores all unsaved fields after %s", (action) => {
    const key = skillStashKey("league", "team");
    const savedSkills = [skill("removed"), skill("first"), skill("second")];
    const draft: ConfigDraft = {
      contextMd: "Unsaved context",
      modelId: "anthropic/claude-opus-5",
      harness: { ...DEFAULT_HARNESS, maxSteps: 7, reasoningEffort: "high", deliberateMode: true },
      skills: [savedSkills[2], savedSkills[1]],
      note: "Unsaved note",
      changeSummary: "Changed the model and instructions",
    };

    stashConfigDraft(key, draft);
    const published = skill("new");
    if (action === "publish") stashPublishedSkill(key, published);

    // The editor remounts with saved data; the handoff must restore the user's
    // draft, including its skill removals and ordering, before the next save.
    expect(takeStashedConfigDraft(key, savedSkills)).toEqual({
      draft,
      skills: action === "publish" ? [...draft.skills, published] : draft.skills,
    });
    expect(takeStashedConfigDraft(key, savedSkills)).toBeNull();
  });

  it("keeps an intentionally empty draft instead of restoring saved attachments", () => {
    const key = skillStashKey("league", "team");
    const draft: ConfigDraft = {
      contextMd: "",
      modelId: "mock/scripted",
      harness: DEFAULT_HARNESS,
      skills: [],
      note: "",
      changeSummary: "",
    };
    stashConfigDraft(key, draft);
    expect(takeStashedConfigDraft(key, [skill("removed")])).toEqual({ draft, skills: [] });
  });

  it("merges a skill from a directly opened composer without replacing saved fields", () => {
    const key = skillStashKey("league", "team");
    const existing = skill("existing");
    const published = skill("new");
    stashPublishedSkill(key, existing);
    stashPublishedSkill(key, published);
    expect(takeStashedConfigDraft(skillStashKey("league", "other-team"), [])).toBeNull();
    expect(takeStashedConfigDraft(key, [existing])).toEqual({
      draft: null,
      skills: [existing, published],
    });
  });
});
