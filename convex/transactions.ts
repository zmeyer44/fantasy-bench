/**
 * The transaction log (PRD §5.3): every add, drop, trade and draft pick.
 *
 * Both lists are paginated straight off an index — `by_leagueId` for the league
 * feed, `by_teamId` for a team page — because a season's log grows without
 * bound and no read path may fold it. Rows are decorated with the player and
 * team names the UI shows, which is at most two point reads per row.
 */
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import { requireLeagueRead } from "./lib/auth";

export type TransactionRow = {
  id: Id<"transactions">;
  leagueId: Id<"leagues">;
  teamId: Id<"teams">;
  teamName: string;
  teamAbbreviation: string;
  type: Doc<"transactions">["type"];
  weekNo: number | null;
  playerId: Id<"players"> | null;
  playerName: string | null;
  playerPosition: string | null;
  playerNflTeam: string | null;
  relatedTeamId: Id<"teams"> | null;
  relatedTeamName: string | null;
  tradeId: Id<"trades"> | null;
  runId: Id<"runs"> | null;
  details: Record<string, unknown> | null;
  createdAt: number;
};

async function decorate(ctx: QueryCtx, row: Doc<"transactions">): Promise<TransactionRow> {
  const team = await ctx.db.get("teams", row.teamId);
  const player = row.playerId ? await ctx.db.get("players", row.playerId) : null;
  const related = row.relatedTeamId ? await ctx.db.get("teams", row.relatedTeamId) : null;
  return {
    id: row._id,
    leagueId: row.leagueId,
    teamId: row.teamId,
    teamName: team?.name ?? "Unknown",
    teamAbbreviation: team?.abbreviation ?? "??",
    type: row.type,
    weekNo: row.weekNo ?? null,
    playerId: row.playerId ?? null,
    playerName: player?.fullName ?? null,
    playerPosition: player?.position ?? null,
    playerNflTeam: player?.nflTeam ?? null,
    relatedTeamId: row.relatedTeamId ?? null,
    relatedTeamName: related?.name ?? null,
    tradeId: row.tradeId ?? null,
    runId: row.runId ?? null,
    details: (row.details as Record<string, unknown> | undefined) ?? null,
    createdAt: row._creationTime,
  };
}

/** The league-wide transaction feed, newest first. */
export const list = query({
  args: { leagueId: v.id("leagues"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { leagueId, paginationOpts }) => {
    await requireLeagueRead(ctx, leagueId);
    const page = await ctx.db
      .query("transactions")
      .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
      .order("desc")
      .paginate(paginationOpts);
    return {
      ...page,
      page: await Promise.all(page.page.map((row) => decorate(ctx, row))),
    };
  },
});

/** One team's transaction history, newest first. */
export const forTeam = query({
  args: { teamId: v.id("teams"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { teamId, paginationOpts }) => {
    const team = await ctx.db.get("teams", teamId);
    if (!team) {
      return { page: [] as TransactionRow[], isDone: true, continueCursor: "" };
    }
    await requireLeagueRead(ctx, team.leagueId);
    const page = await ctx.db
      .query("transactions")
      .withIndex("by_teamId", (q) => q.eq("teamId", teamId))
      .order("desc")
      .paginate(paginationOpts);
    return {
      ...page,
      page: await Promise.all(page.page.map((row) => decorate(ctx, row))),
    };
  },
});
