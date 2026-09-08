/**
 * Trace read models (PRD §5.8) — the port of `lib/services/views/traces.ts`.
 *
 * Three things changed shape:
 *
 *  1. **Search.** The old search was a Postgres `ILIKE` over `run_steps` wrapped
 *     in `EXISTS`. Convex has no equivalent, so every run keeps one small
 *     `run_search_docs` row with a search index (`search_text`) over player
 *     names, tool names, rationale, outcome and model text; the filters ride
 *     along as `filterFields`.
 *  2. **Counting.** `actionCount` comes from the run's denormalised
 *     `committedActionCount` + `rejectedActionCount`, and the list has no total
 *     (it is paginated — the UI shows "load more" instead of a page count).
 *  3. **Detail.** `trace()` returned run + steps + actions + usage in one go.
 *     Steps are now paginated (`runs.steps`) and large tool results are lazy
 *     (`runs.stepPayload`), so the viewer subscribes to a small document.
 */
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";

import type { TraceListItem as LegacyListItem } from "../lib/services/views/traces";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, query, type QueryCtx } from "./_generated/server";
import { requireLeagueRead } from "./lib/auth";
import { appError } from "./lib/errors";
import { modelLabel, windowLabelText } from "./lib/views_shared";
import { runStatus, windowType } from "./schema";

export const TRACE_PAGE_SIZE = 25;
/** Whole-team export cap, unchanged from `TEAM_EXPORT_RUN_LIMIT`. */
export const TEAM_EXPORT_RUN_LIMIT = 200;
const SEARCH_TEXT_LIMIT = 60_000;
const MAX_STEPS_PER_RUN = 64;
const MAX_ACTIONS_PER_RUN = 200;
const MAX_PAYLOADS_PER_RUN = 300;

/** `TraceListItem` with Convex ids and epoch-ms dates. */
export type RunListItem = Omit<
  LegacyListItem,
  "id" | "leagueId" | "teamId" | "windowId" | "startedAt" | "finishedAt" | "createdAt"
> & {
  id: Id<"runs">;
  leagueId: Id<"leagues">;
  teamId: Id<"teams"> | null;
  windowId: Id<"windows">;
  startedAt: number | null;
  finishedAt: number | null;
  createdAt: number;
};

export type PromptSection = {
  id: string;
  title: string;
  role: "system" | "user";
  chars: number;
  tokenEstimate: number;
  text: string;
};

export type TraceStep = {
  id: Id<"run_steps">;
  stepIndex: number;
  modelId: string;
  text: string | null;
  reasoning: string | null;
  toolCalls: unknown[];
  toolResults: unknown[];
  usage: Doc<"run_steps">["usage"];
  finishReason: string | null;
  latencyMs: number | null;
  costUsd: number;
  createdAt: number;
  /** True when any tool result in this step reports a validation failure. */
  hasValidationError: boolean;
};

export type TraceAction = {
  id: Id<"run_actions">;
  toolCallId: string;
  stepIndex: number;
  actionType: string;
  payload: Record<string, unknown>;
  validationResult: { ok: boolean; errors?: string[] };
  committedAt: number | null;
  createdAt: number;
};

export type TraceDetail = {
  run: RunListItem & {
    error: string | null;
    fallback: Doc<"runs">["fallbackApplied"] | null;
    totalInputTokens: number;
    totalOutputTokens: number;
    kind: string;
    attempt: number;
    lastPersistedStep: number;
  };
  league: { id: Id<"leagues">; name: string; isPublic: boolean };
  window: {
    id: Id<"windows">;
    type: Doc<"windows">["type"];
    label: string;
    labelText: string;
    weekNo: number;
    roundNo: number;
    opensAt: number;
    submissionDeadlineAt: number;
    closesAt: number;
    snapshotId: Id<"snapshots"> | null;
  };
  team: { id: Id<"teams">; name: string; abbreviation: string } | null;
  configVersion: {
    id: Id<"config_versions">;
    versionNo: number;
    modelId: string;
    changeSummary: string | null;
    createdAt: number;
  } | null;
  promptSections: PromptSection[];
  promptSectionsSource: "runtime" | "derived" | "none";
  actions: TraceAction[];
  /** Totals off the run document — the per-step figures live on each step. */
  usage: {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    stepCount: number;
    committedActionCount: number;
    rejectedActionCount: number;
  };
};

// ------------------------------------------------------------- decoration

/** Per-page cache so 25 runs sharing a window do not re-read it 25 times. */
type Decorator = {
  window: (id: Id<"windows">) => Promise<Doc<"windows"> | null>;
  team: (id: Id<"teams"> | undefined) => Promise<Doc<"teams"> | null>;
  version: (id: Id<"config_versions"> | undefined) => Promise<Doc<"config_versions"> | null>;
};

export function decorator(ctx: QueryCtx): Decorator {
  const windows = new Map<string, Doc<"windows"> | null>();
  const teams = new Map<string, Doc<"teams"> | null>();
  const versions = new Map<string, Doc<"config_versions"> | null>();
  return {
    async window(id) {
      if (!windows.has(id)) windows.set(id, await ctx.db.get("windows", id));
      return windows.get(id) ?? null;
    },
    async team(id) {
      if (!id) return null;
      if (!teams.has(id)) teams.set(id, await ctx.db.get("teams", id));
      return teams.get(id) ?? null;
    },
    async version(id) {
      if (!id) return null;
      if (!versions.has(id)) versions.set(id, await ctx.db.get("config_versions", id));
      return versions.get(id) ?? null;
    },
  };
}

export async function toListItem(run: Doc<"runs">, cache: Decorator): Promise<RunListItem> {
  const window = await cache.window(run.windowId);
  const team = await cache.team(run.teamId);
  const version = await cache.version(run.configVersionId);
  return {
    id: run._id,
    leagueId: run.leagueId,
    teamId: run.teamId ?? null,
    teamName: team?.name ?? null,
    teamAbbreviation: team?.abbreviation ?? null,
    windowId: run.windowId,
    windowLabel: run.windowLabel,
    windowLabelText: windowLabelText(run.windowLabel),
    windowType: run.windowType,
    weekNo: run.weekNo,
    roundNo: window?.roundNo ?? 1,
    modelId: run.modelId,
    modelLabel: modelLabel(run.modelId),
    status: run.status,
    outcome: run.outcome ?? null,
    rationale: run.rationale ?? null,
    costUsd: run.totalCostUsd ?? 0,
    stepCount: run.stepCount,
    actionCount: run.committedActionCount + run.rejectedActionCount,
    startedAt: run.startedAt ?? null,
    finishedAt: run.finishedAt ?? null,
    durationMs: run.startedAt && run.finishedAt ? run.finishedAt - run.startedAt : null,
    configVersionNo: version?.versionNo ?? null,
    fallbackKind: run.fallbackApplied?.kind ?? null,
    createdAt: run._creationTime,
  };
}

/** The most recent runs for a team (the team page's "recent traces" card). */
export async function recentRunsForTeam(
  ctx: QueryCtx,
  teamId: Id<"teams">,
  limit = 10,
): Promise<RunListItem[]> {
  const rows = await ctx.db
    .query("runs")
    .withIndex("by_teamId", (q) => q.eq("teamId", teamId))
    .order("desc")
    .take(limit);
  const cache = decorator(ctx);
  const out: RunListItem[] = [];
  for (const row of rows) out.push(await toListItem(row, cache));
  return out;
}

// -------------------------------------------------------------------- list

const filterArgs = {
  teamId: v.optional(v.id("teams")),
  windowType: v.optional(windowType),
  weekNo: v.optional(v.number()),
  status: v.optional(runStatus),
  modelId: v.optional(v.string()),
};

type Filters = {
  teamId?: Id<"teams">;
  windowType?: Doc<"runs">["windowType"];
  weekNo?: number;
  status?: Doc<"runs">["status"];
  modelId?: string;
};

/**
 * Runs for a league, newest first, paginated.
 *
 * The most selective filter picks the index; the rest are applied *inside* that
 * index range, never as a bare table filter.
 */
export const list = query({
  args: { leagueId: v.id("leagues"), ...filterArgs, paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    await requireLeagueRead(ctx, args.leagueId);
    const { leagueId, paginationOpts, ...filters } = args;
    const page = await runsQuery(ctx, leagueId, filters).paginate(paginationOpts);
    const cache = decorator(ctx);
    const items: RunListItem[] = [];
    for (const run of page.page) items.push(await toListItem(run, cache));
    return { ...page, page: items };
  },
});

function runsQuery(ctx: QueryCtx, leagueId: Id<"leagues">, f: Filters) {
  const base = f.teamId
    ? ctx.db
        .query("runs")
        .withIndex("by_leagueId_teamId", (q) =>
          q.eq("leagueId", leagueId).eq("teamId", f.teamId),
        )
    : f.modelId
      ? ctx.db
          .query("runs")
          .withIndex("by_leagueId_modelId", (q) =>
            q.eq("leagueId", leagueId).eq("modelId", f.modelId as string),
          )
      : f.weekNo !== undefined
        ? ctx.db
            .query("runs")
            .withIndex("by_leagueId_weekNo", (q) =>
              q.eq("leagueId", leagueId).eq("weekNo", f.weekNo as number),
            )
        : f.windowType
          ? ctx.db
              .query("runs")
              .withIndex("by_leagueId_windowType", (q) =>
                q.eq("leagueId", leagueId).eq("windowType", f.windowType!),
              )
          : f.status
            ? ctx.db
                .query("runs")
                .withIndex("by_leagueId_status", (q) =>
                  q.eq("leagueId", leagueId).eq("status", f.status!),
                )
            : ctx.db.query("runs").withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId));

  return base.order("desc").filter((q) => {
    const clauses = [];
    if (f.teamId) clauses.push(q.eq(q.field("teamId"), f.teamId));
    if (f.modelId) clauses.push(q.eq(q.field("modelId"), f.modelId));
    if (f.weekNo !== undefined) clauses.push(q.eq(q.field("weekNo"), f.weekNo));
    if (f.windowType) clauses.push(q.eq(q.field("windowType"), f.windowType));
    if (f.status) clauses.push(q.eq(q.field("status"), f.status));
    if (clauses.length === 0) return q.eq(q.field("leagueId"), leagueId);
    return clauses.reduce((a, b) => q.and(a, b));
  });
}

// ------------------------------------------------------------------ search

/**
 * Full-text search over `run_search_docs`.
 *
 * Same result shape as `list`, plus `matchedPlayers` — the old service resolved
 * the term against player names so a payload full of ids was searchable; here
 * the names are already in the indexed text, and the resolved list is kept so
 * the UI can still say what it searched for.
 */
export const search = query({
  args: {
    leagueId: v.id("leagues"),
    q: v.string(),
    ...filterArgs,
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireLeagueRead(ctx, args.leagueId);
    const term = args.q.trim();
    if (term.length === 0) {
      return {
        page: [] as RunListItem[],
        isDone: true,
        continueCursor: "",
        matchedPlayers: [] as Array<{ id: Id<"players">; fullName: string; position: string }>,
      };
    }

    const result = await ctx.db
      .query("run_search_docs")
      .withSearchIndex("search_text", (q) => {
        let search = q.search("text", term).eq("leagueId", args.leagueId);
        if (args.teamId) search = search.eq("teamId", args.teamId);
        if (args.windowType) search = search.eq("windowType", args.windowType);
        if (args.weekNo !== undefined) search = search.eq("weekNo", args.weekNo);
        if (args.status) search = search.eq("status", args.status);
        if (args.modelId) search = search.eq("modelId", args.modelId);
        return search;
      })
      .paginate(args.paginationOpts);

    const cache = decorator(ctx);
    const items: RunListItem[] = [];
    for (const doc of result.page) {
      const run = await ctx.db.get("runs", doc.runId);
      if (run) items.push(await toListItem(run, cache));
    }

    const matchedPlayers =
      term.length >= 3
        ? (
            await ctx.db
              .query("players")
              .withSearchIndex("search_fullName", (q) => q.search("fullName", term))
              .take(25)
          ).map((p) => ({ id: p._id, fullName: p.fullName, position: p.position }))
        : [];

    return { ...result, page: items, matchedPlayers };
  },
});

// ------------------------------------------------------------------ detail

/** Rebuild prompt sections from the first step's message array (pre-`promptSections` runs). */
function deriveSections(messages: unknown): PromptSection[] {
  if (!Array.isArray(messages)) return [];
  const sections: PromptSection[] = [];
  messages.forEach((message, index) => {
    if (!message || typeof message !== "object") return;
    const record = message as Record<string, unknown>;
    if (record.role !== "system" && record.role !== "user") return;
    const role = record.role === "system" ? "system" : "user";
    const text =
      typeof record.content === "string"
        ? record.content
        : JSON.stringify(record.content ?? "", null, 2);
    sections.push({
      id: `message-${index}`,
      title: role === "system" ? "System prompt" : "Initial user message",
      role,
      chars: text.length,
      tokenEstimate: Math.ceil(text.length / 4),
      text,
    });
  });
  return sections;
}

/** Best-effort: does this tool result look like a rejected write? */
export function resultHasError(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const record = result as Record<string, unknown>;
  const output = (record.output ?? record.result ?? record) as Record<string, unknown>;
  if (output && typeof output === "object") {
    if (output.ok === false) return true;
    if (Array.isArray(output.errors) && output.errors.length > 0) return true;
    if (typeof output.error === "string" && output.error.length > 0) return true;
  }
  return false;
}

function toStep(step: Doc<"run_steps">): TraceStep {
  const toolResults = (step.toolResults ?? []) as unknown[];
  return {
    id: step._id,
    stepIndex: step.stepIndex,
    modelId: step.modelId,
    text: step.text ?? null,
    reasoning: step.reasoning ?? null,
    toolCalls: (step.toolCalls ?? []) as unknown[],
    toolResults,
    usage: step.usage,
    finishReason: step.finishReason ?? null,
    latencyMs: step.latencyMs ?? null,
    costUsd: step.costUsd ?? 0,
    createdAt: step._creationTime,
    hasValidationError: Array.isArray(toolResults) && toolResults.some(resultHasError),
  };
}

async function buildDetail(ctx: QueryCtx, run: Doc<"runs">): Promise<TraceDetail> {
  const league = await ctx.db.get("leagues", run.leagueId);
  const window = await ctx.db.get("windows", run.windowId);
  if (!league || !window) throw appError("NOT_FOUND", "Run not found");
  const team = run.teamId ? await ctx.db.get("teams", run.teamId) : null;
  const version = run.configVersionId
    ? await ctx.db.get("config_versions", run.configVersionId)
    : null;

  const cache = decorator(ctx);
  const listItem = await toListItem(run, cache);

  // Bounded: one run's committed + rejected actions (maxSteps × tools per step).
  const actionRows = await ctx.db
    .query("run_actions")
    .withIndex("by_runId_stepIndex", (q) => q.eq("runId", run._id))
    .take(MAX_ACTIONS_PER_RUN);

  let promptSections: PromptSection[] = [];
  let promptSectionsSource: TraceDetail["promptSectionsSource"] = "none";
  if (run.promptSections && run.promptSections.length > 0) {
    promptSections = run.promptSections;
    promptSectionsSource = "runtime";
  } else {
    const first = await ctx.db
      .query("run_steps")
      .withIndex("by_runId_stepIndex", (q) => q.eq("runId", run._id))
      .first();
    const derived = deriveSections(first?.responseMessages);
    if (derived.length > 0) {
      promptSections = derived;
      promptSectionsSource = "derived";
    }
  }

  return {
    run: {
      ...listItem,
      error: run.error ?? null,
      fallback: run.fallbackApplied ?? null,
      totalInputTokens: run.totalInputTokens,
      totalOutputTokens: run.totalOutputTokens,
      kind: run.kind,
      attempt: run.attempt,
      lastPersistedStep: run.lastPersistedStep,
    },
    league: { id: league._id, name: league.name, isPublic: league.isPublic },
    window: {
      id: window._id,
      type: window.type,
      label: window.label,
      labelText: windowLabelText(window.label),
      weekNo: window.weekNo,
      roundNo: window.roundNo,
      opensAt: window.opensAt,
      submissionDeadlineAt: window.submissionDeadlineAt,
      closesAt: window.closesAt,
      snapshotId: window.snapshotId ?? null,
    },
    team: team ? { id: team._id, name: team.name, abbreviation: team.abbreviation } : null,
    configVersion: version
      ? {
          id: version._id,
          versionNo: version.versionNo,
          modelId: version.modelId,
          changeSummary: version.changeSummary ?? null,
          createdAt: version._creationTime,
        }
      : null,
    promptSections,
    promptSectionsSource,
    actions: actionRows.map((action) => ({
      id: action._id,
      toolCallId: action.toolCallId,
      stepIndex: action.stepIndex,
      actionType: action.actionType,
      payload: action.payload ?? {},
      validationResult: action.validationResult ?? { ok: true },
      committedAt: action.committedAt ?? null,
      createdAt: action._creationTime,
    })),
    usage: {
      inputTokens: run.totalInputTokens,
      outputTokens: run.totalOutputTokens,
      costUsd: run.totalCostUsd,
      stepCount: run.stepCount,
      committedActionCount: run.committedActionCount,
      rejectedActionCount: run.rejectedActionCount,
    },
  };
}

export const get = query({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }): Promise<TraceDetail> => {
    const run = await ctx.db.get("runs", runId);
    if (!run) throw appError("NOT_FOUND", "Run not found");
    await requireLeagueRead(ctx, run.leagueId);
    return buildDetail(ctx, run);
  },
});

export const steps = query({
  args: { runId: v.id("runs"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { runId, paginationOpts }) => {
    const run = await ctx.db.get("runs", runId);
    if (!run) throw appError("NOT_FOUND", "Run not found");
    await requireLeagueRead(ctx, run.leagueId);
    const page = await ctx.db
      .query("run_steps")
      .withIndex("by_runId_stepIndex", (q) => q.eq("runId", runId))
      .paginate(paginationOpts);
    return { ...page, page: page.page.map(toStep) };
  },
});

/** One overflowed tool result, loaded on demand by the trace viewer. */
export const stepPayload = query({
  args: { payloadId: v.id("run_step_payloads") },
  handler: async (ctx, { payloadId }) => {
    const payload = await ctx.db.get("run_step_payloads", payloadId);
    if (!payload) throw appError("NOT_FOUND", "Payload not found");
    const run = await ctx.db.get("runs", payload.runId);
    if (!run) throw appError("NOT_FOUND", "Run not found");
    await requireLeagueRead(ctx, run.leagueId);
    return {
      id: payload._id,
      runId: payload.runId,
      stepIndex: payload.stepIndex,
      toolCallId: payload.toolCallId,
      toolName: payload.toolName,
      payload: payload.payload as unknown,
      bytes: payload.bytes,
    };
  },
});

/**
 * Model ids that have actually run in this league — powers the filter select.
 * Read off `model_week_rollups` (per-league rows), never by scanning runs.
 */
export const modelOptions = query({
  args: { leagueId: v.id("leagues") },
  returns: v.array(
    v.object({ modelId: v.string(), label: v.string(), runCount: v.number() }),
  ),
  handler: async (ctx, { leagueId }) => {
    const { league } = await requireLeagueRead(ctx, leagueId);
    const counts = new Map<string, number>();
    // Bounded: one row per (model, week); week 0 covers draft/commissioner runs.
    for (let weekNo = 0; weekNo <= 22; weekNo++) {
      const rows = await ctx.db
        .query("model_week_rollups")
        .withIndex("by_leagueId_season_weekNo", (q) =>
          q.eq("leagueId", leagueId).eq("season", league.season).eq("weekNo", weekNo),
        )
        .take(50);
      for (const row of rows) {
        counts.set(row.modelId, (counts.get(row.modelId) ?? 0) + row.runCount);
      }
    }
    return [...counts.entries()]
      .map(([modelId, runCount]) => ({ modelId, label: modelLabel(modelId), runCount }))
      .sort((a, b) => b.runCount - a.runCount || a.modelId.localeCompare(b.modelId));
  },
});

// ------------------------------------------------------------------ export

export type TraceExport = {
  version: 1;
  kind: "run";
  exportedAt: string;
  trace: TraceDetail & { steps: TraceStep[] };
};

async function exportRun(ctx: QueryCtx, run: Doc<"runs">): Promise<TraceDetail & { steps: TraceStep[] }> {
  const detail = await buildDetail(ctx, run);
  // Bounded: a run has at most `maxStepsCap` steps (≤ 31 in every shipped config).
  const stepRows = await ctx.db
    .query("run_steps")
    .withIndex("by_runId_stepIndex", (q) => q.eq("runId", run._id))
    .take(MAX_STEPS_PER_RUN);
  // Bounded: overflow payloads for those steps.
  const payloadRows = await ctx.db
    .query("run_step_payloads")
    .withIndex("by_runId_stepIndex_toolCallId", (q) => q.eq("runId", run._id))
    .take(MAX_PAYLOADS_PER_RUN);
  const payloadByCall = new Map(payloadRows.map((row) => [row.toolCallId, row.payload]));

  const steps = stepRows.map((step) => {
    const decorated = toStep(step);
    decorated.toolResults = decorated.toolResults.map((result) => {
      if (!result || typeof result !== "object") return result;
      const record = result as Record<string, unknown>;
      const toolCallId = typeof record.toolCallId === "string" ? record.toolCallId : null;
      if (record.payloadRef && toolCallId && payloadByCall.has(toolCallId)) {
        return { ...record, output: payloadByCall.get(toolCallId), payloadRef: undefined };
      }
      return result;
    });
    return decorated;
  });

  return { ...detail, steps };
}

const exportRunQuery = query({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }): Promise<TraceExport> => {
    const run = await ctx.db.get("runs", runId);
    if (!run) throw appError("NOT_FOUND", "Run not found");
    await requireLeagueRead(ctx, run.leagueId);
    return {
      version: 1,
      kind: "run",
      exportedAt: new Date(Date.now()).toISOString(),
      trace: await exportRun(ctx, run),
    };
  },
});

export { exportRunQuery as export };

/**
 * One page of a whole-team export. The route handler pages through this; the
 * 16 MiB return cap is why a season cannot come back in one call.
 */
export const exportTeamPage = query({
  args: { teamId: v.id("teams"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { teamId, paginationOpts }) => {
    const team = await ctx.db.get("teams", teamId);
    if (!team) throw appError("NOT_FOUND", "Team not found");
    await requireLeagueRead(ctx, team.leagueId);
    const page = await ctx.db
      .query("runs")
      .withIndex("by_teamId", (q) => q.eq("teamId", teamId))
      .order("desc")
      .paginate(paginationOpts);
    const traces: Array<TraceDetail & { steps: TraceStep[] }> = [];
    for (const run of page.page) traces.push(await exportRun(ctx, run));
    return {
      ...page,
      version: 1 as const,
      kind: "team" as const,
      exportedAt: new Date(Date.now()).toISOString(),
      team: {
        id: team._id,
        name: team.name,
        abbreviation: team.abbreviation,
        leagueId: team.leagueId,
      },
      page: traces,
    };
  },
});

// ------------------------------------------------------------- search doc

/**
 * Rebuild one run's search document.
 *
 * Called by `persistStep` / `onComplete` in Phase 4-5; exposed here so the read
 * path and the write path share one definition of what is searchable: player
 * names, tool names, action types, rationale, outcome, model id and step text.
 */
export const upsertSearchDoc = internalMutation({
  args: { runId: v.id("runs") },
  returns: v.null(),
  handler: async (ctx, { runId }) => {
    const run = await ctx.db.get("runs", runId);
    if (!run) return null;

    const parts: string[] = [
      run.modelId,
      run.windowLabel,
      run.outcome ?? "",
      run.rationale ?? "",
    ];

    const stepRows = await ctx.db
      .query("run_steps")
      .withIndex("by_runId_stepIndex", (q) => q.eq("runId", runId))
      .take(MAX_STEPS_PER_RUN);
    for (const step of stepRows) {
      if (step.text) parts.push(step.text);
      const calls = (step.toolCalls ?? []) as Array<Record<string, unknown>>;
      if (Array.isArray(calls)) {
        for (const call of calls) {
          if (call && typeof call.toolName === "string") parts.push(call.toolName);
        }
      }
    }

    const actionRows = await ctx.db
      .query("run_actions")
      .withIndex("by_runId_stepIndex", (q) => q.eq("runId", runId))
      .take(MAX_ACTIONS_PER_RUN);
    const playerIds = new Set<Id<"players">>();
    for (const action of actionRows) {
      parts.push(action.actionType);
      collectPlayerIds(ctx, action.payload, playerIds);
    }
    for (const playerId of playerIds) {
      const player = await ctx.db.get("players", playerId);
      if (player) parts.push(player.fullName);
    }
    if (run.teamId) {
      const team = await ctx.db.get("teams", run.teamId);
      if (team) parts.push(team.name, team.abbreviation);
    }

    const text = parts.filter(Boolean).join(" \n").slice(0, SEARCH_TEXT_LIMIT);
    const row = {
      runId,
      leagueId: run.leagueId,
      teamId: run.teamId,
      windowType: run.windowType,
      weekNo: run.weekNo,
      status: run.status,
      modelId: run.modelId,
      text,
    };
    const existing = await ctx.db
      .query("run_search_docs")
      .withIndex("by_runId", (q) => q.eq("runId", runId))
      .unique();
    if (existing) await ctx.db.replace("run_search_docs", existing._id, row);
    else await ctx.db.insert("run_search_docs", row);
    return null;
  },
});

/** Pull every value out of an action payload that is a real `players` id. */
function collectPlayerIds(
  ctx: { db: { normalizeId: (table: "players", id: string) => Id<"players"> | null } },
  value: unknown,
  out: Set<Id<"players">>,
  depth = 0,
): void {
  if (depth > 4 || out.size >= 60) return;
  if (typeof value === "string") {
    const id = ctx.db.normalizeId("players", value);
    if (id) out.add(id);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPlayerIds(ctx, item, out, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectPlayerIds(ctx, item, out, depth + 1);
  }
}
