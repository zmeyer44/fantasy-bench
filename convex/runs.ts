/**
 * Trace read models (PRD §5.8).
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
import { type WorkId } from "@convex-dev/workpool";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { DataModel, Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { agentCtxValidator, withAgentAction, type AgentCtx } from "./lib/agent_action";
import { requireLeagueRead, type LeagueAccess } from "./lib/auth";
import {
  CUSTOM_TOOL_PREFIX,
  isPrivateAt,
  redactPromptSections,
  redactToolCalls,
  redactToolResults,
  revealAtFor,
} from "./lib/visibility";
import { appError } from "./lib/errors";
import { round8 } from "./lib/pricing_pure";
import { paginationResult } from "./lib/validators";
import { modelLabel, windowLabelText } from "./lib/views_shared";
import { runPool } from "./runtime/pool";
import type { ExecuteRunSummary } from "./runtime/types";
import { promptSection, runStatus, stepUsage, windowType } from "./schema";

export const TRACE_PAGE_SIZE = 25;
/** Whole-team export cap, unchanged from `TEAM_EXPORT_RUN_LIMIT`. */
export const TEAM_EXPORT_RUN_LIMIT = 200;
const SEARCH_TEXT_LIMIT = 60_000;
const MAX_STEPS_PER_RUN = 64;
const MAX_ACTIONS_PER_RUN = 200;
const MAX_PAYLOADS_PER_RUN = 300;

/** One row of the trace list (dates are epoch ms). */
export type RunListItem = {
  id: Id<"runs">;
  leagueId: Id<"leagues">;
  teamId: Id<"teams"> | null;
  teamName: string | null;
  teamAbbreviation: string | null;
  windowId: Id<"windows">;
  windowLabel: string;
  windowLabelText: string;
  windowType: Doc<"windows">["type"];
  weekNo: number | null;
  roundNo: number;
  modelId: string;
  modelLabel: string;
  status: Doc<"runs">["status"];
  outcome: string | null;
  rationale: string | null;
  costUsd: number;
  stepCount: number;
  actionCount: number;
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
  configVersionNo: number | null;
  fallbackKind: string | null;
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
  /** Gateway-reported cost for this call when the provider returned one. */
  gatewayCostUsd: number | null;
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
  /**
   * Epoch ms until which this viewer sees the owner's prompt material and
   * custom-tool calls redacted (customisation cooldown); null when visible.
   */
  privateUntil: number | null;
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
    gatewayCostUsd: step.gatewayCostUsd ?? null,
    createdAt: step._creationTime,
    hasValidationError: Array.isArray(toolResults) && toolResults.some(resultHasError),
  };
}

/**
 * The customisation cooldown as it applies to one run: the team owner and the
 * commissioner see everything; everyone else sees owner material redacted until
 * three weeks after the run.
 */
export async function runPrivacy(
  ctx: QueryCtx,
  run: Doc<"runs">,
  access: LeagueAccess,
): Promise<{ privateUntil: number | null }> {
  const viewerUserId = access.viewer?.userId ?? null;
  const team = run.teamId ? await ctx.db.get("teams", run.teamId) : null;
  const canSeePrivate =
    viewerUserId !== null &&
    (access.isCommissioner || (team !== null && team.ownerUserId === viewerUserId));
  const privateUntil = isPrivateAt(run._creationTime, Date.now(), canSeePrivate)
    ? revealAtFor(run._creationTime)
    : null;
  return { privateUntil };
}

/** A step as this viewer may see it. */
function stepForViewer(step: Doc<"run_steps">, privateUntil: number | null): TraceStep {
  const base = toStep(step);
  if (privateUntil === null) return base;
  return {
    ...base,
    toolCalls: redactToolCalls(base.toolCalls, privateUntil),
    toolResults: redactToolResults(base.toolResults, privateUntil),
  };
}

async function buildDetail(
  ctx: QueryCtx,
  run: Doc<"runs">,
  privateUntil: number | null,
): Promise<TraceDetail> {
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
  if (privateUntil !== null) promptSections = redactPromptSections(promptSections, privateUntil);

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
          changeSummary: privateUntil === null ? (version.changeSummary ?? null) : null,
          createdAt: version._creationTime,
        }
      : null,
    promptSections,
    promptSectionsSource,
    privateUntil,
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
    const access = await requireLeagueRead(ctx, run.leagueId);
    const { privateUntil } = await runPrivacy(ctx, run, access);
    return buildDetail(ctx, run, privateUntil);
  },
});

export const steps = query({
  args: { runId: v.id("runs"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { runId, paginationOpts }) => {
    const run = await ctx.db.get("runs", runId);
    if (!run) throw appError("NOT_FOUND", "Run not found");
    const access = await requireLeagueRead(ctx, run.leagueId);
    const { privateUntil } = await runPrivacy(ctx, run, access);
    const page = await ctx.db
      .query("run_steps")
      .withIndex("by_runId_stepIndex", (q) => q.eq("runId", runId))
      .paginate(paginationOpts);
    return { ...page, page: page.page.map((step) => stepForViewer(step, privateUntil)) };
  },
});

/**
 * The run's usage ledger, paginated.
 *
 * The viewer used to rebuild these rows from the loaded steps, which meant the
 * ledger only ever showed the pages of steps that happened to be open and could
 * not show the gateway's own figure. `usage_events` is the authoritative
 * per-model-call record (one row per step, written by `ledger.recordStep`), so
 * the table subscribes to it directly.
 */
export const usageEvents = query({
  args: { runId: v.id("runs"), paginationOpts: paginationOptsValidator },
  returns: paginationResult(
    v.object({
      stepIndex: v.number(),
      modelId: v.string(),
      provider: v.string(),
      inputTokens: v.number(),
      outputTokens: v.number(),
      cachedInputTokens: v.number(),
      reasoningTokens: v.number(),
      latencyMs: v.union(v.number(), v.null()),
      costUsd: v.number(),
      computedCostUsd: v.number(),
      gatewayCostUsd: v.union(v.number(), v.null()),
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx, { runId, paginationOpts }) => {
    const run = await ctx.db.get("runs", runId);
    if (!run) throw appError("NOT_FOUND", "Run not found");
    await requireLeagueRead(ctx, run.leagueId);
    const page = await ctx.db
      .query("usage_events")
      .withIndex("by_runId_stepIndex", (q) => q.eq("runId", runId))
      .paginate(paginationOpts);
    return {
      ...page,
      page: page.page.map((event) => ({
        stepIndex: event.stepIndex,
        modelId: event.modelId,
        provider: event.provider,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cachedInputTokens: event.cachedInputTokens,
        reasoningTokens: event.reasoningTokens,
        latencyMs: event.latencyMs ?? null,
        costUsd: event.costUsd,
        computedCostUsd: event.computedCostUsd,
        gatewayCostUsd: event.gatewayCostUsd ?? null,
        createdAt: event.createdAt,
      })),
    };
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
    const access = await requireLeagueRead(ctx, run.leagueId);
    const { privateUntil } = await runPrivacy(ctx, run, access);
    if (privateUntil !== null && payload.toolName.startsWith(CUSTOM_TOOL_PREFIX)) {
      throw appError("FORBIDDEN", "This custom-tool result is private until the owner's cooldown passes.");
    }
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
 * Player names matching a search term — the "Player matches:" line under the
 * trace filters. `runs.search` resolves the same names for its own page, but the
 * line has to stay live as the term changes, so the UI subscribes to this
 * instead of re-reading a server-rendered page.
 */
export const searchPlayers = query({
  args: { leagueId: v.id("leagues"), q: v.string() },
  returns: v.array(
    v.object({
      playerId: v.id("players"),
      fullName: v.string(),
      position: v.string(),
      nflTeam: v.union(v.string(), v.null()),
    }),
  ),
  handler: async (ctx, { leagueId, q }) => {
    await requireLeagueRead(ctx, leagueId);
    const term = q.trim();
    if (term.length === 0) return [];
    const rows = await ctx.db
      .query("players")
      .withSearchIndex("search_fullName", (search) => search.search("fullName", term))
      .take(10);
    return rows.map((player) => ({
      playerId: player._id,
      fullName: player.fullName,
      position: player.position,
      nflTeam: player.nflTeam ?? null,
    }));
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

async function exportRun(
  ctx: QueryCtx,
  run: Doc<"runs">,
  access: LeagueAccess,
): Promise<TraceDetail & { steps: TraceStep[] }> {
  const { privateUntil } = await runPrivacy(ctx, run, access);
  const detail = await buildDetail(ctx, run, privateUntil);
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
    // Inline the overflow payloads first, then redact: a private custom-tool
    // result must not come back through the payload table either.
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
    if (privateUntil === null) return decorated;
    return {
      ...decorated,
      toolCalls: redactToolCalls(decorated.toolCalls, privateUntil),
      toolResults: redactToolResults(decorated.toolResults, privateUntil),
    };
  });

  return { ...detail, steps };
}

const exportRunQuery = query({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }): Promise<TraceExport> => {
    const run = await ctx.db.get("runs", runId);
    if (!run) throw appError("NOT_FOUND", "Run not found");
    const access = await requireLeagueRead(ctx, run.leagueId);
    return {
      version: 1,
      kind: "run",
      exportedAt: new Date(Date.now()).toISOString(),
      trace: await exportRun(ctx, run, access),
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
    const access = await requireLeagueRead(ctx, team.leagueId);
    const page = await ctx.db
      .query("runs")
      .withIndex("by_teamId", (q) => q.eq("teamId", teamId))
      .order("desc")
      .paginate(paginationOpts);
    const traces: Array<TraceDetail & { steps: TraceStep[] }> = [];
    for (const run of page.page) traces.push(await exportRun(ctx, run, access));
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

// ===========================================================================
// Phase 5a — the write half: the runtime's persistence contract.
//
// Ownership note: everything above this line is the Phase 2 read half and is
// untouched. Everything below is written by (or for) the agent runtime in
// `convex/runtime/**`, plus the two entry points the scheduler package calls:
// `enqueueRun` and `internal.runs.cancelForWindow`.
//
// The division of labour is deliberate and load-bearing:
//
//  - `internal.runtime.execute.executeRun` (an action) does the model work and
//    calls `markRunning` once and `persistStep` once per step. It NEVER writes a
//    terminal status.
//  - `internal.runs.onComplete` (the Workpool completion mutation) is the ONLY
//    writer of a terminal status, of `runs.finishedAt`, of
//    `windows.terminalRunCount`, and the only place the fallback model is
//    enqueued or the safety autopilot is scheduled.
//  - `internal.runs.cancelForWindow` is the escape hatch `windows.close` uses for
//    runs that are still in flight when the window shuts.
// ===========================================================================

/** Tool results larger than this move to `run_step_payloads` (PRD 5.8). */
export const PAYLOAD_INLINE_LIMIT = 64 * 1024;
/** Runs per window: one per team, with headroom for fallback-model retries. */
const MAX_RUNS_PER_WINDOW = 64;
/** Actions scanned when deciding whether a run committed its window's primary action. */
const MAX_ACTIONS_SCAN = 200;

const TERMINAL_STATUSES = new Set<Doc<"runs">["status"]>([
  "succeeded",
  "partial",
  "failed",
  "timed_out",
  "fallback",
  "skipped",
]);

export function isTerminalRunStatus(status: Doc<"runs">["status"]): boolean {
  return TERMINAL_STATUSES.has(status);
}

// ------------------------------------------------------------------ enqueue

/**
 * Put a pending run on the Workpool and remember its work id.
 *
 * The scheduler package (`windows.dispatch`) calls exactly this; nothing else
 * should call `runPool.enqueueAction` for a run, because `runs.workId` is what
 * `cancelForWindow` cancels and what the retry accounting hangs off.
 */
export async function enqueueRun(ctx: MutationCtx, runId: Id<"runs">): Promise<WorkId> {
  const workId = await runPool.enqueueAction(
    ctx,
    internal.runtime.execute.executeRun,
    { runId },
    { onComplete: internal.runs.onComplete, context: { runId } },
  );
  await ctx.db.patch("runs", runId, { workId });
  return workId;
}

/** `npx convex run runs:enqueue '{"runId":"…"}'` — the dev/smoke entry point. */
export const enqueue = internalMutation({
  args: { runId: v.id("runs") },
  returns: v.string(),
  handler: async (ctx, { runId }) => enqueueRun(ctx, runId),
});

// ------------------------------------------------------------- run lifecycle

/**
 * Mark a claimed run running and stamp what the executor resolved.
 *
 * Replaces the Postgres `claimRun` conditional UPDATE: the Workpool owns the
 * claim, so this only records the model, config version and prompt sections and
 * bumps `attempt` (one bump per Workpool attempt, so a retry is visible in the
 * trace).
 */
export const markRunning = internalMutation({
  args: {
    runId: v.id("runs"),
    modelId: v.string(),
    configVersionId: v.optional(v.id("config_versions")),
    promptSections: v.optional(v.array(promptSection)),
    keySource: v.optional(v.union(v.literal("league"), v.literal("team"))),
    now: v.optional(v.number()),
  },
  returns: v.object({ attempt: v.number(), running: v.boolean() }),
  handler: async (ctx, args) => {
    const run = await ctx.db.get("runs", args.runId);
    if (!run) throw appError("NOT_FOUND", "Run not found");
    if (isTerminalRunStatus(run.status)) return { attempt: run.attempt, running: false };
    const now = args.now ?? Date.now();
    const attempt = run.attempt + 1;
    await ctx.db.patch("runs", args.runId, {
      status: "running",
      startedAt: run.startedAt ?? now,
      modelId: args.modelId,
      attempt,
      ...(args.configVersionId ? { configVersionId: args.configVersionId } : {}),
      ...(args.promptSections ? { promptSections: args.promptSections } : {}),
      ...(args.keySource ? { keySource: args.keySource } : {}),
    });
    return { attempt, running: true };
  },
});

// ------------------------------------------------------------- write actions

/**
 * The replay check every write tool makes before it commits.
 *
 * `run_actions` is written by the service mutations themselves
 * (`convex/lib/agent_action.ts`), inside the same transaction as the domain
 * write. This query is the read side of that contract: a hit means the tool call
 * already happened and its stored result must be replayed verbatim.
 */
export const actionResult = internalQuery({
  args: { runId: v.id("runs"), toolCallId: v.string() },
  // Documented v.any(): the stored tool result, replayed verbatim to the model.
  returns: v.object({
    found: v.boolean(),
    committed: v.boolean(),
    result: v.optional(v.any()),
  }),
  handler: async (ctx, { runId, toolCallId }) => {
    const row = await ctx.db
      .query("run_actions")
      .withIndex("by_runId_toolCallId", (q) => q.eq("runId", runId).eq("toolCallId", toolCallId))
      .first();
    if (!row) return { found: false, committed: false };
    return { found: true, committed: row.committedAt != null, result: row.result };
  },
});

/**
 * Record a write-tool call that was rejected before it reached a service
 * mutation — a snapshot-level validation failure, or a mutation that threw so
 * its own transaction (and its `run_actions` row) rolled back.
 *
 * Idempotent on `(runId, toolCallId)`: a no-op when the mutation already wrote
 * the row itself, which is the common case.
 */
export const recordRejectedAction = internalMutation({
  args: {
    runId: v.id("runs"),
    toolCallId: v.string(),
    stepIndex: v.number(),
    actionType: v.string(),
    payload: v.record(v.string(), v.any()),
    errors: v.array(v.string()),
  },
  returns: v.object({ recorded: v.boolean() }),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("run_actions")
      .withIndex("by_runId_toolCallId", (q) =>
        q.eq("runId", args.runId).eq("toolCallId", args.toolCallId),
      )
      .first();
    if (existing) return { recorded: false };
    const run = await ctx.db.get("runs", args.runId);
    if (!run) return { recorded: false };
    await ctx.db.insert("run_actions", {
      runId: args.runId,
      leagueId: run.leagueId,
      teamId: run.teamId,
      toolCallId: args.toolCallId,
      stepIndex: args.stepIndex,
      actionType: args.actionType,
      payload: args.payload,
      validationResult: { ok: false, errors: args.errors },
      result: { ok: false, errors: args.errors },
    });
    await ctx.db.patch("runs", args.runId, {
      rejectedActionCount: run.rejectedActionCount + 1,
    });
    return { recorded: true };
  },
});

/**
 * `set_rationale`. The only write tool with no service of its own: the rationale
 * lives on the run document, so it is written here, under the same
 * `(runId, toolCallId)` contract as every other write tool.
 */
export const setRationale = internalMutation({
  args: { runId: v.id("runs"), text: v.string(), agentCtx: agentCtxValidator },
  returns: v.union(
    v.object({ ok: v.literal(true), chars: v.number() }),
    v.object({ ok: v.literal(false), errors: v.array(v.string()) }),
  ),
  handler: async (ctx, args) => {
    return withAgentAction(
      ctx,
      args.agentCtx as AgentCtx,
      { actionType: "set_rationale", payload: { text: args.text } },
      async () => {
        const text = args.text.trim();
        if (!text) return { ok: false as const, errors: ["Rationale text cannot be empty."] };
        await ctx.db.patch("runs", args.runId, { rationale: text });
        return { ok: true as const, chars: text.length };
      },
    );
  },
});

// --------------------------------------------------------------- persistStep

function byteLength(value: unknown): number {
  try {
    return JSON.stringify(value ?? null)?.length ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Commit one model step: the `run_steps` document, its oversized tool results,
 * and the run's running totals — in one transaction.
 *
 * `internal.ledger.recordStep` is called from inside this mutation via
 * `ctx.runMutation`, which joins the same transaction: the step document, the
 * usage event and the rollups commit together or not at all.
 *
 * Idempotent on `(runId, stepIndex)`: a replayed step writes nothing.
 */
export const persistStep = internalMutation({
  args: {
    runId: v.id("runs"),
    stepIndex: v.number(),
    modelId: v.string(),
    text: v.optional(v.string()),
    reasoning: v.optional(v.string()),
    // Documented v.any(): AI SDK payloads, exactly as the schema stores them.
    responseMessages: v.any(),
    toolCalls: v.any(),
    toolResults: v.any(),
    usage: stepUsage,
    finishReason: v.optional(v.string()),
    latencyMs: v.optional(v.number()),
    gatewayCostUsd: v.optional(v.number()),
    rationale: v.optional(v.string()),
    /** The run is executing on the league's fallback model. */
    isFallbackStep: v.optional(v.boolean()),
    /** Write-tool calls rejected by validation during this step. */
    invalidActionCount: v.optional(v.number()),
  },
  returns: v.object({
    persisted: v.boolean(),
    stepCount: v.number(),
    lastPersistedStep: v.number(),
    offloadedPayloads: v.number(),
    costUsd: v.number(),
  }),
  // Explicit annotation: this mutation cross-calls `internal.ledger.recordStep`;
  // without it the generated `api` type collapses to `any` (type cycle).
  handler: async (
    ctx,
    args,
  ): Promise<{
    persisted: boolean;
    stepCount: number;
    lastPersistedStep: number;
    offloadedPayloads: number;
    costUsd: number;
  }> => {
    const run = await ctx.db.get("runs", args.runId);
    if (!run) throw appError("NOT_FOUND", "Run not found");

    const existing = await ctx.db
      .query("run_steps")
      .withIndex("by_runId_stepIndex", (q) =>
        q.eq("runId", args.runId).eq("stepIndex", args.stepIndex),
      )
      .first();
    if (existing) {
      return {
        persisted: false,
        stepCount: run.stepCount,
        lastPersistedStep: run.lastPersistedStep,
        offloadedPayloads: 0,
        costUsd: existing.costUsd,
      };
    }

    // Ledger first, in this same transaction (PRD 5.9 / brief §7 "all of that is
    // one transaction"): the usage event and the three rollups commit with the
    // step document or not at all. `recordStep` is idempotent on (runId, stepIndex).
    const ledger: { costUsd: number } = await ctx.runMutation(internal.ledger.recordStep, {
      runId: args.runId,
      stepIndex: args.stepIndex,
      modelId: args.modelId,
      usage: {
        inputTokens: args.usage.inputTokens,
        outputTokens: args.usage.outputTokens,
        cachedInputTokens: args.usage.cachedInputTokens,
        reasoningTokens: args.usage.reasoningTokens,
      },
      ...(args.latencyMs === undefined ? {} : { latencyMs: args.latencyMs }),
      ...(args.gatewayCostUsd === undefined ? {} : { gatewayCostUsd: args.gatewayCostUsd }),
      ...(args.isFallbackStep ? { isFallbackStep: true } : {}),
      ...(args.invalidActionCount ? { invalidActionCount: args.invalidActionCount } : {}),
    });
    const costUsd = ledger.costUsd;

    // Oversized tool results move to `run_step_payloads` and leave a reference
    // behind, so a 400 KB search result cannot push the step past 1 MiB.
    const rawResults = Array.isArray(args.toolResults)
      ? (args.toolResults as Array<Record<string, unknown>>)
      : [];
    const storedResults: unknown[] = [];
    let offloadedPayloads = 0;
    for (const result of rawResults) {
      const bytes = byteLength(result);
      if (bytes <= PAYLOAD_INLINE_LIMIT) {
        storedResults.push(result);
        continue;
      }
      const toolCallId = typeof result?.toolCallId === "string" ? result.toolCallId : "unknown";
      const toolName = typeof result?.toolName === "string" ? result.toolName : "unknown";
      const payloadRef = await ctx.db.insert("run_step_payloads", {
        runId: args.runId,
        stepIndex: args.stepIndex,
        toolCallId,
        toolName,
        payload: result,
        bytes,
      });
      storedResults.push({
        type: "tool-result",
        toolCallId,
        toolName,
        payloadRef,
        bytes,
        truncated: true,
      });
      offloadedPayloads += 1;
    }

    const doc = {
      runId: args.runId,
      leagueId: run.leagueId,
      stepIndex: args.stepIndex,
      modelId: args.modelId,
      responseMessages: args.responseMessages ?? [],
      toolCalls: args.toolCalls ?? [],
      toolResults: storedResults,
      usage: args.usage,
      costUsd: round8(costUsd),
      ...(args.text ? { text: args.text } : {}),
      ...(args.reasoning ? { reasoning: args.reasoning } : {}),
      ...(args.finishReason ? { finishReason: args.finishReason } : {}),
      ...(args.latencyMs === undefined ? {} : { latencyMs: args.latencyMs }),
      ...(args.gatewayCostUsd === undefined ? {} : { gatewayCostUsd: args.gatewayCostUsd }),
    };
    await ctx.db.insert("run_steps", { ...doc, bytes: byteLength(doc) });

    const stepCount = Math.max(run.stepCount, args.stepIndex + 1);
    const lastPersistedStep = Math.max(run.lastPersistedStep, args.stepIndex);
    await ctx.db.patch("runs", args.runId, {
      stepCount,
      lastPersistedStep,
      totalCostUsd: round8(run.totalCostUsd + costUsd),
      totalInputTokens: run.totalInputTokens + args.usage.inputTokens,
      totalOutputTokens: run.totalOutputTokens + args.usage.outputTokens,
      ...(args.rationale ? { rationale: args.rationale } : {}),
    });

    return { persisted: true, stepCount, lastPersistedStep, offloadedPayloads, costUsd };
  },
});

// ---------------------------------------------------------------- completion

/** Did this run land the action its window exists for? */
async function committedActionTypes(
  ctx: MutationCtx,
  runId: Id<"runs">,
): Promise<Set<string>> {
  // Bounded: one run's actions.
  const rows = await ctx.db
    .query("run_actions")
    .withIndex("by_runId_stepIndex", (q) => q.eq("runId", runId))
    .take(MAX_ACTIONS_SCAN);
  const out = new Set<string>();
  for (const row of rows) if (row.committedAt != null) out.add(row.actionType);
  return out;
}

/**
 * Schedule the lineup safety autopilot for a run that ended without a lineup.
 *
 * PRD 5.4 fallbacks: a lineup window must never leave a team with an illegal or
 * empty lineup, whatever the agent did or failed to do.
 */
async function scheduleSafetyAutopilot(
  ctx: MutationCtx,
  run: Doc<"runs">,
  window: Doc<"windows">,
): Promise<boolean> {
  if (window.type !== "lineup" || !run.teamId || !window.snapshotId) return false;
  const rules = await ctx.db
    .query("league_rules")
    .withIndex("by_leagueId", (q) => q.eq("leagueId", run.leagueId))
    .unique();
  if (rules && rules.safetyAutopilot === false) return false;
  const committed = await committedActionTypes(ctx, run._id);
  if (committed.has("set_lineup")) return false;
  await ctx.scheduler.runAfter(0, internal.lineups.applySafetyAutopilot, {
    snapshotId: window.snapshotId,
    teamId: run.teamId,
    weekNo: run.weekNo,
    runId: run._id,
  });
  return true;
}

/** Read the action's return value defensively — the Workpool types it as `any`. */
function readSummary(value: unknown): Partial<ExecuteRunSummary> {
  if (!value || typeof value !== "object") return {};
  return value as Partial<ExecuteRunSummary>;
}

async function finishRun(
  ctx: MutationCtx,
  run: Doc<"runs">,
  patch: {
    status: Doc<"runs">["status"];
    outcome?: string | null;
    error?: string | null;
    fallbackApplied?: Doc<"runs">["fallbackApplied"] | null;
    modelId?: string;
  },
): Promise<void> {
  const window = await ctx.db.get("windows", run.windowId);
  await ctx.db.patch("runs", run._id, {
    status: patch.status,
    finishedAt: Date.now(),
    ...(patch.modelId ? { modelId: patch.modelId } : {}),
    ...(patch.outcome ? { outcome: patch.outcome } : {}),
    ...(patch.error ? { error: patch.error } : {}),
    ...(patch.fallbackApplied ? { fallbackApplied: patch.fallbackApplied } : {}),
  });
  if (window) {
    await ctx.db.patch("windows", window._id, {
      terminalRunCount: window.terminalRunCount + 1,
    });
    if (patch.status !== "succeeded") await scheduleSafetyAutopilot(ctx, run, window);
  }
  // `internal.ledger.recordRunOutcome` is a mutation, so it cannot be called
  // inline from another mutation; scheduling from a mutation is transactional and
  // exactly-once, which is the guarantee the ledger's idempotency needs.
  await ctx.scheduler.runAfter(0, internal.ledger.recordRunOutcome, {
    runId: run._id,
    status: patch.status,
    fallbackApplied: patch.fallbackApplied != null,
  });
  await ctx.scheduler.runAfter(0, internal.runs.upsertSearchDoc, { runId: run._id });
}

/**
 * Create and enqueue the fallback-model retry of a failed run.
 *
 * A new `runs` document rather than a mutation of the old one: the failed
 * attempt keeps its trace, and the fallback run carries `fallbackOfRunId` plus
 * `fallbackApplied.kind = 'fallback_model'` so the disclosure PRD 5.4 asks for is
 * in the data, not in prose.
 */
export async function enqueueFallbackRunFor(
  ctx: MutationCtx,
  run: Doc<"runs">,
  toModelId: string,
  detail: string,
): Promise<Id<"runs"> | null> {
  if (run.fallbackOfRunId) return null;
  if (!toModelId || toModelId === run.modelId) return null;
  const newRunId = await ctx.db.insert("runs", {
    windowId: run.windowId,
    leagueId: run.leagueId,
    ...(run.teamId ? { teamId: run.teamId } : {}),
    ...(run.configVersionId ? { configVersionId: run.configVersionId } : {}),
    modelId: toModelId,
    kind: run.kind,
    status: "pending",
    windowType: run.windowType,
    windowLabel: run.windowLabel,
    weekNo: run.weekNo,
    attempt: 0,
    lastPersistedStep: -1,
    totalCostUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    stepCount: 0,
    committedActionCount: 0,
    rejectedActionCount: 0,
    fallbackOfRunId: run._id,
    fallbackApplied: {
      kind: "fallback_model" as const,
      detail,
      fromModelId: run.modelId,
      toModelId,
    },
  });
  const window = await ctx.db.get("windows", run.windowId);
  if (window) await ctx.db.patch("windows", window._id, { runCount: window.runCount + 1 });
  await enqueueRun(ctx, newRunId);
  return newRunId;
}

export const enqueueFallbackRun = internalMutation({
  args: { runId: v.id("runs"), toModelId: v.string(), detail: v.optional(v.string()) },
  returns: v.union(v.null(), v.id("runs")),
  handler: async (ctx, { runId, toModelId, detail }) => {
    const run = await ctx.db.get("runs", runId);
    if (!run) return null;
    return enqueueFallbackRunFor(ctx, run, toModelId, detail ?? "primary run failed");
  },
});

/**
 * The Workpool completion mutation — the ONLY writer of a terminal run status.
 *
 *  - `success` → the status the action decided (`succeeded` / `partial` /
 *    `fallback` / `timed_out` / `skipped`), plus its outcome, error and fallback
 *    disclosure.
 *  - `failed`  → `failed` after the pool exhausted its retries; if the league
 *    names a fallback model and this run is not itself a fallback, a fresh run on
 *    that model is enqueued.
 *  - `canceled` → `timed_out`: the only thing that cancels a run is
 *    `windows.close`.
 *
 * It runs in its own transaction, after the action's, so everything it needs
 * about what the run did is already in `run_steps` / `run_actions`.
 */
const onCompleteContext = v.object({ runId: v.id("runs") });

export const onComplete = runPool.defineOnComplete<DataModel, typeof onCompleteContext>({
  context: onCompleteContext,
  handler: async (ctx, { context, result }) => {
    const run = await ctx.db.get("runs", context.runId);
    if (!run) return;

    // `windows.close` may have finalised this run already (it cancels the work
    // item and marks it `timed_out` in one transaction). Never double-count.
    if (isTerminalRunStatus(run.status)) {
      await ctx.scheduler.runAfter(0, internal.runs.upsertSearchDoc, { runId: run._id });
      return;
    }

    if (result.kind === "success") {
      const summary = readSummary(result.returnValue);
      await finishRun(ctx, run, {
        status: summary.status ?? "succeeded",
        outcome: summary.outcome ?? null,
        error: summary.error ?? null,
        fallbackApplied: summary.fallbackApplied ?? null,
        ...(summary.modelId ? { modelId: summary.modelId } : {}),
      });
      return;
    }

    if (result.kind === "canceled") {
      await finishRun(ctx, run, {
        status: "timed_out",
        outcome: "window_closed",
        error: "the run was cancelled when its window closed",
      });
      return;
    }

    const error = result.error;
    await finishRun(ctx, run, { status: "failed", outcome: "failed", error });

    const rules = await ctx.db
      .query("league_rules")
      .withIndex("by_leagueId", (q) => q.eq("leagueId", run.leagueId))
      .unique();
    const fallbackModelId = rules?.fallbackModelId;
    if (fallbackModelId) {
      await enqueueFallbackRunFor(
        ctx,
        run,
        fallbackModelId,
        `primary model failed (${error.slice(0, 500)})`,
      );
    }
  },
});

/**
 * Time out every run of a window that is still in flight, cancelling its
 * Workpool job first. Called by `windows.close`.
 *
 * Marking the status here (rather than waiting for the cancellation to surface
 * in `onComplete`) is what makes the close deterministic: the window is closed
 * with every run terminal, and `onComplete` sees a terminal run and does nothing.
 *
 * The lineup fallback is deliberately NOT applied here — `windows.close`
 * schedules `internal.windows.autopilotForTeam` for every team in the window
 * immediately after this call, which also covers teams whose run never started.
 */
export const cancelForWindow = internalMutation({
  args: { windowId: v.id("windows"), now: v.optional(v.number()) },
  returns: v.object({ cancelled: v.number() }),
  handler: async (ctx, { windowId, now }) => {
    const window = await ctx.db.get("windows", windowId);
    let cancelled = 0;
    for (const status of ["pending", "running"] as const) {
      // Bounded: one window's runs (one per team, plus fallback retries).
      const rows = await ctx.db
        .query("runs")
        .withIndex("by_windowId_status", (q) => q.eq("windowId", windowId).eq("status", status))
        .take(MAX_RUNS_PER_WINDOW);
      for (const run of rows) {
        if (run.workId) {
          try {
            await runPool.cancel(ctx, run.workId as WorkId);
          } catch {
            // Already finished or expired from the pool's status table; the
            // status write below is what matters.
          }
        }
        await ctx.db.patch("runs", run._id, {
          status: "timed_out",
          outcome: run.outcome ?? "window_closed",
          error: run.error ?? "the window closed before the run finished",
          finishedAt: now ?? Date.now(),
        });
        cancelled += 1;
        // No safety autopilot here: `internal.windows.close` schedules one per
        // team right after calling this, for every team in the window, which
        // covers runs that never started as well as these.
        await ctx.scheduler.runAfter(0, internal.ledger.recordRunOutcome, {
          runId: run._id,
          status: "timed_out" as const,
        });
        await ctx.scheduler.runAfter(0, internal.runs.upsertSearchDoc, { runId: run._id });
      }
    }
    if (window && cancelled > 0) {
      await ctx.db.patch("windows", windowId, {
        terminalRunCount: window.terminalRunCount + cancelled,
      });
    }
    return { cancelled };
  },
});

