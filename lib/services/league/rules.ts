/**
 * Commissioner console domain logic (PRD 5.1, 5.2, 7).
 *
 * Two rules drive everything here:
 *
 *  1. **Immutability.** Once the draft begins (`league_rules.rules_locked_at` is
 *     set, or the league has left `setup`), the rule set is frozen except for
 *     budgets, moderation/conduct settings, and the model allowlist/fallback —
 *     and every one of those changes is logged.
 *  2. **Everything is logged.** Every accepted field change writes a
 *     `league_rule_changes` row (league, user, field, from, to, created_at), so
 *     the Change log tab is a complete audit trail, not a summary.
 *
 * Model ids are always pinned: an id ending in `latest` is rejected, and an id
 * must either exist in `MODEL_CATALOG` or be a `mock/*` id (dev + tests).
 */
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { db, withTransaction, type DbOrTx } from "@/lib/db";
import {
  agentConfigs,
  configVersionSkills,
  configVersions,
  leagueRuleChanges,
  leagueRules,
  leagues,
  teams,
  user,
} from "@/lib/db/schema";
import type { League, LeagueRules } from "@/lib/db/types";
import { MODEL_CATALOG } from "@/lib/models";

import { joinLeague } from "./queries";

export type LeagueRuleChange = typeof leagueRuleChanges.$inferSelect;

// ---------------------------------------------------------------- errors

export class RulesError extends Error {
  readonly field?: string;
  constructor(message: string, field?: string) {
    super(message);
    this.name = "RulesError";
    this.field = field;
  }
}

// ------------------------------------------------------------ validation

const HHMM = /^([01]?\d|2[0-3]):[0-5]\d$/;
const WEEKDAY = z.enum(["sun", "mon", "tue", "wed", "thu", "fri", "sat"]);

/** A gateway model id we are willing to pin an agent to. */
export function isPinnedModelId(modelId: string): boolean {
  if (!modelId || /\blatest$/i.test(modelId.trim())) return false;
  if (modelId.startsWith("mock/")) return modelId.length > "mock/".length;
  return MODEL_CATALOG.some((entry) => entry.modelId === modelId);
}

export function assertPinnedModelId(modelId: string, field = "modelAllowlist"): void {
  if (/\blatest$/i.test(modelId.trim())) {
    throw new RulesError(
      `"${modelId}" is an alias. Model versions must be pinned for the season (PRD 5.1).`,
      field,
    );
  }
  if (!isPinnedModelId(modelId)) {
    throw new RulesError(`"${modelId}" is not a known model id.`, field);
  }
}

export const rosterSlotsSchema = z
  .record(z.string().min(1).max(12), z.number().int().min(0).max(20))
  .refine((slots) => Object.values(slots).some((count) => count > 0), {
    message: "At least one roster slot is required",
  });

export const editLockSchema = z.object({
  unlockDay: WEEKDAY,
  unlockTime: z.string().regex(HHMM, "Use HH:mm (24h) Eastern"),
  lockDay: WEEKDAY,
  lockTime: z.string().regex(HHMM, "Use HH:mm (24h) Eastern"),
});

export const windowOverrideSchema = z.object({
  enabled: z.boolean().optional(),
  opensDay: WEEKDAY.optional(),
  opensTime: z.string().regex(HHMM).optional(),
  closesDay: WEEKDAY.optional(),
  closesTime: z.string().regex(HHMM).optional(),
  submissionLeadMinutes: z.number().int().min(0).max(720).optional(),
  rounds: z.number().int().min(1).max(10).optional(),
});

export const windowOverridesSchema = z.record(z.string().min(1).max(48), windowOverrideSchema);

/** Every commissioner-editable field on `league_rules`. All optional — this is a patch. */
export const rulesPatchSchema = z.object({
  scoringPreset: z.enum(["ppr", "half_ppr", "standard"]).optional(),
  superflex: z.boolean().optional(),
  tePremium: z.boolean().optional(),
  rosterSlots: rosterSlotsSchema.optional(),
  faabBudget: z.number().int().min(0).max(1000).optional(),
  playoffTeams: z.number().int().min(2).max(8).optional(),
  playoffStartWeek: z.number().int().min(10).max(18).optional(),
  regularSeasonWeeks: z.number().int().min(4).max(17).optional(),
  transparencyMode: z.enum(["live", "delayed"]).optional(),
  injectionPolicy: z.enum(["permitted", "prohibited"]).optional(),
  modelAllowlist: z.array(z.string().min(1)).min(1).optional(),
  fallbackModelId: z.string().min(1).nullable().optional(),
  weeklyTokenCapPerTeam: z.number().int().min(0).nullable().optional(),
  leagueUsdHardCap: z.number().min(0).nullable().optional(),
  contextCharLimit: z.number().int().min(500).max(100_000).optional(),
  maxStepsCap: z.number().int().min(1).max(30).optional(),
  editLock: editLockSchema.optional(),
  windowOverrides: windowOverridesSchema.nullable().optional(),
  tradeReviewHours: z.number().int().min(0).max(168).optional(),
  fairnessFloor: z.number().min(0).max(2).optional(),
  antiChurnWeeks: z.number().int().min(0).max(17).optional(),
  maxOpenProposals: z.number().int().min(0).max(20).optional(),
  maxMessagesPerRun: z.number().int().min(0).max(50).optional(),
  maxThreadsPerWindow: z.number().int().min(0).max(20).optional(),
  forumPostsPerDay: z.number().int().min(0).max(50).optional(),
  forumCommentsPerDay: z.number().int().min(0).max(200).optional(),
  safetyAutopilot: z.boolean().optional(),
});

export type RulesPatch = z.infer<typeof rulesPatchSchema>;

/**
 * Fields that stay editable after the rules lock (PRD 5.1: "immutable once the
 * draft begins, except for budgets and moderation settings"), plus:
 *
 *  - `modelAllowlist` / `fallbackModelId` / `safetyAutopilot` — PRD 7 requires the
 *    commissioner to be able to designate a replacement when a provider
 *    deprecates a pinned model, and every such change is logged league-wide.
 *  - `editLock` / `windowOverrides` — PRD 5.5 explicitly gives the commissioner the
 *    lock window, and real-world schedule changes (a flexed game) have to be
 *    absorbable. These are schedule administration, not competitive rules.
 */
export const MUTABLE_AFTER_LOCK: ReadonlySet<keyof RulesPatch> = new Set([
  // budgets
  "weeklyTokenCapPerTeam",
  "leagueUsdHardCap",
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

// -------------------------------------------------------------- helpers

export async function getRules(leagueId: string, executor: DbOrTx = db): Promise<LeagueRules> {
  const rules = await executor.query.leagueRules.findFirst({
    where: eq(leagueRules.leagueId, leagueId),
  });
  if (!rules) throw new RulesError("League rules not found");
  return rules;
}

export async function getLeague(leagueId: string, executor: DbOrTx = db): Promise<League> {
  const league = await executor.query.leagues.findFirst({ where: eq(leagues.id, leagueId) });
  if (!league) throw new RulesError("League not found");
  return league;
}

/** True once the draft has begun: rules are frozen except for `MUTABLE_AFTER_LOCK`. */
export function rulesAreLocked(league: League, rules: LeagueRules): boolean {
  return rules.rulesLockedAt !== null || league.status !== "setup";
}

export async function logRuleChange(
  args: {
    leagueId: string;
    userId: string | null;
    field: string;
    from: unknown;
    to: unknown;
    note?: string;
  },
  executor: DbOrTx = db,
): Promise<void> {
  await executor.insert(leagueRuleChanges).values({
    leagueId: args.leagueId,
    userId: args.userId,
    field: args.field,
    fromValue: args.from ?? null,
    toValue: args.to ?? null,
    note: args.note ?? null,
  });
}

export async function listRuleChanges(
  leagueId: string,
  limit = 100,
  executor: DbOrTx = db,
): Promise<Array<LeagueRuleChange & { userName: string | null }>> {
  const rows = await executor
    .select({ change: leagueRuleChanges, userName: user.name })
    .from(leagueRuleChanges)
    .leftJoin(user, eq(user.id, leagueRuleChanges.userId))
    .where(eq(leagueRuleChanges.leagueId, leagueId))
    .orderBy(desc(leagueRuleChanges.createdAt))
    .limit(limit);
  return rows.map((row) => ({ ...row.change, userName: row.userName }));
}

function differs(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);
}

// ---------------------------------------------------------- updateRules

export type UpdateRulesResult = {
  rules: LeagueRules;
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
export async function updateRules(
  leagueId: string,
  userId: string | null,
  patch: RulesPatch,
  executor: DbOrTx = db,
): Promise<UpdateRulesResult> {
  const parsed = rulesPatchSchema.parse(patch);

  return withTransaction(async (tx) => {
    const league = await getLeague(leagueId, tx);
    const rules = await getRules(leagueId, tx);
    const locked = rulesAreLocked(league, rules);

    const entries = Object.entries(parsed).filter(([, value]) => value !== undefined) as Array<
      [keyof RulesPatch, unknown]
    >;

    if (locked) {
      const blocked = entries
        .filter(([field]) => !MUTABLE_AFTER_LOCK.has(field))
        .filter(([field, value]) => differs((rules as Record<string, unknown>)[field], value));
      if (blocked.length > 0) {
        throw new RulesError(
          `Rules are locked (the draft has begun). ${blocked
            .map(([field]) => String(field))
            .join(", ")} cannot change; budgets, conduct settings and the model allowlist still can.`,
          String(blocked[0][0]),
        );
      }
    }

    if (parsed.modelAllowlist) {
      for (const modelId of parsed.modelAllowlist) assertPinnedModelId(modelId);
    }
    if (parsed.fallbackModelId) assertPinnedModelId(parsed.fallbackModelId, "fallbackModelId");

    const nextPlayoffStart = parsed.playoffStartWeek ?? rules.playoffStartWeek;
    const nextRegular = parsed.regularSeasonWeeks ?? rules.regularSeasonWeeks;
    if (nextPlayoffStart <= nextRegular) {
      throw new RulesError(
        "Playoffs must start after the regular season ends.",
        "playoffStartWeek",
      );
    }

    const update: Record<string, unknown> = {};
    const changed: string[] = [];
    for (const [field, value] of entries) {
      if (!differs((rules as Record<string, unknown>)[field], value)) continue;
      update[field] = value;
      changed.push(String(field));
    }

    if (changed.length === 0) return { rules, changed, rejected: [] };

    const [updated] = await tx
      .update(leagueRules)
      .set(update)
      .where(eq(leagueRules.leagueId, leagueId))
      .returning();

    for (const field of changed) {
      await logRuleChange(
        {
          leagueId,
          userId,
          field: `rules.${field}`,
          from: (rules as Record<string, unknown>)[field] ?? null,
          to: update[field] ?? null,
          note: locked ? "changed after rules lock" : undefined,
        },
        tx,
      );
    }

    return { rules: updated, changed, rejected: [] };
  }, executor);
}

// -------------------------------------------------- focused rule setters

export async function setModelAllowlist(
  leagueId: string,
  userId: string | null,
  modelIds: string[],
  executor: DbOrTx = db,
): Promise<LeagueRules> {
  if (modelIds.length === 0) {
    throw new RulesError("The allowlist must contain at least one model.", "modelAllowlist");
  }
  const unique = [...new Set(modelIds)];
  for (const modelId of unique) assertPinnedModelId(modelId);
  const result = await updateRules(leagueId, userId, { modelAllowlist: unique }, executor);
  return result.rules;
}

export async function setBudgets(
  leagueId: string,
  userId: string | null,
  input: { weeklyTokenCapPerTeam?: number | null; leagueUsdHardCap?: number | null },
  executor: DbOrTx = db,
): Promise<LeagueRules> {
  const result = await updateRules(leagueId, userId, input, executor);
  return result.rules;
}

export async function setEditLock(
  leagueId: string,
  userId: string | null,
  editLock: z.infer<typeof editLockSchema>,
  executor: DbOrTx = db,
): Promise<LeagueRules> {
  const result = await updateRules(leagueId, userId, { editLock }, executor);
  return result.rules;
}

export async function setWindowOverrides(
  leagueId: string,
  userId: string | null,
  windowOverrides: z.infer<typeof windowOverridesSchema> | null,
  executor: DbOrTx = db,
): Promise<LeagueRules> {
  const result = await updateRules(leagueId, userId, { windowOverrides }, executor);
  return result.rules;
}

export async function setTransparency(
  leagueId: string,
  userId: string | null,
  transparencyMode: "live" | "delayed",
  executor: DbOrTx = db,
): Promise<LeagueRules> {
  const result = await updateRules(leagueId, userId, { transparencyMode }, executor);
  return result.rules;
}

export async function setInjectionPolicy(
  leagueId: string,
  userId: string | null,
  injectionPolicy: "permitted" | "prohibited",
  executor: DbOrTx = db,
): Promise<LeagueRules> {
  const result = await updateRules(leagueId, userId, { injectionPolicy }, executor);
  return result.rules;
}

export async function setFallbacks(
  leagueId: string,
  userId: string | null,
  input: { fallbackModelId?: string | null; safetyAutopilot?: boolean },
  executor: DbOrTx = db,
): Promise<LeagueRules> {
  const result = await updateRules(leagueId, userId, input, executor);
  return result.rules;
}

// -------------------------------------------------------------- league

export const updateLeagueSchema = z.object({
  name: z.string().min(3).max(60).optional(),
  isPublic: z.boolean().optional(),
  draftType: z.enum(["snake", "auction"]).optional(),
  draftScheduledAt: z.date().nullable().optional(),
});

export type UpdateLeagueInput = z.infer<typeof updateLeagueSchema>;

/** Name/visibility/draft settings. `draftType` freezes once the draft begins. */
export async function updateLeague(
  leagueId: string,
  userId: string | null,
  input: UpdateLeagueInput,
  executor: DbOrTx = db,
): Promise<League> {
  const parsed = updateLeagueSchema.parse(input);

  return withTransaction(async (tx) => {
    const league = await getLeague(leagueId, tx);
    const rules = await getRules(leagueId, tx);
    const locked = rulesAreLocked(league, rules);

    if (locked && parsed.draftType && parsed.draftType !== league.draftType) {
      throw new RulesError("The draft format cannot change once the draft has begun.", "draftType");
    }

    const update: Record<string, unknown> = {};
    const changed: string[] = [];
    for (const [field, value] of Object.entries(parsed)) {
      if (value === undefined) continue;
      if (!differs((league as Record<string, unknown>)[field], value)) continue;
      update[field] = value;
      changed.push(field);
    }
    if (changed.length === 0) return league;

    update.updatedAt = new Date();
    const [updated] = await tx
      .update(leagues)
      .set(update)
      .where(eq(leagues.id, leagueId))
      .returning();

    for (const field of changed) {
      await logRuleChange(
        {
          leagueId,
          userId,
          field: `league.${field}`,
          from: (league as Record<string, unknown>)[field] ?? null,
          to: update[field] ?? null,
        },
        tx,
      );
    }
    return updated;
  }, executor);
}

// --------------------------------------------------------- invite links

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomCode(length = 8): string {
  let out = "";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

/** The league's invite code, minting one on first use. */
export async function ensureJoinCode(leagueId: string, executor: DbOrTx = db): Promise<string> {
  const league = await getLeague(leagueId, executor);
  if (league.joinCode) return league.joinCode;

  for (let attempt = 0; attempt < 8; attempt++) {
    const code = randomCode();
    const [updated] = await executor
      .update(leagues)
      .set({ joinCode: code, updatedAt: new Date() })
      .where(and(eq(leagues.id, leagueId), isNull(leagues.joinCode)))
      .returning();
    if (updated?.joinCode) return updated.joinCode;
    const again = await getLeague(leagueId, executor);
    if (again.joinCode) return again.joinCode;
  }
  throw new RulesError("Could not mint an invite code; try again.");
}

export type InviteLink = { code: string; url: string };

export function joinUrl(code: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? "";
  return `${base}/leagues/join/${code}`;
}

export async function inviteLink(leagueId: string, executor: DbOrTx = db): Promise<InviteLink> {
  const code = await ensureJoinCode(leagueId, executor);
  return { code, url: joinUrl(code) };
}

/** Rotate the code, invalidating every previously shared link. */
export async function rotateJoinCode(
  leagueId: string,
  userId: string | null,
  executor: DbOrTx = db,
): Promise<InviteLink> {
  const league = await getLeague(leagueId, executor);
  const code = randomCode();
  await executor
    .update(leagues)
    .set({ joinCode: code, updatedAt: new Date() })
    .where(eq(leagues.id, leagueId));
  await logRuleChange(
    { leagueId, userId, field: "league.joinCode", from: league.joinCode, to: "(rotated)" },
    executor,
  );
  return { code, url: joinUrl(code) };
}

export async function getLeagueByJoinCode(
  code: string,
  executor: DbOrTx = db,
): Promise<League | undefined> {
  return executor.query.leagues.findFirst({ where: eq(leagues.joinCode, code.toUpperCase()) });
}

/** Join via an invite code. Wraps the existing `joinLeague`, which is idempotent. */
export async function joinByCode(
  code: string,
  userId: string,
  executor: DbOrTx = db,
): Promise<{ leagueId: string; teamId: string | null }> {
  const league = await getLeagueByJoinCode(code, executor);
  if (!league) throw new RulesError("That invite code is not valid.", "code");
  const { teamId } = await joinLeague(league.id, userId, executor);
  return { leagueId: league.id, teamId };
}

// ----------------------------------------------------------------- teams

export async function assignOwner(
  teamId: string,
  userId: string | null,
  actingUserId: string | null,
  executor: DbOrTx = db,
): Promise<{ teamId: string; ownerUserId: string | null }> {
  return withTransaction(async (tx) => {
    const team = await tx.query.teams.findFirst({ where: eq(teams.id, teamId) });
    if (!team) throw new RulesError("Team not found", "teamId");

    if (userId) {
      const owner = await tx.query.user.findFirst({ where: eq(user.id, userId) });
      if (!owner) throw new RulesError("No such user", "userId");
      const clash = await tx.query.teams.findFirst({
        where: and(eq(teams.leagueId, team.leagueId), eq(teams.ownerUserId, userId)),
      });
      if (clash && clash.id !== teamId) {
        throw new RulesError(`${owner.name} already owns ${clash.name}.`, "userId");
      }
    }

    const [updated] = await tx
      .update(teams)
      .set({ ownerUserId: userId })
      .where(eq(teams.id, teamId))
      .returning();

    await logRuleChange(
      {
        leagueId: team.leagueId,
        userId: actingUserId,
        field: `team.${team.name}.owner`,
        from: team.ownerUserId,
        to: userId,
      },
      tx,
    );

    return { teamId: updated.id, ownerUserId: updated.ownerUserId };
  }, executor);
}

/** Look a prospective owner up by email — the commissioner's assign-by-email flow. */
export async function findUserByEmail(email: string, executor: DbOrTx = db) {
  return executor.query.user.findFirst({ where: eq(user.email, email.trim().toLowerCase()) });
}

export async function renameTeam(
  teamId: string,
  name: string,
  actingUserId: string | null,
  opts: { abbreviation?: string } = {},
  executor: DbOrTx = db,
): Promise<{ teamId: string; name: string; abbreviation: string }> {
  const trimmed = name.trim();
  if (trimmed.length < 2 || trimmed.length > 40) {
    throw new RulesError("Team names are 2–40 characters.", "name");
  }
  const abbreviation = opts.abbreviation?.trim().toUpperCase();
  if (abbreviation && (abbreviation.length < 2 || abbreviation.length > 5)) {
    throw new RulesError("Abbreviations are 2–5 characters.", "abbreviation");
  }

  return withTransaction(async (tx) => {
    const team = await tx.query.teams.findFirst({ where: eq(teams.id, teamId) });
    if (!team) throw new RulesError("Team not found", "teamId");

    const clash = await tx.query.teams.findFirst({
      where: and(eq(teams.leagueId, team.leagueId), eq(teams.name, trimmed)),
    });
    if (clash && clash.id !== teamId) {
      throw new RulesError("Another team in this league already has that name.", "name");
    }

    const [updated] = await tx
      .update(teams)
      .set({ name: trimmed, ...(abbreviation ? { abbreviation } : {}) })
      .where(eq(teams.id, teamId))
      .returning();

    await logRuleChange(
      {
        leagueId: team.leagueId,
        userId: actingUserId,
        field: `team.${team.name}.name`,
        from: team.name,
        to: trimmed,
      },
      tx,
    );

    return { teamId: updated.id, name: updated.name, abbreviation: updated.abbreviation };
  }, executor);
}

// ----------------------------------------------------------------- draft

export type StartDraftResult = {
  leagueId: string;
  status: "drafting";
  scheduledAt: Date | null;
  /** True when `lib/services/draft` (scheduler package) generated the board. */
  boardGenerated: boolean;
};

/**
 * Begin the draft: stamp the rules lock, flip the league to `drafting`, and hand
 * off to the scheduler package's `startDraft` when it exists.
 *
 * The hand-off is a guarded dynamic import rather than a static one: the
 * scheduler owns `lib/services/draft` and its export surface is still moving
 * (`getDraftBoard`/`startDraft` have appeared and disappeared during this
 * build), so a static import would make this package fail to compile whenever
 * theirs is mid-edit. When `startDraft` is absent we set `draft_scheduled_at`
 * and the status and let the tick pick it up.
 */
export async function startDraft(
  leagueId: string,
  userId: string | null,
  opts: { scheduledAt?: Date | null } = {},
  executor: DbOrTx = db,
): Promise<StartDraftResult> {
  const league = await getLeague(leagueId, executor);
  if (league.status !== "setup") {
    throw new RulesError(`The draft has already started (league is ${league.status}).`);
  }

  const teamRows = await executor.select().from(teams).where(eq(teams.leagueId, leagueId));
  const unowned = teamRows.filter((team) => team.ownerUserId === null).length;
  if (teamRows.length === 0) throw new RulesError("This league has no teams.");

  const scheduledAt = opts.scheduledAt ?? league.draftScheduledAt ?? new Date();

  await withTransaction(async (tx) => {
    await tx
      .update(leagues)
      .set({ status: "drafting", draftScheduledAt: scheduledAt, updatedAt: new Date() })
      .where(eq(leagues.id, leagueId));
    await tx
      .update(leagueRules)
      .set({ rulesLockedAt: new Date() })
      .where(and(eq(leagueRules.leagueId, leagueId), isNull(leagueRules.rulesLockedAt)));
    await logRuleChange(
      {
        leagueId,
        userId,
        field: "league.status",
        from: league.status,
        to: "drafting",
        note:
          unowned > 0
            ? `draft started with ${unowned} unowned team(s) on default configs`
            : "draft started; rules locked",
      },
      tx,
    );
  }, executor);

  let boardGenerated = false;
  try {
    const draftModule = (await import("@/lib/services/draft")) as Record<string, unknown>;
    const start = draftModule.startDraft;
    if (typeof start === "function") {
      await (start as (id: string, o?: unknown) => Promise<unknown>)(leagueId, {
        type: league.draftType,
        scheduledAt,
      });
      boardGenerated = true;
    }
  } catch {
    boardGenerated = false;
  }

  return { leagueId, status: "drafting", scheduledAt, boardGenerated };
}

// ------------------------------------------------- deprecated model swap

export type ReplaceModelResult = {
  fromModelId: string;
  toModelId: string;
  teamsUpdated: Array<{ teamId: string; teamName: string; newVersionNo: number }>;
  allowlistUpdated: boolean;
};

/**
 * A provider deprecated a pinned model mid-season (PRD 7 / risk table): point
 * every team that was running `fromId` at `toId`.
 *
 * Config versions are immutable, so each affected team gets a NEW version
 * (same context, same skills, same harness) with the change summary
 * "commissioner replacement" — the owner's config history shows exactly when
 * and why the model moved. The swap is also logged league-wide.
 *
 * Config versions are written here rather than through `lib/services/config`
 * (console package) because that module is a contract stub whose save path
 * enforces the owner edit lock, which must not apply to a commissioner
 * replacement.
 */
export async function replaceDeprecatedModel(
  leagueId: string,
  userId: string | null,
  fromModelId: string,
  toModelId: string,
  executor: DbOrTx = db,
): Promise<ReplaceModelResult> {
  assertPinnedModelId(toModelId, "toModelId");
  if (fromModelId === toModelId) {
    throw new RulesError("Pick a different replacement model.", "toModelId");
  }

  return withTransaction(async (tx) => {
    const rules = await getRules(leagueId, tx);

    const teamRows = await tx
      .select({ id: teams.id, name: teams.name })
      .from(teams)
      .where(eq(teams.leagueId, leagueId));
    const teamIds = teamRows.map((t) => t.id);
    const nameById = new Map(teamRows.map((t) => [t.id, t.name]));

    const configRows =
      teamIds.length > 0
        ? await tx
            .select({
              configId: agentConfigs.id,
              teamId: agentConfigs.teamId,
              currentVersionId: agentConfigs.currentVersionId,
            })
            .from(agentConfigs)
            .where(inArray(agentConfigs.teamId, teamIds))
        : [];

    const teamsUpdated: ReplaceModelResult["teamsUpdated"] = [];

    for (const config of configRows) {
      if (!config.currentVersionId) continue;
      const current = await tx.query.configVersions.findFirst({
        where: eq(configVersions.id, config.currentVersionId),
      });
      if (!current || current.modelId !== fromModelId) continue;

      const [{ maxVersion } = { maxVersion: current.versionNo }] = await tx
        .select({ maxVersion: sql<number>`coalesce(max(${configVersions.versionNo}), 0)::int` })
        .from(configVersions)
        .where(eq(configVersions.configId, config.configId));

      const [version] = await tx
        .insert(configVersions)
        .values({
          configId: config.configId,
          versionNo: maxVersion + 1,
          contextMd: current.contextMd,
          modelId: toModelId,
          harness: current.harness,
          createdByUserId: userId,
          appliedAt: new Date(),
          changeSummary: "commissioner replacement",
        })
        .returning();

      const attachedSkills = await tx
        .select()
        .from(configVersionSkills)
        .where(eq(configVersionSkills.configVersionId, current.id));
      if (attachedSkills.length > 0) {
        await tx.insert(configVersionSkills).values(
          attachedSkills.map((skill) => ({
            configVersionId: version.id,
            skillId: skill.skillId,
            position: skill.position,
          })),
        );
      }

      await tx
        .update(agentConfigs)
        .set({ currentVersionId: version.id, updatedAt: new Date() })
        .where(eq(agentConfigs.id, config.configId));

      teamsUpdated.push({
        teamId: config.teamId,
        teamName: nameById.get(config.teamId) ?? "Unknown",
        newVersionNo: version.versionNo,
      });
    }

    // Swap the id in the allowlist and the fallback slot too, so no owner can
    // re-select the dead model.
    let allowlistUpdated = false;
    const allowlist = rules.modelAllowlist ?? [];
    if (allowlist.includes(fromModelId)) {
      const next = [...new Set(allowlist.map((id) => (id === fromModelId ? toModelId : id)))];
      await tx
        .update(leagueRules)
        .set({ modelAllowlist: next })
        .where(eq(leagueRules.leagueId, leagueId));
      await logRuleChange(
        {
          leagueId,
          userId,
          field: "rules.modelAllowlist",
          from: allowlist,
          to: next,
          note: "commissioner replacement",
        },
        tx,
      );
      allowlistUpdated = true;
    }
    if (rules.fallbackModelId === fromModelId) {
      await tx
        .update(leagueRules)
        .set({ fallbackModelId: toModelId })
        .where(eq(leagueRules.leagueId, leagueId));
      await logRuleChange(
        {
          leagueId,
          userId,
          field: "rules.fallbackModelId",
          from: fromModelId,
          to: toModelId,
          note: "commissioner replacement",
        },
        tx,
      );
    }

    await logRuleChange(
      {
        leagueId,
        userId,
        field: "models.replaceDeprecated",
        from: fromModelId,
        to: toModelId,
        note: `commissioner replacement across ${teamsUpdated.length} team(s)`,
      },
      tx,
    );

    return { fromModelId, toModelId, teamsUpdated, allowlistUpdated };
  }, executor);
}

/** Model ids currently in use by a team's live config — powers the swap tool's "from" list. */
export async function modelsInUse(
  leagueId: string,
  executor: DbOrTx = db,
): Promise<Array<{ modelId: string; teamCount: number }>> {
  const rows = await executor
    .select({ modelId: configVersions.modelId, teamCount: sql<number>`count(*)::int` })
    .from(teams)
    .innerJoin(agentConfigs, eq(agentConfigs.teamId, teams.id))
    .innerJoin(configVersions, eq(configVersions.id, agentConfigs.currentVersionId))
    .where(eq(teams.leagueId, leagueId))
    .groupBy(configVersions.modelId);
  return rows;
}
