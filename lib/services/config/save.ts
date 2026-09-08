/**
 * Writing a config version.
 *
 * Every save is an append: `config_versions` rows are immutable, and the only
 * column ever updated on them is `applied_at`. What a save changes is which
 * version the mutable `agent_configs` pointer names — and that depends entirely
 * on the edit lock (PRD 5.5):
 *
 *   inside the window  -> `current_version_id`, `applied_at = now`
 *   outside the window -> `pending_version_id` (replacing any earlier queue)
 */
import { and, desc, eq, inArray } from "drizzle-orm";

import { db, withTransaction, type DbOrTx } from "@/lib/db";
import {
  agentConfigs,
  configVersionSkills,
  configVersions,
  leagueMembers,
  leagueRules,
  leagues,
  skills,
  teams,
} from "@/lib/db/schema";
import type { ConfigVersion } from "@/lib/db/types";
import { findModel } from "@/lib/models";
import { formatET, isWithinEditWindow } from "@/lib/time";

import { ConfigForbiddenError, ConfigNotFoundError, ConfigValidationError, type ConfigIssue } from "./errors";
import {
  MAX_STEPS_CEILING,
  MAX_STEPS_FLOOR,
  TEMPERATURE_MAX,
  TEMPERATURE_MIN,
  TOKEN_BUDGET_MAX,
  TOKEN_BUDGET_MIN,
  modelSupportsReasoning,
  parseHarness,
  type HarnessSettings,
} from "./harness";
import {
  ensureAgentConfig,
  editLockStatusFor,
  getVersion,
  toEditLock,
  type ConfigVersionWithSkills,
} from "./queries";

export type SaveVersionInput = {
  teamId: string;
  userId: string;
  contextMd: string;
  modelId: string;
  harness: Partial<HarnessSettings>;
  skillIds: string[];
  changeSummary?: string | null;
  /** Clock injection point. Defaults to `new Date()`. */
  now?: Date;
};

export type SaveVersionResult = {
  version: ConfigVersionWithSkills;
  /** True when the edit window was open and this version is live immediately. */
  applied: boolean;
  /** True when the lock was closed and this version is queued for the next unlock. */
  queued: boolean;
  /** When the queued version goes live (null when it already applied). */
  appliesAt: Date | null;
  /** The note-to-agent text that was folded into the context, if any. */
  noteAppended: string | null;
};

/** Maximum skills attachable to one version — a soft guard on prompt blow-up. */
export const MAX_ATTACHED_SKILLS = 12;

/**
 * Create a new immutable version for a team.
 *
 * Validates against `league_rules`, folds in and clears the note-to-agent
 * scratchpad, then applies or queues depending on the edit lock.
 */
export async function saveVersion(
  input: SaveVersionInput,
  executor: DbOrTx = db,
): Promise<SaveVersionResult> {
  const now = input.now ?? new Date();

  return withTransaction(async (tx) => {
    const team = await tx.query.teams.findFirst({ where: eq(teams.id, input.teamId) });
    if (!team) throw new ConfigNotFoundError(`Team ${input.teamId} not found`);

    const league = await tx.query.leagues.findFirst({ where: eq(leagues.id, team.leagueId) });
    if (!league) throw new ConfigNotFoundError(`League ${team.leagueId} not found`);

    const rules = await tx.query.leagueRules.findFirst({
      where: eq(leagueRules.leagueId, team.leagueId),
    });

    await assertMayEdit({ userId: input.userId, team, leagueId: team.leagueId }, tx);

    const config = await ensureAgentConfig(input.teamId, tx);

    // ---- note to agent: appended to the context, then cleared (PRD 5.5) -----
    const note = (config.noteToAgent ?? "").trim();
    const contextMd = note
      ? `${input.contextMd.trimEnd()}\n\n${noteBlock(note, now)}`
      : input.contextMd;

    // ---- validation ---------------------------------------------------------
    const skillIds = dedupe(input.skillIds);
    const harness = parseHarnessStrictly(input.harness);
    const issues = validateAgainstRules({
      contextMd,
      modelId: input.modelId,
      harness,
      skillIds,
      rules,
      noteWasAppended: note.length > 0,
    });

    if (skillIds.length > 0) {
      const found = await tx
        .select({ id: skills.id })
        .from(skills)
        .where(inArray(skills.id, skillIds));
      const known = new Set(found.map((r) => r.id));
      const missing = skillIds.filter((id) => !known.has(id));
      if (missing.length > 0) {
        issues.push({ field: "skillIds", message: `Unknown skill(s): ${missing.join(", ")}` });
      }
    }

    if (issues.length > 0) throw new ConfigValidationError(issues);

    // ---- append the immutable version --------------------------------------
    const [latest] = await tx
      .select({ versionNo: configVersions.versionNo })
      .from(configVersions)
      .where(eq(configVersions.configId, config.id))
      .orderBy(desc(configVersions.versionNo))
      .limit(1);

    const versionNo = (latest?.versionNo ?? 0) + 1;
    const lock = toEditLock(rules?.editLock);
    const open = isWithinEditWindow(now, lock);

    const [version] = await tx
      .insert(configVersions)
      .values({
        configId: config.id,
        versionNo,
        contextMd,
        modelId: input.modelId,
        harness,
        createdByUserId: input.userId,
        createdAt: now,
        appliedAt: open ? now : null,
        changeSummary: input.changeSummary?.trim() || null,
      })
      .returning();

    if (skillIds.length > 0) {
      await tx.insert(configVersionSkills).values(
        skillIds.map((skillId, position) => ({
          configVersionId: version.id,
          skillId,
          position,
        })),
      );
    }

    // ---- apply or queue -----------------------------------------------------
    await tx
      .update(agentConfigs)
      .set(
        open
          ? {
              currentVersionId: version.id,
              pendingVersionId: null,
              noteToAgent: null,
              updatedAt: now,
            }
          : { pendingVersionId: version.id, noteToAgent: null, updatedAt: now },
      )
      .where(eq(agentConfigs.id, config.id));

    const hydrated = await getVersion(version.id, tx);
    if (!hydrated) throw new ConfigNotFoundError("Version disappeared after insert");

    return {
      version: hydrated,
      applied: open,
      queued: !open,
      appliesAt: open ? null : editLockStatusFor(lock, now).nextChange,
      noteAppended: note || null,
    };
  }, executor);
}

function noteBlock(note: string, now: Date): string {
  return `## Note from my owner (${formatET(now, "MMM d, yyyy")})\n\n${note}`;
}

function dedupe(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Fill defaults then round/coerce, but do NOT clamp — out-of-range values must
 * surface as validation errors on the save path rather than being silently fixed.
 */
function parseHarnessStrictly(partial: Partial<HarnessSettings>): HarnessSettings {
  const base = parseHarness({});
  return {
    maxSteps: partial.maxSteps ?? base.maxSteps,
    tokenBudget: partial.tokenBudget ?? base.tokenBudget,
    temperature: partial.temperature ?? base.temperature,
    reasoningEffort: partial.reasoningEffort ?? null,
    deliberateMode: partial.deliberateMode ?? base.deliberateMode,
  };
}

export type ValidationContext = {
  contextMd: string;
  modelId: string;
  harness: HarnessSettings;
  skillIds: string[];
  rules?: { contextCharLimit: number; modelAllowlist: string[]; maxStepsCap: number; weeklyTokenCapPerTeam: number | null } | null;
  noteWasAppended?: boolean;
};

/** Every rule from PRD 5.1/5.4 that a saved version must satisfy. Pure. */
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

  if (!Number.isInteger(tokenBudget) || tokenBudget < TOKEN_BUDGET_MIN || tokenBudget > TOKEN_BUDGET_MAX) {
    issues.push({
      field: "harness.tokenBudget",
      message: `Token budget must be between ${TOKEN_BUDGET_MIN.toLocaleString()} and ${TOKEN_BUDGET_MAX.toLocaleString()}`,
    });
  }
  const weeklyCap = rules?.weeklyTokenCapPerTeam ?? null;
  if (weeklyCap !== null && tokenBudget > weeklyCap) {
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

  if (reasoningEffort && !modelSupportsReasoning(ctx.modelId)) {
    issues.push({
      field: "harness.reasoningEffort",
      message: `${ctx.modelId} does not support reasoning effort`,
    });
  }

  if (ctx.skillIds.length > MAX_ATTACHED_SKILLS) {
    issues.push({
      field: "skillIds",
      message: `Attach at most ${MAX_ATTACHED_SKILLS} skills`,
    });
  }

  return issues;
}

/** Only the team's owner or the league commissioner may write a config version. */
export async function assertMayEdit(
  args: { userId: string; team: { ownerUserId: string | null; id: string }; leagueId: string },
  executor: DbOrTx = db,
): Promise<void> {
  if (args.team.ownerUserId && args.team.ownerUserId === args.userId) return;

  const membership = await executor.query.leagueMembers.findFirst({
    where: and(
      eq(leagueMembers.leagueId, args.leagueId),
      eq(leagueMembers.userId, args.userId),
    ),
  });
  if (membership?.role === "commissioner") return;

  throw new ConfigForbiddenError();
}

/** True when `userId` may edit `teamId`'s config. Used by the UI for read-only mode. */
export async function canEditConfig(
  teamId: string,
  userId: string | null | undefined,
  executor: DbOrTx = db,
): Promise<boolean> {
  if (!userId) return false;
  const team = await executor.query.teams.findFirst({ where: eq(teams.id, teamId) });
  if (!team) return false;
  try {
    await assertMayEdit({ userId, team, leagueId: team.leagueId }, executor);
    return true;
  } catch {
    return false;
  }
}

/**
 * Promote every queued version in a league to current. Called by the scheduler
 * tick at the edit-window unlock. Idempotent: teams with no pending version are
 * left alone. Returns the number of teams promoted.
 */
export async function applyPendingConfigVersions(
  leagueId: string,
  executor: DbOrTx = db,
): Promise<number> {
  return withTransaction(async (tx) => {
    const rows = await tx
      .select({ config: agentConfigs })
      .from(agentConfigs)
      .innerJoin(teams, eq(teams.id, agentConfigs.teamId))
      .where(eq(teams.leagueId, leagueId));

    const pending = rows
      .map((r) => r.config)
      .filter((c): c is typeof c & { pendingVersionId: string } => c.pendingVersionId !== null);
    if (pending.length === 0) return 0;

    const now = new Date();

    await tx
      .update(configVersions)
      .set({ appliedAt: now })
      .where(inArray(configVersions.id, pending.map((c) => c.pendingVersionId)));

    for (const config of pending) {
      await tx
        .update(agentConfigs)
        .set({
          currentVersionId: config.pendingVersionId,
          pendingVersionId: null,
          updatedAt: now,
        })
        .where(eq(agentConfigs.id, config.id));
    }

    return pending.length;
  }, executor);
}

/**
 * Set (or clear) the owner's scratchpad. The text is folded into the context on
 * the next save and cleared at that point. Authorisation is the caller's job —
 * the tRPC router applies `assertMayEdit`.
 */
export async function setNoteToAgent(
  teamId: string,
  text: string | null,
  executor: DbOrTx = db,
): Promise<{ noteToAgent: string | null }> {
  const config = await ensureAgentConfig(teamId, executor);
  const value = text?.trim() ? text.trim().slice(0, 4_000) : null;

  const [updated] = await executor
    .update(agentConfigs)
    .set({ noteToAgent: value, updatedAt: new Date() })
    .where(eq(agentConfigs.id, config.id))
    .returning();

  return { noteToAgent: updated?.noteToAgent ?? null };
}

export type { ConfigVersion };
