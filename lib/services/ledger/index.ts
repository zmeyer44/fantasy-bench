/**
 * CONTRACT STUB — owned by the agent-runtime package, which replaces this file.
 * Append-only usage/cost ledger and budget checks (PRD 5.9).
 */
import type { DbOrTx } from "@/lib/db";

export type UsageInput = {
  runId: string;
  stepIndex: number;
  teamId: string | null;
  leagueId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  latencyMs?: number;
  gatewayCostUsd?: number | null;
};

export async function recordUsage(_input: UsageInput, _executor?: DbOrTx): Promise<{ costUsd: number }> {
  throw new Error("not implemented (runtime package)");
}

export async function getRemainingBudget(_args: {
  leagueId: string;
  teamId: string | null;
  weekNo: number;
}): Promise<{ teamTokensRemaining: number | null; leagueUsdRemaining: number | null; leagueCapReached: boolean }> {
  throw new Error("not implemented (runtime package)");
}
