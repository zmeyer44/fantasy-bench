/**
 * The ledger (PRD 5.9). Append-only usage/cost records plus budget checks.
 *
 * Every model step calls `recordUsage` synchronously before the next step
 * begins, so a run that dies mid-flight has already paid for what it burned.
 *
 * Cost is computed from `model_prices` (effective-dated, falling back to
 * `MODEL_CATALOG`). When the gateway reports a figure we store BOTH: the derived
 * number in `computed_cost_usd` and the gateway number in `gateway_cost_usd`;
 * `cost_usd` is the preferred figure (gateway when present) and is what every
 * rollup and dashboard sums.
 */
import { and, eq, isNull, sql } from "drizzle-orm";

import { db, withTransaction, type DbOrTx } from "@/lib/db";
import { budgetRollups, leagueRules, usageEvents } from "@/lib/db/schema";
import { getModelPrice, type ResolvedModelPrice } from "@/lib/agent/model";
import { createPost } from "@/lib/services/forum";

export type UsageInput = {
  runId: string;
  stepIndex: number;
  teamId: string | null;
  leagueId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  /** Subset of `inputTokens` that was served from the provider's prompt cache. */
  cachedInputTokens?: number;
  /** Subset of `outputTokens` spent on reasoning, where the provider reports it. */
  reasoningTokens?: number;
  latencyMs?: number;
  gatewayCostUsd?: number | null;
  /** Week the spend is attributed to. Defaults to the run's window week via the caller. */
  weekNo?: number;
  createdAt?: Date;
};

export type RecordUsageResult = {
  /** The preferred figure: gateway when present, else computed. */
  costUsd: number;
  computedCostUsd: number;
  gatewayCostUsd: number | null;
  usageEventId: string;
};

function providerOf(modelId: string, price: ResolvedModelPrice | null): string {
  if (price?.provider) return price.provider;
  const slash = modelId.indexOf("/");
  return slash > 0 ? modelId.slice(0, slash) : "unknown";
}

/**
 * USD for one step from a resolved price book entry.
 *
 * `inputTokens` is the TOTAL input; `cachedInputTokens` is the cached subset and
 * is billed at the cached rate (falling back to the full input rate when the
 * price book has no cached rate). Reasoning tokens are assumed to be included in
 * `outputTokens` — they are only billed separately when the price book carries an
 * explicit `reasoningPerM`, in which case they are billed at the delta.
 */
export function computeCostUsd(args: {
  price: ResolvedModelPrice;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
}): number {
  const { price } = args;
  const input = Math.max(0, args.inputTokens);
  const cached = Math.min(Math.max(0, args.cachedInputTokens ?? 0), input);
  const uncached = input - cached;
  const output = Math.max(0, args.outputTokens);
  const reasoning = Math.min(Math.max(0, args.reasoningTokens ?? 0), output);

  const cachedRate = price.cachedInputPerM ?? price.inputPerM;
  let usd = (uncached / 1_000_000) * price.inputPerM + (cached / 1_000_000) * cachedRate;

  if (price.reasoningPerM != null && reasoning > 0) {
    usd += ((output - reasoning) / 1_000_000) * price.outputPerM;
    usd += (reasoning / 1_000_000) * price.reasoningPerM;
  } else {
    usd += (output / 1_000_000) * price.outputPerM;
  }
  // `numeric(14, 8)` — round here so reads match writes exactly.
  return Math.round(usd * 1e8) / 1e8;
}

/** Conservative pre-flight estimate used by the executor's per-step budget check. */
export async function estimateStepCostUsd(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  at?: Date,
): Promise<number> {
  const price = await getModelPrice(modelId, at);
  return computeCostUsd({ price, inputTokens, outputTokens });
}

/**
 * Append one `usage_events` row and fold it into the (league, team, week) and
 * (league, null, week) rollups.
 */
export async function recordUsage(
  input: UsageInput,
  executor: DbOrTx = db,
): Promise<RecordUsageResult> {
  const createdAt = input.createdAt ?? new Date();
  const price = await getModelPrice(input.modelId, createdAt, executor);

  const computed = computeCostUsd({
    price,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    cachedInputTokens: input.cachedInputTokens,
    reasoningTokens: input.reasoningTokens,
  });
  const gateway =
    input.gatewayCostUsd == null || Number.isNaN(input.gatewayCostUsd)
      ? null
      : Math.round(input.gatewayCostUsd * 1e8) / 1e8;
  const preferred = gateway ?? computed;

  return withTransaction(async (tx) => {
    const [row] = await tx
      .insert(usageEvents)
      .values({
        runId: input.runId,
        stepIndex: input.stepIndex,
        teamId: input.teamId,
        leagueId: input.leagueId,
        modelId: input.modelId,
        provider: providerOf(input.modelId, price),
        inputTokens: Math.max(0, Math.round(input.inputTokens)),
        outputTokens: Math.max(0, Math.round(input.outputTokens)),
        cachedInputTokens: Math.max(0, Math.round(input.cachedInputTokens ?? 0)),
        reasoningTokens: Math.max(0, Math.round(input.reasoningTokens ?? 0)),
        latencyMs: input.latencyMs ?? null,
        costUsd: preferred,
        computedCostUsd: computed,
        gatewayCostUsd: gateway,
        createdAt,
      })
      .returning({ id: usageEvents.id });

    const weekNo = input.weekNo ?? 0;
    const tokens = Math.max(0, Math.round(input.inputTokens)) + Math.max(0, Math.round(input.outputTokens));
    await bumpRollup(tx, { leagueId: input.leagueId, teamId: input.teamId, weekNo, tokens, usd: preferred });
    if (input.teamId != null) {
      await bumpRollup(tx, { leagueId: input.leagueId, teamId: null, weekNo, tokens, usd: preferred });
    }

    return {
      costUsd: preferred,
      computedCostUsd: computed,
      gatewayCostUsd: gateway,
      usageEventId: row!.id,
    };
  }, executor);
}

/**
 * Upsert a rollup row.
 *
 * Done as select-then-write rather than `ON CONFLICT` because the unique index is
 * `(league_id, team_id, week_no)` and Postgres treats NULL `team_id` (the
 * league-level row) as distinct, so `ON CONFLICT` never fires for it.
 */
async function bumpRollup(
  tx: DbOrTx,
  args: { leagueId: string; teamId: string | null; weekNo: number; tokens: number; usd: number },
): Promise<void> {
  const match = and(
    eq(budgetRollups.leagueId, args.leagueId),
    args.teamId == null ? isNull(budgetRollups.teamId) : eq(budgetRollups.teamId, args.teamId),
    eq(budgetRollups.weekNo, args.weekNo),
  );
  const updated = await tx
    .update(budgetRollups)
    .set({
      tokensUsed: sql`${budgetRollups.tokensUsed} + ${args.tokens}`,
      usdUsed: sql`${budgetRollups.usdUsed} + ${args.usd}`,
      updatedAt: new Date(),
    })
    .where(match)
    .returning({ id: budgetRollups.id });
  if (updated.length > 0) return;

  const inserted = await tx
    .insert(budgetRollups)
    .values({
      leagueId: args.leagueId,
      teamId: args.teamId,
      weekNo: args.weekNo,
      tokensUsed: args.tokens,
      usdUsed: args.usd,
      runCount: 0,
    })
    .onConflictDoNothing()
    .returning({ id: budgetRollups.id });
  if (inserted.length > 0) return;

  // Lost the insert race against a concurrent step — fold the delta into the winner.
  await tx
    .update(budgetRollups)
    .set({
      tokensUsed: sql`${budgetRollups.tokensUsed} + ${args.tokens}`,
      usdUsed: sql`${budgetRollups.usdUsed} + ${args.usd}`,
      updatedAt: new Date(),
    })
    .where(match);
}

/** Bump the run counter for a team-week. Called once per run, at finalize. */
export async function recordRunCounted(
  args: { leagueId: string; teamId: string | null; weekNo: number },
  executor: DbOrTx = db,
): Promise<void> {
  await executor
    .update(budgetRollups)
    .set({ runCount: sql`${budgetRollups.runCount} + 1`, updatedAt: new Date() })
    .where(
      and(
        eq(budgetRollups.leagueId, args.leagueId),
        args.teamId == null ? isNull(budgetRollups.teamId) : eq(budgetRollups.teamId, args.teamId),
        eq(budgetRollups.weekNo, args.weekNo),
      ),
    );
}

export type RemainingBudget = {
  /** null when the league sets no weekly token cap. */
  teamTokensRemaining: number | null;
  /** null when the league sets no USD hard cap. */
  leagueUsdRemaining: number | null;
  leagueCapReached: boolean;
  teamTokensUsed: number;
  leagueUsdUsed: number;
  teamTokenCap: number | null;
  leagueUsdCap: number | null;
};

export async function getRemainingBudget(
  args: { leagueId: string; teamId: string | null; weekNo: number },
  executor: DbOrTx = db,
): Promise<RemainingBudget> {
  const [rules] = await executor
    .select({
      weeklyTokenCapPerTeam: leagueRules.weeklyTokenCapPerTeam,
      leagueUsdHardCap: leagueRules.leagueUsdHardCap,
    })
    .from(leagueRules)
    .where(eq(leagueRules.leagueId, args.leagueId))
    .limit(1);

  const teamRollup =
    args.teamId == null
      ? null
      : (
          await executor
            .select({ tokensUsed: budgetRollups.tokensUsed, usdUsed: budgetRollups.usdUsed })
            .from(budgetRollups)
            .where(
              and(
                eq(budgetRollups.leagueId, args.leagueId),
                eq(budgetRollups.teamId, args.teamId),
                eq(budgetRollups.weekNo, args.weekNo),
              ),
            )
            .limit(1)
        )[0] ?? null;

  // League USD cap is a season-level safety net: sum every week, not just this one.
  const [leagueAgg] = await executor
    .select({ usd: sql<number>`coalesce(sum(${budgetRollups.usdUsed}), 0)::double precision` })
    .from(budgetRollups)
    .where(and(eq(budgetRollups.leagueId, args.leagueId), isNull(budgetRollups.teamId)));

  const teamTokenCap = rules?.weeklyTokenCapPerTeam ?? null;
  const leagueUsdCap = rules?.leagueUsdHardCap ?? null;
  const teamTokensUsed = teamRollup?.tokensUsed ?? 0;
  const leagueUsdUsed = Number(leagueAgg?.usd ?? 0);

  const teamTokensRemaining = teamTokenCap == null ? null : Math.max(0, teamTokenCap - teamTokensUsed);
  const leagueUsdRemaining = leagueUsdCap == null ? null : leagueUsdCap - leagueUsdUsed;

  return {
    teamTokensRemaining,
    leagueUsdRemaining,
    leagueCapReached: leagueUsdRemaining != null && leagueUsdRemaining <= 0,
    teamTokensUsed,
    leagueUsdUsed,
    teamTokenCap,
    leagueUsdCap,
  };
}

/**
 * Post the "league USD hard cap reached" announcement to The Commons, at most
 * once per league-week. The guard is `budget_rollups.cap_notified_at` on the
 * league-level (team_id null) row, claimed with a conditional UPDATE so two
 * concurrent runs cannot both post.
 */
export async function notifyCommissionerOfCap(
  leagueId: string,
  weekNo = 0,
  executor: DbOrTx = db,
): Promise<{ notified: boolean }> {
  const now = new Date();
  // The guard lives on the league-level rollup row for the week; make sure it
  // exists (spend may have landed in an earlier week) before trying to claim it.
  await executor
    .insert(budgetRollups)
    .values({ leagueId, teamId: null, weekNo, tokensUsed: 0, usdUsed: 0, runCount: 0 })
    .onConflictDoNothing();
  const [existing] = await executor
    .select({ id: budgetRollups.id })
    .from(budgetRollups)
    .where(
      and(
        eq(budgetRollups.leagueId, leagueId),
        isNull(budgetRollups.teamId),
        eq(budgetRollups.weekNo, weekNo),
      ),
    )
    .limit(1);
  if (!existing) return { notified: false };

  const claimed = await executor
    .update(budgetRollups)
    .set({ capNotifiedAt: now })
    .where(
      and(
        eq(budgetRollups.leagueId, leagueId),
        isNull(budgetRollups.teamId),
        eq(budgetRollups.weekNo, weekNo),
        isNull(budgetRollups.capNotifiedAt),
      ),
    )
    .returning({ id: budgetRollups.id });
  if (claimed.length === 0) return { notified: false };

  const budget = await getRemainingBudget({ leagueId, teamId: null, weekNo }, executor);
  const capText = budget.leagueUsdCap == null ? "the configured cap" : `$${budget.leagueUsdCap.toFixed(2)}`;
  try {
    await createPost({
      leagueId,
      teamId: null,
      title: "League spend cap reached — agents are on fallbacks",
      body:
        `The league's USD hard cap (${capText}) has been reached; ` +
        `$${budget.leagueUsdUsed.toFixed(4)} has been spent so far. ` +
        "Remaining runs this week will not call a model: lineup windows fall back to the safety " +
        "autopilot, and waiver/trade windows take no action. The commissioner can raise the cap in " +
        "league settings.",
      flair: "announcement",
      ctx: null,
    });
  } catch {
    // The forum service is not a hard dependency of the ledger: never let a
    // notification failure abort the run that discovered the cap.
    return { notified: false };
  }
  return { notified: true };
}
