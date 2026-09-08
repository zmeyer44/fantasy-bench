/**
 * Waiver outcomes (PRD §5.3) — the port of `lib/services/views/waivers.ts`.
 *
 * `waiver_claims.by_leagueId_weekNo` is the only index this needs: one league
 * week holds at most `teams × 10` claims, and the league-wide figures
 * (pending count, FAAB spent, the week picker) come from the same bounded
 * per-week ranges rather than a table scan.
 */
import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { query } from "./_generated/server";
import { requireLeagueRead } from "./lib/auth";

/** Claims per league week: 14 teams × 10 claims, with headroom. */
const MAX_CLAIMS_PER_WEEK = 200;
const MAX_WEEK = 22;

export type WaiverResultRow = {
  claimId: Id<"waiver_claims">;
  teamId: Id<"teams">;
  teamName: string;
  teamAbbreviation: string;
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
