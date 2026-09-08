/**
 * Waivers — FAAB blind bidding (PRD §5.4 write tools, §6.2 processing).
 *
 * `submitWaiverClaims` and `dropPlayer` are agent write tools: they validate
 * against the window's snapshot and return a structured error the agent can
 * retry against. `processWaivers` runs once at window close from the tick and
 * is the only place a roster actually changes.
 *
 * Ordering at close: highest bid wins; ties break on waiver priority (worst
 * record first), then on submission time. Winning a claim rotates that team to
 * the back of the priority order.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { db, withTransaction, type DbOrTx } from "@/lib/db";
import {
  leagueRules,
  nflGames,
  players,
  rosterSlots,
  teams,
  transactions,
  waiverClaims,
  windows,
} from "@/lib/db/schema";
import type { ActionResult, AgentContext } from "@/lib/services/messaging";
import { loadSnapshot } from "@/lib/services/snapshot";
import type { SnapshotPayload } from "@/lib/snapshot/types";

export type WaiverClaimInput = {
  addPlayerId: string;
  dropPlayerId?: string;
  bid: number;
};

export type WaiverResultRow = {
  claimId: string;
  teamId: string;
  teamName: string;
  addPlayerId: string;
  addPlayerName: string;
  dropPlayerId: string | null;
  dropPlayerName: string | null;
  bid: number;
  status: "pending" | "won" | "lost" | "invalid";
  resultReason: string | null;
  processedAt: string | null;
};

/** Total roster capacity = every slot in the league's roster shape. */
export function rosterCapacity(rosterShape: Record<string, number>): number {
  return Object.values(rosterShape).reduce((sum, n) => sum + n, 0);
}

async function loadWindowSnapshot(
  snapshotId: string | null,
  executor: DbOrTx,
): Promise<SnapshotPayload | null> {
  if (!snapshotId) return null;
  try {
    return (await loadSnapshot(snapshotId, executor)).payload;
  } catch {
    return null;
  }
}

// ------------------------------------------------------- submit_waiver_claims

export async function submitWaiverClaims(
  args: {
    leagueId: string;
    teamId: string;
    windowId: string;
    weekNo: number;
    claims: WaiverClaimInput[];
    ctx: AgentContext;
  },
  executor: DbOrTx = db,
): Promise<ActionResult<{ claimIds: string[]; accepted: number }>> {
  const { leagueId, teamId, windowId, weekNo, claims, ctx } = args;
  if (claims.length === 0) return { ok: false, errors: ["No claims submitted."] };

  return withTransaction(async (tx) => {
    const window = await tx.query.windows.findFirst({ where: eq(windows.id, windowId) });
    if (!window || window.leagueId !== leagueId) {
      return { ok: false, errors: [`Window ${windowId} does not belong to this league.`] };
    }
    if (window.type !== "waiver") {
      return { ok: false, errors: [`Window ${window.label} is not a waiver window.`] };
    }
    if (window.status !== "open") {
      return { ok: false, errors: [`Waiver window ${window.label} is ${window.status}, not open.`] };
    }

    const team = await tx.query.teams.findFirst({ where: eq(teams.id, teamId) });
    if (!team || team.leagueId !== leagueId) {
      return { ok: false, errors: [`Team ${teamId} is not in this league.`] };
    }
    const rules = await tx.query.leagueRules.findFirst({
      where: eq(leagueRules.leagueId, leagueId),
    });
    if (!rules) return { ok: false, errors: ["League rules are missing."] };

    const snapshot = await loadWindowSnapshot(window.snapshotId, tx);
    const roster = await tx
      .select({ playerId: rosterSlots.playerId })
      .from(rosterSlots)
      .where(eq(rosterSlots.teamId, teamId));
    const rosterIds = new Set(roster.map((r) => r.playerId));
    const capacity = rosterCapacity(rules.rosterSlots);

    // Rostered anywhere in the league = not a free agent.
    const leagueRostered = new Set(
      (
        await tx
          .select({ playerId: rosterSlots.playerId })
          .from(rosterSlots)
          .innerJoin(teams, eq(teams.id, rosterSlots.teamId))
          .where(eq(teams.leagueId, leagueId))
      ).map((r) => r.playerId),
    );

    const errors: string[] = [];
    const seenAdds = new Set<string>();
    let totalBid = 0;
    let netRosterChange = 0;

    for (const [i, claim] of claims.entries()) {
      const label = `claim ${i + 1}`;
      const bid = Math.trunc(claim.bid);
      if (!Number.isFinite(bid) || bid < 0) {
        errors.push(`${label}: bid must be a non-negative whole number.`);
        continue;
      }
      if (bid > team.faabRemaining) {
        errors.push(`${label}: bid ${bid} exceeds your remaining FAAB (${team.faabRemaining}).`);
      }
      totalBid += bid;

      if (seenAdds.has(claim.addPlayerId)) {
        errors.push(`${label}: duplicate claim for the same player in this submission.`);
        continue;
      }
      seenAdds.add(claim.addPlayerId);

      // Free-agency is judged against the window's snapshot, so every team in
      // the window sees the same wire (PRD 5.3).
      const snapshotPlayer = snapshot?.players[claim.addPlayerId];
      const isFreeAgent = snapshot
        ? snapshotPlayer !== undefined && snapshotPlayer.ownerTeamId === null
        : !leagueRostered.has(claim.addPlayerId);
      if (!isFreeAgent) {
        errors.push(`${label}: ${playerLabel(snapshot, claim.addPlayerId)} is not a free agent.`);
      }

      if (claim.dropPlayerId) {
        if (!rosterIds.has(claim.dropPlayerId)) {
          errors.push(`${label}: ${playerLabel(snapshot, claim.dropPlayerId)} is not on your roster.`);
        }
      } else {
        netRosterChange += 1;
      }
    }

    if (rosterIds.size + netRosterChange > capacity) {
      errors.push(
        `Roster would exceed ${capacity} players — add a drop to at least ${rosterIds.size + netRosterChange - capacity} claim(s).`,
      );
    }
    if (totalBid > team.faabRemaining) {
      // Not fatal on its own (losing claims cost nothing), but worth telling the agent.
      errors.push(
        `Total bids (${totalBid}) exceed your FAAB (${team.faabRemaining}); you cannot win all of these.`,
      );
    }

    if (errors.length > 0) return { ok: false, errors };

    // Replacing this team's earlier claims for the same players keeps "last
    // submission wins" true across retries within the window.
    const addIds = claims.map((c) => c.addPlayerId);
    await tx
      .delete(waiverClaims)
      .where(
        and(
          eq(waiverClaims.windowId, windowId),
          eq(waiverClaims.teamId, teamId),
          eq(waiverClaims.status, "pending"),
          inArray(waiverClaims.addPlayerId, addIds),
        ),
      );

    const inserted = await tx
      .insert(waiverClaims)
      .values(
        claims.map((claim, i) => ({
          teamId,
          windowId,
          leagueId,
          weekNo,
          addPlayerId: claim.addPlayerId,
          dropPlayerId: claim.dropPlayerId ?? null,
          bid: Math.trunc(claim.bid),
          priority: i + 1,
          runId: ctx.runId || null,
          status: "pending" as const,
        })),
      )
      .returning({ id: waiverClaims.id });

    return { ok: true, claimIds: inserted.map((r) => r.id), accepted: inserted.length };
  }, executor);
}

function playerLabel(snapshot: SnapshotPayload | null, playerId: string): string {
  return snapshot?.players[playerId]?.fullName ?? playerId;
}

// -------------------------------------------------------------- drop_player

export async function dropPlayer(
  args: {
    leagueId: string;
    teamId: string;
    playerId: string;
    weekNo: number;
    ctx: AgentContext;
    now?: Date;
  },
  executor: DbOrTx = db,
): Promise<ActionResult<{ playerId: string }>> {
  const { leagueId, teamId, playerId, weekNo, ctx } = args;
  const now = args.now ?? new Date();

  return withTransaction(async (tx) => {
    const team = await tx.query.teams.findFirst({ where: eq(teams.id, teamId) });
    if (!team || team.leagueId !== leagueId) {
      return { ok: false, errors: [`Team ${teamId} is not in this league.`] };
    }
    const slot = await tx.query.rosterSlots.findFirst({
      where: and(eq(rosterSlots.teamId, teamId), eq(rosterSlots.playerId, playerId)),
    });
    if (!slot) return { ok: false, errors: ["That player is not on your roster."] };

    if (await isPlayerLocked(playerId, weekNo, now, tx)) {
      return { ok: false, errors: ["That player's game has already kicked off; he is locked."] };
    }

    await tx
      .delete(rosterSlots)
      .where(and(eq(rosterSlots.teamId, teamId), eq(rosterSlots.playerId, playerId)));
    await tx.insert(transactions).values({
      leagueId,
      teamId,
      type: "drop",
      weekNo,
      playerId,
      runId: ctx.runId || null,
      details: { source: "agent_drop", windowId: ctx.windowId },
    });
    return { ok: true, playerId };
  }, executor);
}

/** A player is locked once his team's game for the week has kicked off. */
export async function isPlayerLocked(
  playerId: string,
  weekNo: number,
  now: Date,
  executor: DbOrTx = db,
): Promise<boolean> {
  const player = await executor.query.players.findFirst({ where: eq(players.id, playerId) });
  if (!player?.nflTeam) return false;
  const games = await executor
    .select({ kickoffAt: nflGames.kickoffAt })
    .from(nflGames)
    .where(
      and(
        eq(nflGames.week, weekNo),
        sql`(${nflGames.homeTeam} = ${player.nflTeam} or ${nflGames.awayTeam} = ${player.nflTeam})`,
      ),
    );
  return games.some((g) => g.kickoffAt.getTime() <= now.getTime());
}

// ---------------------------------------------------------- processWaivers

export async function processWaivers(
  windowId: string,
  now: Date = new Date(),
  executor: DbOrTx = db,
): Promise<{ processed: number; awarded: number }> {
  return withTransaction(async (tx) => {
    const window = await tx.query.windows.findFirst({ where: eq(windows.id, windowId) });
    if (!window || window.type !== "waiver") return { processed: 0, awarded: 0 };

    const rules = await tx.query.leagueRules.findFirst({
      where: eq(leagueRules.leagueId, window.leagueId),
    });
    if (!rules) return { processed: 0, awarded: 0 };
    const capacity = rosterCapacity(rules.rosterSlots);

    const pending = await tx
      .select()
      .from(waiverClaims)
      .where(and(eq(waiverClaims.windowId, windowId), eq(waiverClaims.status, "pending")))
      .orderBy(asc(waiverClaims.createdAt));
    if (pending.length === 0) return { processed: 0, awarded: 0 };

    const leagueTeams = await tx
      .select()
      .from(teams)
      .where(eq(teams.leagueId, window.leagueId));
    const teamById = new Map(leagueTeams.map((t) => [t.id, { ...t }]));

    const rosterRows = await tx
      .select({ teamId: rosterSlots.teamId, playerId: rosterSlots.playerId })
      .from(rosterSlots)
      .innerJoin(teams, eq(teams.id, rosterSlots.teamId))
      .where(eq(teams.leagueId, window.leagueId));
    const rosterByTeam = new Map<string, Set<string>>(leagueTeams.map((t) => [t.id, new Set()]));
    const rosteredPlayers = new Set<string>();
    for (const row of rosterRows) {
      rosterByTeam.get(row.teamId)?.add(row.playerId);
      rosteredPlayers.add(row.playerId);
    }

    // bid desc -> waiver priority asc (1 = worst record, first in line) -> earlier submission
    const ordered = [...pending].sort((a, b) => {
      if (b.bid !== a.bid) return b.bid - a.bid;
      const pa = teamById.get(a.teamId)?.waiverPriority ?? 99;
      const pb = teamById.get(b.teamId)?.waiverPriority ?? 99;
      if (pa !== pb) return pa - pb;
      return a.createdAt.getTime() - b.createdAt.getTime();
    });

    const winners: string[] = [];
    let awarded = 0;

    for (const claim of ordered) {
      const team = teamById.get(claim.teamId);
      const roster = rosterByTeam.get(claim.teamId);
      const fail = async (reason: string, status: "lost" | "invalid" = "invalid") => {
        await tx
          .update(waiverClaims)
          .set({ status, resultReason: reason, processedAt: now })
          .where(eq(waiverClaims.id, claim.id));
      };

      if (!team || !roster) {
        await fail("Team no longer exists.");
        continue;
      }
      if (rosteredPlayers.has(claim.addPlayerId)) {
        await fail("Player was already claimed by a higher bid.", "lost");
        continue;
      }
      if (claim.bid > team.faabRemaining) {
        await fail(`Insufficient FAAB (${team.faabRemaining} remaining).`);
        continue;
      }
      if (claim.dropPlayerId && !roster.has(claim.dropPlayerId)) {
        await fail("Drop player is no longer on the roster.");
        continue;
      }
      const sizeAfter = roster.size + 1 - (claim.dropPlayerId ? 1 : 0);
      if (sizeAfter > capacity) {
        await fail(`Roster would exceed ${capacity} players.`);
        continue;
      }

      // ---- award
      if (claim.dropPlayerId) {
        await tx
          .delete(rosterSlots)
          .where(
            and(
              eq(rosterSlots.teamId, claim.teamId),
              eq(rosterSlots.playerId, claim.dropPlayerId),
            ),
          );
        roster.delete(claim.dropPlayerId);
        rosteredPlayers.delete(claim.dropPlayerId);
        await tx.insert(transactions).values({
          leagueId: window.leagueId,
          teamId: claim.teamId,
          type: "drop",
          weekNo: claim.weekNo,
          playerId: claim.dropPlayerId,
          runId: claim.runId,
          details: { source: "waiver", windowId, claimId: claim.id },
        });
      }

      await tx
        .insert(rosterSlots)
        .values({
          teamId: claim.teamId,
          playerId: claim.addPlayerId,
          acquiredVia: "waiver",
          acquiredAt: now,
        })
        .onConflictDoNothing();
      roster.add(claim.addPlayerId);
      rosteredPlayers.add(claim.addPlayerId);

      team.faabRemaining -= claim.bid;
      await tx
        .update(teams)
        .set({ faabRemaining: team.faabRemaining })
        .where(eq(teams.id, claim.teamId));

      await tx.insert(transactions).values({
        leagueId: window.leagueId,
        teamId: claim.teamId,
        type: "add",
        weekNo: claim.weekNo,
        playerId: claim.addPlayerId,
        runId: claim.runId,
        details: { source: "waiver", windowId, claimId: claim.id, bid: claim.bid },
      });
      await tx
        .update(waiverClaims)
        .set({ status: "won", resultReason: `Won at $${claim.bid}.`, processedAt: now })
        .where(eq(waiverClaims.id, claim.id));

      if (!winners.includes(claim.teamId)) winners.push(claim.teamId);
      awarded++;
    }

    // Rotate: every team that won drops to the back of the priority order.
    if (winners.length > 0) {
      const losers = leagueTeams
        .filter((t) => !winners.includes(t.id))
        .sort((a, b) => a.waiverPriority - b.waiverPriority)
        .map((t) => t.id);
      const order = [...losers, ...winners];
      for (const [i, teamId] of order.entries()) {
        await tx
          .update(teams)
          .set({ waiverPriority: i + 1 })
          .where(eq(teams.id, teamId));
      }
    }

    return { processed: ordered.length, awarded };
  }, executor);
}

export async function getWaiverResults(
  windowId: string,
  executor: DbOrTx = db,
): Promise<WaiverResultRow[]> {
  const rows = await executor
    .select({
      claim: waiverClaims,
      teamName: teams.name,
      addPlayerName: players.fullName,
    })
    .from(waiverClaims)
    .innerJoin(teams, eq(teams.id, waiverClaims.teamId))
    .innerJoin(players, eq(players.id, waiverClaims.addPlayerId))
    .where(eq(waiverClaims.windowId, windowId))
    .orderBy(asc(waiverClaims.status), asc(waiverClaims.createdAt));

  const dropIds = rows
    .map((r) => r.claim.dropPlayerId)
    .filter((id): id is string => id !== null);
  const dropNames = new Map<string, string>();
  if (dropIds.length > 0) {
    const dropped = await executor
      .select({ id: players.id, fullName: players.fullName })
      .from(players)
      .where(inArray(players.id, dropIds));
    for (const d of dropped) dropNames.set(d.id, d.fullName);
  }

  return rows.map(({ claim, teamName, addPlayerName }) => ({
    claimId: claim.id,
    teamId: claim.teamId,
    teamName,
    addPlayerId: claim.addPlayerId,
    addPlayerName,
    dropPlayerId: claim.dropPlayerId,
    dropPlayerName: claim.dropPlayerId ? (dropNames.get(claim.dropPlayerId) ?? null) : null,
    bid: claim.bid,
    status: claim.status,
    resultReason: claim.resultReason,
    processedAt: claim.processedAt?.toISOString() ?? null,
  }));
}
