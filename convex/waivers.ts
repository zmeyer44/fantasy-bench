/**
 * Waiver outcomes (PRD §5.3).
 *
 * `waiver_claims.by_leagueId_weekNo` is the only index this needs: one league
 * week holds at most `teams × 10` claims, and the league-wide figures
 * (pending count, FAAB spent, the week picker) come from the same bounded
 * per-week ranges rather than a table scan.
 */
import { v } from "convex/values";

import type { SnapshotPayload } from "../lib/snapshot/types";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, query, type QueryCtx } from "./_generated/server";
import { agentCtxValidator, fail, withAgentAction } from "./lib/agent_action";
import { requireLeagueRead } from "./lib/auth";
import { rosterCapacity } from "./lib/draft_pure";
import { isLocked } from "./lib/lineup_pure";
import { payloadForWindow } from "./lineups";
import { readPayload, latestPayload } from "./snapshot";
import { projectionFor } from "./lib/views_shared";

/** Claims per league week: 14 teams × 10 claims, with headroom. */
const MAX_CLAIMS_PER_WEEK = 200;
const MAX_WEEK = 22;

export type WaiverResultRow = {
  claimId: Id<"waiver_claims">;
  teamId: Id<"teams">;
  teamName: string;
  teamAbbreviation: string;
  avatarUrl?: string | null;
  avatarTemplate?: string;
  addSleeperId?: string;
  addNflTeam?: string | null;
  addPlayerId: Id<"players">;
  addPlayerName: string;
  addPlayerPosition: string | null;
  dropPlayerId: Id<"players"> | null;
  dropPlayerName: string | null;
  bid: number;
  priority: number;
  status: Doc<"waiver_claims">["status"];
  resultReason: string | null;
  processedAt: number | null;
  runId: Id<"runs"> | null;
  weekNo: number;
};

export type WaiverWeekView = {
  leagueId: Id<"leagues">;
  weekNo: number;
  results: WaiverResultRow[];
  pendingCount: number;
  /** Every week that has at least one claim, newest first — powers the week picker. */
  weeksWithClaims: number[];
  faab: Array<{
    teamId: Id<"teams">;
    teamName: string;
    abbreviation: string;
    remaining: number;
    spent: number;
  }>;
  window: { id: Id<"windows">; opensAt: number; closesAt: number; status: string } | null;
};

export const results = query({
  args: { leagueId: v.id("leagues"), weekNo: v.number() },
  handler: async (ctx, { leagueId, weekNo }): Promise<WaiverWeekView> => {
    await requireLeagueRead(ctx, leagueId);

    // Bounded: ≤ 14 teams.
    const teamRows = await ctx.db
      .query("teams")
      .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
      .collect();
    const teamById = new Map(teamRows.map((t) => [t._id as string, t]));

    let pendingCount = 0;
    const weeksWithClaims: number[] = [];
    const spentByTeam = new Map<string, number>();
    let weekClaims: Doc<"waiver_claims">[] = [];

    // Bounded: one range per league week, each capped at MAX_CLAIMS_PER_WEEK.
    for (let week = 0; week <= MAX_WEEK; week++) {
      const claims = await ctx.db
        .query("waiver_claims")
        .withIndex("by_leagueId_weekNo", (q) => q.eq("leagueId", leagueId).eq("weekNo", week))
        .take(MAX_CLAIMS_PER_WEEK);
      if (claims.length === 0) continue;
      weeksWithClaims.push(week);
      for (const claim of claims) {
        if (claim.status === "pending") pendingCount++;
        if (claim.status === "won") {
          spentByTeam.set(claim.teamId, (spentByTeam.get(claim.teamId) ?? 0) + claim.bid);
        }
      }
      if (week === weekNo) weekClaims = claims;
    }

    const results: WaiverResultRow[] = [];
    for (const claim of weekClaims.sort((a, b) => b.bid - a.bid || a.priority - b.priority)) {
      const addPlayer = await ctx.db.get("players", claim.addPlayerId);
      const dropPlayer = claim.dropPlayerId
        ? await ctx.db.get("players", claim.dropPlayerId)
        : null;
      const team = teamById.get(claim.teamId);
      results.push({
        claimId: claim._id,
        teamId: claim.teamId,
        teamName: team?.name ?? "Unknown",
        teamAbbreviation: team?.abbreviation ?? "??",
        avatarUrl: team?.avatarStorageId ? await ctx.storage.getUrl(team.avatarStorageId) : null,
        avatarTemplate: team?.avatarTemplate,
        addSleeperId: addPlayer?.sleeperId,
        addNflTeam: addPlayer?.nflTeam ?? null,
        addPlayerId: claim.addPlayerId,
        addPlayerName: addPlayer?.fullName ?? "Unknown",
        addPlayerPosition: addPlayer?.position ?? null,
        dropPlayerId: claim.dropPlayerId ?? null,
        dropPlayerName: dropPlayer?.fullName ?? null,
        bid: claim.bid,
        priority: claim.priority,
        status: claim.status,
        resultReason: claim.resultReason ?? null,
        processedAt: claim.processedAt ?? null,
        runId: claim.runId ?? null,
        weekNo: claim.weekNo,
      });
    }

    const windowRows = await ctx.db
      .query("windows")
      .withIndex("by_leagueId_weekNo_type", (q) =>
        q.eq("leagueId", leagueId).eq("weekNo", weekNo).eq("type", "waiver"),
      )
      .take(10);
    const windowRow = windowRows.sort((a, b) => b.opensAt - a.opensAt)[0] ?? null;

    return {
      leagueId,
      weekNo,
      results,
      pendingCount,
      weeksWithClaims: weeksWithClaims.slice().sort((a, b) => b - a),
      faab: teamRows
        .slice()
        .sort((a, b) => b.faabRemaining - a.faabRemaining)
        .map((team) => ({
          teamId: team._id,
          teamName: team.name,
          abbreviation: team.abbreviation,
          remaining: team.faabRemaining,
          spent: spentByTeam.get(team._id) ?? 0,
        })),
      window: windowRow
        ? {
            id: windowRow._id,
            opensAt: windowRow.opensAt,
            closesAt: windowRow.closesAt,
            status: windowRow.status,
          }
        : null,
    };
  },
});

// ---------------------------------------------------------------------------
// Write paths (PRD §5.4 write tools, §6.2 processing) — the port of
// the runtime's waiver tools.
//
// `submit` and `drop` are agent write tools: they validate against the window's
// snapshot and return a structured error the agent can retry against, never a
// throw. `process` runs once at window close and is the only place a roster
// actually changes on a waiver.
//
// Ordering at close: highest bid wins; ties break on waiver priority (worst
// record first), then on submission order. Winning a claim rotates that team to
// the back of the priority order.
// ---------------------------------------------------------------------------

/** Rostered rows in one league: 14 teams × 16 roster slots, with headroom. */
const MAX_ROSTER_ROWS = 400;
/** NFL games in one week: 16, with headroom for flexed/international slates. */
const MAX_GAMES_PER_WEEK = 40;

const claimInput = v.object({
  addPlayerId: v.id("players"),
  dropPlayerId: v.optional(v.id("players")),
  bid: v.number(),
});

/** Every player rostered anywhere in the league (bounded: teams × roster size). */
async function leagueRosteredIds(
  ctx: QueryCtx,
  leagueId: Id<"leagues">,
): Promise<Set<string>> {
  const rows = await ctx.db
    .query("roster_slots")
    .withIndex("by_leagueId_playerId", (q) => q.eq("leagueId", leagueId))
    .take(MAX_ROSTER_ROWS);
  return new Set(rows.map((r) => r.playerId as string));
}

function playerLabel(snapshot: SnapshotPayload | null, playerId: string): string {
  return snapshot?.players[playerId]?.fullName ?? playerId;
}

/**
 * A player is locked once his game for the week has kicked off.
 *
 * The window's snapshot is the source of truth (every team in the window sees
 * the same wire, PRD 5.3); without one the check falls back to `nfl_games`,
 * which is what the old service did.
 */
async function isPlayerLocked(
  ctx: QueryCtx,
  args: {
    leagueId: Id<"leagues">;
    playerId: Id<"players">;
    weekNo: number;
    now: number;
    snapshot: SnapshotPayload | null;
  },
): Promise<boolean> {
  const fromSnapshot = args.snapshot?.players[args.playerId];
  if (fromSnapshot) return isLocked(fromSnapshot, new Date(args.now));

  const player = await ctx.db.get("players", args.playerId);
  if (!player?.nflTeam) return false;
  const league = await ctx.db.get("leagues", args.leagueId);
  if (!league) return false;
  // Bounded: one NFL week is ~16 games.
  const games = await ctx.db
    .query("nfl_games")
    .withIndex("by_season_week", (q) => q.eq("season", league.season).eq("week", args.weekNo))
    .take(MAX_GAMES_PER_WEEK);
  return games.some(
    (g) =>
      (g.homeTeam === player.nflTeam || g.awayTeam === player.nflTeam) &&
      g.kickoffAt <= args.now,
  );
}

// ------------------------------------------------------- submit_waiver_claims

/**
 * `submit_waiver_claims`.
 *
 * Replaces the team's pending claims for this window wholesale
 * (`by_windowId_teamId`), so the last submission inside a window is the one that
 * processes — "last submission wins" across retries, and across a rethink.
 */
export const submit = internalMutation({
  args: {
    leagueId: v.id("leagues"),
    teamId: v.id("teams"),
    windowId: v.id("windows"),
    weekNo: v.number(),
    claims: v.array(claimInput),
    agentCtx: agentCtxValidator,
  },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      claimIds: v.array(v.id("waiver_claims")),
      accepted: v.number(),
      replaced: v.number(),
    }),
    v.object({ ok: v.literal(false), errors: v.array(v.string()) }),
  ),
  handler: async (ctx, args) => {
    return withAgentAction(
      ctx,
      args.agentCtx,
      {
        actionType: "submit_waiver_claims",
        payload: { teamId: args.teamId, windowId: args.windowId, claims: args.claims },
      },
      async () => {
        const { leagueId, teamId, windowId, weekNo, claims } = args;
        if (claims.length === 0) return fail("No claims submitted.");

        const window = await ctx.db.get("windows", windowId);
        if (!window || window.leagueId !== leagueId) {
          return fail(`Window ${windowId} does not belong to this league.`);
        }
        if (window.type !== "waiver") {
          return fail(`Window ${window.label} is not a waiver window.`);
        }
        if (window.status !== "open") {
          return fail(`Waiver window ${window.label} is ${window.status}, not open.`);
        }

        const team = await ctx.db.get("teams", teamId);
        if (!team || team.leagueId !== leagueId) {
          return fail(`Team ${teamId} is not in this league.`);
        }
        const rules = await ctx.db
          .query("league_rules")
          .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
          .unique();
        if (!rules) return fail("League rules are missing.");

        const snapshot = window.snapshotId ? await readPayload(ctx, window.snapshotId) : null;

        // Bounded: one team's roster.
        const roster = await ctx.db
          .query("roster_slots")
          .withIndex("by_teamId", (q) => q.eq("teamId", teamId))
          .take(MAX_ROSTER_ROWS);
        const rosterIds = new Set(roster.map((r) => r.playerId as string));
        const capacity = rosterCapacity(rules.rosterSlots);
        const leagueRostered = await leagueRosteredIds(ctx, leagueId);

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

          // Free agency is judged against the window's snapshot, so every team in
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
              errors.push(
                `${label}: ${playerLabel(snapshot, claim.dropPlayerId)} is not on your roster.`,
              );
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
          // Not fatal on its own (losing claims cost nothing), but worth saying.
          errors.push(
            `Total bids (${totalBid}) exceed your FAAB (${team.faabRemaining}); you cannot win all of these.`,
          );
        }

        if (errors.length > 0) return { ok: false as const, errors };

        // Bounded: one team's claims in one window (≤ 10 by the tool schema).
        const previous = await ctx.db
          .query("waiver_claims")
          .withIndex("by_windowId_teamId", (q) => q.eq("windowId", windowId).eq("teamId", teamId))
          .take(MAX_CLAIMS_PER_WEEK);
        let replaced = 0;
        for (const row of previous) {
          if (row.status !== "pending") continue;
          await ctx.db.delete("waiver_claims", row._id);
          replaced++;
        }

        const claimIds: Id<"waiver_claims">[] = [];
        for (const [i, claim] of claims.entries()) {
          claimIds.push(
            await ctx.db.insert("waiver_claims", {
              leagueId,
              teamId,
              windowId,
              weekNo,
              addPlayerId: claim.addPlayerId,
              dropPlayerId: claim.dropPlayerId,
              bid: Math.trunc(claim.bid),
              priority: i + 1,
              runId: args.agentCtx.runId,
              status: "pending",
            }),
          );
        }

        return { ok: true as const, claimIds, accepted: claimIds.length, replaced };
      },
    );
  },
});

// ------------------------------------------------------------- drop_player

/** `drop_player`: immediate, unless the player's game has already kicked off. */
export const drop = internalMutation({
  args: {
    leagueId: v.id("leagues"),
    teamId: v.id("teams"),
    playerId: v.id("players"),
    weekNo: v.number(),
    agentCtx: agentCtxValidator,
    now: v.optional(v.number()),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), playerId: v.id("players") }),
    v.object({ ok: v.literal(false), errors: v.array(v.string()) }),
  ),
  handler: async (ctx, args) => {
    return withAgentAction(
      ctx,
      args.agentCtx,
      {
        actionType: "drop_player",
        payload: { teamId: args.teamId, playerId: args.playerId, weekNo: args.weekNo },
      },
      async () => {
        const { leagueId, teamId, playerId, weekNo } = args;
        const now = args.now ?? Date.now();

        const team = await ctx.db.get("teams", teamId);
        if (!team || team.leagueId !== leagueId) {
          return fail(`Team ${teamId} is not in this league.`);
        }
        const slot = await ctx.db
          .query("roster_slots")
          .withIndex("by_teamId_playerId", (q) => q.eq("teamId", teamId).eq("playerId", playerId))
          .first();
        if (!slot) return fail("That player is not on your roster.");

        const snapshot = await payloadForWindow(ctx, args.agentCtx.windowId);
        if (await isPlayerLocked(ctx, { leagueId, playerId, weekNo, now, snapshot })) {
          return fail("That player's game has already kicked off; he is locked.");
        }

        await ctx.db.delete("roster_slots", slot._id);
        await ctx.db.insert("transactions", {
          leagueId,
          teamId,
          type: "drop",
          weekNo,
          playerId,
          runId: args.agentCtx.runId,
          details: { source: "agent_drop", windowId: args.agentCtx.windowId },
        });
        return { ok: true as const, playerId };
      },
    );
  },
});

// ---------------------------------------------------------------- processing

/**
 * Resolve every pending claim in a waiver window (PRD §6.2).
 *
 * Bounded by construction: one window holds at most `teams × 10` claims and one
 * league at most `teams × roster size` roster rows, so the whole resolution is
 * a handful of index ranges plus in-memory bookkeeping.
 */
export const process = internalMutation({
  args: { windowId: v.id("windows"), now: v.optional(v.number()) },
  returns: v.object({ processed: v.number(), awarded: v.number() }),
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const window = await ctx.db.get("windows", args.windowId);
    if (!window || window.type !== "waiver") return { processed: 0, awarded: 0 };

    const rules = await ctx.db
      .query("league_rules")
      .withIndex("by_leagueId", (q) => q.eq("leagueId", window.leagueId))
      .unique();
    if (!rules) return { processed: 0, awarded: 0 };
    const capacity = rosterCapacity(rules.rosterSlots);

    // Bounded: teams × 10 claims per window.
    const claims = await ctx.db
      .query("waiver_claims")
      .withIndex("by_windowId", (q) => q.eq("windowId", args.windowId))
      .take(MAX_CLAIMS_PER_WEEK);
    const pending = claims.filter((c) => c.status === "pending");
    if (pending.length === 0) return { processed: 0, awarded: 0 };

    // Bounded: ≤ 14 teams.
    const leagueTeams = await ctx.db
      .query("teams")
      .withIndex("by_leagueId", (q) => q.eq("leagueId", window.leagueId))
      .collect();
    const teamById = new Map(leagueTeams.map((t) => [t._id as string, { ...t }]));

    const rosterRows = await ctx.db
      .query("roster_slots")
      .withIndex("by_leagueId_playerId", (q) => q.eq("leagueId", window.leagueId))
      .take(MAX_ROSTER_ROWS);
    const rosterByTeam = new Map<string, Set<string>>(
      leagueTeams.map((t) => [t._id as string, new Set<string>()]),
    );
    const slotIdByKey = new Map<string, Id<"roster_slots">>();
    const rosteredPlayers = new Set<string>();
    for (const row of rosterRows) {
      rosterByTeam.get(row.teamId)?.add(row.playerId);
      slotIdByKey.set(`${row.teamId}:${row.playerId}`, row._id);
      rosteredPlayers.add(row.playerId);
    }

    // bid desc -> waiver priority asc (1 = worst record, first in line) -> earlier
    // submission -> the order the claims were listed in that submission.
    const ordered = [...pending].sort((a, b) => {
      if (b.bid !== a.bid) return b.bid - a.bid;
      const pa = teamById.get(a.teamId)?.waiverPriority ?? 99;
      const pb = teamById.get(b.teamId)?.waiverPriority ?? 99;
      if (pa !== pb) return pa - pb;
      if (a._creationTime !== b._creationTime) return a._creationTime - b._creationTime;
      return a.priority - b.priority;
    });

    const winners: string[] = [];
    let awarded = 0;

    for (const claim of ordered) {
      const team = teamById.get(claim.teamId);
      const roster = rosterByTeam.get(claim.teamId);
      const reject = async (reason: string, status: "lost" | "invalid" = "invalid") => {
        await ctx.db.patch("waiver_claims", claim._id, {
          status,
          resultReason: reason,
          processedAt: now,
        });
      };

      if (!team || !roster) {
        await reject("Team no longer exists.");
        continue;
      }
      if (rosteredPlayers.has(claim.addPlayerId)) {
        await reject("Player was already claimed by a higher bid.", "lost");
        continue;
      }
      if (claim.bid > team.faabRemaining) {
        await reject(`Insufficient FAAB (${team.faabRemaining} remaining).`);
        continue;
      }
      if (claim.dropPlayerId && !roster.has(claim.dropPlayerId)) {
        await reject("Drop player is no longer on the roster.");
        continue;
      }
      const sizeAfter = roster.size + 1 - (claim.dropPlayerId ? 1 : 0);
      if (sizeAfter > capacity) {
        await reject(`Roster would exceed ${capacity} players.`);
        continue;
      }

      // ---- award
      if (claim.dropPlayerId) {
        const slotId = slotIdByKey.get(`${claim.teamId}:${claim.dropPlayerId}`);
        if (slotId) await ctx.db.delete("roster_slots", slotId);
        roster.delete(claim.dropPlayerId);
        rosteredPlayers.delete(claim.dropPlayerId);
        slotIdByKey.delete(`${claim.teamId}:${claim.dropPlayerId}`);
        await ctx.db.insert("transactions", {
          leagueId: window.leagueId,
          teamId: claim.teamId,
          type: "drop",
          weekNo: claim.weekNo,
          playerId: claim.dropPlayerId,
          runId: claim.runId,
          details: { source: "waiver", windowId: args.windowId, claimId: claim._id },
        });
      }

      const addedSlotId = await ctx.db.insert("roster_slots", {
        leagueId: window.leagueId,
        teamId: claim.teamId,
        playerId: claim.addPlayerId,
        acquiredVia: "waiver",
        acquiredAt: now,
      });
      roster.add(claim.addPlayerId);
      rosteredPlayers.add(claim.addPlayerId);
      slotIdByKey.set(`${claim.teamId}:${claim.addPlayerId}`, addedSlotId);

      team.faabRemaining -= claim.bid;
      await ctx.db.patch("teams", claim.teamId, { faabRemaining: team.faabRemaining });

      await ctx.db.insert("transactions", {
        leagueId: window.leagueId,
        teamId: claim.teamId,
        type: "add",
        weekNo: claim.weekNo,
        playerId: claim.addPlayerId,
        runId: claim.runId,
        details: {
          source: "waiver",
          windowId: args.windowId,
          claimId: claim._id,
          bid: claim.bid,
        },
      });
      await ctx.db.patch("waiver_claims", claim._id, {
        status: "won",
        resultReason: `Won at $${claim.bid}.`,
        processedAt: now,
      });

      if (!winners.includes(claim.teamId)) winners.push(claim.teamId);
      awarded++;
    }

    // Rotate: every team that won drops to the back of the priority order.
    if (winners.length > 0) {
      const losers = leagueTeams
        .filter((t) => !winners.includes(t._id))
        .sort((a, b) => a.waiverPriority - b.waiverPriority)
        .map((t) => t._id as Id<"teams">);
      const order = [...losers, ...(winners as Id<"teams">[])];
      for (const [i, teamId] of order.entries()) {
        await ctx.db.patch("teams", teamId, { waiverPriority: i + 1 });
      }
    }

    return { processed: ordered.length, awarded };
  },
});

export type AvailablePlayer = {
  id: string;
  fullName: string;
  sleeperId: string;
  position: string;
  nflTeam: string | null;
  opponent: string | null;
  kickoffAt: string | null;
  injuryStatus: string | null;
  projection: number | null;
  ownedPct: number | null;
};

/** Snapshot projections, with current roster ownership checked before showing availability. */
export const available = query({
  args: { leagueId: v.id("leagues") },
  handler: async (
    ctx,
    { leagueId },
  ): Promise<{
    players: AvailablePlayer[];
    weekNo: number | null;
    takenAt: number | null;
  }> => {
    await requireLeagueRead(ctx, leagueId);
    const snapshot = await latestPayload(ctx, leagueId);
    if (!snapshot) {
      const candidates = (
        await Promise.all(
          (["QB", "RB", "WR", "TE", "K", "DEF"] as const).map((position) =>
            ctx.db
              .query("players")
              .withIndex("by_position_searchRank", (q) =>
                q.eq("position", position).gt("searchRank", 0),
              )
              .take(100),
          ),
        )
      ).flat();
      const roster = await ctx.db
        .query("roster_slots")
        .withIndex("by_leagueId_playerId", (q) => q.eq("leagueId", leagueId))
        .take(600);
      const owned = new Set<string>(roster.map((row) => row.playerId));
      return {
        players: candidates
          .filter(
            (player) =>
              !owned.has(player._id) &&
              player.nflTeam &&
              player.status !== "Inactive" &&
              player.status !== "Retired",
          )
          .sort(
            (a, b) => (a.searchRank ?? Infinity) - (b.searchRank ?? Infinity),
          )
          .map((player) => ({
            id: player._id,
            fullName: player.fullName,
            sleeperId: player.sleeperId,
            position: player.position,
            nflTeam: player.nflTeam ?? null,
            injuryStatus: player.injuryStatus ?? null,
            projection: null,
            ownedPct: null,
            opponent: null,
            kickoffAt: null,
          })),
        weekNo: null,
        takenAt: null,
      };
    }
    const roster = await ctx.db
      .query("roster_slots")
      .withIndex("by_leagueId_playerId", (q) => q.eq("leagueId", leagueId))
      .take(600);
    const owned = new Set<string>(roster.map((row) => row.playerId));
    const players = Object.values(snapshot.payload.players)
      .filter((player) => !owned.has(player.id))
      .map((player) => ({
        id: player.id,
        fullName: player.fullName,
        sleeperId: player.sleeperId,
        position: player.position,
        nflTeam: player.nflTeam,
        opponent: player.opponent,
        kickoffAt: player.kickoffAt,
        injuryStatus: player.injuryStatus,
        projection: projectionFor(
          player.projection,
          snapshot.payload.rules.scoringPreset,
        ),
        ownedPct: player.ownedPct,
      }))
      .sort((a, b) => (b.projection ?? -1) - (a.projection ?? -1));
    return {
      players,
      weekNo: snapshot.payload.weekNo,
      takenAt: snapshot.snapshot.takenAt,
    };
  },
});
