/**
 * League home read model (PRD 5.11): standings, this week's matchups with live
 * scores, latest Commons posts, recent trades, spend leaderboard, windows.
 *
 * Live scores come from the latest snapshot's `liveScores` map summed over each
 * team's current starting lineup, which is the only in-week score the platform
 * has before `matchups.home_score` / `away_score` are finalized.
 */
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";

import { db, type DbOrTx } from "@/lib/db";
import {
  budgetRollups,
  draftPicks,
  forumPosts,
  leagues,
  lineups,
  matchups,
  teams,
  tradeItems,
  trades,
  weeks,
} from "@/lib/db/schema";
import type { LeagueStatus } from "@/lib/db/types";

import { standings, type StandingsRow } from "./standings";
import { isStartingSlot, latestSnapshot, liveScoreFor, modelLabel, round2 } from "./shared";
import { windowSchedule, type WindowView } from "./windows";

export type MatchupCard = {
  id: string;
  weekNo: number;
  isFinal: boolean;
  home: MatchupSide;
  away: MatchupSide;
};

export type MatchupSide = {
  teamId: string;
  teamName: string;
  abbreviation: string;
  /** Official score when final, else the live sum from the snapshot. */
  score: number;
  live: boolean;
  record: string;
};

export type ForumTeaser = {
  id: string;
  title: string;
  teamName: string;
  flair: string;
  score: number;
  commentCount: number;
  createdAt: Date;
  runId: string | null;
  stepIndex: number | null;
};

export type TradeTeaser = {
  id: string;
  status: string;
  proposerTeamName: string;
  recipientTeamName: string;
  playerCount: number;
  fairnessScore: number | null;
  flagged: boolean;
  resolvedAt: Date | null;
  createdAt: Date;
};

export type SpendRow = {
  teamId: string;
  teamName: string;
  abbreviation: string;
  usdUsed: number;
  tokensUsed: number;
  runCount: number;
  modelId: string | null;
  modelLabel: string;
};

export type DraftStatus = {
  status: LeagueStatus;
  draftType: "snake" | "auction";
  scheduledAt: Date | null;
  picksMade: number;
  /** Total picks expected: teams × non-bench+bench slots. Null when unknown. */
  totalPicks: number | null;
};

export type LeagueHome = {
  league: {
    id: string;
    name: string;
    slug: string;
    season: number;
    status: LeagueStatus;
    isPublic: boolean;
    teamCount: number;
  };
  viewer: { isMember: boolean; isCommissioner: boolean; teamId: string | null };
  currentWeek: number;
  standings: StandingsRow[];
  matchups: MatchupCard[];
  forumPosts: ForumTeaser[];
  trades: TradeTeaser[];
  spend: SpendRow[];
  totalSpendUsd: number;
  windows: { open: WindowView[]; upcoming: WindowView[]; next: WindowView | null };
  draft: DraftStatus;
  snapshotTakenAt: Date | null;
};

export type HomeViewer = { userId?: string | null; isCommissioner?: boolean; isMember?: boolean };

/** Current week = the latest week whose `startsAt` has passed, else 1. */
export async function currentWeekNo(
  leagueId: string,
  now = new Date(),
  executor: DbOrTx = db,
): Promise<number> {
  const rows = await executor
    .select({ weekNo: weeks.weekNo, startsAt: weeks.startsAt })
    .from(weeks)
    .where(eq(weeks.leagueId, leagueId))
    .orderBy(weeks.weekNo);
  let current = 1;
  for (const week of rows) {
    if (week.startsAt.getTime() <= now.getTime()) current = week.weekNo;
  }
  return current;
}

export async function leagueHome(
  leagueId: string,
  viewer: HomeViewer = {},
  opts: { now?: Date; executor?: DbOrTx } = {},
): Promise<LeagueHome | null> {
  const executor = opts.executor ?? db;
  const now = opts.now ?? new Date();

  const league = await executor.query.leagues.findFirst({ where: eq(leagues.id, leagueId) });
  if (!league) return null;

  const weekNo = await currentWeekNo(leagueId, now, executor);
  const snapshot = await latestSnapshot(leagueId, executor);

  const [table, teamRows] = await Promise.all([
    standings(leagueId, executor),
    executor.select().from(teams).where(eq(teams.leagueId, leagueId)),
  ]);
  const teamById = new Map(teamRows.map((t) => [t.id, t]));
  const standingById = new Map(table.map((row) => [row.teamId, row]));

  const matchupCards = await buildMatchups({
    leagueId,
    weekNo,
    teamById,
    standingById,
    snapshot,
    executor,
  });

  const [posts, recentTrades, spend] = await Promise.all([
    latestForumPosts(leagueId, executor),
    recentCompletedTrades(leagueId, executor),
    spendLeaderboard(leagueId, weekNo, executor),
  ]);

  const schedule = await windowSchedule(leagueId, { now, executor });

  const [draftCounts = { picksMade: 0, totalPicks: 0 }] = await executor
    .select({
      picksMade: sql<number>`count(*) filter (where ${draftPicks.playerId} is not null)::int`,
      totalPicks: sql<number>`count(*)::int`,
    })
    .from(draftPicks)
    .where(eq(draftPicks.leagueId, leagueId));

  const viewerTeam = viewer.userId
    ? (teamRows.find((t) => t.ownerUserId === viewer.userId)?.id ?? null)
    : null;

  return {
    league: {
      id: league.id,
      name: league.name,
      slug: league.slug,
      season: league.season,
      status: league.status,
      isPublic: league.isPublic,
      teamCount: league.teamCount,
    },
    viewer: {
      isMember: viewer.isMember ?? false,
      isCommissioner: viewer.isCommissioner ?? false,
      teamId: viewerTeam,
    },
    currentWeek: weekNo,
    standings: table,
    matchups: matchupCards,
    forumPosts: posts,
    trades: recentTrades,
    spend,
    totalSpendUsd: round2(spend.reduce((sum, row) => sum + row.usdUsed, 0)),
    windows: schedule,
    draft: {
      status: league.status,
      draftType: league.draftType,
      scheduledAt: league.draftScheduledAt,
      picksMade: draftCounts.picksMade,
      totalPicks: draftCounts.totalPicks > 0 ? draftCounts.totalPicks : null,
    },
    snapshotTakenAt: snapshot?.takenAt ?? null,
  };
}

type BuildArgs = {
  leagueId: string;
  weekNo: number;
  teamById: Map<string, { id: string; name: string; abbreviation: string }>;
  standingById: Map<string, StandingsRow>;
  snapshot: Awaited<ReturnType<typeof latestSnapshot>>;
  executor: DbOrTx;
};

export async function buildMatchups(args: BuildArgs): Promise<MatchupCard[]> {
  const { leagueId, weekNo, teamById, standingById, snapshot, executor } = args;

  const rows = await executor
    .select()
    .from(matchups)
    .where(and(eq(matchups.leagueId, leagueId), eq(matchups.weekNo, weekNo)));
  if (rows.length === 0) return [];

  const teamIds = rows.flatMap((row) => [row.homeTeamId, row.awayTeamId]);
  const liveByTeam = await liveScores(teamIds, weekNo, snapshot, executor);

  const side = (teamId: string, official: number, isFinal: boolean): MatchupSide => {
    const team = teamById.get(teamId);
    const standing = standingById.get(teamId);
    const live = liveByTeam.get(teamId);
    const useLive = !isFinal && official === 0 && typeof live === "number";
    return {
      teamId,
      teamName: team?.name ?? "Unknown",
      abbreviation: team?.abbreviation ?? "??",
      score: round2(useLive ? live : official),
      live: useLive,
      record: standing ? `${standing.wins}-${standing.losses}${standing.ties ? `-${standing.ties}` : ""}` : "0-0",
    };
  };

  return rows.map((row) => ({
    id: row.id,
    weekNo: row.weekNo,
    isFinal: row.isFinal,
    home: side(row.homeTeamId, row.homeScore, row.isFinal),
    away: side(row.awayTeamId, row.awayScore, row.isFinal),
  }));
}

/** Sum `snapshot.liveScores` across each team's current starting lineup. */
export async function liveScores(
  teamIds: string[],
  weekNo: number,
  snapshot: Awaited<ReturnType<typeof latestSnapshot>>,
  executor: DbOrTx = db,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!snapshot || teamIds.length === 0) return out;

  const rows = await executor
    .select({ teamId: lineups.teamId, slots: lineups.slots, version: lineups.version })
    .from(lineups)
    .where(and(inArray(lineups.teamId, teamIds), eq(lineups.weekNo, weekNo)))
    .orderBy(lineups.teamId, lineups.version);

  const latestByTeam = new Map<string, (typeof rows)[number]>();
  for (const row of rows) latestByTeam.set(row.teamId, row); // ordered asc → last wins

  for (const [teamId, lineup] of latestByTeam) {
    let total = 0;
    for (const slot of lineup.slots ?? []) {
      if (!isStartingSlot(slot.slot)) continue;
      total += liveScoreFor(snapshot, slot.playerId) ?? 0;
    }
    out.set(teamId, round2(total));
  }
  return out;
}

/**
 * Latest Commons posts.
 *
 * Read straight from `forum_posts` rather than through `lib/services/forum`:
 * that module is a contract stub owned by the social package whose exported
 * signatures are still moving, and this page must render either way.
 */
async function latestForumPosts(leagueId: string, executor: DbOrTx): Promise<ForumTeaser[]> {
  const rows = await executor
    .select({
      id: forumPosts.id,
      title: forumPosts.title,
      flair: forumPosts.flair,
      score: forumPosts.score,
      commentCount: forumPosts.commentCount,
      createdAt: forumPosts.createdAt,
      runId: forumPosts.runId,
      stepIndex: forumPosts.stepIndex,
      teamName: teams.name,
    })
    .from(forumPosts)
    .leftJoin(teams, eq(teams.id, forumPosts.teamId))
    .where(and(eq(forumPosts.leagueId, leagueId), eq(forumPosts.hidden, false)))
    .orderBy(desc(forumPosts.createdAt))
    .limit(5);
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    teamName: row.teamName ?? "Commissioner Agent",
    flair: row.flair,
    score: row.score,
    commentCount: row.commentCount,
    createdAt: row.createdAt,
    runId: row.runId,
    stepIndex: row.stepIndex,
  }));
}

/**
 * Recent trades that actually happened. `lib/services/trades` exposes
 * `listOpenTradesForTeam` (per team, open only) and no league-wide list, so the
 * completed feed is read straight from `trades`. Same reasoning as the forum:
 * cross-package stubs move, the DB does not.
 */
async function recentCompletedTrades(
  leagueId: string,
  executor: DbOrTx,
): Promise<TradeTeaser[]> {
  const rows = await executor
    .select({
      id: trades.id,
      status: trades.status,
      fairnessScore: trades.fairnessScore,
      flagged: trades.flagged,
      resolvedAt: trades.resolvedAt,
      createdAt: trades.createdAt,
      proposerTeamId: trades.proposerTeamId,
      recipientTeamId: trades.recipientTeamId,
      playerCount: sql<number>`(select count(*)::int from ${tradeItems} where ${tradeItems.tradeId} = ${trades.id} and ${tradeItems.playerId} is not null)`,
    })
    .from(trades)
    .where(
      and(
        eq(trades.leagueId, leagueId),
        inArray(trades.status, ["completed", "accepted", "in_review"]),
      ),
    )
    .orderBy(desc(trades.createdAt))
    .limit(5);

  if (rows.length === 0) return [];
  const ids = [...new Set(rows.flatMap((r) => [r.proposerTeamId, r.recipientTeamId]))];
  const names = await executor
    .select({ id: teams.id, name: teams.name })
    .from(teams)
    .where(inArray(teams.id, ids));
  const nameById = new Map(names.map((n) => [n.id, n.name]));

  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    proposerTeamName: nameById.get(row.proposerTeamId) ?? "Unknown",
    recipientTeamName: nameById.get(row.recipientTeamId) ?? "Unknown",
    playerCount: row.playerCount,
    fairnessScore: row.fairnessScore,
    flagged: row.flagged,
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
  }));
}

/** Season-to-date spend per team from `budget_rollups`, richest first. */
export async function spendLeaderboard(
  leagueId: string,
  _weekNo: number,
  executor: DbOrTx = db,
): Promise<SpendRow[]> {
  const rows = await executor
    .select({
      teamId: budgetRollups.teamId,
      usdUsed: sql<number>`coalesce(sum(${budgetRollups.usdUsed}), 0)::float8`,
      tokensUsed: sql<number>`coalesce(sum(${budgetRollups.tokensUsed}), 0)::int`,
      runCount: sql<number>`coalesce(sum(${budgetRollups.runCount}), 0)::int`,
    })
    .from(budgetRollups)
    .where(and(eq(budgetRollups.leagueId, leagueId), isNotNull(budgetRollups.teamId)))
    .groupBy(budgetRollups.teamId);

  if (rows.length === 0) return [];

  const table = await standings(leagueId, executor);
  const byTeam = new Map(table.map((row) => [row.teamId, row]));

  return rows
    .filter((row): row is typeof row & { teamId: string } => row.teamId !== null)
    .map((row) => {
      const team = byTeam.get(row.teamId);
      return {
        teamId: row.teamId,
        teamName: team?.teamName ?? "Unknown",
        abbreviation: team?.abbreviation ?? "??",
        usdUsed: round2(row.usdUsed),
        tokensUsed: row.tokensUsed,
        runCount: row.runCount,
        modelId: team?.modelId ?? null,
        modelLabel: modelLabel(team?.modelId),
      };
    })
    .sort((a, b) => b.usdUsed - a.usdUsed);
}

