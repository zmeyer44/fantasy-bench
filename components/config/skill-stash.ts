/**
 * A one-shot handoff between the config editor and the skill composer, which
 * live on separate pages.
 *
 * Leaving the editor to author a skill would otherwise drop the working draft,
 * so the editor stashes it on the way out, the composer
 * appends whatever it publishes, and the editor consumes the stash when it
 * mounts again. Like the markdown editor's drafts, this is a convenience: if
 * sessionStorage is unavailable the handoff is best-effort.
 */
import type { HarnessSettings } from "@/convex/lib/config_pure";
import type { AttachedSkill } from "./skill-picker";

const PREFIX = "fb:config-draft:v1:";

export type ConfigDraft = {
  contextMd: string;
  modelId: string;
  harness: HarnessSettings;
  skills: AttachedSkill[];
  note: string;
  changeSummary: string;
};

type SkillStash = {
  /** The editor draft, or null when the composer was opened directly. */
  draft: ConfigDraft | null;
  /** Skills published by the composer since the stash was written. */
  added: AttachedSkill[];
};

/** `leagueId:teamId` — one draft per team per tab. */
export function skillStashKey(leagueId: string, teamId: string): string {
  return `${PREFIX}${leagueId}:${teamId}`;
}

function read(key: string): SkillStash | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SkillStash;
    return Array.isArray(parsed.added) ? parsed : null;
  } catch {
    return null;
  }
}

function write(key: string, stash: SkillStash) {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(stash));
  } catch {
    /* quota or private mode: the handoff is best-effort */
  }
}

/** Editor → composer: remember every unsaved field before navigating away. */
export function stashConfigDraft(key: string, draft: ConfigDraft) {
  write(key, { draft, added: read(key)?.added ?? [] });
}

/** Composer → editor: a newly published skill to attach on the way back. */
export function stashPublishedSkill(key: string, skill: AttachedSkill) {
  const stash = read(key);
  write(key, { draft: stash?.draft ?? null, added: [...(stash?.added ?? []), skill] });
}

/**
 * Consume the stash and fold it into the list the editor is showing. Returns
 * null when there is nothing to restore, so the caller can leave state alone.
 */
export function takeStashedConfigDraft(
  key: string,
  current: AttachedSkill[],
): { draft: ConfigDraft | null; skills: AttachedSkill[] } | null {
  const stash = read(key);
  if (!stash) return null;
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    /* ignore */
  }

  const seen = new Set<string>();
  const out: AttachedSkill[] = [];
  for (const skill of [...(stash.draft?.skills ?? current), ...stash.added]) {
    if (seen.has(skill.id)) continue;
    seen.add(skill.id);
    out.push(skill);
  }
  return { draft: stash.draft, skills: out };
}
