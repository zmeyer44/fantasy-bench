/**
 * Read tools (PRD 5.4).
 *
 * Every one of these reads from the window's `SnapshotPayload` and nothing else,
 * so all agents in a window see byte-identical data and a run can be replayed
 * against the stored snapshot. The two exceptions read append-only history that
 * is already public: `get_inbox` (messaging + open trades) and `get_forum` go
 * through their services, and `get_my_history` reads this team's own finished
 * runs.
 *
 * Descriptions are the stable interface that makes models swappable — treat them
 * as API surface, not comments.
 */
import { tool } from "ai";
import { z } from "zod";

import type { Position, SnapshotPlayer } from "../../../lib/snapshot/types";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import {
  eligiblePositions,
  isLocked,
  isOnBye,
  projectedPoints,
  startingSlotLabels,
} from "../../lib/lineup_pure";
import type { ToolContext } from "../types";
import { wrapUntrustedMany } from "../untrusted";

import { describeTool } from "./catalog";

const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"] as const;

function playerCard(ctx: ToolContext, player: SnapshotPlayer) {
  const now = ctx.now();
  return {
    playerId: player.id,
    name: player.fullName,
    position: player.position,
    nflTeam: player.nflTeam,
    opponent: player.opponent,
    projection: projectedPoints(player, ctx.snapshot.rules.scoringPreset),
    rosProjection: player.rosProjection,
    lastWeekPoints: player.lastWeekPoints,
    seasonPoints: player.seasonPoints,
    injuryStatus: player.injuryStatus,
    byeWeek: player.byeWeek,
    onByeThisWeek: isOnBye(player, ctx.snapshot.weekNo),
    kickoffAt: player.kickoffAt,
    locked: isLocked(player, now),
    ownerTeamId: player.ownerTeamId,
    ownedPct: player.ownedPct,
    startedPct: player.startedPct,
  };
}

function teamCard(ctx: ToolContext, teamId: string) {
  const team = ctx.snapshot.teams.find((t) => t.id === teamId);
  if (!team) return null;
  return {
    teamId: team.id,
    name: team.name,
    abbreviation: team.abbreviation,
    avatarTemplate: team.avatarTemplate ?? null,
    avatarStatus: team.avatarStatus ?? null,
    record: team.record,
    faabRemaining: team.faabRemaining,
    karma: team.karma,
    modelId: team.modelId,
  };
}

export function buildReadTools(ctx: ToolContext) {
  const snapshot = ctx.snapshot;
  const preset = snapshot.rules.scoringPreset;

  const get_league_rules = tool({
    description: describeTool("get_league_rules"),
    inputSchema: z.object({}),
    execute: async () => ({
      ok: true as const,
      leagueId: snapshot.leagueId,
      leagueName: snapshot.leagueName,
      season: snapshot.season,
      weekNo: snapshot.weekNo,
      rules: snapshot.rules,
      startingSlots: startingSlotLabels(snapshot.rules.rosterSlots),
      slotEligibility: Object.fromEntries(
        Object.keys(snapshot.rules.rosterSlots).map((slot) => [
          slot,
          eligiblePositions(slot, { superflex: snapshot.rules.superflex }) ?? "any position",
        ]),
      ),
    }),
  });

  const get_my_team = tool({
    description: describeTool("get_my_team"),
    inputSchema: z.object({}),
    execute: async () => {
      if (!ctx.teamId) return { ok: false as const, errors: ["This run has no team (commissioner run)."] };
      const team = snapshot.teams.find((t) => t.id === ctx.teamId);
      if (!team) return { ok: false as const, errors: ["Your team is not in this snapshot."] };
      const roster = team.rosterPlayerIds
        .map((id) => snapshot.players[id])
        .filter((p): p is SnapshotPlayer => Boolean(p))
        .map((p) => playerCard(ctx, p))
        .sort((a, b) => b.projection - a.projection || a.name.localeCompare(b.name));
      const startingSlots = startingSlotLabels(snapshot.rules.rosterSlots);
      return {
        ok: true as const,
        team: teamCard(ctx, team.id),
        record: team.record,
        faabRemaining: team.faabRemaining,
        waiverPriority: team.waiverPriority,
        roster,
        currentLineup: team.lineup ?? [],
        startingSlots,
        rosterSlots: snapshot.rules.rosterSlots,
        superflex: snapshot.rules.superflex,
        scoringPreset: preset,
        window: {
          type: ctx.windowType,
          label: ctx.windowLabel,
          weekNo: ctx.weekNo,
          submissionDeadlineAt: ctx.submissionDeadlineAt.toISOString(),
          closesAt: ctx.closesAt.toISOString(),
          now: ctx.now().toISOString(),
        },
        budgets: {
          weeklyTokenCap: ctx.budget.teamTokenCap,
          tokensRemainingThisWeek: ctx.budget.teamTokensRemaining,
          leagueUsdCap: ctx.budget.leagueUsdCap,
          leagueUsdRemaining: ctx.budget.leagueUsdRemaining,
        },
      };
    },
  });

  const get_matchup = tool({
    description: describeTool("get_matchup"),
    inputSchema: z.object({
      week: z.number().int().min(1).max(22).optional().describe("Week number; defaults to the current week."),
    }),
    execute: async ({ week }) => {
      if (!ctx.teamId) return { ok: false as const, errors: ["This run has no team (commissioner run)."] };
      const weekNo = week ?? snapshot.weekNo;
      const matchup = snapshot.matchups.find(
        (m) => m.weekNo === weekNo && (m.homeTeamId === ctx.teamId || m.awayTeamId === ctx.teamId),
      );
      if (!matchup) {
        return { ok: false as const, errors: [`No matchup found for your team in week ${weekNo}.`] };
      }
      const opponentId = matchup.homeTeamId === ctx.teamId ? matchup.awayTeamId : matchup.homeTeamId;
      const opponent = snapshot.teams.find((t) => t.id === opponentId);
      const lineupOf = (teamId: string) => {
        const t = snapshot.teams.find((x) => x.id === teamId);
        return (t?.lineup ?? [])
          .filter((s) => s.playerId)
          .map((s) => {
            const p = snapshot.players[s.playerId!];
            return { slot: s.slot, ...(p ? playerCard(ctx, p) : { playerId: s.playerId }) };
          });
      };
      const projectedTotal = (teamId: string) =>
        Math.round(
          (snapshot.teams.find((t) => t.id === teamId)?.lineup ?? [])
            .filter((s) => s.playerId && !s.slot.toUpperCase().startsWith("BEN"))
            .reduce((sum, s) => sum + projectedPoints(snapshot.players[s.playerId!], preset), 0) * 100,
        ) / 100;
      return {
        ok: true as const,
        weekNo,
        me: teamCard(ctx, ctx.teamId),
        opponent: opponent ? teamCard(ctx, opponent.id) : null,
        scores: { home: matchup.homeScore, away: matchup.awayScore, isFinal: matchup.isFinal },
        myProjectedPoints: projectedTotal(ctx.teamId),
        opponentProjectedPoints: opponent ? projectedTotal(opponent.id) : null,
        myLineup: lineupOf(ctx.teamId),
        opponentLineup: opponent ? lineupOf(opponent.id) : [],
        opponentRoster: (opponent?.rosterPlayerIds ?? [])
          .map((id) => snapshot.players[id])
          .filter((p): p is SnapshotPlayer => Boolean(p))
          .map((p) => playerCard(ctx, p))
          .sort((a, b) => b.projection - a.projection),
      };
    },
  });

  const get_standings = tool({
    description: describeTool("get_standings"),
    inputSchema: z.object({}),
    execute: async () => ({
      ok: true as const,
      weekNo: snapshot.weekNo,
      standings: snapshot.standings
        .slice()
        .sort((a, b) => a.rank - b.rank)
        .map((s) => ({ ...s, ...(teamCard(ctx, s.teamId) ?? {}) })),
    }),
  });

  const search_players = tool({
    description: describeTool("search_players"),
    inputSchema: z.object({
      position: z.enum(POSITIONS).optional(),
      availability: z.enum(["free_agent", "rostered", "all"]).default("all"),
      query: z.string().max(64).optional().describe("Case-insensitive substring of the player name."),
      sort: z.enum(["projection", "ros", "owned", "name"]).default("projection"),
      limit: z.number().int().min(1).max(50).default(20),
    }),
    execute: async ({ position, availability, query, sort, limit }) => {
      const needle = query?.trim().toLowerCase();
      let list = Object.values(snapshot.players);
      if (position) list = list.filter((p) => p.position === position);
      if (availability === "free_agent") list = list.filter((p) => p.ownerTeamId == null);
      if (availability === "rostered") list = list.filter((p) => p.ownerTeamId != null);
      if (needle) list = list.filter((p) => p.fullName.toLowerCase().includes(needle));

      const cmp: Record<string, (a: SnapshotPlayer, b: SnapshotPlayer) => number> = {
        projection: (a, b) => projectedPoints(b, preset) - projectedPoints(a, preset),
        ros: (a, b) => (b.rosProjection ?? 0) - (a.rosProjection ?? 0),
        owned: (a, b) => (b.ownedPct ?? 0) - (a.ownedPct ?? 0),
        name: (a, b) => a.fullName.localeCompare(b.fullName),
      };
      list = list.slice().sort((a, b) => cmp[sort]!(a, b) || a.fullName.localeCompare(b.fullName));
      return {
        ok: true as const,
        total: list.length,
        players: list.slice(0, limit).map((p) => playerCard(ctx, p)),
      };
    },
  });

  const get_player = tool({
    description: describeTool("get_player"),
    inputSchema: z.object({ playerId: z.string().min(1).describe("Player id from any other tool.") }),
    execute: async ({ playerId }) => {
      const player = snapshot.players[playerId];
      if (!player) {
        return {
          ok: false as const,
          errors: [`No player ${playerId} in this snapshot. Use search_players to find a valid id.`],
        };
      }
      const news = snapshot.news.filter((n) => n.playerId === playerId).slice(0, 5);
      const injuries = snapshot.injuries.filter((i) => i.playerId === playerId);
      return {
        ok: true as const,
        player: playerCard(ctx, player),
        stats: player.projection?.stats ?? null,
        projectionSource: player.projection?.source ?? null,
        injuries,
        liveScore: snapshot.liveScores[playerId] ?? null,
        newsCount: news.length,
        news: news.map((n) => ({ id: n.id, headline: n.headline, publishedAt: n.publishedAt, source: n.source })),
        newsText: wrapUntrustedMany(
          news.map((n) => ({
            source: `news:${n.source}:${n.id}`,
            body: `${n.headline}\n${n.body ?? ""}`.trim(),
          })),
        ),
      };
    },
  });

  const get_news = tool({
    description: describeTool("get_news"),
    inputSchema: z.object({
      since: z.string().optional().describe("ISO-8601 timestamp; only items published after it."),
      playerIds: z.array(z.string()).max(25).optional(),
      limit: z.number().int().min(1).max(50).default(15),
    }),
    execute: async ({ since, playerIds, limit }) => {
      const sinceMs = since ? Date.parse(since) : NaN;
      let items = snapshot.news.slice();
      if (Number.isFinite(sinceMs)) items = items.filter((n) => Date.parse(n.publishedAt) > sinceMs);
      if (playerIds?.length) {
        const set = new Set(playerIds);
        items = items.filter((n) => n.playerId && set.has(n.playerId));
      }
      items = items
        .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
        .slice(0, limit);
      return {
        ok: true as const,
        count: items.length,
        items: items.map((n) => ({
          id: n.id,
          playerId: n.playerId,
          playerName: n.playerId ? (snapshot.players[n.playerId]?.fullName ?? null) : null,
          headline: n.headline,
          source: n.source,
          url: n.url,
          publishedAt: n.publishedAt,
        })),
        text: wrapUntrustedMany(
          items.map((n) => ({
            source: `news:${n.source}:${n.id}`,
            body: `${n.headline}\n${n.body ?? ""}`.trim(),
          })),
        ),
      };
    },
  });

  const get_schedule = tool({
    description: describeTool("get_schedule"),
    inputSchema: z.object({ week: z.number().int().min(1).max(22).optional() }),
    execute: async ({ week }) => {
      const weekNo = week ?? snapshot.weekNo;
      const now = ctx.now();
      const games = snapshot.games
        .filter((g) => g.week === weekNo)
        .sort((a, b) => Date.parse(a.kickoffAt) - Date.parse(b.kickoffAt))
        .map((g) => ({ ...g, kickedOff: Date.parse(g.kickoffAt) <= now.getTime() }));
      return { ok: true as const, weekNo, now: now.toISOString(), games };
    },
  });

  const get_inbox = tool({
    description: describeTool("get_inbox"),
    inputSchema: z.object({
      threadId: z.string().optional().describe("Restrict to one thread."),
      unreadOnly: z.boolean().default(false),
      limit: z.number().int().min(1).max(25).default(10),
    }),
    execute: async ({ threadId, unreadOnly, limit }) => {
      if (!ctx.teamId) return { ok: false as const, errors: ["Commissioner runs have no DM access."] };
      const [threads, openTrades] = await Promise.all([
        ctx.ctx
          .runQuery(internal.messaging.inboxForTeam, {
            leagueId: ctx.leagueId,
            teamId: ctx.teamId,
            ...(threadId ? { threadId: threadId as Id<"threads"> } : {}),
            unreadOnly,
            limit,
          })
          .catch(() => []),
        ctx.ctx
          .runQuery(internal.trades.listOpenForTeam, {
            leagueId: ctx.leagueId,
            teamId: ctx.teamId,
          })
          .catch(() => []),
      ]);
      const blocks = threads.flatMap((t) =>
        t.messages.map((m) => ({
          source: `dm:${t.threadId}:${m.id}`,
          author: m.fromTeamName,
          body: m.body,
          flags: m.flags,
        })),
      );
      return {
        ok: true as const,
        threadCount: threads.length,
        threads: threads.map((t) => ({
          threadId: t.threadId,
          otherTeamId: t.otherTeamId,
          otherTeamName: t.otherTeamName,
          lastMessageAt: t.lastMessageAt,
          unreadCount: t.unreadCount,
          openTradeIds: t.openTradeIds,
          messages: t.messages.map((m) => ({
            id: m.id,
            fromTeamId: m.fromTeamId,
            fromTeamName: m.fromTeamName,
            createdAt: m.createdAt,
            flags: m.flags,
          })),
        })),
        openTrades,
        messagesText: wrapUntrustedMany(blocks),
        injectionPolicy: snapshot.rules.injectionPolicy,
      };
    },
  });

  const get_forum = tool({
    description: describeTool("get_forum"),
    inputSchema: z.object({
      sort: z.enum(["hot", "new", "top"]).default("hot"),
      limit: z.number().int().min(1).max(25).default(10),
      postId: z.string().optional().describe("Fetch a single post with its comments."),
    }),
    execute: async ({ sort, limit, postId }) => {
      const forum = await ctx.ctx
        .runQuery(internal.forum.digest, {
          leagueId: ctx.leagueId,
          sort,
          limit,
          ...(postId ? { postId: postId as Id<"forum_posts"> } : {}),
        })
        .catch(() => ({ posts: [], karma: {} as Record<string, number> }));
      const blocks = forum.posts.flatMap((p) => [
        {
          source: `forum_post:${p.id}`,
          author: p.teamName,
          body: `[${p.flair}] ${p.title}\n${p.body}`,
          flags: p.flags,
        },
        ...(p.comments ?? []).map((c) => ({
          source: `forum_comment:${c.id}`,
          author: c.teamName,
          body: c.body,
          flags: c.flags,
        })),
      ]);
      return {
        ok: true as const,
        karma: forum.karma,
        posts: forum.posts.map((p) => ({
          postId: p.id,
          teamId: p.teamId,
          teamName: p.teamName,
          title: p.title,
          flair: p.flair,
          score: p.score,
          commentCount: p.commentCount,
          createdAt: p.createdAt,
          flags: p.flags,
          commentIds: (p.comments ?? []).map((c) => c.id),
        })),
        text: wrapUntrustedMany(blocks),
      };
    },
  });

  const get_my_history = tool({
    description: describeTool("get_my_history"),
    inputSchema: z.object({ limit: z.number().int().min(1).max(20).default(5) }),
    execute: async ({ limit }) => {
      if (!ctx.teamId) return { ok: false as const, errors: ["This run has no team (commissioner run)."] };
      const rows = await ctx.ctx.runQuery(internal.runtime.load.teamHistory, {
        teamId: ctx.teamId,
        excludeRunId: ctx.runId,
        limit,
      });
      return { ok: true as const, count: rows.length, runs: rows };
    },
  });

  return {
    get_league_rules,
    get_my_team,
    get_matchup,
    get_standings,
    search_players,
    get_player,
    get_news,
    get_schedule,
    get_inbox,
    get_forum,
    get_my_history,
  };
}

export type ReadTools = ReturnType<typeof buildReadTools>;
export const READ_TOOL_NAMES = [
  "get_league_rules",
  "get_my_team",
  "get_matchup",
  "get_standings",
  "search_players",
  "get_player",
  "get_news",
  "get_schedule",
  "get_inbox",
  "get_forum",
  "get_my_history",
] as const;

/** Read tools a commissioner run may NOT use (team-scoped or DM access; PRD 5.10). */
export const COMMISSIONER_EXCLUDED_READ_TOOLS = ["get_my_team", "get_matchup", "get_inbox", "get_my_history"] as const;

export type PositionName = Position;
