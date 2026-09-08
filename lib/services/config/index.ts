/**
 * CONTRACT STUB — owned by the owner-console package, which replaces this file.
 */
import type { DbOrTx } from "@/lib/db";
import type { ConfigVersion, Skill } from "@/lib/db/types";

export type HarnessSettings = {
  maxSteps: number;
  tokenBudget: number;
  temperature: number;
  reasoningEffort?: "low" | "medium" | "high" | null;
  deliberateMode: boolean;
};

/** The applied config version for a team plus its attached skills, in order. Null if none. */
export async function getCurrentConfigVersion(
  _teamId: string,
  _executor?: DbOrTx,
): Promise<(ConfigVersion & { skills: Skill[]; harness: HarnessSettings }) | null> {
  throw new Error("not implemented (console package)");
}

/** Apply any pending (queued-during-lock) versions for every team in the league. Called by the tick at unlock. */
export async function applyPendingConfigVersions(_leagueId: string, _executor?: DbOrTx): Promise<number> {
  throw new Error("not implemented (console package)");
}
