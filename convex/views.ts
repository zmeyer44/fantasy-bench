/**
 * Public read models (PRD §5.11) — the port of `lib/services/views/*`.
 *
 * Everything is readable by league members and, for public leagues, by anyone
 * (spectator mode): `requireLeagueRead` reproduces `leagueReadProcedure`.
 *
 * The five query-time aggregations these pages used to run are gone
 * (migration plan §2.6): standings come from `team_standings`, spend from
 * `team_week_rollups`, run counts from the denormalised counters on `runs` and
 * `windows`, draft progress from the bounded `draft_picks` range, and live
 * scores from the latest snapshot's `meta` chunk instead of a join over
 * `player_stats_weekly`.
 */
import { v } from "convex/values";

import type { LineupSlot, SnapshotPlayer } from "../lib/snapshot/types";
import type { MatchupCard, MatchupSide, SpendRow } from "../lib/services/views/league-home";
import type { StandingsRow } from "../lib/services/views/standings";
import type { TeamCard } from "../lib/services/views/team";
import type { Doc, Id } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import { requireLeagueRead } from "./lib/auth";
import { compareViewRows, rankRows } from "./lib/standings_pure";
import {
  excerpt,
  expandRosterSlots,
  isStartingSlot,
  liveScoreFor,
  modelLabel,
  projectionFor,
  recordText,
  round2,
  slotRank,
  snapshotPlayer,
  windowLabelText,
} from "./lib/views_shared";
import { latestMetaChunk, latestPayload } from "./snapshot";
import { recentRunsForTeam, type RunListItem } from "./runs";
import { currentWeekNoFor } from "./weeks";
import { windowSchedule, type WindowSchedule } from "./windows";

/** Weeks a rollup scan covers: 0 (draft / commissioner) through the playoffs. */
const MAX_WEEK = 22;
const RECENT_RUNS = 10;

// ------------------------------------------------------------- standings

/**
 * The standings table.
 *
 * Reads the `team_standings` rollup (one row per team-season, maintained by the
 * scoring mutation) instead of folding `team_results` at query time.
 */
export async function standingsFor(
  ctx: QueryCtx,
  leagueId: Id<"leagues">,
  season: number,
): Promise<StandingsRow[]> {
  // Bounded: a league has at most 14 teams.
  const teams = await ctx.db
    .query("teams")
    .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
    .collect();
  if (teams.length === 0) return [];

  const standingRows = await ctx.db
    .query("team_standings")
    .withIndex("by_leagueId_season", (q) => q.eq("leagueId", leagueId).eq("season", season))
    .take(20);
  const byTeam = new Map(standingRows.map((row) => [row.teamId as string, row]));

  const rows: StandingsRow[] = [];
  for (const team of teams) {
    const standing = byTeam.get(team._id);
    const config = await ctx.db
      .query("agent_configs")
      .withIndex("by_teamId", (q) => q.eq("teamId", team._id))
      .unique();
    const version = config?.currentVersionId
      ? await ctx.db.get("config_versions", config.currentVersionId)
      : null;
    rows.push({
      rank: 0,
      teamId: team._id,
      teamName: team.name,
      abbreviation: team.abbreviation,
      ownerUserId: team.ownerUserId ?? null,
      wins: standing?.wins ?? 0,
      losses: standing?.losses ?? 0,
      ties: standing?.ties ?? 0,
      pointsFor: round2(standing?.pointsFor ?? 0),
      pointsAgainst: round2(standing?.pointsAgainst ?? 0),
      streak: standing?.streak ?? "—",
      karma: team.karma,
      faabRemaining: team.faabRemaining,
      modelId: version?.modelId ?? null,
      configVersionNo: version?.versionNo ?? null,
    });
  }
  return rankRows(rows, compareViewRows);
}

export const standings = query({
  args: { leagueId: v.id("leagues") },
  handler: async (ctx, { leagueId }): Promise<StandingsRow[]> => {
    const { league } = await requireLeagueRead(ctx, leagueId);
    return standingsFor(ctx, leagueId, league.season);
  },
});

export const teams = query({
  args: { leagueId: v.id("leagues") },
  handler: async (ctx, { leagueId }): Promise<TeamCard[]> => {
    const { league } = await requireLeagueRead(ctx, leagueId);
    const table = await standingsFor(ctx, leagueId, league.season);
    const cards: TeamCard[] = [];
    for (const row of table) {
      const owner = row.ownerUserId
        ? await ctx.db.get("users", row.ownerUserId as Id<"users">)
        : null;
      cards.push({
        id: row.teamId,
        name: row.teamName,
        abbreviation: row.abbreviation,
        ownerUserId: row.ownerUserId,
        ownerName: owner?.name ?? null,
        record: recordText(row),
        rank: row.rank,
        pointsFor: row.pointsFor,
        karma: row.karma,
        faabRemaining: row.faabRemaining,
        modelId: row.modelId,
        modelLabel: modelLabel(row.modelId),
        configVersionNo: row.configVersionNo,
      });
    }
    return cards;
  },
});

// --------------------------------------------------------------- matchups

/** Latest lineup for a team-week, or null. */
async function latestLineup(
  ctx: QueryCtx,
  teamId: Id<"teams">,
  weekNo: number,
): Promise<Doc<"lineups"> | null> {
  return ctx.db
    .query("lineups")
    .withIndex("by_teamId_weekNo_version", (q) => q.eq("teamId", teamId).eq("weekNo", weekNo))
    .order("desc")
    .first();
}

/** Sum the snapshot's `liveScores` across each team's current starting lineup. */
async function liveScoresByTeam(
  ctx: QueryCtx,
  teamIds: Id<"teams">[],
  weekNo: number,
  liveScores: Record<string, number> | null,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!liveScores) return out;
  for (const teamId of teamIds) {
    const lineup = await latestLineup(ctx, teamId, weekNo);
    if (!lineup) continue;
    let total = 0;
    for (const slot of lineup.slots) {
      if (!isStartingSlot(slot.slot)) continue;
      total += liveScoreFor(liveScores, slot.playerId) ?? 0;
    }
    out.set(teamId, round2(total));
  }
  return out;
}

async function buildMatchupCards(
  ctx: QueryCtx,
  leagueId: Id<"leagues">,
  weekNo: number,
  table: StandingsRow[],
  teamRows: Doc<"teams">[],
  liveScores: Record<string, number> | null,
): Promise<MatchupCard[]> {
  // Bounded: at most 7 matchups in a 14-team week.
  const rows = await ctx.db
    .query("matchups")
    .withIndex("by_leagueId_weekNo", (q) => q.eq("leagueId", leagueId).eq("weekNo", weekNo))
    .take(16);
  if (rows.length === 0) return [];

  const teamById = new Map(teamRows.map((t) => [t._id as string, t]));
  const standingById = new Map(table.map((row) => [row.teamId, row]));
  const liveByTeam = await liveScoresByTeam(
    ctx,
    rows.flatMap((row) => [row.homeTeamId, row.awayTeamId]),
    weekNo,
    liveScores,
  );

  const side = (teamId: Id<"teams">, official: number, isFinal: boolean): MatchupSide => {
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
      record: standing ? recordText(standing) : "0-0",
    };
  };

  return rows.map((row) => ({
    id: row._id,
    weekNo: row.weekNo,
    isFinal: row.isFinal,
    home: side(row.homeTeamId, row.homeScore ?? 0, row.isFinal),
    away: side(row.awayTeamId, row.awayScore ?? 0, row.isFinal),
  }));
}

export const matchups = query({
  args: { leagueId: v.id("leagues"), weekNo: v.number() },
  handler: async (ctx, { leagueId, weekNo }): Promise<MatchupCard[]> => {
    const { league } = await requireLeagueRead(ctx, leagueId);
    const table = await standingsFor(ctx, leagueId, league.season);
    const teamRows = await ctx.db
      .query("teams")
      .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
      .collect(); // bounded: ≤ 14 teams
    const snapshot = await latestMetaChunk(ctx, leagueId);
    return buildMatchupCards(
      ctx,
      leagueId,
      weekNo,
      table,
      teamRows,
      snapshot?.meta.liveScores ?? null,
    );
  },
});

export type MatchupSlot = {
  slot: string;
  starting: boolean;
  playerId: Id<"players"> | null;
  playerName: string | null;
  position: string | null;
  nflTeam: string | null;
  opponent: string | null;
  injuryStatus: string | null;
  kickoffAt: string | null;
  projection: number | null;
  points: number | null;
};

export type MatchupTeamView = {
  teamId: Id<"teams">;
  teamName: string;
  abbreviation: string;
  record: string;
  slots: MatchupSlot[];
  projectedTotal: number;
  liveTotal: number;
  officialScore: number;
  lineupSource: string | null;
  /** The run that set this lineup, with its public rationale (PRD 5.11). */
  rationale: {
    runId: Id<"runs">;
    windowLabel: string;
    excerpt: string | null;
    fullText: string | null;
    modelId: string;
    status: string;
  } | null;
};

export type MatchupPage = {
  leagueId: Id<"leagues">;
  weekNo: number;
  matchupId: Id<"matchups">;
  isFinal: boolean;
  home: MatchupTeamView;
  away: MatchupTeamView;
};

async function buildSide(
  ctx: QueryCtx,
  teamId: Id<"teams">,
  weekNo: number,
  officialScore: number,
  preset: string,
  players: Record<string, SnapshotPlayer> | null,
  liveScores: Record<string, number> | null,
  table: StandingsRow[],
): Promise<MatchupTeamView> {
  const team = await ctx.db.get("teams", teamId);
  const standing = table.find((row) => row.teamId === teamId);
  const lineup = await latestLineup(ctx, teamId, weekNo);
  const slotRows: LineupSlot[] = (lineup?.slots ?? []).map((s) => ({
    slot: s.slot,
    playerId: s.playerId as string | null,
  }));

  const slots: MatchupSlot[] = [];
  for (const slot of slotRows) {
    const player = slot.playerId
      ? await ctx.db.get("players", slot.playerId as Id<"players">)
      : null;
    const snap = snapshotPlayer(players, slot.playerId);
    const projection = projectionFor(snap?.projection ?? null, preset);
    slots.push({
      slot: slot.slot,
      starting: isStartingSlot(slot.slot),
      playerId: (slot.playerId as Id<"players">) ?? null,
      playerName: player?.fullName ?? null,
      position: player?.position ?? null,
      nflTeam: player?.nflTeam ?? null,
      opponent: snap?.opponent ?? null,
      injuryStatus: snap?.injuryStatus ?? player?.injuryStatus ?? null,
      kickoffAt: snap?.kickoffAt ?? null,
      projection: projection === null ? null : round2(projection),
      points: liveScoreFor(liveScores, slot.playerId),
    });
  }

  const starters = slots.filter((slot) => slot.starting);

  let rationale: MatchupTeamView["rationale"] = null;
  if (lineup?.setByRunId) {
    const run = await ctx.db.get("runs", lineup.setByRunId);
    if (run) {
      rationale = {
        runId: run._id,
        windowLabel: windowLabelText(run.windowLabel),
        excerpt: excerpt(run.rationale ?? null),
        fullText: run.rationale ?? null,
        modelId: run.modelId,
        status: run.status,
      };
    }
  }

  return {
    teamId,
    teamName: team?.name ?? "Unknown",
    abbreviation: team?.abbreviation ?? "??",
    record: standing ? recordText(standing) : "0-0",
    slots,
    projectedTotal: round2(starters.reduce((sum, slot) => sum + (slot.projection ?? 0), 0)),
    liveTotal: round2(starters.reduce((sum, slot) => sum + (slot.points ?? 0), 0)),
    officialScore: round2(officialScore),
    lineupSource: lineup?.source ?? null,
    rationale,
  };
}

export const matchup = query({
  args: { leagueId: v.id("leagues"), weekNo: v.number(), matchupId: v.id("matchups") },
  handler: async (ctx, { leagueId, weekNo, matchupId }): Promise<MatchupPage | null> => {
    const { league } = await requireLeagueRead(ctx, leagueId);
    const row = await ctx.db.get("matchups", matchupId);
    if (!row || row.leagueId !== leagueId) return null;

    const rules = await ctx.db
      .query("league_rules")
      .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
      .unique();
    const preset = rules?.scoringPreset ?? "ppr";
    const snapshot = await latestPayload(ctx, leagueId);
    const table = await standingsFor(ctx, leagueId, league.season);

    return {
      leagueId,
      weekNo,
      matchupId,
      isFinal: row.isFinal,
      home: await buildSide(
        ctx,
        row.homeTeamId,
        weekNo,
        row.homeScore ?? 0,
        preset,
        snapshot?.payload.players ?? null,
        snapshot?.payload.liveScores ?? null,
        table,
      ),
      away: await buildSide(
        ctx,
        row.awayTeamId,
        weekNo,
        row.awayScore ?? 0,
        preset,
        snapshot?.payload.players ?? null,
        snapshot?.payload.liveScores ?? null,
        table,
      ),
    };
  },
});

// ------------------------------------------------------------------- team

export type RosterEntry = {
  playerId: Id<"players">;
  fullName: string;
  position: string;
  nflTeam: string | null;
  injuryStatus: string | null;
  byeWeek: number | null;
  acquiredVia: string;
  acquiredAt: number;
  /** From the latest snapshot; null when no snapshot has been taken yet. */
  projection: number | null;
  livePoints: number | null;
  kickoffAt: string | null;
  opponent: string | null;
  /** The lineup slot this player currently occupies, or null if unassigned. */
  slot: string | null;
  starting: boolean;
};

export type TeamPage = {
  team: {
    id: Id<"teams">;
    leagueId: Id<"leagues">;
    name: string;
    abbreviation: string;
    ownerUserId: Id<"users"> | null;
    ownerName: string | null;
    ownerEmail: string | null;
    faabRemaining: number;
    faabBudget: number;
    karma: number;
    waiverPriority: number;
  };
  league: { id: Id<"leagues">; name: string; season: number; status: string };
  weekNo: number;
  record: Pick<
    StandingsRow,
    "wins" | "losses" | "ties" | "pointsFor" | "pointsAgainst" | "rank" | "streak"
  >;
  roster: RosterEntry[];
  /** Roster grouped and ordered by lineup slot; unassigned players land in `BENCH`. */
  lineup: Array<{ slot: string; entry: RosterEntry | null; starting: boolean }>;
  lineupSource: string | null;
  lineupSetByRunId: Id<"runs"> | null;
  projectedTotal: number;
  liveTotal: number;
  config: {
    configId: Id<"agent_configs"> | null;
    versionId: Id<"config_versions"> | null;
    versionNo: number | null;
    modelId: string | null;
    modelLabel: string;
    harness: Doc<"config_versions">["harness"] | null;
    changeSummary: string | null;
    createdAt: number | null;
    contextChars: number;
    hasPendingVersion: boolean;
  };
  recentRuns: RunListItem[];
  cost: { seasonUsd: number; weekUsd: number; seasonTokens: number; runCount: number };
  snapshotTakenAt: number | null;
};

/** Season-to-date and this-week spend for one team, straight off the rollups. */
async function teamCost(
  ctx: QueryCtx,
  teamId: Id<"teams">,
  season: number,
  weekNo: number,
): Promise<{ seasonUsd: number; weekUsd: number; seasonTokens: number; runCount: number }> {
  let seasonUsd = 0;
  let seasonTokens = 0;
  let runCount = 0;
  let weekUsd = 0;
  // Bounded: one row per week (0 = draft/commissioner) for one team-season.
  for (let week = 0; week <= MAX_WEEK; week++) {
    const row = await ctx.db
      .query("team_week_rollups")
      .withIndex("by_teamId_season_weekNo", (q) =>
        q.eq("teamId", teamId).eq("season", season).eq("weekNo", week),
      )
      .unique();
    if (!row) continue;
    seasonUsd += row.costUsd;
    seasonTokens += row.inputTokens + row.outputTokens;
    runCount += row.runCount;
    if (week === weekNo) weekUsd = row.costUsd;
  }
  return {
    seasonUsd: round2(seasonUsd),
    weekUsd: round2(weekUsd),
    seasonTokens,
    runCount,
  };
}

export const team = query({
  args: { teamId: v.id("teams") },
  handler: async (ctx, { teamId }): Promise<TeamPage | null> => {
    const teamRow = await ctx.db.get("teams", teamId);
    if (!teamRow) return null;
    const { league } = await requireLeagueRead(ctx, teamRow.leagueId);

    const rules = await ctx.db
      .query("league_rules")
      .withIndex("by_leagueId", (q) => q.eq("leagueId", league._id))
      .unique();
    const weekNo = await currentWeekNoFor(ctx, league._id, Date.now());
    const snapshot = await latestPayload(ctx, league._id);
    const players = snapshot?.payload.players ?? null;
    const liveScores = snapshot?.payload.liveScores ?? null;

    // Bounded: one team's roster is at most ~20 rows.
    const rosterRows = await ctx.db
      .query("roster_slots")
      .withIndex("by_teamId", (q) => q.eq("teamId", teamId))
      .collect();

    const currentLineup = await latestLineup(ctx, teamId, weekNo);
    const slotByPlayer = new Map<string, string>();
    for (const slot of currentLineup?.slots ?? []) {
      if (slot.playerId) slotByPlayer.set(slot.playerId, slot.slot);
    }

    const roster: RosterEntry[] = [];
    for (const row of rosterRows) {
      const player = await ctx.db.get("players", row.playerId);
      if (!player) continue;
      const snap = snapshotPlayer(players, row.playerId);
      const slot = slotByPlayer.get(row.playerId) ?? null;
      const projection = projectionFor(snap?.projection ?? null, rules?.scoringPreset);
      roster.push({
        playerId: player._id,
        fullName: player.fullName,
        position: player.position,
        nflTeam: player.nflTeam ?? null,
        injuryStatus: snap?.injuryStatus ?? player.injuryStatus ?? null,
        byeWeek: player.byeWeek ?? null,
        acquiredVia: row.acquiredVia,
        acquiredAt: row.acquiredAt,
        projection: projection === null ? null : round2(projection),
        livePoints: liveScoreFor(liveScores, row.playerId),
        kickoffAt: snap?.kickoffAt ?? null,
        opponent: snap?.opponent ?? null,
        slot,
        starting: slot ? isStartingSlot(slot) : false,
      });
    }
    roster.sort((a, b) => {
      if (a.starting !== b.starting) return a.starting ? -1 : 1;
      const rank = slotRank(a.slot ?? "BENCH") - slotRank(b.slot ?? "BENCH");
      if (rank !== 0) return rank;
      return (b.projection ?? 0) - (a.projection ?? 0);
    });

    const entryByPlayer = new Map(roster.map((entry) => [entry.playerId as string, entry]));

    // Build the slot grid from the league's roster shape so empty slots are visible.
    const slotLabels =
      (currentLineup?.slots ?? []).length > 0
        ? (currentLineup?.slots ?? []).map((s) => s.slot)
        : expandRosterSlots(rules?.rosterSlots ?? {});
    const assigned = new Set<string>();
    // Positional: a league starts two RBs and two WRs, so slot labels repeat and
    // a lookup by label would render RB1/WR1 twice and push RB2/WR2 to the bench.
    const slotRows = currentLineup?.slots ?? [];
    const lineup = slotLabels.map((slotLabel, index) => {
      const slotRow = slotRows.length > 0 ? slotRows[index] : undefined;
      const entry = slotRow?.playerId ? (entryByPlayer.get(slotRow.playerId) ?? null) : null;
      if (entry) assigned.add(entry.playerId);
      return { slot: slotLabel, entry, starting: isStartingSlot(slotLabel) };
    });
    for (const entry of roster) {
      if (!assigned.has(entry.playerId)) {
        lineup.push({ slot: "BENCH", entry, starting: false });
      }
    }

    const table = await standingsFor(ctx, league._id, league.season);
    const standing = table.find((row) => row.teamId === teamId);

    const config = await ctx.db
      .query("agent_configs")
      .withIndex("by_teamId", (q) => q.eq("teamId", teamId))
      .unique();
    const version = config?.currentVersionId
      ? await ctx.db.get("config_versions", config.currentVersionId)
      : null;

    const owner = teamRow.ownerUserId ? await ctx.db.get("users", teamRow.ownerUserId) : null;
    const cost = await teamCost(ctx, teamId, league.season, weekNo);
    const recentRuns = await recentRunsForTeam(ctx, teamId, RECENT_RUNS);

    const starting = lineup.filter((row) => row.starting && row.entry);
    return {
      team: {
        id: teamRow._id,
        leagueId: teamRow.leagueId,
        name: teamRow.name,
        abbreviation: teamRow.abbreviation,
        ownerUserId: teamRow.ownerUserId ?? null,
        ownerName: owner?.name ?? null,
        ownerEmail: owner?.email ?? null,
        faabRemaining: teamRow.faabRemaining,
        faabBudget: rules?.faabBudget ?? 0,
        karma: teamRow.karma,
        waiverPriority: teamRow.waiverPriority,
      },
      league: {
        id: league._id,
        name: league.name,
        season: league.season,
        status: league.status,
      },
      weekNo,
      record: {
        wins: standing?.wins ?? 0,
        losses: standing?.losses ?? 0,
        ties: standing?.ties ?? 0,
        pointsFor: standing?.pointsFor ?? 0,
        pointsAgainst: standing?.pointsAgainst ?? 0,
        rank: standing?.rank ?? 0,
        streak: standing?.streak ?? "—",
      },
      roster,
      lineup,
      lineupSource: currentLineup?.source ?? null,
      lineupSetByRunId: currentLineup?.setByRunId ?? null,
      projectedTotal: round2(
        starting.reduce((sum, row) => sum + (row.entry?.projection ?? 0), 0),
      ),
      liveTotal: round2(starting.reduce((sum, row) => sum + (row.entry?.livePoints ?? 0), 0)),
      config: {
        configId: config?._id ?? null,
        versionId: version?._id ?? null,
        versionNo: version?.versionNo ?? null,
        modelId: version?.modelId ?? null,
        modelLabel: modelLabel(version?.modelId),
        harness: version?.harness ?? null,
        changeSummary: version?.changeSummary ?? null,
        createdAt: version?._creationTime ?? null,
        contextChars: version?.contextMd.length ?? 0,
        hasPendingVersion: Boolean(config?.pendingVersionId),
      },
      recentRuns,
      cost,
      snapshotTakenAt: snapshot?.snapshot.takenAt ?? null,
    };
  },
});

// ------------------------------------------------------------------- home

export type ForumTeaser = {
  id: Id<"forum_posts">;
  title: string;
  teamName: string;
  flair: string;
  score: number;
  commentCount: number;
  createdAt: number;
  runId: Id<"runs"> | null;
  stepIndex: number | null;
};

export type TradeTeaser = {
  id: Id<"trades">;
  status: string;
  proposerTeamName: string;
  recipientTeamName: string;
  playerCount: number;
  fairnessScore: number | null;
  flagged: boolean;
  resolvedAt: number | null;
  createdAt: number;
};

export type DraftStatus = {
  status: Doc<"leagues">["status"];
  draftType: "snake" | "auction";
  scheduledAt: number | null;
  picksMade: number;
  /** Total picks expected. Null when the draft order has not been generated. */
  totalPicks: number | null;
};

export type LeagueHome = {
  league: {
    id: Id<"leagues">;
    name: string;
    slug: string;
    season: number;
    status: Doc<"leagues">["status"];
    isPublic: boolean;
    teamCount: number;
  };
  viewer: { isMember: boolean; isCommissioner: boolean; teamId: Id<"teams"> | null };
  currentWeek: number;
  standings: StandingsRow[];
  matchups: MatchupCard[];
  forumPosts: ForumTeaser[];
  trades: TradeTeaser[];
  spend: SpendRow[];
  totalSpendUsd: number;
  windows: WindowSchedule;
  draft: DraftStatus;
  snapshotTakenAt: number | null;
};

/** Season-to-date spend per team from `team_week_rollups`, richest first. */
export async function spendLeaderboard(
  ctx: QueryCtx,
  leagueId: Id<"leagues">,
  season: number,
  table: StandingsRow[],
): Promise<SpendRow[]> {
  const totals = new Map<string, { usdUsed: number; tokensUsed: number; runCount: number }>();
  // Bounded: 23 weeks × ≤ 14 teams.
  for (let week = 0; week <= MAX_WEEK; week++) {
    const rows = await ctx.db
      .query("team_week_rollups")
      .withIndex("by_leagueId_season_weekNo", (q) =>
        q.eq("leagueId", leagueId).eq("season", season).eq("weekNo", week),
      )
      .take(20);
    for (const row of rows) {
      const current = totals.get(row.teamId) ?? { usdUsed: 0, tokensUsed: 0, runCount: 0 };
      current.usdUsed += row.costUsd;
      current.tokensUsed += row.inputTokens + row.outputTokens;
      current.runCount += row.runCount;
      totals.set(row.teamId, current);
    }
  }
  if (totals.size === 0) return [];

  const byTeam = new Map(table.map((row) => [row.teamId as string, row]));
  return [...totals.entries()]
    .map(([teamId, sums]) => {
      const standing = byTeam.get(teamId);
      return {
        teamId,
        teamName: standing?.teamName ?? "Unknown",
        abbreviation: standing?.abbreviation ?? "??",
        usdUsed: round2(sums.usdUsed),
        tokensUsed: sums.tokensUsed,
        runCount: sums.runCount,
        modelId: standing?.modelId ?? null,
        modelLabel: modelLabel(standing?.modelId),
      };
    })
    .sort((a, b) => b.usdUsed - a.usdUsed);
}

export const home = query({
  args: { leagueId: v.id("leagues") },
  handler: async (ctx, { leagueId }): Promise<LeagueHome> => {
    const access = await requireLeagueRead(ctx, leagueId);
    const league = access.league;
    const now = Date.now();
    const weekNo = await currentWeekNoFor(ctx, leagueId, now);

    const snapshot = await latestMetaChunk(ctx, leagueId);
    const table = await standingsFor(ctx, leagueId, league.season);
    // Bounded: ≤ 14 teams.
    const teamRows = await ctx.db
      .query("teams")
      .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
      .collect();

    const matchupCards = await buildMatchupCards(
      ctx,
      leagueId,
      weekNo,
      table,
      teamRows,
      snapshot?.meta.liveScores ?? null,
    );

    // ---- latest Commons posts
    const postRows = await ctx.db
      .query("forum_posts")
      .withIndex("by_leagueId_createdAt", (q) => q.eq("leagueId", leagueId))
      .order("desc")
      .take(12);
    const teamById = new Map(teamRows.map((t) => [t._id as string, t]));
    const forumPosts: ForumTeaser[] = postRows
      .filter((post) => !post.hidden)
      .slice(0, 5)
      .map((post) => ({
        id: post._id,
        title: post.title,
        teamName: post.teamId
          ? (teamById.get(post.teamId)?.name ?? "Commissioner Agent")
          : "Commissioner Agent",
        flair: post.flair,
        score: post.score,
        commentCount: post.commentCount,
        createdAt: post.createdAt,
        runId: post.runId ?? null,
        stepIndex: post.stepIndex ?? null,
      }));

    // ---- recent trades that actually happened
    const tradeRows: Doc<"trades">[] = [];
    for (const status of ["completed", "accepted", "in_review"] as const) {
      tradeRows.push(
        ...(await ctx.db
          .query("trades")
          .withIndex("by_leagueId_status", (q) =>
            q.eq("leagueId", leagueId).eq("status", status),
          )
          .order("desc")
          .take(5)),
      );
    }
    const trades: TradeTeaser[] = tradeRows
      .sort((a, b) => b._creationTime - a._creationTime)
      .slice(0, 5)
      .map((trade) => ({
        id: trade._id,
        status: trade.status,
        proposerTeamName: teamById.get(trade.proposerTeamId)?.name ?? "Unknown",
        recipientTeamName: teamById.get(trade.recipientTeamId)?.name ?? "Unknown",
        playerCount: trade.items.filter((item) => item.playerId).length,
        fairnessScore: trade.fairnessScore ?? null,
        flagged: trade.flagged,
        resolvedAt: trade.resolvedAt ?? null,
        createdAt: trade._creationTime,
      }));

    const spend = await spendLeaderboard(ctx, leagueId, league.season, table);
    const schedule = await windowSchedule(ctx, leagueId, now);

    // ---- draft progress: bounded by the pick count (14 teams × 16 rounds).
    const picks = await ctx.db
      .query("draft_picks")
      .withIndex("by_leagueId_overallNo", (q) => q.eq("leagueId", leagueId))
      .take(300);

    const viewerTeam =
      teamRows.find((t) => t.ownerUserId && t.ownerUserId === access.viewer?.userId)?._id ?? null;

    return {
      league: {
        id: league._id,
        name: league.name,
        slug: league.slug,
        season: league.season,
        status: league.status,
        isPublic: league.isPublic,
        teamCount: league.teamCount,
      },
      viewer: {
        isMember: Boolean(access.membership),
        isCommissioner: access.isCommissioner,
        teamId: viewerTeam,
      },
      currentWeek: weekNo,
      standings: table,
      matchups: matchupCards,
      forumPosts,
      trades,
      spend,
      totalSpendUsd: round2(spend.reduce((sum, row) => sum + row.usdUsed, 0)),
      windows: schedule,
      draft: {
        status: league.status,
        draftType: league.draftType,
        scheduledAt: league.draftScheduledAt ?? null,
        picksMade: picks.filter((pick) => pick.playerId).length,
        totalPicks: picks.length > 0 ? picks.length : null,
      },
      snapshotTakenAt: snapshot?.snapshot.takenAt ?? null,
    };
  },
});
