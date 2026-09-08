/**
 * Config version diffs (PRD 5.5).
 *
 * Two layers: a unified context diff of the markdown context (via the `diff`
 * package, rendered as hunks with +/- lines), and a structured field diff for
 * model / harness / skills so the UI can show them as a table rather than as
 * text noise.
 */
import { structuredPatch } from "diff";

import { db, type DbOrTx } from "@/lib/db";
import { findModel } from "@/lib/models";

import { ConfigNotFoundError } from "./errors";
import { getVersion, type ConfigVersionWithSkills } from "./queries";
import type { HarnessSettings } from "./harness";

export type DiffLineKind = "context" | "add" | "del";
export type DiffLine = { kind: DiffLineKind; text: string; oldNo: number | null; newNo: number | null };

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

export type SkillDiff = {
  before: Array<{ id: string; name: string; slug: string }>;
  after: Array<{ id: string; name: string; slug: string }>;
  added: Array<{ id: string; name: string; slug: string }>;
  removed: Array<{ id: string; name: string; slug: string }>;
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
  createdAt: Date;
  changeSummary: string | null;
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

export function diffSkills(
  before: ConfigVersionWithSkills["skills"],
  after: ConfigVersionWithSkills["skills"],
): SkillDiff {
  const pick = (s: { id: string; name: string; slug: string }) => ({
    id: s.id,
    name: s.name,
    slug: s.slug,
  });
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

function stamp(v: ConfigVersionWithSkills): VersionStamp {
  return {
    id: v.id,
    versionNo: v.versionNo,
    modelId: v.modelId,
    createdAt: v.createdAt,
    changeSummary: v.changeSummary,
  };
}

/** Diff two hydrated versions. Pure — no database access. */
export function diffVersionRows(
  a: ConfigVersionWithSkills,
  b: ConfigVersionWithSkills,
): ConfigDiff {
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

/**
 * Diff version `a` (the older side) against version `b` (the newer side).
 * Both ids must exist; version history is public within the league.
 */
export async function diffVersions(
  a: string,
  b: string,
  executor: DbOrTx = db,
): Promise<ConfigDiff> {
  const [left, right] = await Promise.all([getVersion(a, executor), getVersion(b, executor)]);
  if (!left) throw new ConfigNotFoundError(`Config version ${a} not found`);
  if (!right) throw new ConfigNotFoundError(`Config version ${b} not found`);
  return diffVersionRows(left, right);
}
