/**
 * Everything `internal.runtime.execute.executeRun` needs to read, as internal
 * queries.
 *
 * The action is not allowed to touch `ctx.db`, so every read the Postgres
 * executor did inline is one of these. Keeping them here (rather than in
 * `convex/runs.ts`) means the executor's read surface is owned by the runtime
 * package and the trace read models stay untouched.
 *
 * `runContext` is deliberately one round trip: run + window + league + rules +
 * team + the pinned config version + the frozen snapshot payload (reassembled
 * from `snapshot_chunks`) + its digest + the custom providers in scope. The four
 * things it does NOT return are the ones that already have owners elsewhere and
 * are internal queries in their own right, so a query cannot call them:
 * `internal.configs.currentForTeam`, `internal.ledger.remainingBudget`,
 * `internal.messaging.inboxForTeam` and `internal.forum.digest`. The action calls
 * those four itself, right after this one.
 */
import { v } from "convex/values";

import { keyProviderOf, type KeyProvider } from "../../lib/key-providers";
import { findModel } from "../../lib/models";
import {
  emptyDigest,
  type SnapshotDigest,
  type SnapshotPayload,
} from "../../lib/snapshot/types";
import type { Doc, Id } from "../_generated/dataModel";
import { internalQuery, type QueryCtx } from "../_generated/server";
import { catalogPrice, type ResolvedModelPrice } from "../lib/pricing_pure";
import { withLiveRosterOwnership } from "../lib/snapshot_live";
import { readPayload } from "../snapshot";

/** Custom providers in scope for one run; a league has a handful at most. */
const MAX_CUSTOM_PROVIDERS = 50;
/** Terminal runs scanned for `get_my_history` before the status filter. */
const HISTORY_SCAN = 40;
/** Actions replayed into the tool state when a retried attempt resumes. */
const MAX_PRIOR_ACTIONS = 200;
/** Maximum roster rows in one league (20 teams × 16 slots, with headroom). */
const MAX_ROSTER_ROWS = 400;
/** Hard ceiling on steps replayed on resume; `maxSteps` is always well under it. */
export const MAX_RESUME_STEPS = 64;

export type LoadedConfigVersion = {
  configVersionId: Id<"config_versions">;
  modelId: string;
  contextMd: string;
  harness: Doc<"config_versions">["harness"];
  skills: Array<{ name: string; bodyMd: string; description?: string }>;
  toolOverrides: Doc<"config_versions">["toolOverrides"];
};

export type RunContext = {
  run: Doc<"runs">;
  window: Doc<"windows">;
  league: Doc<"leagues">;
  rules: Doc<"league_rules"> | null;
  teamName: string;
  /** Only when the run pins a config version (a replay, or a run created mid-week). */
  pinnedConfig: LoadedConfigVersion | null;
  noteToAgent: string | null;
  snapshot: SnapshotPayload | null;
  digest: SnapshotDigest;
  customProviders: Doc<"custom_providers">[];
  /** The team's own key (Vercel or OpenRouter), still encrypted; the action decrypts it. Null = league key. */
  teamKey: {
    id: Id<"team_gateway_keys">;
    provider: KeyProvider;
    ciphertext: string;
    iv: string;
    last4: string;
  } | null;
  /**
   * What previous attempts of this run already did, so a resumed attempt can
   * rebuild its in-memory tool state instead of concluding the agent never
   * acted. Bounded by `MAX_PRIOR_ACTIONS`.
   */
  priorActions: Array<{ actionType: string; committed: boolean; lineupWarnings: string[] }>;
};

async function skillsFor(
  ctx: QueryCtx,
  version: Doc<"config_versions">,
): Promise<LoadedConfigVersion["skills"]> {
  const out: LoadedConfigVersion["skills"] = [];
  // Bounded: `skillIds` is capped by the config editor (12).
  for (const skillId of version.skillIds) {
    const skill = await ctx.db.get("skills", skillId);
    if (skill) {
      out.push({
        name: skill.name,
        bodyMd: skill.bodyMd,
        ...(skill.description ? { description: skill.description } : {}),
      });
    }
  }
  return out;
}

export const runContext = internalQuery({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }): Promise<RunContext | null> => {
    const run = await ctx.db.get("runs", runId);
    if (!run) return null;
    const window = await ctx.db.get("windows", run.windowId);
    if (!window) return null;
    const league = await ctx.db.get("leagues", run.leagueId);
    if (!league) return null;

    const rules = await ctx.db
      .query("league_rules")
      .withIndex("by_leagueId", (q) => q.eq("leagueId", run.leagueId))
      .unique();

    const team = run.teamId ? await ctx.db.get("teams", run.teamId) : null;

    const agentConfig = run.teamId
      ? await ctx.db
          .query("agent_configs")
          .withIndex("by_teamId", (q) => q.eq("teamId", run.teamId as Id<"teams">))
          .unique()
      : null;

    let pinnedConfig: LoadedConfigVersion | null = null;
    if (run.configVersionId) {
      const version = await ctx.db.get("config_versions", run.configVersionId);
      if (version) {
        pinnedConfig = {
          configVersionId: version._id,
          modelId: version.modelId,
          contextMd: version.contextMd,
          harness: version.harness,
          skills: await skillsFor(ctx, version),
          toolOverrides: version.toolOverrides,
        };
      }
    }

    let snapshot = window.snapshotId ? await readPayload(ctx, window.snapshotId) : null;
    if (snapshot && window.type === "draft") {
      const rosterRows = await ctx.db
        .query("roster_slots")
        .withIndex("by_leagueId_playerId", (q) => q.eq("leagueId", run.leagueId))
        .take(MAX_ROSTER_ROWS);
      snapshot = withLiveRosterOwnership(snapshot, rosterRows);
    }
    const digestRow = window.snapshotId
      ? await ctx.db
          .query("snapshot_digests")
          .withIndex("by_snapshotId", (q) => q.eq("snapshotId", window.snapshotId!))
          .unique()
      : null;
    const digest: SnapshotDigest = digestRow
      ? {
          headline: digestRow.headline,
          topNews: digestRow.topNews,
          injuryChanges: digestRow.injuryChanges,
          projectionMovers: digestRow.projectionMovers,
          standingsSummary: digestRow.standingsSummary,
        }
      : emptyDigest();

    // Bounded: `MAX_CUSTOM_PROVIDERS` per scope; a league has a handful at most.
    const leagueScoped = await ctx.db
      .query("custom_providers")
      .withIndex("by_leagueId", (q) => q.eq("leagueId", run.leagueId))
      .take(MAX_CUSTOM_PROVIDERS);
    const global = await ctx.db
      .query("custom_providers")
      .withIndex("by_leagueId", (q) => q.eq("leagueId", undefined))
      .take(MAX_CUSTOM_PROVIDERS);
    const customProviders = [...global, ...leagueScoped].filter(
      (p) => p.enabled && (p.teamId == null || p.teamId === run.teamId),
    );

    const teamKeyRow = run.teamId
      ? await ctx.db
          .query("team_gateway_keys")
          .withIndex("by_teamId", (q) => q.eq("teamId", run.teamId as Id<"teams">))
          .unique()
      : null;
    const teamKey = teamKeyRow
      ? {
          id: teamKeyRow._id,
          provider: keyProviderOf(teamKeyRow),
          ciphertext: teamKeyRow.ciphertext,
          iv: teamKeyRow.iv,
          last4: teamKeyRow.last4,
        }
      : null;

    // Bounded: one run's actions.
    const priorActions = (
      await ctx.db
        .query("run_actions")
        .withIndex("by_runId_stepIndex", (q) => q.eq("runId", runId))
        .take(MAX_PRIOR_ACTIONS)
    ).map((row) => {
      const result = row.result && typeof row.result === "object"
        ? (row.result as { warnings?: unknown })
        : null;
      return {
        actionType: row.actionType,
        committed: row.committedAt != null,
        lineupWarnings: Array.isArray(result?.warnings)
          ? result.warnings.filter((warning): warning is string => typeof warning === "string")
          : [],
      };
    });

    return {
      run,
      window,
      league,
      rules,
      teamName: team?.name ?? "Commissioner",
      pinnedConfig,
      noteToAgent: agentConfig?.noteToAgent ?? null,
      snapshot,
      digest,
      customProviders,
      teamKey,
      priorActions,
    };
  },
});

/**
 * The price in effect for `modelId` (the ledger's own resolution order:
 * `model_prices` first, then `lib/models.ts`, then a zero price so an unknown
 * model can never abort a run).
 */
export const modelPrice = internalQuery({
  args: { modelId: v.string(), at: v.optional(v.number()) },
  handler: async (ctx, { modelId, at }): Promise<ResolvedModelPrice> => {
    const row = await ctx.db
      .query("model_prices")
      .withIndex("by_modelId_effectiveFrom", (q) =>
        q.eq("modelId", modelId).lte("effectiveFrom", at ?? Date.now()),
      )
      .order("desc")
      .first();
    if (row) {
      return {
        modelId: row.modelId,
        provider: row.provider,
        displayName: row.displayName,
        inputPerM: row.inputPerM,
        outputPerM: row.outputPerM,
        cachedInputPerM: row.cachedInputPerM ?? null,
        reasoningPerM: row.reasoningPerM ?? null,
        supportsReasoning: row.supportsReasoning,
        source: "model_prices",
      };
    }
    if (findModel(modelId)) return catalogPrice(modelId);
    return catalogPrice(modelId);
  },
});

/**
 * The `responseMessages` of every step already committed for this run, in order.
 *
 * This is the resume seed: replaying them puts the model back exactly where the
 * previous attempt stopped, so steps ≤ `runs.lastPersistedStep` are never
 * re-executed and their tool calls are never re-committed.
 */
export const persistedMessages = internalQuery({
  args: { runId: v.id("runs"), upToStepIndex: v.number() },
  handler: async (
    ctx,
    { runId, upToStepIndex },
  ): Promise<Array<{ stepIndex: number; responseMessages: unknown }>> => {
    if (upToStepIndex < 0) return [];
    // Bounded: one run's steps, capped at `MAX_RESUME_STEPS`.
    const rows = await ctx.db
      .query("run_steps")
      .withIndex("by_runId_stepIndex", (q) =>
        q.eq("runId", runId).lte("stepIndex", upToStepIndex),
      )
      .take(MAX_RESUME_STEPS);
    return rows
      .sort((a, b) => a.stepIndex - b.stepIndex)
      .map((row) => ({ stepIndex: row.stepIndex, responseMessages: row.responseMessages }));
  },
});

export type HistoryRun = {
  runId: Id<"runs">;
  window: string;
  windowType: Doc<"runs">["windowType"];
  weekNo: number;
  status: Doc<"runs">["status"];
  outcome: string | null;
  rationale: string | null;
  modelId: string;
  costUsd: number;
  stepCount: number;
  finishedAt: string | null;
  fallbackApplied: Doc<"runs">["fallbackApplied"] | null;
};

/** `get_my_history`: this team's own finished runs, newest first. */
export const teamHistory = internalQuery({
  args: {
    teamId: v.id("teams"),
    excludeRunId: v.optional(v.id("runs")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { teamId, excludeRunId, limit }): Promise<HistoryRun[]> => {
    // Bounded: `HISTORY_SCAN` of one team's runs, newest first.
    const rows = await ctx.db
      .query("runs")
      .withIndex("by_teamId", (q) => q.eq("teamId", teamId))
      .order("desc")
      .take(HISTORY_SCAN);
    const terminal = new Set(["succeeded", "partial", "fallback", "failed", "timed_out"]);
    return rows
      .filter((r) => r._id !== excludeRunId && terminal.has(r.status))
      .slice(0, Math.max(1, Math.min(limit ?? 5, 20)))
      .map((r) => ({
        runId: r._id,
        window: r.windowLabel,
        windowType: r.windowType,
        weekNo: r.weekNo,
        status: r.status,
        outcome: r.outcome ?? null,
        rationale: r.rationale ?? null,
        modelId: r.modelId,
        costUsd: r.totalCostUsd,
        stepCount: r.stepCount,
        finishedAt: r.finishedAt ? new Date(r.finishedAt).toISOString() : null,
        fallbackApplied: r.fallbackApplied ?? null,
      }));
  },
});
