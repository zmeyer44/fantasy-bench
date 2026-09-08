/**
 * The live draft board (PRD §5.2) — the port of `lib/services/views/draft.ts`.
 *
 * Reactive by construction: the page subscribes to this query, which replaces
 * the old 15-second `draft-refresher` poll. Every read is one bounded index
 * range (a draft is at most 14 teams × 16 rounds = 224 picks).
 */
import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { query } from "./_generated/server";
import { requireLeagueRead } from "./lib/auth";
import { round2 } from "./lib/views_shared";

/** 14 teams × 16 rounds, the largest draft the rules allow. */
const MAX_PICKS = 300;

export type DraftBoardPick = {
  id: Id<"draft_picks">;
  round: number;
  pickNo: number;
  overallNo: number;
  teamId: Id<"teams">;
  teamName: string;
  teamAbbreviation: string;
  playerId: Id<"players"> | null;
  playerName: string | null;
  position: string | null;
  nflTeam: string | null;
  price: number | null;
  auto: boolean;
  rationale: string | null;
  runId: Id<"runs"> | null;
  costUsd: number | null;
  madeAt: number | null;
};

export type DraftBoard = {
  leagueId: Id<"leagues">;
  draftType: Doc<"leagues">["draftType"];
  status: Doc<"leagues">["status"];
  scheduledAt: number | null;
  rounds: number;
  teams: Array<{ id: Id<"teams">; name: string; abbreviation: string; slotIndex: number }>;
  picks: DraftBoardPick[];
  /** `grid[round - 1][slotIndex]` — the pick for that cell, or null. */
  grid: Array<Array<DraftBoardPick | null>>;
  onTheClock: {
    teamId: Id<"teams">;
    teamName: string;
    overallNo: number;
    round: number;
    pickNo: number;
    deadlineAt: number | null;
  } | null;
  picksMade: number;
  totalPicks: number;
  runningCostUsd: number;
};

export const board = query({
  args: { leagueId: v.id("leagues") },
  handler: async (ctx, { leagueId }): Promise<DraftBoard> => {
    const { league } = await requireLeagueRead(ctx, leagueId);

    // Bounded: ≤ 14 teams.
    const teamRows = (
      await ctx.db
        .query("teams")
        .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
        .collect()
    ).sort((a, b) => a.waiverPriority - b.waiverPriority);
    const teamById = new Map(teamRows.map((t) => [t._id as string, t]));

    const pickRows = await ctx.db
      .query("draft_picks")
      .withIndex("by_leagueId_overallNo", (q) => q.eq("leagueId", leagueId))
      .take(MAX_PICKS);

    const picks: DraftBoardPick[] = [];
    let runningCostUsd = 0;
    const countedRuns = new Set<string>();
    for (const row of pickRows) {
      const player = row.playerId ? await ctx.db.get("players", row.playerId) : null;
      const run = row.madeByRunId ? await ctx.db.get("runs", row.madeByRunId) : null;
      if (run && !countedRuns.has(run._id)) {
        countedRuns.add(run._id);
        runningCostUsd += run.totalCostUsd ?? 0;
      }
      picks.push({
        id: row._id,
        round: row.round,
        pickNo: row.pickNo,
        overallNo: row.overallNo,
        teamId: row.teamId,
        teamName: teamById.get(row.teamId)?.name ?? "Unknown",
        teamAbbreviation: teamById.get(row.teamId)?.abbreviation ?? "??",
        playerId: row.playerId ?? null,
        playerName: player?.fullName ?? null,
        position: player?.position ?? null,
        nflTeam: player?.nflTeam ?? null,
        price: row.price ?? null,
        auto: row.auto,
        rationale: row.rationale ?? null,
        runId: row.madeByRunId ?? null,
        costUsd: run?.totalCostUsd ?? null,
        madeAt: row.madeAt ?? null,
      });
    }
    picks.sort((a, b) => a.overallNo - b.overallNo);

    // Draft-order slot index comes from round 1, falling back to waiver priority
    // so the grid still lines up before the order is generated.
    const roundOne = picks.filter((p) => p.round === 1).sort((a, b) => a.pickNo - b.pickNo);
    const slotOrder =
      roundOne.length > 0 ? roundOne.map((p) => p.teamId) : teamRows.map((t) => t._id);
    const boardTeams = slotOrder
      .map((teamId, index) => {
        const team = teamById.get(teamId);
        return team
          ? { id: team._id, name: team.name, abbreviation: team.abbreviation, slotIndex: index }
          : null;
      })
      .filter((t): t is NonNullable<typeof t> => t !== null);
    const slotIndexByTeam = new Map(boardTeams.map((t) => [t.id as string, t.slotIndex]));

    const rounds = picks.reduce((max, pick) => Math.max(max, pick.round), 0);
    const grid: Array<Array<DraftBoardPick | null>> = Array.from({ length: rounds }, () =>
      new Array<DraftBoardPick | null>(boardTeams.length).fill(null),
    );
    for (const pick of picks) {
      const slot = slotIndexByTeam.get(pick.teamId);
      if (slot === undefined || pick.round < 1 || pick.round > rounds) continue;
      grid[pick.round - 1][slot] = pick;
    }

    // On the clock = the lowest unmade pick. Its deadline is the open draft window's close.
    const next = picks.find((pick) => pick.playerId === null) ?? null;
    let onTheClock: DraftBoard["onTheClock"] = null;
    if (next && league.status === "drafting") {
      const openWindows: Doc<"windows">[] = [];
      for (const status of ["open", "closing"] as const) {
        openWindows.push(
          ...(await ctx.db
            .query("windows")
            .withIndex("by_leagueId_status", (q) =>
              q.eq("leagueId", leagueId).eq("status", status),
            )
            .take(20)),
        );
      }
      const draftWindow = openWindows
        .filter((w) => w.type === "draft")
        .sort((a, b) => a.closesAt - b.closesAt)[0];
      onTheClock = {
        teamId: next.teamId,
        teamName: next.teamName,
        overallNo: next.overallNo,
        round: next.round,
        pickNo: next.pickNo,
        deadlineAt: draftWindow?.closesAt ?? null,
      };
    }

    return {
      leagueId,
      draftType: league.draftType,
      status: league.status,
      scheduledAt: league.draftScheduledAt ?? null,
      rounds,
      teams: boardTeams,
      picks,
      grid,
      onTheClock,
      picksMade: picks.filter((p) => p.playerId !== null).length,
      totalPicks: picks.length,
      runningCostUsd: round2(runningCostUsd),
    };
  },
});
