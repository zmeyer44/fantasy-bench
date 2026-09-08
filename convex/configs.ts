/**
 * Agent config read models (PRD 5.5).
 *
 * Everything here is PUBLIC WITHIN THE LEAGUE: configs, version history, diffs
 * and the lock status are visible to every member and to spectators of a public
 * league, so every query rides `requireLeagueRead`. Do not add ownership checks —
 * `canEdit` reports the write right, it does not gate the read.
 *
 * `save` / `setNote` are Phase 3. The pure validation they need already lives in
 * `convex/lib/config_pure.ts` (`validateAgainstRules`).
 */
import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { query } from "./_generated/server";
import { requireLeagueRead } from "./lib/auth";
import {
  editLockStatusFor,
  estimatePromptSize,
  parseHarness,
  toEditLock,
  weekStartMs,
  type ConfigDiff,
  type DiffableVersion,
  type EditLockStatus,
  type HarnessSettings,
  type PromptEstimate,
} from "./lib/config_pure";
import { diffVersionRows } from "./lib/config_pure";
import { appError } from "./lib/errors";
import { findModel } from "@/lib/models";

type Ctx = QueryCtx | MutationCtx;

export type ConfigVersionWithSkills = Doc<"config_versions"> & {
  harness: HarnessSettings;
  skills: Doc<"skills">[];
};

export type ConfigVersionSummary = Doc<"config_versions"> & {
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

/** Attached skills in injection order (the order of `skillIds`). Bounded at 12. */
async function hydrate(ctx: Ctx, version: Doc<"config_versions">): Promise<ConfigVersionWithSkills> {
  const skills: Doc<"skills">[] = [];
  for (const skillId of version.skillIds) {
    const skill = await ctx.db.get("skills", skillId);
    if (skill) skills.push(skill);
  }
  return { ...version, harness: parseHarness(version.harness), skills };
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
  for (const version of rows) {
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
      changedThisWeek: createdAtOf(version) >= weekStart,
      modelDisplayName: findModel(version.modelId)?.displayName ?? version.modelId,
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
    return {
      team,
      league: access.league,
      rules,
      config,
      current: current ? await hydrate(ctx, current) : null,
      pending: pending ? await hydrate(ctx, pending) : null,
      versions: config ? await listVersions(ctx, config, now) : [],
      lock: editLockStatusFor(toEditLock(rules?.editLock), now),
      canEdit:
        viewerUserId !== null && (team.ownerUserId === viewerUserId || access.isCommissioner),
      viewerUserId,
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
    await requireLeagueRead(ctx, leagueId);
    const team = await teamInLeague(ctx, teamId, leagueId);
    const config = await configOf(ctx, teamId);
    return {
      team,
      config,
      versions: config ? await listVersions(ctx, config, Date.now()) : [],
    };
  },
});

/** One version, hydrated with its skills, plus the version before it. */
export const version = query({
  args: { leagueId: v.id("leagues"), versionId: v.id("config_versions") },
  handler: async (
    ctx,
    { leagueId, versionId },
  ): Promise<{ version: ConfigVersionWithSkills; previous: ConfigVersionWithSkills | null }> => {
    await requireLeagueRead(ctx, leagueId);
    const row = await ctx.db.get("config_versions", versionId);
    if (!row || row.leagueId !== leagueId) throw appError("NOT_FOUND", "Version not found.");

    const priorRows = await ctx.db
      .query("config_versions")
      .withIndex("by_configId_versionNo", (q) =>
        q.eq("configId", row.configId).lt("versionNo", row.versionNo),
      )
      .order("desc")
      .take(1);

    return {
      version: await hydrate(ctx, row),
      previous: priorRows[0] ? await hydrate(ctx, priorRows[0]) : null,
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

/** Context diff + structured model/harness/skill diffs. Computed in the query (pure). */
export const diff = query({
  args: {
    leagueId: v.id("leagues"),
    a: v.id("config_versions"),
    b: v.id("config_versions"),
  },
  handler: async (ctx, { leagueId, a, b }): Promise<ConfigDiff> => {
    await requireLeagueRead(ctx, leagueId);
    const left = await ctx.db.get("config_versions", a);
    const right = await ctx.db.get("config_versions", b);
    if (!left || left.leagueId !== leagueId) throw appError("NOT_FOUND", `Config version ${a} not found`);
    if (!right || right.leagueId !== leagueId) throw appError("NOT_FOUND", `Config version ${b} not found`);
    return diffVersionRows(diffable(await hydrate(ctx, left)), diffable(await hydrate(ctx, right)));
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
