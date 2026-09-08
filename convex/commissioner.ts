/**
 * Commissioner console read models (PRD 5.1, 5.2, 7).
 *
 * Every function is commissioner-scoped (membership + role). The console's
 * mutations (updateRules, setBudgets, rotateJoinCode, …) are Phase 3; this file
 * carries only what the settings page renders on first paint.
 */
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { query } from "./_generated/server";
import { requireCommissioner } from "./lib/auth";
import { appError } from "./lib/errors";
import { leagueDoc, paginationResult, ruleChangeDoc, rulesDoc } from "./lib/validators";
import { MODEL_CATALOG } from "@/lib/models";

type Ctx = QueryCtx | MutationCtx;

/** The change log page caps at the same 200 rows the tRPC procedure defaulted to. */
const CHANGE_LOG_LIMIT = 200;

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
 * Deviation from `lib/services/league/rules.ts#inviteLink`: that function minted
 * a code on first read. A Convex query cannot write, so a league with no code
 * reports `null` and Phase 3's `commissioner.rotateJoinCode` mutation mints one.
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
