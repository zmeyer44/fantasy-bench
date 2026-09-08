/**
 * Dev-only smoke helpers for the runtime package.
 *
 * `npx convex run runtime/dev:smokeLineup '{"leagueId":"…"}'` creates ONE pending
 * run against the newest lineup window that already has a ready snapshot, for the
 * league's first team, and puts it on the Workpool. It opens nothing and closes
 * nothing, so it is safe to run against the shared dev deployment while the
 * scheduler package is still landing `windows.open` / `windows.close`.
 *
 * Then: `npx convex data runs` should show the run terminal with steps, and
 * `npx convex run runtime/dev:runReport '{"runId":"…"}'` prints the trace
 * skeleton (status, steps, actions, usage events).
 */
import { v } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery } from "../_generated/server";
import { enqueueRun } from "../runs";

/** Windows scanned back from the newest before giving up on finding a snapshot. */
const WINDOW_SCAN = 40;

export const smokeLineup = internalMutation({
  args: {
    leagueId: v.id("leagues"),
    /** Defaults to the league's first team. */
    teamId: v.optional(v.id("teams")),
    modelId: v.optional(v.string()),
  },
  returns: v.object({
    runId: v.id("runs"),
    windowId: v.id("windows"),
    teamId: v.id("teams"),
    modelId: v.string(),
    workId: v.string(),
  }),
  handler: async (ctx, args) => {
    // Bounded: the newest `WINDOW_SCAN` windows of one league.
    const windows = await ctx.db
      .query("windows")
      .withIndex("by_leagueId_opensAt", (q) => q.eq("leagueId", args.leagueId))
      .order("desc")
      .take(WINDOW_SCAN);
    const window = windows.find(
      (w) => w.type === "lineup" && w.snapshotId != null && (w.status === "open" || w.status === "closed"),
    );
    if (!window) throw new Error("smokeLineup: no lineup window with a snapshot in this league");

    let team: Doc<"teams"> | null = args.teamId ? await ctx.db.get("teams", args.teamId) : null;
    if (!team) {
      // Bounded: one league's teams.
      const teams = await ctx.db
        .query("teams")
        .withIndex("by_leagueId", (q) => q.eq("leagueId", args.leagueId))
        .take(32);
      team = teams[0] ?? null;
    }
    if (!team) throw new Error("smokeLineup: league has no teams");

    const config = await ctx.db
      .query("agent_configs")
      .withIndex("by_teamId", (q) => q.eq("teamId", team._id))
      .unique();
    const version = config?.currentVersionId
      ? await ctx.db.get("config_versions", config.currentVersionId)
      : null;
    const modelId = args.modelId ?? version?.modelId ?? "mock/scripted";

    const runId: Id<"runs"> = await ctx.db.insert("runs", {
      windowId: window._id,
      leagueId: args.leagueId,
      teamId: team._id,
      modelId,
      kind: "team",
      status: "pending",
      windowType: window.type,
      windowLabel: window.label,
      weekNo: window.weekNo,
      attempt: 0,
      lastPersistedStep: -1,
      totalCostUsd: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      stepCount: 0,
      committedActionCount: 0,
      rejectedActionCount: 0,
    });
    await ctx.db.patch("windows", window._id, { runCount: window.runCount + 1 });
    const workId = await enqueueRun(ctx, runId);

    return { runId, windowId: window._id, teamId: team._id, modelId, workId };
  },
});

/** Everything the smoke test wants to eyeball about one run, in one call. */
export const runReport = internalQuery({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }) => {
    const run = await ctx.db.get("runs", runId);
    if (!run) return null;
    const steps = await ctx.db
      .query("run_steps")
      .withIndex("by_runId_stepIndex", (q) => q.eq("runId", runId))
      .take(64);
    const actions = await ctx.db
      .query("run_actions")
      .withIndex("by_runId_stepIndex", (q) => q.eq("runId", runId))
      .take(64);
    const usage = await ctx.db
      .query("usage_events")
      .withIndex("by_runId_stepIndex", (q) => q.eq("runId", runId))
      .take(64);
    return {
      status: run.status,
      outcome: run.outcome ?? null,
      error: run.error ?? null,
      modelId: run.modelId,
      attempt: run.attempt,
      stepCount: run.stepCount,
      lastPersistedStep: run.lastPersistedStep,
      totalCostUsd: run.totalCostUsd,
      totalInputTokens: run.totalInputTokens,
      totalOutputTokens: run.totalOutputTokens,
      rationale: run.rationale ?? null,
      fallbackApplied: run.fallbackApplied ?? null,
      steps: steps.map((s) => ({
        stepIndex: s.stepIndex,
        finishReason: s.finishReason ?? null,
        costUsd: s.costUsd,
        toolCalls: (Array.isArray(s.toolCalls) ? s.toolCalls : []).map(
          (c: { toolName?: string }) => c?.toolName ?? "?",
        ),
      })),
      actions: actions.map((a) => ({
        actionType: a.actionType,
        stepIndex: a.stepIndex,
        committed: a.committedAt != null,
      })),
      usageEvents: usage.length,
    };
  },
});
