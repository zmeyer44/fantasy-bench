/**
 * Draft (PRD §5.2) — snake and sealed-bid auction.
 *
 * The whole board is materialized up front (`draft_picks`, one row per slot), so
 * "who is on the clock" is a query and the live draft page renders before a
 * single pick is made. The scheduler tick drives progression: one window per
 * pick with a 4-minute clock, an auto-pick fallback at close, and — when the
 * last pick lands — default lineups, a generated schedule, and `in_season`.
 *
 * Auction is deliberately simpler than snake (PRD Phase 1.1): a nomination
 * window followed by one sealed-bid window per lot, ties broken by lowest
 * current roster value then a recorded seeded random.
 */
import { and, asc, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { db, withTransaction, type DbOrTx } from "@/lib/db";
import {
  auctionBids,
  auctionNominations,
  draftPicks,
  leagueRules,
  leagues,
  players,
  rosterSlots,
  runs,
  teams,
  transactions,
  windows,
} from "@/lib/db/schema";
import type { ActionResult, AgentContext } from "@/lib/services/messaging";
import { generateSchedule } from "@/lib/services/standings";
import { safeCommitLineup, safeComputeOptimalLineup } from "@/lib/scheduler/lineup-fallback";
import { rosterCapacity } from "@/lib/services/waivers";
import type { SnapshotPayload } from "@/lib/snapshot/types";

export type DraftBoardPick = {
  id: string;
  round: number;
  pickNo: number;
  overallNo: number;
  teamId: string;
  teamName: string;
  playerId: string | null;
  playerName: string | null;
  position: string | null;
  nflTeam: string | null;
  auto: boolean;
  rationale: string | null;
  runId: string | null;
  costUsd: number | null;
  price: number | null;
  madeAt: string | null;
};

export type DraftBoard = {
  leagueId: string;
  draftType: "snake" | "auction";
  status: "setup" | "drafting" | "in_season" | "complete";
  rounds: number;
  picks: DraftBoardPick[];
  onTheClock: {
    teamId: string;
    teamName: string;
    overallNo: number;
    deadlineAt: string | null;
  } | null;
  runningCostUsd: number;
};

// ------------------------------------------------------------------ random

/** mulberry32 — small, deterministic, and reproducible from a recorded seed. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle<T>(items: T[], seed: number): T[] {
  const rng = seededRandom(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ------------------------------------------------------------- startDraft

export async function startDraft(
  leagueId: string,
  opts: { type?: "snake" | "auction"; scheduledAt?: Date; seed?: number } = {},
  executor: DbOrTx = db,
): Promise<{ order: string[]; rounds: number; picks: number; seed: number }> {
  return withTransaction(async (tx) => {
    const league = await tx.query.leagues.findFirst({ where: eq(leagues.id, leagueId) });
    const rules = await tx.query.leagueRules.findFirst({
      where: eq(leagueRules.leagueId, leagueId),
    });
    if (!league || !rules) throw new Error(`League ${leagueId} not found`);

    const leagueTeams = await tx
      .select()
      .from(teams)
      .where(eq(teams.leagueId, leagueId))
      .orderBy(asc(teams.createdAt), asc(teams.name));
    if (leagueTeams.length < 2) throw new Error("A draft needs at least two teams");

    const type = opts.type ?? league.draftType;
    const seed = opts.seed ?? Math.floor(Math.random() * 2 ** 31);
    const rounds = rosterCapacity(rules.rosterSlots);
    const order = seededShuffle(leagueTeams.map((t) => t.id), seed);

    const existing = await tx
      .select({ n: count() })
      .from(draftPicks)
      .where(eq(draftPicks.leagueId, leagueId));
    let picksCreated = 0;

    if (type === "snake" && (existing[0]?.n ?? 0) === 0) {
      const rows: Array<typeof draftPicks.$inferInsert> = [];
      let overall = 1;
      for (let round = 1; round <= rounds; round++) {
        // Snake: even rounds run in reverse.
        const roundOrder = round % 2 === 1 ? order : [...order].reverse();
        for (const [i, teamId] of roundOrder.entries()) {
          rows.push({ leagueId, round, pickNo: i + 1, overallNo: overall++, teamId });
        }
      }
      await tx.insert(draftPicks).values(rows);
      picksCreated = rows.length;
    }

    if (type === "auction") {
      await tx
        .update(teams)
        .set({ draftBudgetRemaining: rules.draftBudget })
        .where(eq(teams.leagueId, leagueId));
      const nominations = await tx
        .select({ n: count() })
        .from(auctionNominations)
        .where(eq(auctionNominations.leagueId, leagueId));
      if ((nominations[0]?.n ?? 0) === 0) {
        await tx.insert(auctionNominations).values({
          leagueId,
          lotNo: 1,
          nominatingTeamId: order[0],
          openingBid: 1,
          status: "awaiting_nomination",
        });
      }
    }

    await tx
      .update(leagues)
      .set({
        status: "drafting",
        draftType: type,
        draftScheduledAt: opts.scheduledAt ?? league.draftScheduledAt ?? new Date(),
        updatedAt: new Date(),
      })
      .where(eq(leagues.id, leagueId));
    // Rules become immutable once the draft begins (PRD 5.1).
    await tx
      .update(leagueRules)
      .set({ rulesLockedAt: rules.rulesLockedAt ?? new Date() })
      .where(eq(leagueRules.leagueId, leagueId));

    return { order, rounds, picks: picksCreated, seed };
  }, executor);
}

// ------------------------------------------------------------ board reads

/** The next unfilled snake pick, or null when the draft is complete. */
export async function nextPick(
  leagueId: string,
  executor: DbOrTx = db,
): Promise<typeof draftPicks.$inferSelect | undefined> {
  return executor.query.draftPicks.findFirst({
    where: and(eq(draftPicks.leagueId, leagueId), isNull(draftPicks.playerId)),
    orderBy: asc(draftPicks.overallNo),
  });
}

export async function draftedPlayerIds(
  leagueId: string,
  executor: DbOrTx = db,
): Promise<Set<string>> {
  const rows = await executor
    .select({ playerId: draftPicks.playerId })
    .from(draftPicks)
    .where(and(eq(draftPicks.leagueId, leagueId), sql`${draftPicks.playerId} is not null`));
  return new Set(rows.map((r) => r.playerId as string));
}

// ---------------------------------------------------------- pick validation

/**
 * Positional sanity for a draft pick (PRD 5.2 "position cap sanity").
 *
 * Two rules, both about not bricking your own roster:
 *  - K and DEF are streaming positions; one of each is enough, two is the cap.
 *  - After this pick you must still have enough picks left to fill every
 *    mandatory starting slot.
 */
export function validatePickPosition(args: {
  position: string;
  currentPositions: string[];
  rosterShape: Record<string, number>;
  picksRemainingAfter: number;
  superflex: boolean;
}): string | null {
  const { position, currentPositions, rosterShape, picksRemainingAfter } = args;
  const after = [...currentPositions, position];
  const countOf = (pos: string) => after.filter((p) => p === pos).length;

  for (const streaming of ["K", "DEF"]) {
    const cap = Math.max(1, rosterShape[streaming] ?? 1) + 1;
    if (countOf(streaming) > cap) {
      return `You already have ${cap} ${streaming}${cap > 1 ? "s" : ""}; drafting another wastes a roster spot.`;
    }
  }

  // Mandatory single-position starters that still need a body.
  let stillNeeded = 0;
  for (const [slot, required] of Object.entries(rosterShape)) {
    const upper = slot.toUpperCase();
    if (upper === "BENCH" || upper === "FLEX" || upper === "SUPERFLEX") continue;
    stillNeeded += Math.max(0, required - countOf(upper));
  }
  if (stillNeeded > picksRemainingAfter) {
    return `Taking another ${position} leaves you unable to fill ${stillNeeded} required starting slot(s) with ${picksRemainingAfter} pick(s) remaining.`;
  }
  return null;
}

// --------------------------------------------------------- recordDraftPick

export async function recordDraftPick(
  args: {
    leagueId: string;
    windowId: string;
    teamId: string;
    playerId: string;
    ctx: AgentContext;
    auto?: boolean;
    rationale?: string | null;
    now?: Date;
  },
  executor: DbOrTx = db,
): Promise<ActionResult<{ pickId: string; overallNo: number; pickNo: number; round: number }>> {
  const { leagueId, windowId, teamId, playerId, ctx } = args;
  const now = args.now ?? new Date();

  return withTransaction(async (tx) => {
    // `windowId` is empty for platform-made picks (the demo seed, admin tools).
    const window = windowId
      ? await tx.query.windows.findFirst({ where: eq(windows.id, windowId) })
      : null;
    if (windowId && (!window || window.leagueId !== leagueId || window.type !== "draft")) {
      return { ok: false, errors: [`Window ${windowId} is not a draft window in this league.`] };
    }
    const pick = await nextPick(leagueId, tx);
    if (!pick) return { ok: false, errors: ["The draft is already complete."] };
    if (pick.teamId !== teamId) {
      return { ok: false, errors: ["You are not on the clock."] };
    }
    if (window && window.scope.pickNo !== undefined && window.scope.pickNo !== pick.overallNo) {
      return { ok: false, errors: ["That window is for a different pick."] };
    }

    const drafted = await draftedPlayerIds(leagueId, tx);
    if (drafted.has(playerId)) {
      return { ok: false, errors: ["That player is already drafted."] };
    }
    const alreadyRostered = await tx
      .select({ id: rosterSlots.id })
      .from(rosterSlots)
      .innerJoin(teams, eq(teams.id, rosterSlots.teamId))
      .where(and(eq(teams.leagueId, leagueId), eq(rosterSlots.playerId, playerId)));
    if (alreadyRostered.length > 0) {
      return { ok: false, errors: ["That player is already rostered in this league."] };
    }

    const player = await tx.query.players.findFirst({ where: eq(players.id, playerId) });
    if (!player) return { ok: false, errors: [`Unknown player ${playerId}.`] };

    const rules = await tx.query.leagueRules.findFirst({
      where: eq(leagueRules.leagueId, leagueId),
    });
    if (!rules) return { ok: false, errors: ["League rules are missing."] };

    const roster = await tx
      .select({ position: players.position })
      .from(rosterSlots)
      .innerJoin(players, eq(players.id, rosterSlots.playerId))
      .where(eq(rosterSlots.teamId, teamId));
    const remainingAfter = await tx
      .select({ n: count() })
      .from(draftPicks)
      .where(
        and(
          eq(draftPicks.leagueId, leagueId),
          eq(draftPicks.teamId, teamId),
          isNull(draftPicks.playerId),
        ),
      );

    const positionError = validatePickPosition({
      position: player.position,
      currentPositions: roster.map((r) => r.position),
      rosterShape: rules.rosterSlots,
      picksRemainingAfter: Math.max(0, (remainingAfter[0]?.n ?? 1) - 1),
      superflex: rules.superflex,
    });
    if (positionError && !args.auto) return { ok: false, errors: [positionError] };

    await tx
      .update(draftPicks)
      .set({
        playerId,
        madeByRunId: ctx.runId || null,
        windowId: windowId || null,
        auto: args.auto ?? false,
        rationale: args.rationale ?? null,
        madeAt: now,
      })
      .where(eq(draftPicks.id, pick.id));

    await tx
      .insert(rosterSlots)
      .values({ teamId, playerId, acquiredVia: "draft", acquiredAt: now })
      .onConflictDoNothing();

    await tx.insert(transactions).values({
      leagueId,
      teamId,
      type: "draft",
      weekNo: null,
      playerId,
      runId: ctx.runId || null,
      details: {
        round: pick.round,
        pickNo: pick.pickNo,
        overallNo: pick.overallNo,
        auto: args.auto ?? false,
      },
    });

    return {
      ok: true,
      pickId: pick.id,
      overallNo: pick.overallNo,
      pickNo: pick.pickNo,
      round: pick.round,
    };
  }, executor);
}

// -------------------------------------------------------------- auto-pick

/** Best available by this week's projection, respecting the position rules. */
export async function bestAvailablePlayerId(
  leagueId: string,
  teamId: string,
  snapshot: SnapshotPayload | null,
  executor: DbOrTx = db,
): Promise<string | null> {
  const rules = await executor.query.leagueRules.findFirst({
    where: eq(leagueRules.leagueId, leagueId),
  });
  if (!rules) return null;

  const drafted = await draftedPlayerIds(leagueId, executor);
  const rostered = await executor
    .select({ playerId: rosterSlots.playerId })
    .from(rosterSlots)
    .innerJoin(teams, eq(teams.id, rosterSlots.teamId))
    .where(eq(teams.leagueId, leagueId));
  for (const r of rostered) drafted.add(r.playerId);

  const roster = await executor
    .select({ position: players.position })
    .from(rosterSlots)
    .innerJoin(players, eq(players.id, rosterSlots.playerId))
    .where(eq(rosterSlots.teamId, teamId));
  const remaining = await executor
    .select({ n: count() })
    .from(draftPicks)
    .where(
      and(
        eq(draftPicks.leagueId, leagueId),
        eq(draftPicks.teamId, teamId),
        isNull(draftPicks.playerId),
      ),
    );
  const picksRemainingAfter = Math.max(0, (remaining[0]?.n ?? 1) - 1);

  const ranked = await rankedAvailablePlayers(leagueId, snapshot, executor);
  const currentPositions = roster.map((r) => r.position);

  for (const candidate of ranked) {
    if (drafted.has(candidate.id)) continue;
    const problem = validatePickPosition({
      position: candidate.position,
      currentPositions,
      rosterShape: rules.rosterSlots,
      picksRemainingAfter,
      superflex: rules.superflex,
    });
    if (!problem) return candidate.id;
  }
  // Every remaining candidate breaks a positional rule — take the best anyway
  // rather than stalling the draft.
  return ranked.find((c) => !drafted.has(c.id))?.id ?? null;
}

/**
 * Draft-value ordering. Uses the snapshot's projections when one is available
 * (so an auto-pick sees exactly what the agent saw), otherwise the newest
 * projection rows, falling back to Sleeper's search rank.
 */
export async function rankedAvailablePlayers(
  leagueId: string,
  snapshot: SnapshotPayload | null,
  executor: DbOrTx = db,
): Promise<Array<{ id: string; position: string; points: number }>> {
  const rows = await executor
    .select({
      id: players.id,
      position: players.position,
      searchRank: players.searchRank,
    })
    .from(players);

  const points = new Map<string, number>();
  if (snapshot) {
    for (const [id, player] of Object.entries(snapshot.players)) {
      if (player.projection) points.set(id, player.projection.ppr);
    }
  }
  if (points.size === 0) {
    const league = await executor.query.leagues.findFirst({ where: eq(leagues.id, leagueId) });
    const projected = (await executor.execute(sql`
      select distinct on (player_id) player_id, coalesce(projected_points_ppr, 0) as pts
      from player_projections
      where season = ${league?.season ?? new Date().getUTCFullYear()}
      order by player_id, week asc, effective_at desc
    `)) as unknown as Array<{ player_id: string; pts: number | string }>;
    for (const row of projected) points.set(row.player_id, Number(row.pts));
  }

  return rows
    .map((r) => ({
      id: r.id,
      position: r.position,
      points: points.get(r.id) ?? 0,
      rank: r.searchRank ?? 99_999,
    }))
    .sort((a, b) => (b.points !== a.points ? b.points - a.points : a.rank - b.rank))
    .map(({ id, position, points: p }) => ({ id, position, points: p }));
}

// -------------------------------------------------------- draft completion

/**
 * The last pick landed: give everyone a default week-1 lineup, build the
 * schedule, and open the season.
 */
export async function finalizeDraft(
  leagueId: string,
  snapshot: SnapshotPayload | null,
  executor: DbOrTx = db,
): Promise<{ lineups: number; matchups: number }> {
  const league = await executor.query.leagues.findFirst({ where: eq(leagues.id, leagueId) });
  if (!league) return { lineups: 0, matchups: 0 };

  const leagueTeams = await executor.select().from(teams).where(eq(teams.leagueId, leagueId));
  let lineupCount = 0;
  if (snapshot) {
    for (const team of leagueTeams) {
      const slots = await safeComputeOptimalLineup({ snapshot, teamId: team.id });
      if (slots.length === 0) continue;
      await safeCommitLineup(
        { teamId: team.id, weekNo: 1, slots, source: "draft_default" },
        executor,
      );
      lineupCount++;
    }
  }

  const schedule = await generateSchedule(leagueId, executor);
  await executor
    .update(leagues)
    .set({ status: "in_season", updatedAt: new Date() })
    .where(eq(leagues.id, leagueId));

  return { lineups: lineupCount, matchups: schedule.matchups };
}

// ----------------------------------------------------------------- auction

export async function nominatePlayer(
  args: {
    leagueId: string;
    windowId: string;
    teamId: string;
    playerId: string;
    openingBid: number;
    ctx: AgentContext;
  },
  executor: DbOrTx = db,
): Promise<ActionResult<{ nominationId: string }>> {
  const { leagueId, windowId, teamId, playerId, openingBid, ctx } = args;
  return withTransaction(async (tx) => {
    const window = await tx.query.windows.findFirst({ where: eq(windows.id, windowId) });
    if (!window || window.leagueId !== leagueId || window.type !== "draft") {
      return { ok: false, errors: ["That is not an open draft window."] };
    }
    const lot = await tx.query.auctionNominations.findFirst({
      where: and(
        eq(auctionNominations.leagueId, leagueId),
        eq(auctionNominations.status, "awaiting_nomination"),
      ),
      orderBy: asc(auctionNominations.lotNo),
    });
    if (!lot) return { ok: false, errors: ["There is no lot awaiting nomination."] };
    if (lot.nominatingTeamId !== teamId) {
      return { ok: false, errors: ["It is not your nomination."] };
    }
    if ((await draftedPlayerIds(leagueId, tx)).has(playerId)) {
      return { ok: false, errors: ["That player is already drafted."] };
    }
    const team = await tx.query.teams.findFirst({ where: eq(teams.id, teamId) });
    const bid = Math.max(1, Math.trunc(openingBid));
    if (!team || bid > team.draftBudgetRemaining) {
      return { ok: false, errors: ["Opening bid exceeds your remaining budget."] };
    }

    await tx
      .update(auctionNominations)
      .set({ playerId, openingBid: bid, status: "open", windowId, runId: ctx.runId || null })
      .where(eq(auctionNominations.id, lot.id));
    // The nominator's opening bid stands as their sealed bid.
    await tx
      .insert(auctionBids)
      .values({ nominationId: lot.id, teamId, amount: bid, runId: ctx.runId || null, windowId })
      .onConflictDoUpdate({
        target: [auctionBids.nominationId, auctionBids.teamId],
        set: { amount: bid },
      });

    return { ok: true, nominationId: lot.id };
  }, executor);
}

export async function submitAuctionBid(
  args: {
    leagueId: string;
    windowId: string;
    teamId: string;
    playerId: string;
    amount: number;
    ctx: AgentContext;
  },
  executor: DbOrTx = db,
): Promise<ActionResult<{ bidId: string }>> {
  const { leagueId, windowId, teamId, playerId, amount, ctx } = args;
  return withTransaction(async (tx) => {
    const lot = await tx.query.auctionNominations.findFirst({
      where: and(
        eq(auctionNominations.leagueId, leagueId),
        eq(auctionNominations.status, "open"),
        eq(auctionNominations.playerId, playerId),
      ),
      orderBy: asc(auctionNominations.lotNo),
    });
    if (!lot) return { ok: false, errors: ["No open lot for that player."] };

    const team = await tx.query.teams.findFirst({ where: eq(teams.id, teamId) });
    if (!team || team.leagueId !== leagueId) {
      return { ok: false, errors: ["Unknown team."] };
    }
    const bid = Math.trunc(amount);
    if (bid < 0) return { ok: false, errors: ["Bid must be zero or more."] };
    if (bid > team.draftBudgetRemaining) {
      return {
        ok: false,
        errors: [`Bid ${bid} exceeds your remaining budget (${team.draftBudgetRemaining}).`],
      };
    }

    const [row] = await tx
      .insert(auctionBids)
      .values({ nominationId: lot.id, teamId, amount: bid, runId: ctx.runId || null, windowId })
      .onConflictDoUpdate({
        target: [auctionBids.nominationId, auctionBids.teamId],
        set: { amount: bid, runId: ctx.runId || null, windowId },
      })
      .returning({ id: auctionBids.id });

    return { ok: true, bidId: row.id };
  }, executor);
}

/**
 * Resolve a sealed-bid lot. Highest bid wins; ties break on lowest current
 * roster value (fewest players, then least spent), then a seeded random that is
 * recorded on the lot so the trace can show how it broke (PRD 5.2).
 */
export async function resolveAuctionLot(
  nominationId: string,
  now: Date = new Date(),
  executor: DbOrTx = db,
): Promise<{ winnerTeamId: string | null; price: number | null }> {
  return withTransaction(async (tx) => {
    const lot = await tx.query.auctionNominations.findFirst({
      where: eq(auctionNominations.id, nominationId),
    });
    if (!lot || lot.status !== "open" || !lot.playerId) {
      return { winnerTeamId: null, price: null };
    }

    const bids = await tx
      .select()
      .from(auctionBids)
      .where(eq(auctionBids.nominationId, nominationId))
      .orderBy(desc(auctionBids.amount));
    if (bids.length === 0) {
      await tx
        .update(auctionNominations)
        .set({ status: "abandoned", resolvedAt: now })
        .where(eq(auctionNominations.id, nominationId));
      return { winnerTeamId: null, price: null };
    }

    const top = bids[0].amount;
    const tied = bids.filter((b) => b.amount === top);
    let winner = tied[0];
    const tiebreak: Record<string, unknown> = { topBid: top, tiedTeams: tied.map((t) => t.teamId) };

    if (tied.length > 1) {
      const rosterCounts = await tx
        .select({ teamId: rosterSlots.teamId, n: count() })
        .from(rosterSlots)
        .where(inArray(rosterSlots.teamId, tied.map((t) => t.teamId)))
        .groupBy(rosterSlots.teamId);
      const sizeByTeam = new Map(rosterCounts.map((r) => [r.teamId, Number(r.n)]));
      const ranked = [...tied].sort(
        (a, b) => (sizeByTeam.get(a.teamId) ?? 0) - (sizeByTeam.get(b.teamId) ?? 0),
      );
      const smallest = sizeByTeam.get(ranked[0].teamId) ?? 0;
      const stillTied = ranked.filter((t) => (sizeByTeam.get(t.teamId) ?? 0) === smallest);
      if (stillTied.length > 1) {
        const seed = lot.lotNo * 7919 + top;
        const pick = Math.floor(seededRandom(seed)() * stillTied.length);
        winner = stillTied[pick];
        tiebreak.rule = "seeded_random";
        tiebreak.seed = seed;
      } else {
        winner = ranked[0];
        tiebreak.rule = "lowest_roster_value";
      }
    }

    const nextOverall =
      ((
        await tx
          .select({ max: sql<number>`coalesce(max(${draftPicks.overallNo}), 0)` })
          .from(draftPicks)
          .where(eq(draftPicks.leagueId, lot.leagueId))
      )[0]?.max ?? 0) + 1;

    await tx.insert(draftPicks).values({
      leagueId: lot.leagueId,
      round: 1,
      pickNo: lot.lotNo,
      overallNo: nextOverall,
      teamId: winner.teamId,
      playerId: lot.playerId,
      price: winner.amount,
      madeByRunId: winner.runId,
      windowId: winner.windowId,
      madeAt: now,
    });
    await tx
      .insert(rosterSlots)
      .values({
        teamId: winner.teamId,
        playerId: lot.playerId,
        acquiredVia: "draft",
        acquiredAt: now,
      })
      .onConflictDoNothing();
    await tx
      .update(teams)
      .set({ draftBudgetRemaining: sql`${teams.draftBudgetRemaining} - ${winner.amount}` })
      .where(eq(teams.id, winner.teamId));
    await tx.insert(transactions).values({
      leagueId: lot.leagueId,
      teamId: winner.teamId,
      type: "draft",
      playerId: lot.playerId,
      runId: winner.runId,
      details: { auction: true, lotNo: lot.lotNo, price: winner.amount },
    });
    await tx
      .update(auctionNominations)
      .set({
        status: "resolved",
        winningTeamId: winner.teamId,
        winningBid: winner.amount,
        tiebreak,
        resolvedAt: now,
      })
      .where(eq(auctionNominations.id, nominationId));

    return { winnerTeamId: winner.teamId, price: winner.amount };
  }, executor);
}

// ------------------------------------------------------------- draft board

export async function getDraftBoard(
  leagueId: string,
  executor: DbOrTx = db,
): Promise<DraftBoard> {
  const league = await executor.query.leagues.findFirst({ where: eq(leagues.id, leagueId) });
  if (!league) throw new Error(`League ${leagueId} not found`);

  const rows = await executor
    .select({
      pick: draftPicks,
      teamName: teams.name,
      playerName: players.fullName,
      position: players.position,
      nflTeam: players.nflTeam,
      runRationale: runs.rationale,
      runCost: runs.totalCostUsd,
    })
    .from(draftPicks)
    .innerJoin(teams, eq(teams.id, draftPicks.teamId))
    .leftJoin(players, eq(players.id, draftPicks.playerId))
    .leftJoin(runs, eq(runs.id, draftPicks.madeByRunId))
    .where(eq(draftPicks.leagueId, leagueId))
    .orderBy(asc(draftPicks.overallNo));

  const picks: DraftBoardPick[] = rows.map(({ pick, teamName, playerName, position, nflTeam, runRationale, runCost }) => ({
    id: pick.id,
    round: pick.round,
    pickNo: pick.pickNo,
    overallNo: pick.overallNo,
    teamId: pick.teamId,
    teamName,
    playerId: pick.playerId,
    playerName: playerName ?? null,
    position: position ?? null,
    nflTeam: nflTeam ?? null,
    auto: pick.auto,
    // The agent's own `set_rationale` on the pick's run is the public copy.
    rationale: pick.rationale ?? runRationale ?? null,
    runId: pick.madeByRunId,
    costUsd: runCost ?? null,
    price: pick.price,
    madeAt: pick.madeAt?.toISOString() ?? null,
  }));

  const pending = picks.find((p) => p.playerId === null);
  let onTheClock: DraftBoard["onTheClock"] = null;
  if (pending) {
    const openWindow = await executor.query.windows.findFirst({
      where: and(
        eq(windows.leagueId, leagueId),
        eq(windows.type, "draft"),
        eq(windows.status, "open"),
      ),
      orderBy: desc(windows.opensAt),
    });
    onTheClock = {
      teamId: pending.teamId,
      teamName: pending.teamName,
      overallNo: pending.overallNo,
      deadlineAt: openWindow?.closesAt.toISOString() ?? null,
    };
  }

  const rounds = picks.reduce((max, p) => Math.max(max, p.round), 0);
  const runningCostUsd =
    Math.round(picks.reduce((sum, p) => sum + (p.costUsd ?? 0), 0) * 1e6) / 1e6;

  return {
    leagueId,
    draftType: league.draftType,
    status: league.status,
    rounds,
    picks,
    onTheClock,
    runningCostUsd,
  };
}
