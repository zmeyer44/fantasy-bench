/**
 * Types shared by the runtime's prompt, tools and executor.
 *
 * The type half of the tool context. The one structural change
 * from the Postgres runtime is `ctx`: tools no longer hold a Drizzle executor,
 * they hold the Convex `ActionCtx` and reach the database through internal
 * queries and mutations.
 */
import type { Infer } from "convex/values";

import type { SnapshotDigest, SnapshotPayload } from "../../lib/snapshot/types";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import type { RemainingBudget } from "../ledger";
import type { harnessSettings, promptSection } from "../schema";
import type { ToolOverride } from "./tools/catalog";

export type HarnessSettings = Infer<typeof harnessSettings>;
export type PromptSection = Infer<typeof promptSection>;
export type WindowScope = Doc<"windows">["scope"];
export type WindowType = Doc<"windows">["type"];
export type CustomProvider = Doc<"custom_providers">;
export type { RemainingBudget };

/** Everything the run did, accumulated by the write tools for the executor. */
export type RunToolState = {
  rationale: string | null;
  lineupCommitted: boolean;
  /** Empty starting slots in the latest committed lineup (`lineup_incomplete`). */
  lineupEmptyStarters: number;
  waiverClaims: number;
  drops: number;
  tradesProposed: number;
  tradeResponses: number;
  messagesSent: number;
  forumPosts: number;
  forumComments: number;
  forumVotes: number;
  draftActions: number;
  committed: number;
  rejected: number;
  /** Validation errors returned to the model, newest last. */
  errors: string[];
  /** Write-tool rejections since the last `takeStepRejections()`, for the ledger. */
  rejectedThisStep: number;
};

export function emptyRunToolState(): RunToolState {
  return {
    rationale: null,
    lineupCommitted: false,
    lineupEmptyStarters: 0,
    waiverClaims: 0,
    drops: 0,
    tradesProposed: 0,
    tradeResponses: 0,
    messagesSent: 0,
    forumPosts: 0,
    forumComments: 0,
    forumVotes: 0,
    draftActions: 0,
    committed: 0,
    rejected: 0,
    errors: [],
    rejectedThisStep: 0,
  };
}

export type ToolContext = {
  /** The Convex action context; every database touch goes through it. */
  ctx: ActionCtx;
  runId: Id<"runs">;
  leagueId: Id<"leagues">;
  /** null for commissioner runs, which have no roster. */
  teamId: Id<"teams"> | null;
  teamName: string;
  configVersionId: Id<"config_versions"> | null;
  windowId: Id<"windows">;
  windowType: WindowType;
  windowLabel: string;
  windowScope: WindowScope;
  weekNo: number;
  snapshot: SnapshotPayload;
  digest: SnapshotDigest;
  submissionDeadlineAt: Date;
  closesAt: Date;
  /** Injectable clock — tests and replays pass a fixed instant. */
  now: () => Date;
  /** Step index the model is currently on; stamped onto `run_actions`. */
  currentStepIndex: () => number;
  budget: RemainingBudget;
  customProviders: CustomProvider[];
  /** Per-version tool customisation (disable / owner guidance); absent = defaults. */
  toolOverrides?: ToolOverride[];
  state: RunToolState;
};

export type ToolOk = { ok: true; [key: string]: unknown };
export type ToolErr = { ok: false; errors: string[] };
export type ToolResult = ToolOk | ToolErr;

export function toolError(...errors: string[]): ToolErr {
  return { ok: false, errors };
}

/**
 * What `internal.runtime.execute.executeRun` returns to the Workpool, and what
 * `internal.runs.onComplete` turns into a terminal status.
 *
 * The action never writes a terminal status itself — `onComplete` is the only
 * writer (migration plan §4) — so this is the whole handover.
 */
export type ExecuteRunStatus = "succeeded" | "partial" | "fallback" | "timed_out" | "skipped";

export type FallbackApplied = Doc<"runs">["fallbackApplied"];

export type ExecuteRunSummary = {
  runId: Id<"runs">;
  status: ExecuteRunStatus;
  outcome: string | null;
  error: string | null;
  modelId: string;
  stepCount: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  rationale: string | null;
  fallbackApplied: FallbackApplied | null;
  /** False when the run was already terminal and this call did nothing. */
  executed: boolean;
};
