/**
 * Agent config read models (PRD 5.5).
 *
 * Everything here is readable WITHIN THE LEAGUE — every query rides
 * `requireLeagueRead` — but a version's *content* (context, skills, tool
 * overrides, harness, change summary) is private to the team owner and the
 * commissioner for three weeks after it is saved (`convex/lib/visibility.ts`).
 * The envelope (version number, model, author, dates) is always visible.
 * `canEdit` reports the write right; `redacted` on a version reports whether the
 * cooldown hid its content from this viewer.
 *
 * `save` / `setNote` (below) are the only writers. Config versions are IMMUTABLE:
 * a save always appends a row, and the only column ever written afterwards is
 * `appliedAt`, stamped once when a queued version is promoted.
 */
import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { requireLeagueRead, requireOwnerOrCommissioner } from "./lib/auth";
import {
  dedupeIds,
  editLockStatusFor,
  estimatePromptSize,
  noteBlock,
  parseHarness,
  parseHarnessStrictly,
  toEditLock,
  validateAgainstRules,
  weekStartMs,
  type ConfigIssue,
  type ConfigDiff,
  type DiffableVersion,
  type EditLockStatus,
  type HarnessSettings,
  type PromptEstimate,
} from "./lib/config_pure";
import { diffVersionRows } from "./lib/config_pure";
import { appError } from "./lib/errors";
import { configVersionDoc, skillDoc } from "./lib/validators";
import { COOLDOWN_MS, isPrivateAt, revealAtFor } from "./lib/visibility";
import { DEFAULT_AGENT_CONTEXT, DEFAULT_HARNESS } from "./lib/defaults";
import {
  normalizeToolOverrides,
  validateToolOverrides,
  type ToolOverride,
} from "./runtime/tools/catalog";
import { reasoningEffort, toolOverride } from "./schema";
import { keyProviderOf, type KeyProvider } from "@/lib/key-providers";
import { findModel, leagueDefaultModelId } from "@/lib/models";
import { isWithinEditWindow } from "@/lib/time";

type Ctx = QueryCtx | MutationCtx;

/** Epoch ms at which a version's content becomes public; `redacted` says whether it still is not. */
export type Visibility = { revealAt: number; redacted: boolean };

export type ConfigVersionWithSkills = Doc<"config_versions"> &
  Visibility & {
    harness: HarnessSettings;
    skills: Doc<"skills">[];
  };

export type ConfigVersionSummary = Doc<"config_versions"> &
  Visibility & {
  harness: HarnessSettings;
  createdByName: string | null;
  skillCount: number;
  isCurrent: boolean;
  isPending: boolean;
  /** Created on or after the current NFL week's Tuesday 06:00 ET boundary. */
  changedThisWeek: boolean;
  modelDisplayName: string;
};

export type TeamConfigView = {
  team: Doc<"teams">;
  league: Doc<"leagues">;
  rules: Doc<"league_rules"> | null;
  config: Doc<"agent_configs"> | null;
  current: ConfigVersionWithSkills | null;
  pending: ConfigVersionWithSkills | null;
  versions: ConfigVersionSummary[];
};

/** Epoch ms a version was created — the imported Postgres value, else the insert. */
function createdAtOf(version: Doc<"config_versions">): number {
  return version.createdAt ?? version._creationTime;
}

/**
 * The content fields a viewer without private access may not see while the
 * cooldown runs. Sizes and the model stay; the words, the skills, the tool
 * customisations, the harness and the change summary go.
 */
function redactVersion<T extends Doc<"config_versions">>(version: T): T {
  return {
    ...version,
    contextMd: "",
    skillIds: [],
    toolOverrides: undefined,
    changeSummary: undefined,
    harness: parseHarness({}),
  };
}

/**
 * Attached skills in injection order (the order of `skillIds`). Bounded at 12.
 * Redacted for viewers without private access while the version is cooling.
 */
async function hydrate(
  ctx: Ctx,
  raw: Doc<"config_versions">,
  view: { nowMs: number; canSeePrivate: boolean },
): Promise<ConfigVersionWithSkills> {
  const createdAt = createdAtOf(raw);
  const redacted = isPrivateAt(createdAt, view.nowMs, view.canSeePrivate);
  return {
    ...(await hydrateSkills(ctx, redacted ? redactVersion(raw) : raw)),
    revealAt: revealAtFor(createdAt),
    redacted,
  };
}

/** The runtime's view: skills resolved, no visibility envelope. */
async function hydrateSkills(
  ctx: Ctx,
  version: Doc<"config_versions">,
): Promise<Doc<"config_versions"> & { harness: HarnessSettings; skills: Doc<"skills">[] }> {
  const skills: Doc<"skills">[] = [];
  for (const skillId of version.skillIds) {
    const skill = await ctx.db.get("skills", skillId);
    if (skill) skills.push(skill);
  }
  return { ...version, harness: parseHarness(version.harness), skills };
}

/** Owner or commissioner: the people the cooldown does not apply to. */
function canSeePrivateFor(
  access: { viewer: { userId: Id<"users"> } | null; isCommissioner: boolean },
  team: Doc<"teams">,
): boolean {
  const viewerUserId = access.viewer?.userId ?? null;
  return viewerUserId !== null && (team.ownerUserId === viewerUserId || access.isCommissioner);
}

async function configOf(ctx: Ctx, teamId: Id<"teams">): Promise<Doc<"agent_configs"> | null> {
  return ctx.db
    .query("agent_configs")
    .withIndex("by_teamId", (q) => q.eq("teamId", teamId))
    .unique();
}

/** The team must actually belong to the league in the input. */
async function teamInLeague(
  ctx: Ctx,
  teamId: Id<"teams">,
  leagueId: Id<"leagues">,
): Promise<Doc<"teams">> {
  const team = await ctx.db.get("teams", teamId);
  if (!team || team.leagueId !== leagueId) {
    throw appError("NOT_FOUND", "Team not found in this league.");
  }
  return team;
}

/** Version history for a config, newest first. Bounded: versions per team are few. */
async function listVersions(
  ctx: Ctx,
  config: Doc<"agent_configs">,
  nowMs: number,
  canSeePrivate: boolean,
): Promise<ConfigVersionSummary[]> {
  // Bounded by construction: one config's own version chain, read newest-first.
  const rows = await ctx.db
    .query("config_versions")
    .withIndex("by_configId_versionNo", (q) => q.eq("configId", config._id))
    .order("desc")
    .take(200);

  const weekStart = weekStartMs(nowMs);
  const authorNames = new Map<string, string | null>();

  const out: ConfigVersionSummary[] = [];
  for (const raw of rows) {
    const createdAt = createdAtOf(raw);
    const redacted = isPrivateAt(createdAt, nowMs, canSeePrivate);
    const version = redacted ? redactVersion(raw) : raw;
    let createdByName: string | null = null;
    if (version.createdByUserId) {
      if (!authorNames.has(version.createdByUserId)) {
        const author = await ctx.db.get("users", version.createdByUserId);
        authorNames.set(version.createdByUserId, author?.name ?? null);
      }
      createdByName = authorNames.get(version.createdByUserId) ?? null;
    }
    out.push({
      ...version,
      harness: parseHarness(version.harness),
      createdByName,
      skillCount: version.skillIds.length,
      isCurrent: config.currentVersionId === version._id,
      isPending: config.pendingVersionId === version._id,
      changedThisWeek: createdAt >= weekStart,
      modelDisplayName: findModel(version.modelId)?.displayName ?? version.modelId,
      revealAt: revealAtFor(createdAt),
      redacted,
    });
  }
  return out;
}

async function lockStatusFor(ctx: Ctx, leagueId: Id<"leagues">, nowMs: number): Promise<EditLockStatus> {
  const rules = await ctx.db
    .query("league_rules")
    .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
    .unique();
  return editLockStatusFor(toEditLock(rules?.editLock), nowMs);
}

export type ConfigGetView = TeamConfigView & {
  lock: EditLockStatus;
  canEdit: boolean;
  viewerUserId: Id<"users"> | null;
  /** The cooldown as it applies to this viewer. */
  visibility: { canSeePrivate: boolean; cooldownMs: number };
  /**
   * For a viewer who cannot see the current version yet: the newest version
   * whose cooldown has passed, so the editor can still show *something*. Null
   * when the current version is visible or nothing is public yet.
   */
  latestPublic: ConfigVersionWithSkills | null;
};

/** Everything the config editor needs, including lock status and viewer rights. */
export const get = query({
  args: { leagueId: v.id("leagues"), teamId: v.id("teams") },
  handler: async (ctx, { leagueId, teamId }): Promise<ConfigGetView> => {
    const access = await requireLeagueRead(ctx, leagueId);
    const team = await teamInLeague(ctx, teamId, leagueId);
    const now = Date.now();

    const config = await configOf(ctx, teamId);
    const rules = await ctx.db
      .query("league_rules")
      .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
      .unique();

    const current = config?.currentVersionId
      ? await ctx.db.get("config_versions", config.currentVersionId)
      : null;
    const pending = config?.pendingVersionId
      ? await ctx.db.get("config_versions", config.pendingVersionId)
      : null;

    const viewerUserId = access.viewer?.userId ?? null;
    const canSeePrivate = canSeePrivateFor(access, team);
    const view = { nowMs: now, canSeePrivate };
    const hydratedCurrent = current ? await hydrate(ctx, current, view) : null;

    let latestPublic: ConfigVersionWithSkills | null = null;
    if (config && hydratedCurrent?.redacted) {
      // Bounded: one config's version chain, newest first; stops at the first public one.
      const rows = await ctx.db
        .query("config_versions")
        .withIndex("by_configId_versionNo", (q) => q.eq("configId", config._id))
        .order("desc")
        .take(200);
      const revealed = rows.find((row) => !isPrivateAt(createdAtOf(row), now, false));
      if (revealed) latestPublic = await hydrate(ctx, revealed, view);
    }

    return {
      team,
      league: access.league,
      rules,
      config,
      current: hydratedCurrent,
      pending: pending ? await hydrate(ctx, pending, view) : null,
      versions: config ? await listVersions(ctx, config, now, canSeePrivate) : [],
      lock: editLockStatusFor(toEditLock(rules?.editLock), now),
      canEdit: canSeePrivate,
      viewerUserId,
      visibility: { canSeePrivate, cooldownMs: COOLDOWN_MS },
      latestPublic,
    };
  },
});

/** Version history. Public within the league — no ownership check. */
export const versions = query({
  args: { leagueId: v.id("leagues"), teamId: v.id("teams") },
  handler: async (
    ctx,
    { leagueId, teamId },
  ): Promise<{
    team: Doc<"teams">;
    config: Doc<"agent_configs"> | null;
    versions: ConfigVersionSummary[];
  }> => {
    const access = await requireLeagueRead(ctx, leagueId);
    const team = await teamInLeague(ctx, teamId, leagueId);
    const config = await configOf(ctx, teamId);
    return {
      team,
      config,
      versions: config
        ? await listVersions(ctx, config, Date.now(), canSeePrivateFor(access, team))
        : [],
    };
  },
});

/**
 * One version, hydrated with its skills, plus the version before it. Both are
 * redacted for viewers without private access while their cooldown runs.
 */
export const version = query({
  args: { leagueId: v.id("leagues"), versionId: v.id("config_versions") },
  handler: async (
    ctx,
    { leagueId, versionId },
  ): Promise<{ version: ConfigVersionWithSkills; previous: ConfigVersionWithSkills | null }> => {
    const access = await requireLeagueRead(ctx, leagueId);
    const row = await ctx.db.get("config_versions", versionId);
    if (!row || row.leagueId !== leagueId) throw appError("NOT_FOUND", "Version not found.");
    const team = await ctx.db.get("teams", row.teamId);
    if (!team) throw appError("NOT_FOUND", "Version not found.");
    const view = { nowMs: Date.now(), canSeePrivate: canSeePrivateFor(access, team) };

    const priorRows = await ctx.db
      .query("config_versions")
      .withIndex("by_configId_versionNo", (q) =>
        q.eq("configId", row.configId).lt("versionNo", row.versionNo),
      )
      .order("desc")
      .take(1);

    return {
      version: await hydrate(ctx, row, view),
      previous: priorRows[0] ? await hydrate(ctx, priorRows[0], view) : null,
    };
  },
});

function diffable(version: ConfigVersionWithSkills): DiffableVersion {
  return {
    id: version._id,
    versionNo: version.versionNo,
    modelId: version.modelId,
    createdAt: createdAtOf(version),
    changeSummary: version.changeSummary ?? null,
    contextMd: version.contextMd,
    harness: version.harness,
    skills: version.skills.map((s) => ({ id: s._id, name: s.name, slug: s.slug })),
  };
}

/**
 * Context diff + structured model/harness/skill diffs. Computed in the query
 * (pure). FORBIDDEN while either side is still under its cooldown for this
 * viewer — a diff against a redacted version would leak it.
 */
export const diff = query({
  args: {
    leagueId: v.id("leagues"),
    a: v.id("config_versions"),
    b: v.id("config_versions"),
  },
  handler: async (ctx, { leagueId, a, b }): Promise<ConfigDiff> => {
    const access = await requireLeagueRead(ctx, leagueId);
    const left = await ctx.db.get("config_versions", a);
    const right = await ctx.db.get("config_versions", b);
    if (!left || left.leagueId !== leagueId) throw appError("NOT_FOUND", `Config version ${a} not found`);
    if (!right || right.leagueId !== leagueId) throw appError("NOT_FOUND", `Config version ${b} not found`);
    const team = await ctx.db.get("teams", left.teamId);
    if (!team) throw appError("NOT_FOUND", `Config version ${a} not found`);
    const view = { nowMs: Date.now(), canSeePrivate: canSeePrivateFor(access, team) };
    const [before, after] = [await hydrate(ctx, left, view), await hydrate(ctx, right, view)];
    if (before.redacted || after.redacted) {
      throw appError(
        "FORBIDDEN",
        `Version ${before.redacted ? before.versionNo : after.versionNo} is private until its cooldown passes.`,
      );
    }
    return diffVersionRows(diffable(before), diffable(after));
  },
});

/** Is the edit window open, and when does that flip? */
export const lockStatus = query({
  args: { leagueId: v.id("leagues") },
  returns: v.object({
    open: v.boolean(),
    nextChange: v.number(),
    lock: v.object({
      unlockDay: v.string(),
      unlockTime: v.string(),
      lockDay: v.string(),
      lockTime: v.string(),
    }),
  }),
  handler: async (ctx, { leagueId }) => {
    await requireLeagueRead(ctx, leagueId);
    return lockStatusFor(ctx, leagueId, Date.now());
  },
});

/** Live preview: prompt tokens + estimated cost per run for a draft config. */
export const estimate = query({
  args: {
    leagueId: v.id("leagues"),
    contextMd: v.string(),
    skillIds: v.array(v.id("skills")),
    modelId: v.string(),
  },
  handler: async (ctx, args): Promise<PromptEstimate> => {
    await requireLeagueRead(ctx, args.leagueId);
    // Preserve the caller's ordering, and de-duplicate as the Postgres version did.
    const seen = new Set<string>();
    const skills: Array<{ id: string; name: string; bodyMd: string }> = [];
    for (const skillId of args.skillIds) {
      if (seen.has(skillId)) continue;
      seen.add(skillId);
      const skill = await ctx.db.get("skills", skillId);
      if (skill) skills.push({ id: skill._id, name: skill.name, bodyMd: skill.bodyMd });
    }
    return estimatePromptSize({ contextMd: args.contextMd, modelId: args.modelId, skills });
  },
});

// ----------------------------------------------------------------- write paths

/** Input bounds for a saved config. */
const MAX_CONTEXT_CHARS = 200_000;
const MAX_SKILL_IDS = 50;
const MAX_CHANGE_SUMMARY_CHARS = 200;
const MAX_NOTE_CHARS = 4_000;

/**
 * `ConfigValidationError` carried every violated rule at once so the editor
 * could mark each field; the tRPC layer flattened it into a BAD_REQUEST whose
 * message was `field: message; field: message`. Same message here, with the
 * structured issues alongside it in the error data.
 */
function validationError(issues: ConfigIssue[]): ConvexError<{
  code: "BAD_REQUEST";
  message: string;
  issues: ConfigIssue[];
}> {
  const message = issues.map((i) => `${i.field}: ${i.message}`).join("; ") || "Invalid configuration";
  return new ConvexError({ code: "BAD_REQUEST" as const, message, issues });
}

/** The team's `agent_configs` row, created on first write if a team predates it. */
/** The team's own key (`gateway_keys`), as the validator wants it: whether one exists and who issued it. */
async function teamOwnKey(
  ctx: QueryCtx | MutationCtx,
  teamId: Id<"teams">,
): Promise<{ hasOwnKey: boolean; ownKeyProvider: KeyProvider | null }> {
  const row = await ctx.db
    .query("team_gateway_keys")
    .withIndex("by_teamId", (q) => q.eq("teamId", teamId))
    .unique();
  return { hasOwnKey: row !== null, ownKeyProvider: row ? keyProviderOf(row) : null };
}

async function ensureConfig(
  ctx: MutationCtx,
  team: Doc<"teams">,
): Promise<Doc<"agent_configs">> {
  const existing = await configOf(ctx, team._id);
  if (existing) return existing;
  const now = Date.now();
  const configId = await ctx.db.insert("agent_configs", {
    teamId: team._id,
    leagueId: team.leagueId,
    createdAt: now,
    updatedAt: now,
  });
  const created = await ctx.db.get("agent_configs", configId);
  if (!created) throw appError("NOT_FOUND", `Could not create agent config for team ${team._id}`);
  return created;
}

/**
 * `skills.usageCount` counts the *current* config versions attaching a skill, so
 * it only moves when a config's `currentVersionId` moves. The delta between the
 * outgoing and incoming skill lists is exact and bounded (≤ 12 skills a side);
 * a true recount would have to scan every league's configs, which no index
 * supports.
 */
async function shiftSkillUsage(
  ctx: MutationCtx,
  before: readonly Id<"skills">[],
  after: readonly Id<"skills">[],
): Promise<void> {
  const beforeSet = new Set<string>(before);
  const afterSet = new Set<string>(after);
  const delta = new Map<Id<"skills">, number>();
  for (const id of dedupeIds(after)) if (!beforeSet.has(id)) delta.set(id, 1);
  for (const id of dedupeIds(before)) if (!afterSet.has(id)) delta.set(id, -1);

  for (const [skillId, step] of delta) {
    const skill = await ctx.db.get("skills", skillId);
    if (!skill) continue;
    await ctx.db.patch("skills", skillId, {
      usageCount: Math.max(0, skill.usageCount + step),
    });
  }
}

/** The skill ids a config's current version attaches, or `[]`. */
async function currentSkillIds(
  ctx: MutationCtx,
  config: Doc<"agent_configs">,
): Promise<Id<"skills">[]> {
  if (!config.currentVersionId) return [];
  const version = await ctx.db.get("config_versions", config.currentVersionId);
  return version?.skillIds ?? [];
}

/** The team must actually belong to the league in the input (`assertTeamInLeague`). */
async function assertTeamInLeague(team: Doc<"teams">, leagueId: Id<"leagues">): Promise<void> {
  if (team.leagueId !== leagueId) throw appError("NOT_FOUND", "Team not found in this league.");
}

const harnessInput = v.object({
  maxSteps: v.optional(v.number()),
  tokenBudget: v.optional(v.number()),
  temperature: v.optional(v.number()),
  reasoningEffort: v.optional(v.union(reasoningEffort, v.null())),
  deliberateMode: v.optional(v.boolean()),
});

const saveResult = v.object({
  versionId: v.id("config_versions"),
  versionNo: v.number(),
  applied: v.boolean(),
  queued: v.boolean(),
  /** Epoch ms the queued version goes live; null when it applied already. */
  appliesAt: v.union(v.number(), v.null()),
  noteAppended: v.union(v.string(), v.null()),
});

/**
 * Create a new immutable version for a team (`config.save`).
 *
 * Validates against `league_rules`, folds in and clears the note-to-agent
 * scratchpad, then applies immediately or queues for the next unlock depending
 * on the edit lock (PRD 5.5):
 *
 *   inside the window  -> `currentVersionId`, `appliedAt = now`
 *   outside the window -> `pendingVersionId`, replacing any earlier queue
 *
 * Authorization is the team's owner or the league's commissioner, exactly as
 * `assertMayEdit` behind `leagueMemberProcedure`.
 */
export const save = mutation({
  args: {
    leagueId: v.id("leagues"),
    teamId: v.id("teams"),
    contextMd: v.string(),
    modelId: v.string(),
    harness: harnessInput,
    skillIds: v.array(v.id("skills")),
    /** Deltas from the default tool contract; omitted or empty = every tool at its default. */
    toolOverrides: v.optional(v.array(toolOverride)),
    changeSummary: v.optional(v.string()),
  },
  returns: saveResult,
  handler: async (ctx, args) => {
    const access = await requireOwnerOrCommissioner(ctx, args.teamId);
    await assertTeamInLeague(access.team, args.leagueId);

    if (args.contextMd.length > MAX_CONTEXT_CHARS) {
      throw appError("BAD_REQUEST", `Context must be at most ${MAX_CONTEXT_CHARS} characters.`);
    }
    if (args.skillIds.length > MAX_SKILL_IDS) {
      throw appError("BAD_REQUEST", `Attach at most ${MAX_SKILL_IDS} skills.`);
    }
    if ((args.changeSummary ?? "").length > MAX_CHANGE_SUMMARY_CHARS) {
      throw appError("BAD_REQUEST", `Change summaries are at most ${MAX_CHANGE_SUMMARY_CHARS} characters.`);
    }
    if (!args.modelId) throw appError("BAD_REQUEST", "Pick a model.");

    const now = Date.now();
    const config = await ensureConfig(ctx, access.team);
    const rules = await ctx.db
      .query("league_rules")
      .withIndex("by_leagueId", (q) => q.eq("leagueId", args.leagueId))
      .unique();

    // ---- note to agent: appended to the context, then cleared (PRD 5.5) -----
    const note = (config.noteToAgent ?? "").trim();
    const contextMd = note
      ? `${args.contextMd.trimEnd()}\n\n${noteBlock(note, now)}`
      : args.contextMd;

    // ---- validation ---------------------------------------------------------
    const skillIds = dedupeIds(args.skillIds);
    const harness = parseHarnessStrictly(args.harness);
    const issues = validateAgainstRules({
      contextMd,
      modelId: args.modelId,
      harness,
      skillIds,
      rules,
      noteWasAppended: note.length > 0,
      ...(await teamOwnKey(ctx, access.team._id)),
    });

    const toolOverrides = normalizeToolOverrides(args.toolOverrides ?? []);
    issues.push(...validateToolOverrides(toolOverrides));

    const missing: Id<"skills">[] = [];
    for (const skillId of skillIds) {
      if ((await ctx.db.get("skills", skillId)) === null) missing.push(skillId);
    }
    if (missing.length > 0) {
      issues.push({ field: "skillIds", message: `Unknown skill(s): ${missing.join(", ")}` });
    }

    if (issues.length > 0) throw validationError(issues);

    const result = await appendVersion(ctx, access, config, rules, {
      now,
      contextMd,
      modelId: args.modelId,
      harness,
      skillIds,
      toolOverrides,
      changeSummary: args.changeSummary,
      consumeNote: true,
    });
    return { ...result, noteAppended: note ? note : null };
  },
});

/**
 * Change one default tool's customisation — on/off and owner guidance — without
 * touching anything else. Appends a version copied from the newest one (queued
 * first, then live; the platform defaults when the team has none) with that
 * single override replaced, then applies or queues it exactly as `save` does.
 * The owner's note is left for the next full save.
 */
export const saveToolOverride = mutation({
  args: {
    leagueId: v.id("leagues"),
    teamId: v.id("teams"),
    override: toolOverride,
    changeSummary: v.optional(v.string()),
  },
  returns: saveResult,
  handler: async (ctx, args) => {
    const access = await requireOwnerOrCommissioner(ctx, args.teamId);
    await assertTeamInLeague(access.team, args.leagueId);
    if ((args.changeSummary ?? "").length > MAX_CHANGE_SUMMARY_CHARS) {
      throw appError("BAD_REQUEST", `Change summaries are at most ${MAX_CHANGE_SUMMARY_CHARS} characters.`);
    }

    const now = Date.now();
    const config = await ensureConfig(ctx, access.team);
    const rules = await ctx.db
      .query("league_rules")
      .withIndex("by_leagueId", (q) => q.eq("leagueId", args.leagueId))
      .unique();

    const baseId = config.pendingVersionId ?? config.currentVersionId;
    const base = baseId ? await ctx.db.get("config_versions", baseId) : null;
    const contextMd = base?.contextMd ?? DEFAULT_AGENT_CONTEXT;
    const modelId = base?.modelId ?? leagueDefaultModelId(rules?.modelAllowlist);
    const harness = base ? parseHarness(base.harness) : DEFAULT_HARNESS;
    const skillIds = base?.skillIds ?? [];

    const toolOverrides = normalizeToolOverrides([
      ...(base?.toolOverrides ?? []).filter((o) => o.name !== args.override.name),
      args.override,
    ]);
    const issues = validateAgainstRules({
      contextMd,
      modelId,
      harness,
      skillIds,
      rules,
      noteWasAppended: false,
      ...(await teamOwnKey(ctx, access.team._id)),
    });
    issues.push(...validateToolOverrides(toolOverrides));
    if (issues.length > 0) throw validationError(issues);

    const result = await appendVersion(ctx, access, config, rules, {
      now,
      contextMd,
      modelId,
      harness,
      skillIds,
      toolOverrides,
      changeSummary: args.changeSummary,
      consumeNote: false,
    });
    return { ...result, noteAppended: null };
  },
});

/**
 * Append an immutable version and apply it (inside the edit window) or queue it
 * (outside), replacing any earlier queued version. `consumeNote` clears the
 * owner's note once a save has folded it into the context.
 */
async function appendVersion(
  ctx: MutationCtx,
  access: Awaited<ReturnType<typeof requireOwnerOrCommissioner>>,
  config: Doc<"agent_configs">,
  rules: Doc<"league_rules"> | null,
  input: {
    now: number;
    contextMd: string;
    modelId: string;
    harness: HarnessSettings;
    skillIds: Id<"skills">[];
    toolOverrides: ToolOverride[];
    changeSummary: string | undefined;
    consumeNote: boolean;
  },
): Promise<{
  versionId: Id<"config_versions">;
  versionNo: number;
  applied: boolean;
  queued: boolean;
  appliesAt: number | null;
}> {
  const { now } = input;
  const [latest] = await ctx.db
    .query("config_versions")
    .withIndex("by_configId_versionNo", (q) => q.eq("configId", config._id))
    .order("desc")
    .take(1);
  const versionNo = (latest?.versionNo ?? 0) + 1;

  const lock = toEditLock(rules?.editLock);
  const open = isWithinEditWindow(new Date(now), lock);
  const summary = input.changeSummary?.trim();

  const versionId = await ctx.db.insert("config_versions", {
    configId: config._id,
    teamId: access.team._id,
    leagueId: access.team.leagueId,
    versionNo,
    contextMd: input.contextMd,
    modelId: input.modelId,
    harness: input.harness,
    skillIds: input.skillIds,
    toolOverrides: input.toolOverrides.length > 0 ? input.toolOverrides : undefined,
    createdByUserId: access.viewer.userId,
    appliedAt: open ? now : undefined,
    changeSummary: summary ? summary : undefined,
    createdAt: now,
  });

  const note = input.consumeNote ? { noteToAgent: undefined } : {};
  if (open) {
    await shiftSkillUsage(ctx, await currentSkillIds(ctx, config), input.skillIds);
    await ctx.db.patch("agent_configs", config._id, {
      currentVersionId: versionId,
      pendingVersionId: undefined,
      ...note,
      updatedAt: now,
    });
  } else {
    await ctx.db.patch("agent_configs", config._id, {
      pendingVersionId: versionId,
      ...note,
      updatedAt: now,
    });
  }

  return {
    versionId,
    versionNo,
    applied: open,
    queued: !open,
    appliesAt: open ? null : editLockStatusFor(lock, now).nextChange,
  };
}

/**
 * The owner's scratchpad (`config.setNote`). The text is folded into the context
 * on the next save and cleared at that point; passing `null` clears it now.
 */
export const setNote = mutation({
  args: {
    leagueId: v.id("leagues"),
    teamId: v.id("teams"),
    text: v.union(v.string(), v.null()),
  },
  returns: v.object({ noteToAgent: v.union(v.string(), v.null()) }),
  handler: async (ctx, { leagueId, teamId, text }) => {
    const access = await requireOwnerOrCommissioner(ctx, teamId);
    await assertTeamInLeague(access.team, leagueId);
    if ((text ?? "").length > MAX_NOTE_CHARS) {
      throw appError("BAD_REQUEST", `Notes are at most ${MAX_NOTE_CHARS} characters.`);
    }

    const config = await ensureConfig(ctx, access.team);
    const value = text?.trim() ? text.trim().slice(0, MAX_NOTE_CHARS) : undefined;
    await ctx.db.patch("agent_configs", config._id, {
      noteToAgent: value,
      updatedAt: Date.now(),
    });
    return { noteToAgent: value ?? null };
  },
});

/** One team whose queued version just became current. */
export type PromotedVersion = {
  teamId: Id<"teams">;
  versionId: Id<"config_versions">;
  versionNo: number;
};

/**
 * Promote every queued version in a league to current. Shared by the scheduled
 * edit-window unlock (`applyPending`) and the commissioner's manual global save
 * (`commissioner.applyPendingConfigs`), so both paths stamp `appliedAt`, move
 * skill usage and clear the queue identically. Idempotent: teams with no
 * pending version are left alone.
 */
export async function promotePendingVersions(
  ctx: MutationCtx,
  leagueId: Id<"leagues">,
): Promise<PromotedVersion[]> {
  // Bounded by construction: one agent_configs row per team, ≤ 14 per league.
  const configs = await ctx.db
    .query("agent_configs")
    .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
    .collect();

  const now = Date.now();
  const promoted: PromotedVersion[] = [];

  for (const config of configs) {
    const pendingId = config.pendingVersionId;
    if (!pendingId) continue;
    const pending = await ctx.db.get("config_versions", pendingId);
    if (!pending) {
      await ctx.db.patch("agent_configs", config._id, {
        pendingVersionId: undefined,
        updatedAt: now,
      });
      continue;
    }

    // The one write a config version ever receives after insert, stamped once.
    if (pending.appliedAt === undefined) {
      await ctx.db.patch("config_versions", pendingId, { appliedAt: now });
    }
    await shiftSkillUsage(ctx, await currentSkillIds(ctx, config), pending.skillIds);
    await ctx.db.patch("agent_configs", config._id, {
      currentVersionId: pendingId,
      pendingVersionId: undefined,
      updatedAt: now,
    });
    promoted.push({ teamId: config.teamId, versionId: pendingId, versionNo: pending.versionNo });
  }

  return promoted;
}

/**
 * Promote every queued version in a league to current — the edit-window unlock
 * job (Phase 5 schedules it; `weeks.unlockJobId`). Returns the number of teams
 * promoted.
 */
export const applyPending = internalMutation({
  args: { leagueId: v.id("leagues") },
  returns: v.number(),
  handler: async (ctx, { leagueId }) => {
    const promoted = await promotePendingVersions(ctx, leagueId);
    return promoted.length;
  },
});

/**
 * The runtime's `getCurrentConfigVersion`: the applied version for a team with
 * its skills in injection order and its harness parsed into a complete blob.
 */
export const currentForTeam = internalQuery({
  args: { teamId: v.id("teams") },
  returns: v.union(
    v.null(),
    v.object({ ...configVersionDoc.fields, skills: v.array(skillDoc) }),
  ),
  handler: async (ctx, { teamId }) => {
    const config = await configOf(ctx, teamId);
    if (!config?.currentVersionId) return null;
    const version = await ctx.db.get("config_versions", config.currentVersionId);
    if (!version) return null;
    return hydrateSkills(ctx, version);
  },
});
