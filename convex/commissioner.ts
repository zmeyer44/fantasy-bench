/**
 * Commissioner console read models (PRD 5.1, 5.2, 7).
 *
 * Every function is commissioner-scoped (membership + role), except
 * `leagues.joinByCode`, which lives in `convex/leagues.ts` because anyone signed
 * in may redeem a code.
 *
 * Two rules drive the write paths:
 *
 *  1. **Immutability.** Once the draft begins (`league_rules.rulesLockedAt` is
 *     set, or the league has left `setup`), the rule set is frozen except for
 *     `MUTABLE_AFTER_LOCK` — budgets, moderation/conduct settings, the model
 *     allowlist/fallback and schedule administration.
 *  2. **Everything is logged.** Every accepted field change writes a
 *     `league_rule_changes` row, so the Change log tab is a complete audit
 *     trail, not a summary.
 *
 * Model ids are always pinned: an id ending in `latest` is rejected, and an id
 * must either exist in `MODEL_CATALOG` or be a `mock/*` id (dev + tests).
 */
import { paginationOptsValidator } from "convex/server";
import { v, type Infer } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { requireCommissioner } from "./lib/auth";
import { appError } from "./lib/errors";
import { findByEmail } from "./users";
import { mintJoinCode } from "./leagues";
import { leagueDoc, paginationResult, ruleChangeDoc, rulesDoc, teamDoc } from "./lib/validators";
import {
  draftType,
  editLockConfig,
  injectionPolicy,
  scoringPreset,
  transparencyMode,
  windowOverride,
} from "./schema";
import { MODEL_CATALOG } from "@/lib/models";

type Ctx = QueryCtx | MutationCtx;

/** The change log page caps at the same 200 rows the tRPC procedure defaulted to. */
const CHANGE_LOG_LIMIT = 200;
/** A league has 8-14 teams (PRD 5.1); every per-team read below is bounded by it. */
const MAX_TEAMS = 14;

const inviteLinkShape = v.object({
  code: v.union(v.string(), v.null()),
  url: v.union(v.string(), v.null()),
});

const modelInUse = v.object({ modelId: v.string(), teamCount: v.number() });

const catalogEntry = v.object({
  modelId: v.string(),
  provider: v.string(),
  displayName: v.string(),
  inputPerM: v.number(),
  outputPerM: v.number(),
  cachedInputPerM: v.union(v.number(), v.null()),
  reasoningPerM: v.union(v.number(), v.null()),
  supportsReasoning: v.boolean(),
});

const ruleChangeWithUser = v.object({
  ...ruleChangeDoc.fields,
  userName: v.union(v.string(), v.null()),
});

/**
 * `/leagues/join/<code>`. `SITE_URL` is the deployment env var Convex Auth
 * already requires; the Postgres version read `NEXT_PUBLIC_APP_URL`.
 */
function joinUrl(code: string): string {
  const base = process.env.SITE_URL ?? "";
  return `${base}/leagues/join/${code}`;
}

/**
 * The league's invite link.
 *
 * Deviation from the pre-Convex `inviteLink`: that function minted
 * a code on first read. A Convex query cannot write, so a league with no code
 * reports `null` and `commissioner.rotateJoinCode` (below) mints one.
 */
function inviteLinkOf(league: Doc<"leagues">): { code: string | null; url: string | null } {
  return league.joinCode ? { code: league.joinCode, url: joinUrl(league.joinCode) } : { code: null, url: null };
}

async function rulesOf(ctx: Ctx, leagueId: Id<"leagues">): Promise<Doc<"league_rules">> {
  const rules = await ctx.db
    .query("league_rules")
    .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
    .unique();
  if (!rules) throw appError("NOT_FOUND", "League rules not found.");
  return rules;
}

/** Which gateway model each team's *current* config version runs. Bounded by team count. */
async function modelsInUse(
  ctx: Ctx,
  leagueId: Id<"leagues">,
): Promise<Array<{ modelId: string; teamCount: number }>> {
  // Bounded by construction: one agent_configs row per team, at most 14 per league.
  const configs = await ctx.db
    .query("agent_configs")
    .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
    .collect();

  const counts = new Map<string, number>();
  for (const config of configs) {
    if (!config.currentVersionId) continue;
    const version = await ctx.db.get("config_versions", config.currentVersionId);
    if (!version) continue;
    counts.set(version.modelId, (counts.get(version.modelId) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([modelId, teamCount]) => ({ modelId, teamCount }))
    .sort((a, b) => a.modelId.localeCompare(b.modelId));
}

async function changeRows(
  ctx: Ctx,
  leagueId: Id<"leagues">,
  limit: number,
): Promise<Array<Doc<"league_rule_changes"> & { userName: string | null }>> {
  const rows = await ctx.db
    .query("league_rule_changes")
    .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
    .order("desc")
    .take(limit);
  return withUserNames(ctx, rows);
}

async function withUserNames(
  ctx: Ctx,
  rows: Doc<"league_rule_changes">[],
): Promise<Array<Doc<"league_rule_changes"> & { userName: string | null }>> {
  const names = new Map<string, string | null>();
  const out: Array<Doc<"league_rule_changes"> & { userName: string | null }> = [];
  for (const row of rows) {
    let userName: string | null = null;
    if (row.userId) {
      if (!names.has(row.userId)) {
        const user = await ctx.db.get("users", row.userId);
        names.set(row.userId, user?.name ?? null);
      }
      userName = names.get(row.userId) ?? null;
    }
    out.push({ ...row, userName });
  }
  return out;
}

const settingsTeam = v.object({
  id: v.id("teams"),
  name: v.string(),
  abbreviation: v.string(),
  ownerUserId: v.union(v.id("users"), v.null()),
  ownerName: v.union(v.string(), v.null()),
  ownerEmail: v.union(v.string(), v.null()),
  modelId: v.union(v.string(), v.null()),
  configVersionNo: v.union(v.number(), v.null()),
  waiverPriority: v.number(),
});

/**
 * The Teams tab's roster, ordered by waiver priority.
 *
 * The console used to read `views.teams` for this, which is the public standings
 * card: it carries no owner email (the console assigns owners by email) and it
 * folds the whole standings table to produce rows the commissioner does not
 * need. This reads the teams directly and joins the owner and the team's current
 * config version.
 */
async function settingsTeams(
  ctx: Ctx,
  leagueId: Id<"leagues">,
): Promise<Array<Infer<typeof settingsTeam>>> {
  // Bounded by construction: a league has at most MAX_TEAMS teams.
  const teams = await ctx.db
    .query("teams")
    .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
    .take(MAX_TEAMS);

  const rows: Array<Infer<typeof settingsTeam>> = [];
  for (const team of teams) {
    const owner = team.ownerUserId ? await ctx.db.get("users", team.ownerUserId) : null;
    const config = await ctx.db
      .query("agent_configs")
      .withIndex("by_teamId", (q) => q.eq("teamId", team._id))
      .unique();
    const version = config?.currentVersionId
      ? await ctx.db.get("config_versions", config.currentVersionId)
      : null;
    rows.push({
      id: team._id,
      name: team.name,
      abbreviation: team.abbreviation,
      ownerUserId: team.ownerUserId ?? null,
      ownerName: owner?.name ?? null,
      ownerEmail: owner?.email ?? null,
      modelId: version?.modelId ?? null,
      configVersionNo: version?.versionNo ?? null,
      waiverPriority: team.waiverPriority,
    });
  }
  return rows.sort(
    (a, b) => a.waiverPriority - b.waiverPriority || a.name.localeCompare(b.name),
  );
}

/** Everything the settings console renders on first paint. */
export const settings = query({
  args: { leagueId: v.id("leagues") },
  returns: v.object({
    league: leagueDoc,
    rules: rulesDoc,
    invite: inviteLinkShape,
    changes: v.array(ruleChangeWithUser),
    modelsInUse: v.array(modelInUse),
    catalog: v.array(catalogEntry),
    locked: v.boolean(),
    teams: v.array(settingsTeam),
  }),
  handler: async (ctx, { leagueId }) => {
    const access = await requireCommissioner(ctx, leagueId);
    const rules = await rulesOf(ctx, leagueId);
    return {
      league: access.league,
      rules,
      invite: inviteLinkOf(access.league),
      changes: await changeRows(ctx, leagueId, CHANGE_LOG_LIMIT),
      modelsInUse: await modelsInUse(ctx, leagueId),
      catalog: MODEL_CATALOG.map((m) => ({ ...m })),
      locked: rules.rulesLockedAt !== undefined || access.league.status !== "setup",
      teams: await settingsTeams(ctx, leagueId),
    };
  },
});

export const inviteLink = query({
  args: { leagueId: v.id("leagues") },
  returns: inviteLinkShape,
  handler: async (ctx, { leagueId }) => {
    const access = await requireCommissioner(ctx, leagueId);
    return inviteLinkOf(access.league);
  },
});

/** Append-only audit log of every commissioner change, newest first. */
export const changeLog = query({
  args: { leagueId: v.id("leagues"), paginationOpts: paginationOptsValidator },
  returns: paginationResult(ruleChangeWithUser),
  handler: async (ctx, { leagueId, paginationOpts }) => {
    await requireCommissioner(ctx, leagueId);
    const page = await ctx.db
      .query("league_rule_changes")
      .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
      .order("desc")
      .paginate(paginationOpts);
    return { ...page, page: await withUserNames(ctx, page.page) };
  },
});

// ============================================================================
// Write paths
// ============================================================================

/**
 * `RulesError` → a 400 whose message the settings form renders next to the
 * field, exactly as the pre-Convex `guard()` wrapper
 * did (`field: message`).
 */
function rulesError(message: string, field?: string) {
  return appError("BAD_REQUEST", field ? `${field}: ${message}` : message);
}

// ------------------------------------------------------------- model pinning

/** A gateway model id we are willing to pin an agent to. */
export function isPinnedModelId(modelId: string): boolean {
  if (!modelId || /\blatest$/i.test(modelId.trim())) return false;
  if (modelId.startsWith("mock/")) return modelId.length > "mock/".length;
  return MODEL_CATALOG.some((entry) => entry.modelId === modelId);
}

function assertPinnedModelId(modelId: string, field = "modelAllowlist"): void {
  if (/\blatest$/i.test(modelId.trim())) {
    throw rulesError(
      `"${modelId}" is an alias. Model versions must be pinned for the season (PRD 5.1).`,
      field,
    );
  }
  if (!isPinnedModelId(modelId)) {
    throw rulesError(`"${modelId}" is not a known model id.`, field);
  }
}

// ----------------------------------------------------------- the rules patch

/** Every commissioner-editable field on `league_rules`. All optional — a patch. */
const rulesPatchValidator = v.object({
  scoringPreset: v.optional(scoringPreset),
  superflex: v.optional(v.boolean()),
  tePremium: v.optional(v.boolean()),
  rosterSlots: v.optional(v.record(v.string(), v.number())),
  faabBudget: v.optional(v.number()),
  playoffTeams: v.optional(v.number()),
  playoffStartWeek: v.optional(v.number()),
  regularSeasonWeeks: v.optional(v.number()),
  transparencyMode: v.optional(transparencyMode),
  injectionPolicy: v.optional(injectionPolicy),
  modelAllowlist: v.optional(v.array(v.string())),
  fallbackModelId: v.optional(v.union(v.string(), v.null())),
  weeklyTokenCapPerTeam: v.optional(v.union(v.number(), v.null())),
  leagueUsdHardCap: v.optional(v.union(v.number(), v.null())),
  weeklyUsdCapPerTeam: v.optional(v.union(v.number(), v.null())),
  contextCharLimit: v.optional(v.number()),
  maxStepsCap: v.optional(v.number()),
  editLock: v.optional(editLockConfig),
  windowOverrides: v.optional(v.union(v.record(v.string(), windowOverride), v.null())),
  tradeReviewHours: v.optional(v.number()),
  fairnessFloor: v.optional(v.number()),
  antiChurnWeeks: v.optional(v.number()),
  maxOpenProposals: v.optional(v.number()),
  maxMessagesPerRun: v.optional(v.number()),
  maxThreadsPerWindow: v.optional(v.number()),
  forumPostsPerDay: v.optional(v.number()),
  forumCommentsPerDay: v.optional(v.number()),
  safetyAutopilot: v.optional(v.boolean()),
});

type RulesPatch = Infer<typeof rulesPatchValidator>;
type RulesField = keyof RulesPatch;

/** Rules columns where a stored `null` is meaningful (see `effectiveWeeklyUsdCap`). */
const NULL_IS_A_VALUE: ReadonlySet<RulesField> = new Set<RulesField>(["weeklyUsdCapPerTeam"]);

/**
 * Fields that stay editable after the rules lock (PRD 5.1: "immutable once the
 * draft begins, except for budgets and moderation settings"), plus the model
 * allowlist / fallback (PRD 7 deprecation replacements) and the edit lock /
 * window overrides (PRD 5.5 schedule administration, e.g. a flexed game).
 */
export const MUTABLE_AFTER_LOCK: ReadonlySet<RulesField> = new Set<RulesField>([
  // budgets
  "weeklyTokenCapPerTeam",
  "leagueUsdHardCap",
  "weeklyUsdCapPerTeam",
  // moderation / conduct
  "transparencyMode",
  "injectionPolicy",
  "tradeReviewHours",
  "fairnessFloor",
  "antiChurnWeeks",
  "maxOpenProposals",
  "maxMessagesPerRun",
  "maxThreadsPerWindow",
  "forumPostsPerDay",
  "forumCommentsPerDay",
  // models & fallbacks
  "modelAllowlist",
  "fallbackModelId",
  "safetyAutopilot",
  // schedule administration
  "editLock",
  "windowOverrides",
]);

const HHMM = /^([01]?\d|2[0-3]):[0-5]\d$/;
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

function requireInt(field: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw rulesError(`must be a whole number between ${min} and ${max}`, field);
  }
}

function requireNumber(field: string, value: number, min: number, max: number): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw rulesError(`must be between ${min} and ${max}`, field);
  }
}

function requireWeekday(field: string, value: string): void {
  if (!(WEEKDAYS as readonly string[]).includes(value)) {
    throw rulesError("must be a weekday (sun…sat)", field);
  }
}

function requireHhmm(field: string, value: string): void {
  if (!HHMM.test(value)) throw rulesError("Use HH:mm (24h) Eastern", field);
}

/**
 * Everything `rulesPatchSchema` used to assert with Zod. Runs before the lock
 * check so a malformed patch fails the same way locked or unlocked.
 */
function validateRulesPatch(patch: RulesPatch): void {
  if (patch.rosterSlots !== undefined) {
    const entries = Object.entries(patch.rosterSlots);
    for (const [slot, count] of entries) {
      if (slot.length < 1 || slot.length > 12) {
        throw rulesError("slot names are 1–12 characters", "rosterSlots");
      }
      requireInt("rosterSlots", count, 0, 20);
    }
    if (!entries.some(([, count]) => count > 0)) {
      throw rulesError("At least one roster slot is required", "rosterSlots");
    }
  }
  if (patch.faabBudget !== undefined) requireInt("faabBudget", patch.faabBudget, 0, 1_000);
  if (patch.playoffTeams !== undefined) requireInt("playoffTeams", patch.playoffTeams, 2, 8);
  if (patch.playoffStartWeek !== undefined) {
    requireInt("playoffStartWeek", patch.playoffStartWeek, 10, 18);
  }
  if (patch.regularSeasonWeeks !== undefined) {
    requireInt("regularSeasonWeeks", patch.regularSeasonWeeks, 4, 17);
  }
  if (patch.modelAllowlist !== undefined) {
    if (patch.modelAllowlist.length < 1) {
      throw rulesError("The allowlist must contain at least one model.", "modelAllowlist");
    }
    if (patch.modelAllowlist.some((id) => id.length === 0)) {
      throw rulesError("model ids cannot be empty", "modelAllowlist");
    }
  }
  if (patch.fallbackModelId !== undefined && patch.fallbackModelId !== null) {
    if (patch.fallbackModelId.length === 0) {
      throw rulesError("model ids cannot be empty", "fallbackModelId");
    }
  }
  if (patch.weeklyTokenCapPerTeam !== undefined && patch.weeklyTokenCapPerTeam !== null) {
    requireInt("weeklyTokenCapPerTeam", patch.weeklyTokenCapPerTeam, 0, Number.MAX_SAFE_INTEGER);
  }
  if (patch.leagueUsdHardCap !== undefined && patch.leagueUsdHardCap !== null) {
    requireNumber("leagueUsdHardCap", patch.leagueUsdHardCap, 0, Number.MAX_SAFE_INTEGER);
  }
  if (patch.weeklyUsdCapPerTeam !== undefined && patch.weeklyUsdCapPerTeam !== null) {
    requireNumber("weeklyUsdCapPerTeam", patch.weeklyUsdCapPerTeam, 0, Number.MAX_SAFE_INTEGER);
  }
  if (patch.contextCharLimit !== undefined) {
    requireInt("contextCharLimit", patch.contextCharLimit, 500, 100_000);
  }
  if (patch.maxStepsCap !== undefined) requireInt("maxStepsCap", patch.maxStepsCap, 1, 30);
  if (patch.editLock !== undefined) {
    requireWeekday("editLock.unlockDay", patch.editLock.unlockDay);
    requireWeekday("editLock.lockDay", patch.editLock.lockDay);
    requireHhmm("editLock.unlockTime", patch.editLock.unlockTime);
    requireHhmm("editLock.lockTime", patch.editLock.lockTime);
  }
  if (patch.windowOverrides !== undefined && patch.windowOverrides !== null) {
    for (const [label, override] of Object.entries(patch.windowOverrides)) {
      if (label.length < 1 || label.length > 48) {
        throw rulesError("window labels are 1–48 characters", "windowOverrides");
      }
      if (override.opensDay !== undefined) requireWeekday("windowOverrides.opensDay", override.opensDay);
      if (override.closesDay !== undefined) requireWeekday("windowOverrides.closesDay", override.closesDay);
      if (override.opensTime !== undefined) requireHhmm("windowOverrides.opensTime", override.opensTime);
      if (override.closesTime !== undefined) requireHhmm("windowOverrides.closesTime", override.closesTime);
      if (override.submissionLeadMinutes !== undefined) {
        requireInt("windowOverrides.submissionLeadMinutes", override.submissionLeadMinutes, 0, 720);
      }
      if (override.rounds !== undefined) requireInt("windowOverrides.rounds", override.rounds, 1, 10);
    }
  }
  if (patch.tradeReviewHours !== undefined) requireInt("tradeReviewHours", patch.tradeReviewHours, 0, 168);
  if (patch.fairnessFloor !== undefined) requireNumber("fairnessFloor", patch.fairnessFloor, 0, 2);
  if (patch.antiChurnWeeks !== undefined) requireInt("antiChurnWeeks", patch.antiChurnWeeks, 0, 17);
  if (patch.maxOpenProposals !== undefined) requireInt("maxOpenProposals", patch.maxOpenProposals, 0, 20);
  if (patch.maxMessagesPerRun !== undefined) requireInt("maxMessagesPerRun", patch.maxMessagesPerRun, 0, 50);
  if (patch.maxThreadsPerWindow !== undefined) {
    requireInt("maxThreadsPerWindow", patch.maxThreadsPerWindow, 0, 20);
  }
  if (patch.forumPostsPerDay !== undefined) requireInt("forumPostsPerDay", patch.forumPostsPerDay, 0, 50);
  if (patch.forumCommentsPerDay !== undefined) {
    requireInt("forumCommentsPerDay", patch.forumCommentsPerDay, 0, 200);
  }
}

/** JSON equality with `undefined` and `null` treated as the same "unset". */
function differs(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);
}

/** True once the draft has begun: rules are frozen except for `MUTABLE_AFTER_LOCK`. */
function rulesAreLocked(league: Doc<"leagues">, rules: Doc<"league_rules">): boolean {
  return rules.rulesLockedAt !== undefined || league.status !== "setup";
}

async function logRuleChange(
  ctx: MutationCtx,
  args: {
    leagueId: Id<"leagues">;
    userId: Id<"users"> | null;
    field: string;
    from: unknown;
    to: unknown;
    note?: string;
  },
): Promise<void> {
  await ctx.db.insert("league_rule_changes", {
    leagueId: args.leagueId,
    userId: args.userId ?? undefined,
    field: args.field,
    fromValue: args.from ?? null,
    toValue: args.to ?? null,
    note: args.note,
    createdAt: Date.now(),
  });
}

export type UpdateRulesResult = {
  rules: Doc<"league_rules">;
  changed: string[];
  /** Fields the caller asked for that the lock rejected — surfaced inline in the UI. */
  rejected: Array<{ field: string; reason: string }>;
};

/**
 * Apply a validated patch to `league_rules`.
 *
 * Post-lock, a field outside `MUTABLE_AFTER_LOCK` throws rather than silently
 * dropping — a commissioner who thinks they changed the scoring preset and did
 * not is worse than an error.
 */
async function applyRulesPatch(
  ctx: MutationCtx,
  leagueId: Id<"leagues">,
  userId: Id<"users"> | null,
  patch: RulesPatch,
): Promise<UpdateRulesResult> {
  validateRulesPatch(patch);

  const league = await ctx.db.get("leagues", leagueId);
  if (!league) throw rulesError("League not found");
  const rules = await rulesOf(ctx, leagueId);
  const locked = rulesAreLocked(league, rules);

  const stored = rules as unknown as Record<string, unknown>;
  const entries = Object.entries(patch).filter(([, value]) => value !== undefined) as Array<
    [RulesField, unknown]
  >;

  if (locked) {
    const blocked = entries
      .filter(([field]) => !MUTABLE_AFTER_LOCK.has(field))
      .filter(([field, value]) => differs(stored[field], value));
    if (blocked.length > 0) {
      throw rulesError(
        `Rules are locked (the draft has begun). ${blocked
          .map(([field]) => String(field))
          .join(", ")} cannot change; budgets, conduct settings and the model allowlist still can.`,
        String(blocked[0][0]),
      );
    }
  }

  if (patch.modelAllowlist) {
    for (const modelId of patch.modelAllowlist) assertPinnedModelId(modelId);
  }
  if (patch.fallbackModelId) assertPinnedModelId(patch.fallbackModelId, "fallbackModelId");

  const nextPlayoffStart = patch.playoffStartWeek ?? rules.playoffStartWeek;
  const nextRegular = patch.regularSeasonWeeks ?? rules.regularSeasonWeeks;
  if (nextPlayoffStart <= nextRegular) {
    throw rulesError("Playoffs must start after the regular season ends.", "playoffStartWeek");
  }

  const update: Record<string, unknown> = {};
  const changed: string[] = [];
  for (const [field, value] of entries) {
    if (!differs(stored[field], value)) continue;
    // `null` clears an optional column; `ctx.db.patch` removes a field set to
    // undefined. Fields in NULL_IS_A_VALUE keep the null: for them an absent
    // column means "platform default" and null means "the commissioner said none".
    update[field] = value === null && !NULL_IS_A_VALUE.has(field) ? undefined : value;
    changed.push(String(field));
  }

  if (changed.length === 0) return { rules, changed, rejected: [] };

  await ctx.db.patch("league_rules", rules._id, update as Partial<Doc<"league_rules">>);

  for (const field of changed) {
    await logRuleChange(ctx, {
      leagueId,
      userId,
      field: `rules.${field}`,
      from: stored[field] ?? null,
      to: update[field] ?? null,
      note: locked ? "changed after rules lock" : undefined,
    });
  }

  const updated = await ctx.db.get("league_rules", rules._id);
  if (!updated) throw rulesError("League rules not found");
  return { rules: updated, changed, rejected: [] };
}

const updateRulesResult = v.object({
  rules: rulesDoc,
  changed: v.array(v.string()),
  rejected: v.array(v.object({ field: v.string(), reason: v.string() })),
});

export const updateRules = mutation({
  args: { leagueId: v.id("leagues"), patch: rulesPatchValidator },
  returns: updateRulesResult,
  handler: async (ctx, { leagueId, patch }) => {
    const access = await requireCommissioner(ctx, leagueId);
    return applyRulesPatch(ctx, leagueId, access.viewer.userId, patch);
  },
});

/** Every focused setter returns the rules row, as its tRPC counterpart did. */
async function patchRules(
  ctx: MutationCtx,
  leagueId: Id<"leagues">,
  patch: RulesPatch,
): Promise<Doc<"league_rules">> {
  const access = await requireCommissioner(ctx, leagueId);
  const result = await applyRulesPatch(ctx, leagueId, access.viewer.userId, patch);
  return result.rules;
}

export const setModelAllowlist = mutation({
  args: { leagueId: v.id("leagues"), modelIds: v.array(v.string()) },
  returns: rulesDoc,
  handler: async (ctx, { leagueId, modelIds }) => {
    if (modelIds.length === 0) {
      throw rulesError("The allowlist must contain at least one model.", "modelAllowlist");
    }
    const unique = [...new Set(modelIds)];
    for (const modelId of unique) assertPinnedModelId(modelId);
    return patchRules(ctx, leagueId, { modelAllowlist: unique });
  },
});

export const setBudgets = mutation({
  args: {
    leagueId: v.id("leagues"),
    weeklyTokenCapPerTeam: v.optional(v.union(v.number(), v.null())),
    leagueUsdHardCap: v.optional(v.union(v.number(), v.null())),
    /** null removes the cap; the platform default applies until the commissioner sets one. */
    weeklyUsdCapPerTeam: v.optional(v.union(v.number(), v.null())),
  },
  returns: rulesDoc,
  handler: async (ctx, { leagueId, ...patch }) => patchRules(ctx, leagueId, patch),
});

export const setEditLock = mutation({
  args: { leagueId: v.id("leagues"), editLock: editLockConfig },
  returns: rulesDoc,
  handler: async (ctx, { leagueId, editLock }) => patchRules(ctx, leagueId, { editLock }),
});

export const setWindowOverrides = mutation({
  args: {
    leagueId: v.id("leagues"),
    windowOverrides: v.union(v.record(v.string(), windowOverride), v.null()),
  },
  returns: rulesDoc,
  // Explicit annotation: cross-calls internal functions (type cycle guard).
  handler: async (ctx, { leagueId, windowOverrides }): Promise<Doc<"league_rules">> => {
    const rules = await patchRules(ctx, leagueId, { windowOverrides });
    // Re-arm the open/close jobs of every not-yet-opened window for this week
    // and the next so the new template takes effect (PRD 5.3 overrides).
    const weekNo: number | null = await ctx.runQuery(internal.weeks.currentWeekNoInternal, {
      leagueId,
    });
    if (weekNo !== null) {
      for (const w of [weekNo, weekNo + 1]) {
        await ctx.runMutation(internal.windows.rescheduleForLeague, { leagueId, weekNo: w });
      }
    }
    return rules;
  },
});

export const setTransparency = mutation({
  args: { leagueId: v.id("leagues"), transparencyMode: transparencyMode },
  returns: rulesDoc,
  handler: async (ctx, { leagueId, transparencyMode: mode }) =>
    patchRules(ctx, leagueId, { transparencyMode: mode }),
});

export const setInjectionPolicy = mutation({
  args: { leagueId: v.id("leagues"), injectionPolicy: injectionPolicy },
  returns: rulesDoc,
  handler: async (ctx, { leagueId, injectionPolicy: policy }) =>
    patchRules(ctx, leagueId, { injectionPolicy: policy }),
});

export const setFallbacks = mutation({
  args: {
    leagueId: v.id("leagues"),
    fallbackModelId: v.optional(v.union(v.string(), v.null())),
    safetyAutopilot: v.optional(v.boolean()),
  },
  returns: rulesDoc,
  handler: async (ctx, { leagueId, ...patch }) => patchRules(ctx, leagueId, patch),
});

// ------------------------------------------------------------------- league

/** Name/visibility/draft settings. `draftType` freezes once the draft begins. */
export const updateLeague = mutation({
  args: {
    leagueId: v.id("leagues"),
    name: v.optional(v.string()),
    isPublic: v.optional(v.boolean()),
    draftType: v.optional(draftType),
    draftScheduledAt: v.optional(v.union(v.number(), v.null())),
  },
  returns: leagueDoc,
  handler: async (ctx, { leagueId, ...input }) => {
    const access = await requireCommissioner(ctx, leagueId);
    const league = access.league;
    const rules = await rulesOf(ctx, leagueId);
    const locked = rulesAreLocked(league, rules);

    if (input.name !== undefined && (input.name.trim().length < 3 || input.name.trim().length > 60)) {
      throw rulesError("League names are 3–60 characters.", "name");
    }
    if (locked && input.draftType && input.draftType !== league.draftType) {
      throw rulesError("The draft format cannot change once the draft has begun.", "draftType");
    }

    const stored = league as unknown as Record<string, unknown>;
    const update: Record<string, unknown> = {};
    const changed: string[] = [];
    for (const [field, value] of Object.entries(input)) {
      if (value === undefined) continue;
      const next = field === "name" ? (value as string).trim() : value;
      if (!differs(stored[field], next)) continue;
      update[field] = next === null ? undefined : next;
      changed.push(field);
    }
    if (changed.length === 0) return league;

    update.updatedAt = Date.now();
    await ctx.db.patch("leagues", leagueId, update as Partial<Doc<"leagues">>);

    for (const field of changed) {
      await logRuleChange(ctx, {
        leagueId,
        userId: access.viewer.userId,
        field: `league.${field}`,
        from: stored[field] ?? null,
        to: update[field] ?? null,
      });
    }
    const updated = await ctx.db.get("leagues", leagueId);
    if (!updated) throw rulesError("League not found");
    return updated;
  },
});

/**
 * Rotate the invite code, invalidating every previously shared link — and mint
 * one for a league that has none (`inviteLink` can no longer do that from a
 * query).
 */
export const rotateJoinCode = mutation({
  args: { leagueId: v.id("leagues") },
  returns: v.object({ code: v.string(), url: v.string() }),
  handler: async (ctx, { leagueId }) => {
    const access = await requireCommissioner(ctx, leagueId);
    const code = await mintJoinCode(ctx);
    await ctx.db.patch("leagues", leagueId, { joinCode: code, updatedAt: Date.now() });
    await logRuleChange(ctx, {
      leagueId,
      userId: access.viewer.userId,
      field: "league.joinCode",
      from: access.league.joinCode ?? null,
      to: "(rotated)",
    });
    return { code, url: joinUrl(code) };
  },
});

// -------------------------------------------------------------------- draft

/**
 * Begin the draft: generate the board, stamp the rules lock, flip the league to
 * `drafting`, log it.
 *
 * `internal.draft_progression.begin` builds the board (`internal.draft.start`:
 * shuffled order, one `draft_picks` row per (round, pick) for a snake draft or
 * lot 1 for an auction) and then opens the first pick window, whose scheduled
 * close job is the pick clock. It is called from here rather than scheduled so
 * the console can report the pick and order counts in the same round trip.
 */
type StartDraftResult = {
  leagueId: Id<"leagues">;
  status: "drafting";
  scheduledAt: number;
  boardGenerated: boolean;
  pickCount: number;
  orderCount: number;
};

export const startDraft = mutation({
  args: { leagueId: v.id("leagues"), scheduledAt: v.optional(v.union(v.number(), v.null())) },
  returns: v.object({
    leagueId: v.id("leagues"),
    status: v.literal("drafting"),
    scheduledAt: v.number(),
    boardGenerated: v.boolean(),
    /** Rows written to `draft_picks` (0 for an auction, which has no board). */
    pickCount: v.number(),
    /** Teams in the generated draft order. */
    orderCount: v.number(),
  }),
  // The explicit return type breaks the type cycle `commissioner -> _generated/api
  // -> draft -> commissioner` that `ctx.runMutation(internal.draft.start)` creates.
  handler: async (ctx, { leagueId, scheduledAt }): Promise<StartDraftResult> => {
    const access = await requireCommissioner(ctx, leagueId);
    const league = access.league;
    if (league.status !== "setup") {
      throw rulesError(`The draft has already started (league is ${league.status}).`);
    }

    // Bounded by construction: 8–14 teams per league.
    const teams = await ctx.db
      .query("teams")
      .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
      .collect();
    if (teams.length === 0) throw rulesError("This league has no teams.");
    const unowned = teams.filter((team) => team.ownerUserId === undefined).length;

    const now = Date.now();
    const startsAt = scheduledAt ?? league.draftScheduledAt ?? now;

    // Package G's board generator. It also flips the league to `drafting`,
    // pins `draftScheduledAt` and stamps `rulesLockedAt`.
    const board = await ctx.runMutation(internal.draft_progression.begin, {
      leagueId,
      type: league.draftType,
      scheduledAt: startsAt,
    });

    await ctx.db.patch("leagues", leagueId, {
      status: "drafting",
      draftScheduledAt: startsAt,
      updatedAt: now,
    });

    const rules = await rulesOf(ctx, leagueId);
    if (rules.rulesLockedAt === undefined) {
      await ctx.db.patch("league_rules", rules._id, { rulesLockedAt: now });
    }

    await logRuleChange(ctx, {
      leagueId,
      userId: access.viewer.userId,
      field: "league.status",
      from: league.status,
      to: "drafting",
      note:
        unowned > 0
          ? `draft started with ${unowned} unowned team(s) on default configs`
          : "draft started; rules locked",
    });

    return {
      leagueId,
      status: "drafting" as const,
      scheduledAt: startsAt,
      boardGenerated: true,
      pickCount: board.picks,
      orderCount: board.order.length,
    };
  },
});

// -------------------------------------------------------------------- teams

/** The team must belong to the league the caller is commissioner of. */
async function teamOfLeague(
  ctx: MutationCtx,
  leagueId: Id<"leagues">,
  teamId: Id<"teams">,
): Promise<Doc<"teams">> {
  const team = await ctx.db.get("teams", teamId);
  if (!team || team.leagueId !== leagueId) {
    throw appError("NOT_FOUND", "Team not found in this league.");
  }
  return team;
}

const ownerResult = v.object({
  teamId: v.id("teams"),
  ownerUserId: v.union(v.id("users"), v.null()),
});

async function assignOwnerTo(
  ctx: MutationCtx,
  leagueId: Id<"leagues">,
  teamId: Id<"teams">,
  userId: Id<"users"> | null,
  actingUserId: Id<"users">,
): Promise<{ teamId: Id<"teams">; ownerUserId: Id<"users"> | null }> {
  const team = await teamOfLeague(ctx, leagueId, teamId);

  if (userId) {
    const owner = await ctx.db.get("users", userId);
    if (!owner) throw rulesError("No such user", "userId");
    // Bounded by construction: 8–14 teams per league.
    const teams = await ctx.db
      .query("teams")
      .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
      .collect();
    const clash = teams.find((row) => row.ownerUserId === userId);
    if (clash && clash._id !== teamId) {
      throw rulesError(`${owner.name ?? "That user"} already owns ${clash.name}.`, "userId");
    }
  }

  await ctx.db.patch("teams", teamId, { ownerUserId: userId ?? undefined });
  if (userId) {
    // An assigned owner must be a league member, or the owner-only paths
    // (config editor, note to agent, veto votes) would refuse them. Never
    // downgrade a commissioner.
    const membership = await ctx.db
      .query("league_members")
      .withIndex("by_leagueId_userId", (q) => q.eq("leagueId", leagueId).eq("userId", userId))
      .unique();
    if (!membership) {
      await ctx.db.insert("league_members", { leagueId, userId, role: "owner", createdAt: Date.now() });
    } else if (membership.role === "spectator") {
      await ctx.db.patch("league_members", membership._id, { role: "owner" });
    }
  }
  await logRuleChange(ctx, {
    leagueId,
    userId: actingUserId,
    field: `team.${team.name}.owner`,
    from: team.ownerUserId ?? null,
    to: userId,
  });
  return { teamId, ownerUserId: userId };
}

export const assignOwner = mutation({
  args: {
    leagueId: v.id("leagues"),
    teamId: v.id("teams"),
    userId: v.union(v.id("users"), v.null()),
  },
  returns: ownerResult,
  handler: async (ctx, { leagueId, teamId, userId }) => {
    const access = await requireCommissioner(ctx, leagueId);
    return assignOwnerTo(ctx, leagueId, teamId, userId, access.viewer.userId);
  },
});

/** Assign by email — the console's actual affordance (PRD 5.1 team management). */
export const assignOwnerByEmail = mutation({
  args: { leagueId: v.id("leagues"), teamId: v.id("teams"), email: v.string() },
  returns: ownerResult,
  handler: async (ctx, { leagueId, teamId, email }) => {
    const access = await requireCommissioner(ctx, leagueId);
    const owner = await findByEmail(ctx, email);
    if (!owner) {
      throw rulesError(
        `No Fantasy Bench account for ${email}. Send them the invite link instead.`,
        "email",
      );
    }
    return assignOwnerTo(ctx, leagueId, teamId, owner._id, access.viewer.userId);
  },
});

export const renameTeam = mutation({
  args: {
    leagueId: v.id("leagues"),
    teamId: v.id("teams"),
    name: v.string(),
    abbreviation: v.optional(v.string()),
  },
  returns: teamDoc,
  handler: async (ctx, { leagueId, teamId, name, abbreviation }) => {
    const access = await requireCommissioner(ctx, leagueId);
    const trimmed = name.trim();
    if (trimmed.length < 2 || trimmed.length > 40) {
      throw rulesError("Team names are 2–40 characters.", "name");
    }
    const abbrev = abbreviation?.trim().toUpperCase();
    if (abbrev && (abbrev.length < 2 || abbrev.length > 5)) {
      throw rulesError("Abbreviations are 2–5 characters.", "abbreviation");
    }

    const team = await teamOfLeague(ctx, leagueId, teamId);
    const clash = await ctx.db
      .query("teams")
      .withIndex("by_leagueId_name", (q) => q.eq("leagueId", leagueId).eq("name", trimmed))
      .first();
    if (clash && clash._id !== teamId) {
      throw rulesError("Another team in this league already has that name.", "name");
    }

    await ctx.db.patch("teams", teamId, {
      name: trimmed,
      ...(abbrev ? { abbreviation: abbrev } : {}),
    });
    await logRuleChange(ctx, {
      leagueId,
      userId: access.viewer.userId,
      field: `team.${team.name}.name`,
      from: team.name,
      to: trimmed,
    });

    const updated = await ctx.db.get("teams", teamId);
    if (!updated) throw appError("NOT_FOUND", "Team not found.");
    return updated;
  },
});

// ------------------------------------------------- deprecated model swap

/**
 * A provider deprecated a pinned model mid-season (PRD 7 / risk table): point
 * every team that was running `fromModelId` at `toModelId`.
 *
 * Config versions are immutable, so each affected team gets a NEW version (same
 * context, same skills, same harness) summarised "commissioner replacement" —
 * the owner's history shows exactly when and why the model moved. The allowlist
 * and the fallback slot are rewritten too, so no owner can re-select the dead
 * model, and the swap is logged league-wide.
 *
 * This bypasses `configs.save` deliberately: the owner edit lock must not apply
 * to a commissioner replacement.
 */
export const replaceDeprecatedModel = mutation({
  args: { leagueId: v.id("leagues"), fromModelId: v.string(), toModelId: v.string() },
  returns: v.object({
    fromModelId: v.string(),
    toModelId: v.string(),
    teamsUpdated: v.array(
      v.object({
        teamId: v.id("teams"),
        teamName: v.string(),
        newVersionNo: v.number(),
      }),
    ),
    allowlistUpdated: v.boolean(),
  }),
  handler: async (ctx, { leagueId, fromModelId, toModelId }) => {
    const access = await requireCommissioner(ctx, leagueId);
    const userId = access.viewer.userId;

    assertPinnedModelId(toModelId, "toModelId");
    if (fromModelId === toModelId) {
      throw rulesError("Pick a different replacement model.", "toModelId");
    }

    const rules = await rulesOf(ctx, leagueId);
    const now = Date.now();

    // Bounded by construction: 8–14 teams (and one config each) per league.
    const teams = await ctx.db
      .query("teams")
      .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
      .collect();
    const nameById = new Map(teams.map((team) => [team._id as string, team.name]));

    const configs = await ctx.db
      .query("agent_configs")
      .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
      .collect();

    const teamsUpdated: Array<{ teamId: Id<"teams">; teamName: string; newVersionNo: number }> = [];

    for (const config of configs) {
      if (!config.currentVersionId) continue;
      const current = await ctx.db.get("config_versions", config.currentVersionId);
      if (!current || current.modelId !== fromModelId) continue;

      const [latest] = await ctx.db
        .query("config_versions")
        .withIndex("by_configId_versionNo", (q) => q.eq("configId", config._id))
        .order("desc")
        .take(1);
      const versionNo = (latest?.versionNo ?? current.versionNo) + 1;

      const versionId = await ctx.db.insert("config_versions", {
        configId: config._id,
        teamId: config.teamId,
        leagueId,
        versionNo,
        contextMd: current.contextMd,
        modelId: toModelId,
        harness: current.harness,
        // Same attachments, so `skills.usageCount` does not move.
        skillIds: current.skillIds,
        createdByUserId: userId,
        appliedAt: now,
        changeSummary: "commissioner replacement",
        createdAt: now,
      });

      await ctx.db.patch("agent_configs", config._id, {
        currentVersionId: versionId,
        updatedAt: now,
      });

      teamsUpdated.push({
        teamId: config.teamId,
        teamName: nameById.get(config.teamId) ?? "Unknown",
        newVersionNo: versionNo,
      });
    }

    let allowlistUpdated = false;
    const allowlist = rules.modelAllowlist ?? [];
    if (allowlist.includes(fromModelId)) {
      const next = [...new Set(allowlist.map((id) => (id === fromModelId ? toModelId : id)))];
      await ctx.db.patch("league_rules", rules._id, { modelAllowlist: next });
      await logRuleChange(ctx, {
        leagueId,
        userId,
        field: "rules.modelAllowlist",
        from: allowlist,
        to: next,
        note: "commissioner replacement",
      });
      allowlistUpdated = true;
    }
    if (rules.fallbackModelId === fromModelId) {
      await ctx.db.patch("league_rules", rules._id, { fallbackModelId: toModelId });
      await logRuleChange(ctx, {
        leagueId,
        userId,
        field: "rules.fallbackModelId",
        from: fromModelId,
        to: toModelId,
        note: "commissioner replacement",
      });
    }

    await logRuleChange(ctx, {
      leagueId,
      userId,
      field: "models.replaceDeprecated",
      from: fromModelId,
      to: toModelId,
      note: `commissioner replacement across ${teamsUpdated.length} team(s)`,
    });

    return { fromModelId, toModelId, teamsUpdated, allowlistUpdated };
  },
});
