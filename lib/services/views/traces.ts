/**
 * Trace read models (PRD 5.8).
 *
 * ## Search
 *
 * Search is plain Postgres `ILIKE` against the trace tables, wrapped in
 * `EXISTS` sub-queries so one run never fans out into one row per step. There
 * is deliberately no `tsvector` column and no `pg_trgm` extension:
 *
 *  - `run_steps` / `run_actions` are append-only and owned by the runtime
 *    package, so this package must not add a generated column or a trigger to
 *    them.
 *  - The corpus is bounded (one league-season is a few thousand steps), the
 *    query is always filtered by `runs.league_id` first, and results are paged,
 *    so a sequential scan over a league's steps is cheap.
 *
 * Three kinds of term are supported, all from the same box:
 *
 *  1. **Free text** — matched against `run_steps.text`, `.reasoning`,
 *     `.messages::text`, `.tool_calls::text`, `.tool_results::text`, plus
 *     `runs.rationale` / `runs.outcome` / `runs.model_id`.
 *  2. **Tool name** — matched against `run_actions.action_type` and, via the
 *     `tool_calls` JSON text, the AI SDK's `toolName` field.
 *  3. **Player name** — resolved first against `players.full_name`; the
 *     matching player uuids (and Sleeper ids) are then matched against the
 *     JSON text of tool calls, tool results and committed action payloads,
 *     which is where a `set_lineup` / `submit_waiver_claims` payload records
 *     them. Player names also frequently appear verbatim in step text, which
 *     (1) already covers.
 *
 * If this ever gets slow the upgrade path is a `run_search` materialized table
 * owned by this package, not an index on someone else's append-only table.
 */
import { and, desc, eq, ilike, inArray, sql, type SQL } from "drizzle-orm";

import { db, type DbOrTx } from "@/lib/db";
import {
  configVersions,
  leagues,
  players,
  runActions,
  runSteps,
  runs,
  teams,
  usageEvents,
  windows,
} from "@/lib/db/schema";
import type { RunStatus, WindowType } from "@/lib/db/types";
import type { PromptSection } from "@/lib/db/schema/runs";

import { modelLabel, windowLabelText } from "./shared";

export const TRACE_PAGE_SIZE = 25;

export type TraceListItem = {
  id: string;
  leagueId: string;
  teamId: string | null;
  teamName: string | null;
  teamAbbreviation: string | null;
  windowId: string;
  windowLabel: string;
  windowLabelText: string;
  windowType: WindowType;
  weekNo: number | null;
  roundNo: number;
  modelId: string;
  modelLabel: string;
  status: RunStatus;
  outcome: string | null;
  rationale: string | null;
  costUsd: number;
  stepCount: number;
  actionCount: number;
  startedAt: Date | null;
  finishedAt: Date | null;
  durationMs: number | null;
  configVersionNo: number | null;
  fallbackKind: string | null;
  createdAt: Date;
};

export type TraceListFilters = {
  leagueId: string;
  teamId?: string;
  windowType?: WindowType;
  weekNo?: number;
  status?: RunStatus;
  modelId?: string;
  q?: string;
  page?: number;
  pageSize?: number;
};

export type TraceListResult = {
  items: TraceListItem[];
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
  /** Player names the query resolved to, so the UI can say what it searched for. */
  matchedPlayers: Array<{ id: string; fullName: string; position: string }>;
};

/** Build the ILIKE/EXISTS predicate for a free-text query. */
async function searchCondition(
  leagueId: string,
  term: string,
  executor: DbOrTx,
): Promise<{ condition: SQL; matchedPlayers: TraceListResult["matchedPlayers"] }> {
  const like = `%${term}%`;

  // 1. Resolve the term against player names so a payload full of uuids is searchable.
  const matchedPlayers =
    term.length >= 3
      ? await executor
          .select({ id: players.id, fullName: players.fullName, position: players.position, sleeperId: players.sleeperId })
          .from(players)
          .where(ilike(players.fullName, like))
          .limit(25)
      : [];

  const idPatterns = matchedPlayers.flatMap((p) => [`%${p.id}%`, `%"${p.sleeperId}"%`]);

  const stepJsonMatches: SQL[] = [
    sql`${runSteps.text} ilike ${like}`,
    sql`${runSteps.reasoning} ilike ${like}`,
    sql`${runSteps.toolCalls}::text ilike ${like}`,
    sql`${runSteps.toolResults}::text ilike ${like}`,
    sql`${runSteps.messages}::text ilike ${like}`,
    ...idPatterns.flatMap((pattern) => [
      sql`${runSteps.toolCalls}::text ilike ${pattern}`,
      sql`${runSteps.toolResults}::text ilike ${pattern}`,
    ]),
  ];

  const actionMatches: SQL[] = [
    sql`${runActions.actionType} ilike ${like}`,
    sql`${runActions.payload}::text ilike ${like}`,
    ...idPatterns.map((pattern) => sql`${runActions.payload}::text ilike ${pattern}`),
  ];

  const condition = sql`(
    ${runs.rationale} ilike ${like}
    or ${runs.outcome} ilike ${like}
    or ${runs.modelId} ilike ${like}
    or exists (
      select 1 from ${runSteps}
      where ${runSteps.runId} = ${runs.id} and (${sql.join(stepJsonMatches, sql` or `)})
    )
    or exists (
      select 1 from ${runActions}
      where ${runActions.runId} = ${runs.id} and (${sql.join(actionMatches, sql` or `)})
    )
  )`;

  void leagueId;
  return {
    condition,
    matchedPlayers: matchedPlayers.map((p) => ({
      id: p.id,
      fullName: p.fullName,
      position: p.position,
    })),
  };
}

export async function traceList(
  filters: TraceListFilters,
  executor: DbOrTx = db,
): Promise<TraceListResult> {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? TRACE_PAGE_SIZE));

  const conditions: SQL[] = [eq(runs.leagueId, filters.leagueId)];
  if (filters.teamId) conditions.push(eq(runs.teamId, filters.teamId));
  if (filters.status) conditions.push(eq(runs.status, filters.status));
  if (filters.modelId) conditions.push(eq(runs.modelId, filters.modelId));
  if (filters.windowType) conditions.push(eq(windows.type, filters.windowType));
  if (typeof filters.weekNo === "number") conditions.push(eq(windows.weekNo, filters.weekNo));

  let matchedPlayers: TraceListResult["matchedPlayers"] = [];
  const term = filters.q?.trim();
  if (term) {
    const built = await searchCondition(filters.leagueId, term, executor);
    conditions.push(built.condition);
    matchedPlayers = built.matchedPlayers;
  }

  const where = and(...conditions);

  const [{ total } = { total: 0 }] = await executor
    .select({ total: sql<number>`count(*)::int` })
    .from(runs)
    .innerJoin(windows, eq(windows.id, runs.windowId))
    .where(where);

  const rows = await executor
    .select({
      id: runs.id,
      leagueId: runs.leagueId,
      teamId: runs.teamId,
      teamName: teams.name,
      teamAbbreviation: teams.abbreviation,
      windowId: runs.windowId,
      windowLabel: windows.label,
      windowType: windows.type,
      weekNo: windows.weekNo,
      roundNo: windows.roundNo,
      modelId: runs.modelId,
      status: runs.status,
      outcome: runs.outcome,
      rationale: runs.rationale,
      costUsd: runs.totalCostUsd,
      stepCount: runs.stepCount,
      startedAt: runs.startedAt,
      finishedAt: runs.finishedAt,
      createdAt: runs.createdAt,
      configVersionNo: configVersions.versionNo,
      fallbackApplied: runs.fallbackApplied,
      actionCount: sql<number>`(select count(*)::int from ${runActions} where ${runActions.runId} = ${runs.id})`,
    })
    .from(runs)
    .innerJoin(windows, eq(windows.id, runs.windowId))
    .leftJoin(teams, eq(teams.id, runs.teamId))
    .leftJoin(configVersions, eq(configVersions.id, runs.configVersionId))
    .where(where)
    .orderBy(desc(runs.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  return {
    items: rows.map(toListItem),
    page,
    pageSize,
    total,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
    matchedPlayers,
  };
}

/** The column set every list query selects; `toListItem` is the only decorator. */
type RawListRow = {
  id: string;
  leagueId: string;
  teamId: string | null;
  teamName: string | null;
  teamAbbreviation: string | null;
  windowId: string;
  windowLabel: string;
  windowType: WindowType;
  weekNo: number | null;
  roundNo: number;
  modelId: string;
  status: RunStatus;
  outcome: string | null;
  rationale: string | null;
  costUsd: number;
  stepCount: number;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  configVersionNo: number | null;
  fallbackApplied: { kind?: string } | null;
  actionCount: number;
};

function toListItem(row: RawListRow): TraceListItem {
  return {
    id: row.id,
    leagueId: row.leagueId,
    teamId: row.teamId,
    teamName: row.teamName,
    teamAbbreviation: row.teamAbbreviation,
    windowId: row.windowId,
    windowLabel: row.windowLabel,
    windowLabelText: windowLabelText(row.windowLabel),
    windowType: row.windowType,
    weekNo: row.weekNo,
    roundNo: row.roundNo,
    modelId: row.modelId,
    modelLabel: modelLabel(row.modelId),
    status: row.status,
    outcome: row.outcome,
    rationale: row.rationale,
    costUsd: row.costUsd ?? 0,
    stepCount: row.stepCount,
    actionCount: row.actionCount,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    durationMs:
      row.startedAt && row.finishedAt
        ? row.finishedAt.getTime() - row.startedAt.getTime()
        : null,
    configVersionNo: row.configVersionNo,
    fallbackKind: row.fallbackApplied?.kind ?? null,
    createdAt: row.createdAt,
  };
}

// ------------------------------------------------------------------ detail

export type TraceStep = {
  id: string;
  stepIndex: number;
  modelId: string;
  text: string | null;
  reasoning: string | null;
  toolCalls: unknown[];
  toolResults: unknown[];
  usage: Record<string, unknown>;
  finishReason: string | null;
  latencyMs: number | null;
  costUsd: number;
  createdAt: Date;
  /** True when any tool result in this step reports a validation failure. */
  hasValidationError: boolean;
};

export type TraceAction = {
  id: string;
  toolCallId: string;
  stepIndex: number;
  actionType: string;
  payload: Record<string, unknown>;
  validationResult: { ok: boolean; errors?: string[] };
  committedAt: Date | null;
  createdAt: Date;
};

export type TraceUsage = {
  id: string;
  stepIndex: number;
  modelId: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  latencyMs: number | null;
  costUsd: number;
  gatewayCostUsd: number | null;
};

export type TraceDetail = {
  run: TraceListItem & {
    error: string | null;
    fallback: { kind: string; detail?: string; fromModelId?: string; toModelId?: string } | null;
    totalInputTokens: number;
    totalOutputTokens: number;
    kind: string;
    attempt: number;
  };
  league: { id: string; name: string; isPublic: boolean };
  window: {
    id: string;
    type: WindowType;
    label: string;
    labelText: string;
    weekNo: number | null;
    roundNo: number;
    opensAt: Date;
    submissionDeadlineAt: Date;
    closesAt: Date;
    snapshotId: string | null;
  };
  team: { id: string; name: string; abbreviation: string } | null;
  configVersion: {
    id: string;
    versionNo: number;
    modelId: string;
    changeSummary: string | null;
    createdAt: Date;
  } | null;
  /**
   * Prompt sections as stored by the runtime on `runs.prompt_sections`. When the
   * runtime has not written them (older runs), they are reconstructed from the
   * step-0 message array so the viewer always has something to expand.
   */
  promptSections: PromptSection[];
  promptSectionsSource: "runtime" | "derived" | "none";
  steps: TraceStep[];
  actions: TraceAction[];
  usage: TraceUsage[];
};

/** Best-effort: does this tool result look like a rejected write? */
function resultHasError(result: unknown): boolean {
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

/** Rebuild prompt sections from the first step's message array (pre-`prompt_sections` runs). */
function deriveSections(messages: unknown[]): PromptSection[] {
  const sections: PromptSection[] = [];
  messages.forEach((message, index) => {
    if (!message || typeof message !== "object") return;
    const record = message as Record<string, unknown>;
    const role = record.role === "system" ? "system" : "user";
    if (record.role !== "system" && record.role !== "user") return;
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

export async function trace(runId: string, executor: DbOrTx = db): Promise<TraceDetail | null> {
  const [row] = await executor
    .select({
      run: runs,
      window: windows,
      team: teams,
      configVersion: configVersions,
      league: leagues,
      actionCount: sql<number>`(select count(*)::int from ${runActions} where ${runActions.runId} = ${runs.id})`,
    })
    .from(runs)
    .innerJoin(windows, eq(windows.id, runs.windowId))
    .innerJoin(leagues, eq(leagues.id, runs.leagueId))
    .leftJoin(teams, eq(teams.id, runs.teamId))
    .leftJoin(configVersions, eq(configVersions.id, runs.configVersionId))
    .where(eq(runs.id, runId))
    .limit(1);

  if (!row) return null;

  const [stepRows, actionRows, usageRows] = await Promise.all([
    executor.select().from(runSteps).where(eq(runSteps.runId, runId)).orderBy(runSteps.stepIndex),
    executor
      .select()
      .from(runActions)
      .where(eq(runActions.runId, runId))
      .orderBy(runActions.stepIndex, runActions.createdAt),
    executor
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.runId, runId))
      .orderBy(usageEvents.stepIndex),
  ]);

  const stored = row.run.promptSections;
  let promptSections: PromptSection[] = [];
  let promptSectionsSource: TraceDetail["promptSectionsSource"] = "none";
  if (Array.isArray(stored) && stored.length > 0) {
    promptSections = stored;
    promptSectionsSource = "runtime";
  } else {
    const seed = Array.isArray(row.run.messages) && row.run.messages.length > 0
      ? row.run.messages
      : (stepRows[0]?.messages ?? []);
    const derived = deriveSections(seed as unknown[]);
    if (derived.length > 0) {
      promptSections = derived;
      promptSectionsSource = "derived";
    }
  }

  const listItem = toListItem({
    id: row.run.id,
    leagueId: row.run.leagueId,
    teamId: row.run.teamId,
    teamName: row.team?.name ?? null,
    teamAbbreviation: row.team?.abbreviation ?? null,
    windowId: row.run.windowId,
    windowLabel: row.window.label,
    windowType: row.window.type,
    weekNo: row.window.weekNo,
    roundNo: row.window.roundNo,
    modelId: row.run.modelId,
    status: row.run.status,
    outcome: row.run.outcome,
    rationale: row.run.rationale,
    costUsd: row.run.totalCostUsd,
    stepCount: row.run.stepCount,
    startedAt: row.run.startedAt,
    finishedAt: row.run.finishedAt,
    createdAt: row.run.createdAt,
    configVersionNo: row.configVersion?.versionNo ?? null,
    fallbackApplied: row.run.fallbackApplied,
    actionCount: row.actionCount,
  });

  return {
    run: {
      ...listItem,
      error: row.run.error,
      fallback: row.run.fallbackApplied ?? null,
      totalInputTokens: row.run.totalInputTokens,
      totalOutputTokens: row.run.totalOutputTokens,
      kind: row.run.kind,
      attempt: row.run.attempt,
    },
    league: { id: row.league.id, name: row.league.name, isPublic: row.league.isPublic },
    window: {
      id: row.window.id,
      type: row.window.type,
      label: row.window.label,
      labelText: windowLabelText(row.window.label),
      weekNo: row.window.weekNo,
      roundNo: row.window.roundNo,
      opensAt: row.window.opensAt,
      submissionDeadlineAt: row.window.submissionDeadlineAt,
      closesAt: row.window.closesAt,
      snapshotId: row.window.snapshotId,
    },
    team: row.team
      ? { id: row.team.id, name: row.team.name, abbreviation: row.team.abbreviation }
      : null,
    configVersion: row.configVersion
      ? {
          id: row.configVersion.id,
          versionNo: row.configVersion.versionNo,
          modelId: row.configVersion.modelId,
          changeSummary: row.configVersion.changeSummary,
          createdAt: row.configVersion.createdAt,
        }
      : null,
    promptSections,
    promptSectionsSource,
    steps: stepRows.map((step) => ({
      id: step.id,
      stepIndex: step.stepIndex,
      modelId: step.modelId,
      text: step.text,
      reasoning: step.reasoning,
      toolCalls: step.toolCalls ?? [],
      toolResults: step.toolResults ?? [],
      usage: (step.usage ?? {}) as Record<string, unknown>,
      finishReason: step.finishReason,
      latencyMs: step.latencyMs,
      costUsd: step.costUsd ?? 0,
      createdAt: step.createdAt,
      hasValidationError: (step.toolResults ?? []).some(resultHasError),
    })),
    actions: actionRows.map((action) => ({
      id: action.id,
      toolCallId: action.toolCallId,
      stepIndex: action.stepIndex,
      actionType: action.actionType,
      payload: action.payload ?? {},
      validationResult: action.validationResult ?? { ok: true },
      committedAt: action.committedAt,
      createdAt: action.createdAt,
    })),
    usage: usageRows.map((event) => ({
      id: event.id,
      stepIndex: event.stepIndex,
      modelId: event.modelId,
      provider: event.provider,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cachedInputTokens: event.cachedInputTokens,
      reasoningTokens: event.reasoningTokens,
      latencyMs: event.latencyMs,
      costUsd: event.costUsd ?? 0,
      gatewayCostUsd: event.gatewayCostUsd,
    })),
  };
}

// ------------------------------------------------------------------ export

export type TraceExport = {
  version: 1;
  kind: "run";
  exportedAt: string;
  trace: TraceDetail;
};

export async function traceExport(
  runId: string,
  executor: DbOrTx = db,
): Promise<TraceExport | null> {
  const detail = await trace(runId, executor);
  if (!detail) return null;
  return { version: 1, kind: "run", exportedAt: new Date().toISOString(), trace: detail };
}

/** Whole-team export, newest first. Capped so one request cannot stream a season of JSONB. */
export const TEAM_EXPORT_RUN_LIMIT = 200;

export type TeamTracesExport = {
  version: 1;
  kind: "team";
  exportedAt: string;
  team: { id: string; name: string; abbreviation: string; leagueId: string };
  runCount: number;
  truncated: boolean;
  traces: TraceDetail[];
};

export async function teamTracesExport(
  teamId: string,
  executor: DbOrTx = db,
): Promise<TeamTracesExport | null> {
  const team = await executor.query.teams.findFirst({ where: eq(teams.id, teamId) });
  if (!team) return null;

  const ids = await executor
    .select({ id: runs.id })
    .from(runs)
    .where(eq(runs.teamId, teamId))
    .orderBy(desc(runs.createdAt))
    .limit(TEAM_EXPORT_RUN_LIMIT + 1);

  const truncated = ids.length > TEAM_EXPORT_RUN_LIMIT;
  const runIds = ids.slice(0, TEAM_EXPORT_RUN_LIMIT).map((r) => r.id);

  const traces: TraceDetail[] = [];
  for (const id of runIds) {
    const detail = await trace(id, executor);
    if (detail) traces.push(detail);
  }

  return {
    version: 1,
    kind: "team",
    exportedAt: new Date().toISOString(),
    team: {
      id: team.id,
      name: team.name,
      abbreviation: team.abbreviation,
      leagueId: team.leagueId,
    },
    runCount: traces.length,
    truncated,
    traces,
  };
}

/** Distinct model ids that have actually run in this league — powers the filter select. */
export async function traceModelOptions(
  leagueId: string,
  executor: DbOrTx = db,
): Promise<Array<{ modelId: string; label: string; runCount: number }>> {
  const rows = await executor
    .select({
      modelId: runs.modelId,
      runCount: sql<number>`count(*)::int`,
    })
    .from(runs)
    .where(eq(runs.leagueId, leagueId))
    .groupBy(runs.modelId)
    .orderBy(desc(sql`count(*)`));
  return rows.map((row) => ({
    modelId: row.modelId,
    label: modelLabel(row.modelId),
    runCount: row.runCount,
  }));
}

/** The most recent runs for a team, for the team page's "recent traces" card. */
export async function recentRunsForTeam(
  teamId: string,
  limit = 8,
  executor: DbOrTx = db,
): Promise<TraceListItem[]> {
  const rows = await executor
    .select({
      id: runs.id,
      leagueId: runs.leagueId,
      teamId: runs.teamId,
      teamName: teams.name,
      teamAbbreviation: teams.abbreviation,
      windowId: runs.windowId,
      windowLabel: windows.label,
      windowType: windows.type,
      weekNo: windows.weekNo,
      roundNo: windows.roundNo,
      modelId: runs.modelId,
      status: runs.status,
      outcome: runs.outcome,
      rationale: runs.rationale,
      costUsd: runs.totalCostUsd,
      stepCount: runs.stepCount,
      startedAt: runs.startedAt,
      finishedAt: runs.finishedAt,
      createdAt: runs.createdAt,
      configVersionNo: configVersions.versionNo,
      fallbackApplied: runs.fallbackApplied,
      actionCount: sql<number>`(select count(*)::int from ${runActions} where ${runActions.runId} = ${runs.id})`,
    })
    .from(runs)
    .innerJoin(windows, eq(windows.id, runs.windowId))
    .leftJoin(teams, eq(teams.id, runs.teamId))
    .leftJoin(configVersions, eq(configVersions.id, runs.configVersionId))
    .where(eq(runs.teamId, teamId))
    .orderBy(desc(runs.createdAt))
    .limit(limit);
  return rows.map(toListItem);
}

/** Runs that set the given lineups, keyed by run id — used for matchup rationale excerpts. */
export async function rationalesForRuns(
  runIds: string[],
  executor: DbOrTx = db,
): Promise<Map<string, { rationale: string | null; stepIndex: number | null }>> {
  const map = new Map<string, { rationale: string | null; stepIndex: number | null }>();
  if (runIds.length === 0) return map;
  const rows = await executor
    .select({ id: runs.id, rationale: runs.rationale })
    .from(runs)
    .where(inArray(runs.id, runIds));
  for (const row of rows) map.set(row.id, { rationale: row.rationale, stepIndex: null });
  return map;
}

