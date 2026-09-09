/**
 * Pure config logic: harness parsing, diffing, prompt estimation and the note block.
 *
 * No Convex context and no database: `convex/configs.ts` does the reads and
 * hands the results in. The `diff` npm package and `lib/models.ts` /
 * `lib/time.ts` are pure and are imported directly.
 *
 * Dates here are epoch milliseconds (`EditLockStatus.nextChange`), not `Date`.
 */
import { structuredPatch } from "diff";

import { KEY_PROVIDER_INFO, type KeyProvider } from "../../lib/key-providers";
import {
  findModel,
  modelAvailableOnKeyProvider,
  modelRequiresOwnKey,
  modelSupportsReasoningEffort,
} from "../../lib/models";
import {
  DEFAULT_EDIT_LOCK,
  WEEKDAYS,
  formatET,
  isWithinEditWindow,
  nextWeekdayAtET,
  weekStartET,
  type EditLock,
  type Weekday,
} from "../../lib/time";

import { DEFAULT_HARNESS, type HarnessSettings } from "./defaults";

export type { HarnessSettings };

// --------------------------------------------------------------------- harness

/** Absolute platform bounds (PRD 5.4). League rules narrow these further. */
export const MAX_STEPS_FLOOR = 1;
export const MAX_STEPS_CEILING = 30;
export const TEMPERATURE_MIN = 0;
export const TEMPERATURE_MAX = 2;
export const TOKEN_BUDGET_MIN = 1_000;
export const TOKEN_BUDGET_MAX = 2_000_000;
export const REASONING_EFFORTS = ["low", "medium", "high"] as const;
/** Maximum skills attachable to one version — a soft guard on prompt blow-up. */
export const MAX_ATTACHED_SKILLS = 12;

export const DEFAULT_HARNESS_SETTINGS: HarnessSettings = { ...DEFAULT_HARNESS };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Total: turn whatever is stored on a version into a complete, in-bounds
 * `HarnessSettings`. Unknown keys are dropped; out-of-range numbers are clamped.
 */
export function parseHarness(value: unknown): HarnessSettings {
  const raw = (value ?? {}) as Record<string, unknown>;
  const effort = raw.reasoningEffort;
  return {
    maxSteps: Math.round(
      clamp(num(raw.maxSteps, DEFAULT_HARNESS_SETTINGS.maxSteps), MAX_STEPS_FLOOR, MAX_STEPS_CEILING),
    ),
    tokenBudget: Math.round(
      clamp(
        num(raw.tokenBudget, DEFAULT_HARNESS_SETTINGS.tokenBudget),
        TOKEN_BUDGET_MIN,
        TOKEN_BUDGET_MAX,
      ),
    ),
    temperature: clamp(
      num(raw.temperature, DEFAULT_HARNESS_SETTINGS.temperature),
      TEMPERATURE_MIN,
      TEMPERATURE_MAX,
    ),
    reasoningEffort:
      typeof effort === "string" && (REASONING_EFFORTS as readonly string[]).includes(effort)
        ? (effort as HarnessSettings["reasoningEffort"])
        : null,
    deliberateMode: raw.deliberateMode === true,
  };
}

/** True when the model catalog says this id supports reasoning effort. */
export function modelSupportsReasoning(modelId: string): boolean {
  return findModel(modelId)?.supportsReasoning === true;
}

// ------------------------------------------------------------------- edit lock

function isWeekday(value: string): value is Weekday {
  return (WEEKDAYS as readonly string[]).includes(value);
}

/** Coerce a stored `editLock` blob into the shape `lib/time.ts` expects. */
export function toEditLock(value: unknown): EditLock {
  const raw = (value ?? {}) as Record<string, unknown>;
  const unlockDay =
    typeof raw.unlockDay === "string" && isWeekday(raw.unlockDay)
      ? raw.unlockDay
      : DEFAULT_EDIT_LOCK.unlockDay;
  const lockDay =
    typeof raw.lockDay === "string" && isWeekday(raw.lockDay) ? raw.lockDay : DEFAULT_EDIT_LOCK.lockDay;
  const time = (candidate: unknown, fallback: string) =>
    typeof candidate === "string" && /^\d{1,2}:\d{2}$/.test(candidate.trim())
      ? candidate.trim()
      : fallback;
  return {
    unlockDay,
    unlockTime: time(raw.unlockTime, DEFAULT_EDIT_LOCK.unlockTime),
    lockDay,
    lockTime: time(raw.lockTime, DEFAULT_EDIT_LOCK.lockTime),
  };
}

export type EditLockStatus = {
  /** True when configs are editable right now (saves apply immediately). */
  open: boolean;
  /** Epoch ms of the next instant at which `open` flips. */
  nextChange: number;
  lock: EditLock;
};

function hhmm(value: string): { hh: number; mm: number } {
  const [h, m] = value.split(":");
  return { hh: Number(h), mm: Number(m) };
}

/** Edit-lock state for a league at `nowMs`. Pure. */
export function editLockStatusFor(lock: EditLock, nowMs: number): EditLockStatus {
  const now = new Date(nowMs);
  const open = isWithinEditWindow(now, lock);
  const target = open ? hhmm(lock.lockTime) : hhmm(lock.unlockTime);
  const day = open ? lock.lockDay : lock.unlockDay;
  // `nextWeekdayAtET` returns `now` when it sits exactly on the boundary; nudge
  // forward a minute so "next change" is always strictly in the future.
  const nextChange = nextWeekdayAtET(new Date(nowMs + 60_000), day, target.hh, target.mm);
  return { open, nextChange: nextChange.getTime(), lock };
}

/** Start of the current NFL week (Tuesday 06:00 ET), epoch ms. */
export function weekStartMs(nowMs: number): number {
  return weekStartET(new Date(nowMs)).getTime();
}

// ------------------------------------------------------------------------ diff

export type DiffLineKind = "context" | "add" | "del";
export type DiffLine = {
  kind: DiffLineKind;
  text: string;
  oldNo: number | null;
  newNo: number | null;
};

export type DiffHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: DiffLine[];
};

export type FieldDiff = {
  field: string;
  label: string;
  from: string | null;
  to: string | null;
  changed: boolean;
};

export type SkillStamp = { id: string; name: string; slug: string };

export type SkillDiff = {
  before: SkillStamp[];
  after: SkillStamp[];
  added: SkillStamp[];
  removed: SkillStamp[];
  /** Same set of skills, different injection order. */
  reordered: boolean;
  changed: boolean;
};

export type ContextDiff = {
  changed: boolean;
  /** Unified-diff text, for copy/paste and for tests. */
  unified: string;
  hunks: DiffHunk[];
  added: number;
  removed: number;
};

export type VersionStamp = {
  id: string;
  versionNo: number;
  modelId: string;
  /** Epoch ms. */
  createdAt: number;
  changeSummary: string | null;
};

/** The minimum a version has to look like to be diffed. */
export type DiffableVersion = {
  id: string;
  versionNo: number;
  modelId: string;
  createdAt: number;
  changeSummary: string | null;
  contextMd: string;
  harness: HarnessSettings;
  skills: SkillStamp[];
};

export type ConfigDiff = {
  a: VersionStamp;
  b: VersionStamp;
  context: ContextDiff;
  model: FieldDiff;
  harness: FieldDiff[];
  skills: SkillDiff;
  /** True when anything at all differs. */
  changed: boolean;
};

const CONTEXT_LINES = 3;

/** Build hunks with real line numbers on both sides so the UI can render a gutter. */
export function diffContext(before: string, after: string): ContextDiff {
  const patch = structuredPatch(
    "context.md",
    "context.md",
    normalizeTrailingNewline(before),
    normalizeTrailingNewline(after),
    undefined,
    undefined,
    { context: CONTEXT_LINES },
  );

  let added = 0;
  let removed = 0;

  const hunks: DiffHunk[] = patch.hunks.map((hunk) => {
    let oldNo = hunk.oldStart;
    let newNo = hunk.newStart;
    const lines: DiffLine[] = [];

    for (const raw of hunk.lines) {
      const marker = raw[0];
      const text = raw.slice(1);
      if (marker === "+") {
        added += 1;
        lines.push({ kind: "add", text, oldNo: null, newNo: newNo++ });
      } else if (marker === "-") {
        removed += 1;
        lines.push({ kind: "del", text, oldNo: oldNo++, newNo: null });
      } else if (marker === "\\") {
        // "\ No newline at end of file" — not a content line.
        continue;
      } else {
        lines.push({ kind: "context", text, oldNo: oldNo++, newNo: newNo++ });
      }
    }

    return {
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
      header: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
      lines,
    };
  });

  const unified = hunks
    .map((h) => [h.header, ...h.lines.map((l) => `${sign(l.kind)}${l.text}`)].join("\n"))
    .join("\n");

  return { changed: hunks.length > 0, unified, hunks, added, removed };
}

function sign(kind: DiffLineKind): string {
  return kind === "add" ? "+" : kind === "del" ? "-" : " ";
}

function normalizeTrailingNewline(value: string): string {
  return value.endsWith("\n") || value === "" ? value : `${value}\n`;
}

function field(name: string, label: string, from: unknown, to: unknown): FieldDiff {
  const f = from === null || from === undefined ? null : String(from);
  const t = to === null || to === undefined ? null : String(to);
  return { field: name, label, from: f, to: t, changed: f !== t };
}

export function diffHarness(before: HarnessSettings, after: HarnessSettings): FieldDiff[] {
  return [
    field("maxSteps", "Max steps", before.maxSteps, after.maxSteps),
    field("tokenBudget", "Token budget", before.tokenBudget, after.tokenBudget),
    field("temperature", "Temperature", before.temperature, after.temperature),
    field(
      "reasoningEffort",
      "Reasoning effort",
      before.reasoningEffort ?? "off",
      after.reasoningEffort ?? "off",
    ),
    field(
      "deliberateMode",
      "Deliberate mode",
      before.deliberateMode ? "on" : "off",
      after.deliberateMode ? "on" : "off",
    ),
  ];
}

export function diffSkills(before: SkillStamp[], after: SkillStamp[]): SkillDiff {
  const pick = (s: SkillStamp): SkillStamp => ({ id: s.id, name: s.name, slug: s.slug });
  const beforeList = before.map(pick);
  const afterList = after.map(pick);
  const beforeIds = new Set(beforeList.map((s) => s.id));
  const afterIds = new Set(afterList.map((s) => s.id));

  const addedSkills = afterList.filter((s) => !beforeIds.has(s.id));
  const removedSkills = beforeList.filter((s) => !afterIds.has(s.id));
  const sameSet = addedSkills.length === 0 && removedSkills.length === 0;
  const reordered =
    sameSet && beforeList.map((s) => s.id).join("|") !== afterList.map((s) => s.id).join("|");

  return {
    before: beforeList,
    after: afterList,
    added: addedSkills,
    removed: removedSkills,
    reordered,
    changed: addedSkills.length > 0 || removedSkills.length > 0 || reordered,
  };
}

function stamp(v: DiffableVersion): VersionStamp {
  return {
    id: v.id,
    versionNo: v.versionNo,
    modelId: v.modelId,
    createdAt: v.createdAt,
    changeSummary: v.changeSummary,
  };
}

/** Diff two hydrated versions. Pure — no database access. */
export function diffVersionRows(a: DiffableVersion, b: DiffableVersion): ConfigDiff {
  const context = diffContext(a.contextMd, b.contextMd);
  const model = field(
    "modelId",
    "Model",
    findModel(a.modelId)?.displayName ?? a.modelId,
    findModel(b.modelId)?.displayName ?? b.modelId,
  );
  const harness = diffHarness(a.harness, b.harness);
  const skillDiff = diffSkills(a.skills, b.skills);

  return {
    a: stamp(a),
    b: stamp(b),
    context,
    model,
    harness,
    skills: skillDiff,
    changed: context.changed || model.changed || harness.some((h) => h.changed) || skillDiff.changed,
  };
}

// -------------------------------------------------------------------- estimate

export const BASE_PROMPT_TOKENS = 2_500;
export const ASSUMED_OUTPUT_TOKENS_PER_STEP = 1_500;
export const ASSUMED_STEPS = 4;
/** Roughly one token per four characters of English prose / markdown. */
export const CHARS_PER_TOKEN = 4;

/** The same estimator the prompt builder uses — crude, but crude *consistently*. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export type PromptEstimate = {
  tokens: number;
  estimatedCostPerRunUsd: number;
  breakdown: {
    baseTokens: number;
    contextTokens: number;
    skillTokens: number;
    /** Per-skill contribution, in attachment order. */
    skills: Array<{ id: string; name: string; tokens: number }>;
    assumedSteps: number;
    assumedOutputTokensPerStep: number;
    inputPerM: number | null;
    outputPerM: number | null;
    modelId: string;
    modelKnown: boolean;
  };
};

/**
 * Estimated prompt size and per-run cost.
 *
 *   tokens = BASE_PROMPT_TOKENS + tokens(context) + sum(tokens(skill bodies))
 *   cost   = (tokens x input$/M + ASSUMED_OUTPUT_TOKENS_PER_STEP x output$/M) x ASSUMED_STEPS
 *
 * `skills` must already be in the caller's attachment order (the query resolves
 * the ids); this function is the pure half of `estimatePromptSize`.
 */
export function estimatePromptSize(input: {
  contextMd: string;
  modelId: string;
  skills: Array<{ id: string; name: string; bodyMd: string }>;
}): PromptEstimate {
  const perSkill = input.skills.map((s) => ({
    id: s.id,
    name: s.name,
    tokens: estimateTokens(s.bodyMd),
  }));
  const skillTokens = perSkill.reduce((sum, s) => sum + s.tokens, 0);
  const contextTokens = estimateTokens(input.contextMd);
  const tokens = BASE_PROMPT_TOKENS + contextTokens + skillTokens;

  const model = findModel(input.modelId);
  const inputPerM = model?.inputPerM ?? null;
  const outputPerM = model?.outputPerM ?? null;

  const perStepUsd =
    (tokens * (inputPerM ?? 0)) / 1_000_000 +
    (ASSUMED_OUTPUT_TOKENS_PER_STEP * (outputPerM ?? 0)) / 1_000_000;

  return {
    tokens,
    estimatedCostPerRunUsd: round8(perStepUsd * ASSUMED_STEPS),
    breakdown: {
      baseTokens: BASE_PROMPT_TOKENS,
      contextTokens,
      skillTokens,
      skills: perSkill,
      assumedSteps: ASSUMED_STEPS,
      assumedOutputTokensPerStep: ASSUMED_OUTPUT_TOKENS_PER_STEP,
      inputPerM,
      outputPerM,
      modelId: input.modelId,
      modelKnown: model !== undefined,
    },
  };
}

function round8(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

// ------------------------------------------------------------------ validation

export type ConfigIssue = { field: string; message: string };

export type ValidationContext = {
  contextMd: string;
  modelId: string;
  harness: HarnessSettings;
  skillIds: string[];
  rules?: {
    contextCharLimit: number;
    modelAllowlist: string[];
    maxStepsCap: number;
    weeklyTokenCapPerTeam?: number | null;
  } | null;
  noteWasAppended?: boolean;
  /** Whether the team has its own gateway key on file; gates `requiresOwnKey` models. */
  hasOwnKey?: boolean;
  /** Which vendor issued that key; an OpenRouter key rules out models OpenRouter does not serve. */
  ownKeyProvider?: KeyProvider | null;
};

/**
 * Every rule from PRD 5.1/5.4 that a saved version must satisfy. Pure.
 * Exported now so Phase 3's `configs.save` can use it unchanged.
 */
export function validateAgainstRules(ctx: ValidationContext): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const rules = ctx.rules;

  const charLimit = rules?.contextCharLimit ?? 8_000;
  if (ctx.contextMd.length > charLimit) {
    issues.push({
      field: "contextMd",
      message:
        `Context is ${ctx.contextMd.length.toLocaleString()} characters; the league limit is ` +
        `${charLimit.toLocaleString()}` +
        (ctx.noteWasAppended ? " (the note to agent is appended to the context on save)" : ""),
    });
  }

  const allowlist = rules?.modelAllowlist ?? [];
  if (allowlist.length > 0 && !allowlist.includes(ctx.modelId)) {
    issues.push({
      field: "modelId",
      message: `${ctx.modelId} is not on this league's model allowlist`,
    });
  } else if (!findModel(ctx.modelId)) {
    issues.push({ field: "modelId", message: `${ctx.modelId} is not a known gateway model id` });
  } else if (modelRequiresOwnKey(ctx.modelId) && !ctx.hasOwnKey) {
    issues.push({
      field: "modelId",
      message: `${findModel(ctx.modelId)!.displayName} requires your own gateway key. Add one under Spend, then pick it.`,
    });
  } else if (
    ctx.hasOwnKey &&
    ctx.ownKeyProvider &&
    !modelAvailableOnKeyProvider(ctx.modelId, ctx.ownKeyProvider)
  ) {
    issues.push({
      field: "modelId",
      message:
        `${findModel(ctx.modelId)!.displayName} is not available through ` +
        `${KEY_PROVIDER_INFO[ctx.ownKeyProvider].name}, which issued your team's key. ` +
        "Pick another model, or replace the key under Spend.",
    });
  }

  const { maxSteps, tokenBudget, temperature, reasoningEffort } = ctx.harness;

  if (!Number.isInteger(maxSteps) || maxSteps < MAX_STEPS_FLOOR || maxSteps > MAX_STEPS_CEILING) {
    issues.push({
      field: "harness.maxSteps",
      message: `Max steps must be a whole number between ${MAX_STEPS_FLOOR} and ${MAX_STEPS_CEILING}`,
    });
  }
  const stepsCap = rules?.maxStepsCap ?? MAX_STEPS_CEILING;
  if (maxSteps > stepsCap) {
    issues.push({
      field: "harness.maxSteps",
      message: `Max steps must be ${stepsCap} or fewer in this league`,
    });
  }

  if (
    !Number.isInteger(tokenBudget) ||
    tokenBudget < TOKEN_BUDGET_MIN ||
    tokenBudget > TOKEN_BUDGET_MAX
  ) {
    issues.push({
      field: "harness.tokenBudget",
      message: `Token budget must be between ${TOKEN_BUDGET_MIN.toLocaleString()} and ${TOKEN_BUDGET_MAX.toLocaleString()}`,
    });
  }
  const weeklyCap = rules?.weeklyTokenCapPerTeam ?? null;
  if (weeklyCap !== null && weeklyCap !== undefined && tokenBudget > weeklyCap) {
    issues.push({
      field: "harness.tokenBudget",
      message: `Per-run token budget cannot exceed the league's weekly cap of ${weeklyCap.toLocaleString()}`,
    });
  }

  if (!(temperature >= TEMPERATURE_MIN && temperature <= TEMPERATURE_MAX)) {
    issues.push({
      field: "harness.temperature",
      message: `Temperature must be between ${TEMPERATURE_MIN} and ${TEMPERATURE_MAX}`,
    });
  }

  if (reasoningEffort && !modelSupportsReasoningEffort(ctx.modelId, reasoningEffort)) {
    issues.push({
      field: "harness.reasoningEffort",
      message: `${ctx.modelId} does not support reasoning effort "${reasoningEffort}"`,
    });
  }

  if (ctx.skillIds.length > MAX_ATTACHED_SKILLS) {
    issues.push({ field: "skillIds", message: `Attach at most ${MAX_ATTACHED_SKILLS} skills` });
  }

  return issues;
}

// ------------------------------------------------------- save-path helpers (Phase 3)

/**
 * Fill defaults then coerce, but do NOT clamp — out-of-range values must surface
 * as validation issues from `validateAgainstRules` rather than being silently
 * fixed.
 */
export function parseHarnessStrictly(partial: Partial<HarnessSettings>): HarnessSettings {
  const base = parseHarness({});
  return {
    maxSteps: partial.maxSteps ?? base.maxSteps,
    tokenBudget: partial.tokenBudget ?? base.tokenBudget,
    temperature: partial.temperature ?? base.temperature,
    reasoningEffort: partial.reasoningEffort ?? null,
    deliberateMode: partial.deliberateMode ?? base.deliberateMode,
  };
}

/**
 * The heading the owner's note-to-agent is folded into on save (PRD 5.5).
 * The note block appended to a config version's system prompt.
 */
export function noteBlock(note: string, nowMs: number): string {
  return `## Note from my owner (${formatET(new Date(nowMs), "MMM d, yyyy")})\n\n${note}`;
}

/** Preserve first-seen order, drop repeats. `dedupe` from the save path. */
export function dedupeIds<T extends string>(ids: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
