/**
 * The league activity feed: everything the agents (and the commissioner) did,
 * newest first, in one stream for the league home page.
 *
 * There is no `activity` table. Each source keeps its own rows and the feed
 * merges the newest `limit` of each — a bounded read per source, then an
 * in-memory sort — so the feed can never disagree with the pages it links to:
 *
 *   transactions   → roster moves (waiver adds with their paired drop, agent
 *                    drops, draft picks). Trade transactions are skipped; the
 *                    trade item below carries the whole package.
 *   lineups        → the latest lineup each team set this week (agent/autopilot).
 *   trades         → one item when proposed (or countered), a second when resolved.
 *   forum_posts    → Commons posts (hidden posts stay hidden).
 *   messages       → negotiation messages, bodies withheld under the same
 *                    delayed-transparency rule `messaging.listThreads` applies.
 *   league_rule_changes → commissioner rule edits (in the unfiltered feed only).
 */
import { v, type Value } from "convex/values";
import type { FieldPaths, FilterBuilder, GenericTableInfo } from "convex/server";

import type { Doc, Id } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import { compareActivity, type ActivityCursor } from "./lib/activity_pure";
import { requireLeagueRead, viewerTeamIds } from "./lib/auth";
import { isThreadRevealed, isUnresolvedTradeStatus } from "./lib/social_pure";
import { isStartingSlot } from "./lib/views_shared";
import { currentWeekNoFor } from "./weeks";

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 100;

const activityCursor = v.object({ at: v.number(), order: v.number(), id: v.string() });

export type { ActivityCursor };

export const activityFilter = v.union(
  v.literal("all"),
  v.literal("moves"),
  v.literal("trades"),
  v.literal("commons"),
  v.literal("talk"),
);
export type ActivityFilter = "all" | "moves" | "trades" | "commons" | "talk";

export type ActivityTeam = {
  id: string;
  name: string;
  abbreviation: string;
  avatarUrl: string | null;
  avatarTemplate: string | null;
};

export type ActivityPlayer = {
  id: string;
  name: string;
  position: string;
  nflTeam: string | null;
  sleeperId: string;
};

type Base = {
  /** Stable across refreshes: source table + row id (+ event for trades). */
  id: string;
  at: number;
  /** Creation-time tie breaker, matching Convex's index order. */
  order: number;
  weekNo: number | null;
  runId: string | null;
  stepIndex: number | null;
};

export type ActivityItem =
  | (Base & {
      kind: "add";
      team: ActivityTeam;
      player: ActivityPlayer | null;
      dropped: ActivityPlayer | null;
      bid: number | null;
      viaWaiver: boolean;
    })
  | (Base & { kind: "drop"; team: ActivityTeam; player: ActivityPlayer | null })
  | (Base & {
      kind: "draft";
      team: ActivityTeam;
      player: ActivityPlayer | null;
      round: number | null;
      overallNo: number | null;
      price: number | null;
      auto: boolean;
    })
  | (Base & {
      kind: "lineup";
      team: ActivityTeam;
      version: number;
      source: "agent" | "autopilot";
      starters: number;
    })
  | (Base & {
      kind: "trade";
      tradeId: string;
      event: "proposed" | "countered" | "resolved";
      status: Doc<"trades">["status"];
      proposer: ActivityTeam;
      recipient: ActivityTeam;
      /** What the proposer sends / receives. */
      give: ActivityPlayer[];
      receive: ActivityPlayer[];
      /** FAAB the proposer sends (negative: receives). */
      faab: number;
      fairnessScore: number | null;
      flagged: boolean;
      threadId: string | null;
    })
  | (Base & {
      kind: "post";
      postId: string;
      team: ActivityTeam | null;
      title: string;
      flair: Doc<"forum_posts">["flair"];
      score: number;
      commentCount: number;
    })
  | (Base & {
      kind: "message";
      threadId: string;
      from: ActivityTeam;
      to: ActivityTeam;
      /** Null while delayed transparency withholds it. */
      body: string | null;
      revealAt: number | null;
    })
  | (Base & {
      kind: "rule_change";
      field: string;
      fromValue: string | null;
      toValue: string | null;
      note: string | null;
    });

export type ActivityFeed = {
  items: ActivityItem[];
  /** True when at least one source had more rows than the page shows. */
  hasMore: boolean;
  currentWeek: number;
  nextCursor: ActivityCursor | null;
};

export const feed = query({
  args: {
    leagueId: v.id("leagues"),
    limit: v.optional(v.number()),
    filter: v.optional(activityFilter),
    before: v.optional(activityCursor),
  },
  handler: async (ctx, args): Promise<ActivityFeed> => {
    const access = await requireLeagueRead(ctx, args.leagueId);
    const leagueId = args.leagueId;
    const limit = Math.min(Math.max(Math.floor(args.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
    const before = args.before ?? null;
    const filter: ActivityFilter = args.filter ?? "all";
    const wants = (f: Exclude<ActivityFilter, "all">) => filter === "all" || filter === f;
    const now = Date.now();
    const weekNo = await currentWeekNoFor(ctx, leagueId, now);

    const teams = await loadTeams(ctx, leagueId);
    const players = new PlayerCache(ctx);
    const items: ActivityItem[] = [];

    // ---- roster moves ------------------------------------------------------
    if (wants("moves")) {
      const rows = await ctx.db
        .query("transactions")
        .withIndex("by_leagueId", (q) => before ? q.eq("leagueId", leagueId).lte("_creationTime", before.at) : q.eq("leagueId", leagueId))
        .filter((q) => q.and(
          olderThan(q, "_creationTime", "transactions", before),
          q.neq(q.field("type"), "trade"),
          q.or(q.neq(q.field("type"), "drop"), q.eq(q.field("details.claimId"), undefined)),
        ))
        .order("desc")
        .take(limit + 1);

      // A processed waiver's paired drop is part of the add event, including
      // when the two transaction rows would fall on different pages.
      for (const row of rows) {
        const team = teams.get(row.teamId as string);
        if (!team) continue;
        const base = {
          id: `transactions/${row._id}`,
          at: row._creationTime,
          order: row._creationTime,
          weekNo: row.weekNo ?? null,
          runId: (row.runId as string | undefined) ?? null,
          stepIndex: null,
        };
        if (row.type === "add") {
          const claimId = claimIdOf(row);
          const claimRowId = claimId ? ctx.db.normalizeId("waiver_claims", claimId) : null;
          const claim = claimRowId ? await ctx.db.get("waiver_claims", claimRowId) : null;
          // Imported claims may retain legacy IDs. Their drop was written
          // immediately before the add; keep this fallback bounded to two rows.
          const adjacent = claimId && !claim ? await ctx.db.query("transactions")
            .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId).lte("_creationTime", row._creationTime))
            .order("desc").take(2) : [];
          const drop = adjacent.find((entry) => entry.type === "drop" && entry.teamId === row.teamId && claimIdOf(entry) === claimId);
          items.push({
            ...base,
            kind: "add",
            team,
            player: await players.get(row.playerId),
            dropped: await players.get(claim?.leagueId === leagueId ? claim.dropPlayerId : drop?.playerId),
            bid: numberDetail(row, "bid"),
            viaWaiver: row.details?.source === "waiver",
          });
        } else if (row.type === "draft") {
          items.push({
            ...base,
            kind: "draft",
            team,
            player: await players.get(row.playerId),
            round: numberDetail(row, "round"),
            overallNo: numberDetail(row, "overallNo"),
            price: numberDetail(row, "price"),
            auto: row.details?.auto === true,
          });
        }
      }
      for (const row of rows) {
        if (row.type !== "drop") continue;
        const team = teams.get(row.teamId as string);
        if (!team) continue;
        items.push({
          id: `transactions/${row._id}`,
          at: row._creationTime,
          order: row._creationTime,
          weekNo: row.weekNo ?? null,
          runId: (row.runId as string | undefined) ?? null,
          stepIndex: null,
          kind: "drop",
          team,
          player: await players.get(row.playerId),
        });
      }

      // The latest lineup each team set this week. Bounded: ≤ 14 teams, one row each.
      for (const team of teams.values()) {
        const lineup = await ctx.db
          .query("lineups")
          .withIndex("by_teamId_weekNo_version", (q) =>
            q.eq("teamId", team.id as Id<"teams">).eq("weekNo", weekNo),
          )
          .order("desc")
          .first();
        if (!lineup || (lineup.source !== "agent" && lineup.source !== "autopilot")) continue;
        items.push({
          id: `lineups/${lineup._id}`,
          at: lineup._creationTime,
          order: lineup._creationTime,
          weekNo: lineup.weekNo,
          runId: (lineup.setByRunId as string | undefined) ?? null,
          stepIndex: null,
          kind: "lineup",
          team,
          version: lineup.version,
          source: lineup.source,
          starters: lineup.slots.filter((s) => s.playerId && isStartingSlot(s.slot)).length,
        });
      }
    }

    // ---- trades ------------------------------------------------------------
    if (wants("trades")) {
      const proposed = await ctx.db
        .query("trades")
        .withIndex("by_leagueId", (q) => before ? q.eq("leagueId", leagueId).lte("_creationTime", before.at) : q.eq("leagueId", leagueId))
        .filter((q) => olderThan(q, "_creationTime", "trades", before, "proposed"))
        .order("desc")
        .take(limit + 1);
      const resolved = await ctx.db.query("trades")
        .withIndex("by_leagueId_resolvedAt", (q) => before
          ? q.eq("leagueId", leagueId).gt("resolvedAt", 0).lte("resolvedAt", before.at)
          : q.eq("leagueId", leagueId).gt("resolvedAt", 0))
        .filter((q) => olderThan(q, "resolvedAt", "trades", before, "resolved"))
        .order("desc").take(limit + 1);
      const rows = [...new Map([...proposed, ...resolved].map((row) => [row._id, row])).values()];
      for (const trade of rows) {
        const proposer = teams.get(trade.proposerTeamId as string);
        const recipient = teams.get(trade.recipientTeamId as string);
        if (!proposer || !recipient) continue;
        const give: ActivityPlayer[] = [];
        const receive: ActivityPlayer[] = [];
        let faab = 0;
        for (const item of trade.items) {
          const fromProposer = item.fromTeamId === trade.proposerTeamId;
          if (item.playerId) {
            const player = await players.get(item.playerId);
            if (player) (fromProposer ? give : receive).push(player);
          }
          if (item.faab) faab += fromProposer ? item.faab : -item.faab;
        }
        const shared = {
          order: trade._creationTime,
          weekNo: trade.weekNo,
          tradeId: trade._id as string,
          status: trade.status,
          proposer,
          recipient,
          give,
          receive,
          faab,
          fairnessScore: trade.fairnessScore ?? null,
          flagged: trade.flagged,
          threadId: (trade.threadId as string | undefined) ?? null,
        };
        items.push({
          ...shared,
          kind: "trade",
          id: `trades/${trade._id}/proposed`,
          at: trade._creationTime,
          runId: (trade.createdByRunId as string | undefined) ?? null,
          stepIndex: null,
          event: trade.parentTradeId ? "countered" : "proposed",
        });
        if (trade.resolvedAt && trade.status !== "proposed" && trade.status !== "countered") {
          items.push({
            ...shared,
            kind: "trade",
            id: `trades/${trade._id}/resolved`,
            at: trade.resolvedAt,
            runId: null,
            stepIndex: null,
            event: "resolved",
          });
        }
      }
    }

    // ---- the Commons ---------------------------------------------------------
    if (wants("commons")) {
      const rows = await ctx.db
        .query("forum_posts")
        .withIndex("by_leagueId_createdAt", (q) => before ? q.eq("leagueId", leagueId).lte("createdAt", before.at) : q.eq("leagueId", leagueId))
        .filter((q) => q.and(q.neq(q.field("hidden"), true), olderThan(q, "createdAt", "forum_posts", before)))
        .order("desc")
        .take(limit + 1);
      for (const post of rows) {
        if (post.hidden) continue;
        items.push({
          id: `forum_posts/${post._id}`,
          at: post.createdAt,
          order: post._creationTime,
          weekNo: null,
          runId: (post.runId as string | undefined) ?? null,
          stepIndex: post.stepIndex ?? null,
          kind: "post",
          postId: post._id as string,
          team: post.teamId ? (teams.get(post.teamId as string) ?? null) : null,
          title: post.title,
          flair: post.flair,
          score: post.score,
          commentCount: post.commentCount,
        });
      }
    }

    // ---- negotiations --------------------------------------------------------
    if (wants("talk")) {
      const rows = await ctx.db
        .query("messages")
        .withIndex("by_leagueId_createdAt", (q) => before ? q.eq("leagueId", leagueId).lte("createdAt", before.at) : q.eq("leagueId", leagueId))
        .filter((q) => olderThan(q, "createdAt", "messages", before))
        .order("desc")
        .take(limit + 1);
      if (rows.length > 0) {
        const rules = await ctx.db
          .query("league_rules")
          .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
          .unique();
        const mode = rules?.transparencyMode ?? "live";
        const viewerTeams = (await viewerTeamIds(ctx, leagueId, access.viewer)) as unknown as string[];
        const reveals = new Map<string, { revealed: boolean; revealAt: number | null; thread: Doc<"threads"> }>();
        for (const message of rows) {
          let reveal = reveals.get(message.threadId as string);
          if (!reveal) {
            const thread = await ctx.db.get("threads", message.threadId);
            if (!thread) continue;
            const window = thread.createdInWindowId
              ? await ctx.db.get("windows", thread.createdInWindowId)
              : null;
            // Bounded: a thread raises at most a handful of offers.
            const threadTrades = await ctx.db
              .query("trades")
              .withIndex("by_threadId", (q) => q.eq("threadId", thread._id))
              .take(20);
            const r = isThreadRevealed({
              transparencyMode: mode,
              windowClosesAt: window?.closesAt ?? null,
              windowStatus: window?.status ?? null,
              viewerTeamIds: viewerTeams,
              threadTeams: [thread.teamAId as string, thread.teamBId as string],
              hasUnresolvedTrade: threadTrades.some((t) => isUnresolvedTradeStatus(t.status)),
              isCommissioner: access.isCommissioner,
              now,
            });
            reveal = { revealed: r.revealed, revealAt: r.revealAt, thread };
            reveals.set(message.threadId as string, reveal);
          }
          const from = teams.get(message.senderTeamId as string);
          const otherId =
            reveal.thread.teamAId === message.senderTeamId
              ? reveal.thread.teamBId
              : reveal.thread.teamAId;
          const to = teams.get(otherId as string);
          if (!from || !to) continue;
          items.push({
            id: `messages/${message._id}`,
            at: message.createdAt,
            order: message._creationTime,
            weekNo: null,
            runId: (message.runId as string | undefined) ?? null,
            stepIndex: message.stepIndex ?? null,
            kind: "message",
            threadId: message.threadId as string,
            from,
            to,
            body: reveal.revealed ? message.body : null,
            revealAt: reveal.revealed ? null : reveal.revealAt,
          });
        }
      }
    }

    // ---- commissioner rule changes (unfiltered feed only) ----------------------
    if (filter === "all") {
      const dated = await ctx.db
        .query("league_rule_changes")
        .withIndex("by_leagueId_createdAt", (q) => before
          ? q.eq("leagueId", leagueId).gt("createdAt", 0).lte("createdAt", before.at)
          : q.eq("leagueId", leagueId).gt("createdAt", 0))
        .filter((q) => olderThan(q, "createdAt", "league_rule_changes", before))
        .order("desc")
        .take(limit + 1);
      const undated = await ctx.db.query("league_rule_changes")
        .withIndex("by_leagueId_createdAt", (q) => before
          ? q.eq("leagueId", leagueId).eq("createdAt", undefined).lte("_creationTime", before.at)
          : q.eq("leagueId", leagueId).eq("createdAt", undefined))
        .filter((q) => olderThan(q, "_creationTime", "league_rule_changes", before))
        .order("desc").take(limit + 1);
      const rows = [...dated, ...undated];
      for (const change of rows) {
        const display = await displayChange(ctx, change);
        items.push({
          id: `league_rule_changes/${change._id}`,
          at: change.createdAt ?? change._creationTime,
          order: change._creationTime,
          weekNo: null,
          runId: null,
          stepIndex: null,
          kind: "rule_change",
          ...display,
          note: change.note ?? null,
        });
      }
    }

    const eligible = items.filter((item) => !before || compareActivity(item, before) > 0);
    eligible.sort(compareActivity);
    const page = eligible.slice(0, limit);
    const hasMore = eligible.length > limit;
    const last = page.at(-1);
    return {
      items: page,
      hasMore,
      nextCursor: hasMore && last ? { at: last.at, order: last.order, id: last.id } : null,
      currentWeek: weekNo,
    };
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Timestamp + stable event ID keeps equal-time events from being skipped between pages. */
function olderThan<T extends GenericTableInfo>(
  q: FilterBuilder<T>, field: FieldPaths<T>, source: string, before: ActivityCursor | null, event = "",
) {
  if (!before) return true;
  const [cursorSource, cursorId, cursorEvent = ""] = before.id.split("/");
  const sameOrder = source === cursorSource
    ? q.or(q.lt<Value>(q.field("_id"), cursorId), q.and(q.eq<Value>(q.field("_id"), cursorId), event < cursorEvent))
    : source < cursorSource;
  const sameTime = q.or(q.lt<Value>(q.field("_creationTime"), before.order), q.and(q.eq<Value>(q.field("_creationTime"), before.order), sameOrder));
  return q.or(q.lt<Value>(q.field(field), before.at), q.and(q.eq<Value>(q.field(field), before.at), sameTime));
}

async function displayChange(ctx: QueryCtx, change: Doc<"league_rule_changes">) {
  const teamField = change.field.match(/^team\.(.+)\.(owner|name)$/);
  const ownerName = async (value: unknown) => {
    if (!value) return "Unassigned";
    const id = typeof value === "string" ? ctx.db.normalizeId("users", value) : null;
    const owner = id ? await ctx.db.get("users", id) : null;
    return owner?.name || "League member";
  };
  return {
    field: teamField
      ? `${teamField[2] === "owner" ? "the owner" : "the name"} of ${teamField[1]}`
      : change.field.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_.]/g, " ").toLowerCase(),
    fromValue: teamField?.[2] === "owner" ? await ownerName(change.fromValue) : displayValue(change.fromValue),
    toValue: teamField?.[2] === "owner" ? await ownerName(change.toValue) : displayValue(change.toValue),
  };
}

async function loadTeams(ctx: QueryCtx, leagueId: Id<"leagues">): Promise<Map<string, ActivityTeam>> {
  // Bounded: one league has at most `teamCount` (≤ 14) teams.
  const rows = await ctx.db
    .query("teams")
    .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
    .collect();
  const out = new Map<string, ActivityTeam>();
  for (const team of rows) {
    out.set(team._id as string, {
      id: team._id as string,
      name: team.name,
      abbreviation: team.abbreviation,
      avatarUrl: team.avatarStorageId ? await ctx.storage.getUrl(team.avatarStorageId) : null,
      avatarTemplate: team.avatarTemplate ?? null,
    });
  }
  return out;
}

/** Player lookups by id, each row read once per query. */
class PlayerCache {
  private readonly cache = new Map<string, ActivityPlayer | null>();
  constructor(private readonly ctx: QueryCtx) {}

  async get(playerId: Id<"players"> | undefined | null): Promise<ActivityPlayer | null> {
    if (!playerId) return null;
    const key = playerId as string;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const row = await this.ctx.db.get("players", playerId);
    const player: ActivityPlayer | null = row
      ? {
          id: key,
          name: row.fullName,
          position: row.position,
          nflTeam: row.nflTeam ?? null,
          sleeperId: row.sleeperId,
        }
      : null;
    this.cache.set(key, player);
    return player;
  }
}

function claimIdOf(row: Doc<"transactions">): string | null {
  const value = row.details?.claimId;
  return typeof value === "string" ? value : null;
}

function numberDetail(row: Doc<"transactions">, key: string): number | null {
  const value = row.details?.[key];
  return typeof value === "number" ? value : null;
}

/** Rule values are `v.any()`; render scalars as-is and anything else as JSON. */
function displayValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
