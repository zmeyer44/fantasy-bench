/**
 * Provider → Convex ingestion (PRD §6.5, migration plan §2.4 "Ingestion").
 *
 * Shape: **one action fetches, many mutations write.** `fetch` only exists in
 * actions (docs/CONVEX_NOTES.md §3), and a mutation may write at most 16k
 * documents in at most a second, so `internal.ingest.pull` pulls the feeds and
 * hands the normalized rows to `upsertPlayers` / `upsertGames` /
 * `insertProjections` / `upsertStats` / `insertInjuriesAndNews` /
 * `upsertOwnership` in batches of ≤ 400. Each batch is its own transaction, so a
 * failure half-way leaves a coherent prefix rather than nothing.
 *
 * Two rules run through the whole file:
 *
 *  - Projections are **append-only vintages**: a row is written only when the
 *    provider's `effectiveAt` is strictly newer than the stored one for that
 *    (player, season, week, source). `player_projection_latest` is upserted in
 *    the *same* mutation as the history row, which is what lets the snapshot
 *    builder read one bounded range instead of de-duplicating vintages.
 *  - Nothing throws on partial data. A row that will not resolve is counted in
 *    `skipped` and logged; a provider outage degrades the pull, never the app.
 */
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";
import { computeAllPresets } from "./lib/scoring_pure";
import { toETParts } from "./lib/templates";
import * as espn from "./providers/espn";
import { providerLog } from "./providers/http";
import * as nflverse from "./providers/nflverse";
import * as sleeper from "./providers/sleeper";
import { defaultProjectionProvider } from "./providers/index";
import { normalizeTeam } from "./providers/teams";
import type {
  NormalizedGame,
  NormalizedInjury,
  NormalizedNews,
  NormalizedOwnership,
  NormalizedPlayer,
  NormalizedProjection,
  NormalizedStatLine,
} from "./providers/types";

// --------------------------------------------------------------- batching

/**
 * Documents per write mutation. Projections write two documents per row (the
 * vintage and the `latest` upsert) so they get a smaller batch; everything else
 * writes one.
 */
export const BATCH = 400;
export const PROJECTION_BATCH = 250;
/**
 * Injuries and news are the read-heavy batch, not the write-heavy one: an ESPN
 * injury carries no id we index, so resolving one costs up to thirteen index
 * ranges (the espn id, then `nameKey` with and without the team for each of the
 * six positions we track). A transaction may read **4,096 index ranges**
 * (docs/CONVEX_NOTES.md §4), so this batch is an order of magnitude smaller than
 * the others — 400 injuries in one mutation blows the limit, 100 does not.
 */
export const NEWS_BATCH = 100;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// --------------------------------------------------------------- join keys

/**
 * `<name stripped to a-z>|<team>|<POSITION>` — the join key for feeds that
 * carry no id (ESPN injuries and news, FantasyPros projections). Written onto
 * `players.nameKey` by `upsertPlayers` and indexed as `players.by_nameKey`.
 */
export function nameKey(
  name: string,
  team: string | null | undefined,
  position: string | null | undefined,
): string {
  const clean = name.toLowerCase().replace(/[^a-z]/g, "");
  return `${clean}|${normalizeTeam(team) ?? ""}|${(position ?? "").toUpperCase()}`;
}

const TRACKED_POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"] as const;
type TrackedPosition = (typeof TRACKED_POSITIONS)[number];

function trackedPosition(value: string | null | undefined): TrackedPosition | null {
  const upper = (value ?? "").toUpperCase();
  return (TRACKED_POSITIONS as readonly string[]).includes(upper)
    ? (upper as TrackedPosition)
    : null;
}

/** By Sleeper id, then by the name key. Injury feeds carry no position. */
async function resolvePlayer(
  ctx: MutationCtx,
  args: { sleeperId?: string | null; espnId?: string | null; name?: string | null; team?: string | null; position?: string | null },
): Promise<Doc<"players"> | null> {
  if (args.sleeperId) {
    // FantasyPros rows arrive as the synthetic `fp:<nameKey>` id.
    if (args.sleeperId.startsWith("fp:")) {
      const byName = await ctx.db
        .query("players")
        .withIndex("by_nameKey", (q) => q.eq("nameKey", args.sleeperId!.slice(3)))
        .first();
      if (byName) return byName;
    } else {
      const bySleeper = await ctx.db
        .query("players")
        .withIndex("by_sleeperId", (q) => q.eq("sleeperId", args.sleeperId!))
        .first();
      if (bySleeper) return bySleeper;
    }
  }
  if (args.espnId) {
    const byEspn = await ctx.db
      .query("players")
      .withIndex("by_espnId", (q) => q.eq("espnId", args.espnId!))
      .first();
    if (byEspn) return byEspn;
  }
  if (args.name) {
    const positions = args.position ? [args.position] : TRACKED_POSITIONS;
    for (const pos of positions) {
      const hit = await ctx.db
        .query("players")
        .withIndex("by_nameKey", (q) => q.eq("nameKey", nameKey(args.name!, args.team, pos)))
        .first();
      if (hit) return hit;
      const loose = await ctx.db
        .query("players")
        .withIndex("by_nameKey", (q) => q.eq("nameKey", nameKey(args.name!, null, pos)))
        .first();
      if (loose) return loose;
    }
  }
  return null;
}

// -------------------------------------------------------------- validators

const nstr = v.union(v.null(), v.string());
const nnum = v.union(v.null(), v.number());

const playerRow = v.object({
  sleeperId: v.string(),
  gsisId: nstr,
  espnId: nstr,
  fullName: v.string(),
  firstName: nstr,
  lastName: nstr,
  position: v.string(),
  nflTeam: nstr,
  status: nstr,
  injuryStatus: nstr,
  injuryBodyPart: nstr,
  injuryNotes: nstr,
  practiceParticipation: nstr,
  yearsExp: nnum,
  age: nnum,
  searchRank: nnum,
  fantasyPositions: v.array(v.string()),
  newsUpdated: nnum,
  crossIds: v.record(v.string(), v.string()),
});

const gameRow = v.object({
  season: v.number(),
  week: v.number(),
  gameId: v.string(),
  espnId: nstr,
  homeTeam: v.string(),
  awayTeam: v.string(),
  kickoffAt: v.number(),
  status: v.string(),
  homeScore: nnum,
  awayScore: nnum,
  source: v.string(),
});

const projectionRow = v.object({
  sleeperId: v.string(),
  season: v.number(),
  week: v.number(),
  position: nstr,
  team: nstr,
  opponent: nstr,
  gameId: nstr,
  pointsPpr: nnum,
  pointsHalf: nnum,
  pointsStd: nnum,
  stats: v.record(v.string(), v.number()),
  effectiveAt: v.number(),
  source: v.string(),
});

const statRow = v.object({
  sleeperId: v.string(),
  season: v.number(),
  week: v.number(),
  position: nstr,
  team: nstr,
  opponent: nstr,
  gameId: nstr,
  stats: v.record(v.string(), v.number()),
  effectiveAt: v.number(),
  source: v.string(),
});

const injuryRow = v.object({
  espnAthleteId: nstr,
  playerName: v.string(),
  nflTeam: nstr,
  designation: v.string(),
  practiceStatus: nstr,
  comment: nstr,
  effectiveAt: v.number(),
  source: v.string(),
});

const newsRow = v.object({
  externalId: v.string(),
  espnAthleteId: nstr,
  headline: v.string(),
  body: nstr,
  url: nstr,
  publishedAt: nnum,
  source: v.string(),
});

const ownershipRow = v.object({
  sleeperId: v.string(),
  ownedPct: nnum,
  startedPct: nnum,
});

const counts = v.object({ written: v.number(), skipped: v.number() });
type Counts = { written: number; skipped: number };

// ------------------------------------------------------------ ingest_state

export const readState = internalQuery({
  args: { key: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      key: v.string(),
      lastRunAt: v.number(),
      lastEffectiveAt: v.union(v.null(), v.number()),
      lastCount: v.number(),
    }),
  ),
  handler: async (ctx, { key }) => {
    const row = await ctx.db
      .query("ingest_state")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique();
    if (!row) return null;
    return {
      key: row.key,
      lastRunAt: row.lastRunAt,
      lastEffectiveAt: row.lastEffectiveAt ?? null,
      lastCount: row.lastCount,
    };
  },
});

export const recordState = internalMutation({
  args: {
    key: v.string(),
    lastRunAt: v.number(),
    lastEffectiveAt: v.optional(v.number()),
    lastCount: v.number(),
    lastError: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("ingest_state")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();
    const row = {
      key: args.key,
      lastRunAt: args.lastRunAt,
      // Never move the high-water mark backwards.
      lastEffectiveAt: Math.max(args.lastEffectiveAt ?? 0, existing?.lastEffectiveAt ?? 0) || undefined,
      lastCount: args.lastCount,
      lastError: args.lastError,
    };
    if (existing) await ctx.db.replace("ingest_state", existing._id, row);
    else await ctx.db.insert("ingest_state", row);
    return null;
  },
});

// ---------------------------------------------------------------- players

export const upsertPlayers = internalMutation({
  args: { rows: v.array(playerRow), now: v.optional(v.number()) },
  returns: counts,
  handler: async (ctx, args): Promise<Counts> => {
    const now = args.now ?? Date.now();
    let written = 0;
    let skipped = 0;
    for (const row of args.rows) {
      const position = trackedPosition(row.position);
      if (!position) {
        skipped++;
        continue;
      }
      const externalIds = { ...row.crossIds };
      if (row.practiceParticipation) {
        externalIds.practice_participation = row.practiceParticipation;
      }
      const doc = {
        sleeperId: row.sleeperId,
        gsisId: row.gsisId ?? undefined,
        espnId: row.espnId ?? undefined,
        fullName: row.fullName,
        firstName: row.firstName ?? undefined,
        lastName: row.lastName ?? undefined,
        position,
        nflTeam: row.nflTeam ?? undefined,
        status: row.status ?? undefined,
        injuryStatus: row.injuryStatus ?? undefined,
        injuryBodyPart: row.injuryBodyPart ?? undefined,
        injuryNotes: row.injuryNotes ?? undefined,
        yearsExp: row.yearsExp ?? undefined,
        age: row.age ?? undefined,
        searchRank: row.searchRank ?? undefined,
        fantasyPositions: row.fantasyPositions,
        externalIds,
        nameKey: nameKey(row.fullName, row.nflTeam, position),
        updatedAt: now,
      };
      const existing = await ctx.db
        .query("players")
        .withIndex("by_sleeperId", (q) => q.eq("sleeperId", row.sleeperId))
        .first();
      if (existing) {
        // `byeWeek` is derived from the schedule, not carried by this feed.
        await ctx.db.patch("players", existing._id, doc);
      } else {
        await ctx.db.insert("players", doc);
      }
      written++;
    }
    return { written, skipped };
  },
});

// ------------------------------------------------------------------ games

export const upsertGames = internalMutation({
  args: { rows: v.array(gameRow) },
  returns: counts,
  handler: async (ctx, args): Promise<Counts> => {
    let written = 0;
    for (const row of args.rows) {
      const existing = await ctx.db
        .query("nfl_games")
        .withIndex("by_gameId", (q) => q.eq("gameId", row.gameId))
        .first();
      const doc = {
        season: row.season,
        week: row.week,
        gameId: row.gameId,
        // Keep the id/scores we already had when this feed does not carry them
        // (nflverse fills the schedule; ESPN owns kickoff and live status).
        espnId: row.espnId ?? existing?.espnId,
        homeTeam: row.homeTeam,
        awayTeam: row.awayTeam,
        kickoffAt: row.kickoffAt,
        status: row.status,
        homeScore: row.homeScore ?? existing?.homeScore,
        awayScore: row.awayScore ?? existing?.awayScore,
      };
      if (existing) await ctx.db.patch("nfl_games", existing._id, doc);
      else await ctx.db.insert("nfl_games", doc);
      written++;
    }
    return { written, skipped: 0 };
  },
});

// ------------------------------------------------------------ projections

/**
 * Append a projection vintage and refresh `player_projection_latest`.
 *
 * The gate reads `player_projection_latest` — one indexed lookup per row —
 * which is both the test and the upsert target, and it is a **content** gate,
 * not just a vintage one. Sleeper stamps `last_modified` with roughly the
 * request time (verified against the live endpoint), so "is this newer?" alone
 * is always true and a fifteen-minute poll would append 3,200 identical
 * vintages an hour. A row is therefore written only when it is both newer and
 * *different*; an unchanged projection keeps the earlier `effectiveAt`, which is
 * the honest answer to "since when has it been this value?" and is exactly what
 * the as-of replay in PRD 6.6 asks `by_playerId_week_effectiveAt` for.
 *
 * Deviation from Postgres: `player_projections.stats` is
 * `Record<string, number>` in the Convex schema, so the old row's string extras
 * (`team`, `opponent`, `game_id`) are not folded into the stat bag; they live on
 * `nfl_games` and `players` already.
 */
/** Same three preset totals and the same stat bag: nothing to record. */
function unchangedProjection(
  row: { pointsPpr: number | null; pointsHalf: number | null; pointsStd: number | null; stats: Record<string, number> },
  latest: Doc<"player_projection_latest">,
): boolean {
  if (
    (row.pointsPpr ?? 0) !== latest.projectedPointsPpr ||
    (row.pointsHalf ?? 0) !== latest.projectedPointsHalf ||
    (row.pointsStd ?? 0) !== latest.projectedPointsStd
  ) {
    return false;
  }
  const keys = Object.keys(row.stats);
  if (keys.length !== Object.keys(latest.stats).length) return false;
  return keys.every((key) => row.stats[key] === latest.stats[key]);
}

export const insertProjections = internalMutation({
  args: { rows: v.array(projectionRow) },
  returns: counts,
  handler: async (ctx, args): Promise<Counts> => {
    let written = 0;
    let skipped = 0;
    for (const row of args.rows) {
      const player = await resolvePlayer(ctx, { sleeperId: row.sleeperId });
      if (!player) {
        skipped++;
        continue;
      }
      const latest = await ctx.db
        .query("player_projection_latest")
        .withIndex("by_playerId_season_week_source", (q) =>
          q
            .eq("playerId", player._id)
            .eq("season", row.season)
            .eq("week", row.week)
            .eq("source", row.source),
        )
        .unique();
      if (latest && row.effectiveAt <= latest.effectiveAt) {
        skipped++;
        continue;
      }
      if (latest && unchangedProjection(row, latest)) {
        skipped++;
        continue;
      }

      const shared = {
        playerId: player._id,
        season: row.season,
        week: row.week,
        source: row.source,
        projectedPointsPpr: row.pointsPpr ?? 0,
        projectedPointsHalf: row.pointsHalf ?? 0,
        projectedPointsStd: row.pointsStd ?? 0,
        stats: row.stats,
        effectiveAt: row.effectiveAt,
      };
      await ctx.db.insert("player_projections", shared);
      const latestDoc = {
        ...shared,
        position: trackedPosition(row.position) ?? player.position,
      };
      if (latest) await ctx.db.replace("player_projection_latest", latest._id, latestDoc);
      else await ctx.db.insert("player_projection_latest", latestDoc);
      written++;
    }
    return { written, skipped };
  },
});

// ------------------------------------------------------------------ stats

/** Bounded: at most one row per source for a (player, season, week). */
const MAX_STAT_SOURCES = 8;

export const upsertStats = internalMutation({
  args: { rows: v.array(statRow) },
  returns: counts,
  handler: async (ctx, args): Promise<Counts> => {
    let written = 0;
    let skipped = 0;
    for (const row of args.rows) {
      const player = await resolvePlayer(ctx, { sleeperId: row.sleeperId });
      if (!player) {
        skipped++;
        continue;
      }
      const scored = computeAllPresets(row.stats, {
        position: row.position ?? player.position,
      });
      const doc = {
        playerId: player._id,
        season: row.season,
        week: row.week,
        source: row.source,
        stats: row.stats,
        fantasyPointsPpr: scored.ppr,
        fantasyPointsHalf: scored.half,
        fantasyPointsStd: scored.std,
        effectiveAt: row.effectiveAt,
      };
      const siblings = await ctx.db
        .query("player_stats_weekly")
        .withIndex("by_playerId_season_week", (q) =>
          q.eq("playerId", player._id).eq("season", row.season).eq("week", row.week),
        )
        .take(MAX_STAT_SOURCES);
      const existing = siblings.find((s) => s.source === row.source);
      if (existing) await ctx.db.patch("player_stats_weekly", existing._id, doc);
      else await ctx.db.insert("player_stats_weekly", doc);
      written++;
    }
    return { written, skipped };
  },
});

// ------------------------------------------------------- injuries + news

/**
 * ESPN injuries and news in one transaction.
 *
 * `injury_designations` is an effective-dated *log*, not a state table, so a row
 * is written only when the designation actually changed for that player this
 * week. News is deduped on `news_items.by_dedupeKey` (the article url, falling
 * back to `source:externalId`).
 */
export const insertInjuriesAndNews = internalMutation({
  args: {
    injuries: v.array(injuryRow),
    news: v.array(newsRow),
    season: v.number(),
    week: v.number(),
    now: v.optional(v.number()),
  },
  returns: v.object({ injuries: counts, news: counts }),
  handler: async (ctx, args): Promise<{ injuries: Counts; news: Counts }> => {
    const now = args.now ?? Date.now();
    let injuriesWritten = 0;
    let injuriesSkipped = 0;

    for (const injury of args.injuries) {
      const player = await resolvePlayer(ctx, {
        espnId: injury.espnAthleteId,
        name: injury.playerName,
        team: injury.nflTeam,
      });
      if (!player) {
        injuriesSkipped++;
        continue;
      }
      const latest = await ctx.db
        .query("injury_designations")
        .withIndex("by_playerId_effectiveAt", (q) => q.eq("playerId", player._id))
        .order("desc")
        .first();
      if (
        latest &&
        latest.season === args.season &&
        latest.week === args.week &&
        latest.designation === injury.designation
      ) {
        injuriesSkipped++;
        continue;
      }
      await ctx.db.insert("injury_designations", {
        playerId: player._id,
        season: args.season,
        week: args.week,
        designation: injury.designation,
        practiceStatus: injury.practiceStatus ?? undefined,
        source: injury.source,
        effectiveAt: injury.effectiveAt,
      });
      injuriesWritten++;
    }

    let newsWritten = 0;
    let newsSkipped = 0;
    for (const item of args.news) {
      const dedupeKey = item.url ?? `${item.source}:${item.externalId}`;
      const existing = await ctx.db
        .query("news_items")
        .withIndex("by_dedupeKey", (q) => q.eq("dedupeKey", dedupeKey))
        .first();
      if (existing) {
        newsSkipped++;
        continue;
      }
      const player = item.espnAthleteId
        ? await resolvePlayer(ctx, { espnId: item.espnAthleteId })
        : null;
      await ctx.db.insert("news_items", {
        playerId: player?._id,
        source: item.source,
        headline: item.headline,
        body: item.body ?? undefined,
        url: item.url ?? undefined,
        publishedAt: item.publishedAt ?? now,
        effectiveAt: item.publishedAt ?? now,
        dedupeKey,
      });
      newsWritten++;
    }

    return {
      injuries: { written: injuriesWritten, skipped: injuriesSkipped },
      news: { written: newsWritten, skipped: newsSkipped },
    };
  },
});

// -------------------------------------------------------------- ownership

export const upsertOwnership = internalMutation({
  args: {
    rows: v.array(ownershipRow),
    season: v.number(),
    week: v.number(),
    now: v.optional(v.number()),
  },
  returns: counts,
  handler: async (ctx, args): Promise<Counts> => {
    const now = args.now ?? Date.now();
    let written = 0;
    let skipped = 0;
    for (const row of args.rows) {
      const player = await resolvePlayer(ctx, { sleeperId: row.sleeperId });
      if (!player) {
        skipped++;
        continue;
      }
      const doc = {
        playerId: player._id,
        season: args.season,
        week: args.week,
        ownedPct: row.ownedPct ?? 0,
        startedPct: row.startedPct ?? 0,
        effectiveAt: now,
      };
      const existing = await ctx.db
        .query("player_ownership")
        .withIndex("by_season_week_playerId", (q) =>
          q.eq("season", args.season).eq("week", args.week).eq("playerId", player._id),
        )
        .unique();
      if (existing) await ctx.db.replace("player_ownership", existing._id, doc);
      else await ctx.db.insert("player_ownership", doc);
      written++;
    }
    return { written, skipped };
  },
});

// ------------------------------------------------------------------- plan

export const ingestMode = v.union(
  v.literal("regular"),
  v.literal("gameday"),
  v.literal("full"),
);
export type IngestMode = "regular" | "gameday" | "full";

export type IngestPlan = {
  players: boolean;
  schedule: boolean;
  projections: boolean;
  stats: boolean;
  news: boolean;
  ownership: boolean;
};

/**
 * What each cron pulls (chosen by
 * the caller rather than by the clock, because the two crons already encode the
 * clock):
 *
 *  - `regular` (every 15 min): projections move, news moves. Nothing else does.
 *  - `gameday` (every 5 min, Thu/Sun/Mon ET): live stats, live game status, news.
 *  - `full` (daily): the whole universe, including the 14.6 MB player feed.
 */
export function planFor(mode: IngestMode): IngestPlan {
  switch (mode) {
    case "gameday":
      return {
        players: false,
        schedule: true,
        projections: false,
        stats: true,
        news: true,
        ownership: false,
      };
    case "full":
      return {
        players: true,
        schedule: true,
        projections: true,
        stats: true,
        news: true,
        ownership: true,
      };
    default:
      return {
        players: false,
        schedule: false,
        projections: true,
        stats: false,
        news: true,
        ownership: false,
      };
  }
}

/**
 * True on an NFL game day, in Eastern time — the guard the 5-minute cron applies
 * before doing any work (cron schedules are UTC; the NFL calendar is not).
 */
export function isGameDayET(now: number): boolean {
  const et = toETParts(now);
  if (et.weekday === 4 || et.weekday === 0 || et.weekday === 1) return true;
  return et.weekday === 2 && et.hour < 6;
}

// ------------------------------------------------------------------- pull

const pullResult = v.object({
  season: v.number(),
  week: v.number(),
  mode: ingestMode,
  players: counts,
  games: counts,
  projections: counts,
  stats: counts,
  injuries: counts,
  news: counts,
  ownership: counts,
});
type PullResult = {
  season: number;
  week: number;
  mode: IngestMode;
  players: Counts;
  games: Counts;
  projections: Counts;
  stats: Counts;
  injuries: Counts;
  news: Counts;
  ownership: Counts;
};

const ZERO: Counts = { written: 0, skipped: 0 };

function add(a: Counts, b: Counts): Counts {
  return { written: a.written + b.written, skipped: a.skipped + b.skipped };
}

/**
 * The ingest action.
 *
 * Actions are at-most-once (docs/CONVEX_NOTES.md §5), which is exactly right
 * here: a dropped pull is picked up by the next cron five or fifteen minutes
 * later, and every write it does is idempotent, so a duplicate pull is free.
 */
export const pull = internalAction({
  args: {
    mode: ingestMode,
    season: v.optional(v.number()),
    week: v.optional(v.number()),
    now: v.optional(v.number()),
  },
  returns: pullResult,
  handler: async (ctx, args): Promise<PullResult> => {
    const now = args.now ?? Date.now();
    const plan = planFor(args.mode);

    // Sleeper's state endpoint is the cheapest way to learn the live week.
    const state = args.season && args.week ? null : await sleeper.fetchState();
    const season = args.season ?? state?.season ?? new Date(now).getUTCFullYear();
    const week = args.week ?? state?.week ?? 1;

    const result: PullResult = {
      season,
      week,
      mode: args.mode,
      players: ZERO,
      games: ZERO,
      projections: ZERO,
      stats: ZERO,
      injuries: ZERO,
      news: ZERO,
      ownership: ZERO,
    };

    // ---- players (the 14.6 MB universe; `full` only)
    if (plan.players) {
      const rows: NormalizedPlayer[] = await sleeper.fetchAllPlayers();
      for (const batch of chunk(rows, BATCH)) {
        result.players = add(
          result.players,
          await ctx.runMutation(internal.ingest.upsertPlayers, { rows: batch, now }),
        );
      }
      await ctx.runMutation(internal.ingest.recordState, {
        key: "players",
        lastRunAt: now,
        lastCount: rows.length,
      });
    }

    // ---- schedule: nflverse first so ESPN (true UTC kickoff) overwrites it
    if (plan.schedule) {
      const byKey = new Map<string, NormalizedGame>();
      if (args.mode === "full") {
        for (const game of await nflverse.fetchGamesCsv(season)) byKey.set(game.gameId, game);
      }
      for (const w of args.mode === "full" ? range(1, 18) : [week, week + 1]) {
        for (const game of await espn.fetchScoreboard(season, w)) {
          const existing = byKey.get(game.gameId);
          byKey.set(game.gameId, existing ? { ...existing, ...game } : game);
        }
      }
      const rows = [...byKey.values()];
      for (const batch of chunk(rows, BATCH)) {
        result.games = add(
          result.games,
          await ctx.runMutation(internal.ingest.upsertGames, { rows: batch }),
        );
      }
      await ctx.runMutation(internal.ingest.recordState, {
        key: `schedule:${season}`,
        lastRunAt: now,
        lastCount: rows.length,
      });
    }

    // ---- projections (the vintage gate)
    if (plan.projections) {
      const provider = defaultProjectionProvider();
      const rows: NormalizedProjection[] = provider.isConfigured()
        ? await provider.fetchProjections(season, week)
        : [];
      const key = `projections:${season}:${week}:${provider.source}`;
      const maxEffectiveAt = rows.reduce((max, row) => Math.max(max, row.effectiveAt), 0);
      const state = await ctx.runQuery(internal.ingest.readState, { key });
      // A cheap short-circuit for a provider that stamps a stable vintage; the
      // real gate is per-row and content-based in `insertProjections`, because
      // Sleeper stamps `last_modified` with roughly the request time.
      if (rows.length > 0 && maxEffectiveAt > (state?.lastEffectiveAt ?? 0)) {
        for (const batch of chunk(rows, PROJECTION_BATCH)) {
          result.projections = add(
            result.projections,
            await ctx.runMutation(internal.ingest.insertProjections, { rows: batch }),
          );
        }
      } else {
        result.projections = { written: 0, skipped: rows.length };
      }
      await ctx.runMutation(internal.ingest.recordState, {
        key,
        lastRunAt: now,
        lastEffectiveAt: maxEffectiveAt || undefined,
        lastCount: rows.length,
      });
    }

    // ---- actual stats
    if (plan.stats) {
      const rows: NormalizedStatLine[] = await sleeper.fetchStats(season, week);
      for (const batch of chunk(rows, BATCH)) {
        result.stats = add(
          result.stats,
          await ctx.runMutation(internal.ingest.upsertStats, { rows: batch }),
        );
      }
      await ctx.runMutation(internal.ingest.recordState, {
        key: `stats:${season}:${week}`,
        lastRunAt: now,
        lastCount: rows.length,
      });
    }

    // ---- injuries + news
    if (plan.news) {
      const injuries: NormalizedInjury[] = await espn.fetchInjuries();
      const news: NormalizedNews[] = await espn.fetchNews(50);
      const injuryBatches = chunk(injuries, NEWS_BATCH);
      const newsBatches = chunk(news, NEWS_BATCH);
      const rounds = Math.max(injuryBatches.length, newsBatches.length, 1);
      for (let i = 0; i < rounds; i++) {
        const written = await ctx.runMutation(internal.ingest.insertInjuriesAndNews, {
          injuries: injuryBatches[i] ?? [],
          news: newsBatches[i] ?? [],
          season,
          week,
          now,
        });
        result.injuries = add(result.injuries, written.injuries);
        result.news = add(result.news, written.news);
      }
      await ctx.runMutation(internal.ingest.recordState, {
        key: `news:${season}:${week}`,
        lastRunAt: now,
        lastCount: injuries.length + news.length,
      });
    }

    // ---- ownership
    if (plan.ownership) {
      const rows: NormalizedOwnership[] = await sleeper.fetchOwnership(season, week);
      for (const batch of chunk(rows, BATCH)) {
        result.ownership = add(
          result.ownership,
          await ctx.runMutation(internal.ingest.upsertOwnership, {
            rows: batch,
            season,
            week,
            now,
          }),
        );
      }
      await ctx.runMutation(internal.ingest.recordState, {
        key: `ownership:${season}:${week}`,
        lastRunAt: now,
        lastCount: rows.length,
      });
    }

    providerLog(
      "ingest",
      `${args.mode} pull for ${season}w${week}: ` +
        `players ${result.players.written}, games ${result.games.written}, ` +
        `projections ${result.projections.written}, stats ${result.stats.written}, ` +
        `injuries ${result.injuries.written}, news ${result.news.written}`,
    );
    return result;
  },
});

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

/**
 * The cron entry point.
 *
 * A mutation, not the action, so the Eastern game-day guard is evaluated
 * transactionally and the action is only scheduled when there is work to do.
 *
 * `INGEST_DISABLED=1` (`npx convex env set INGEST_DISABLED 1`) mutes every
 * scheduled pull without a deploy — the escape hatch for a shared development
 * deployment that should not be writing live provider data over seeded fixtures.
 * `npx convex run ingest:pullNow` still works while it is set.
 */
export const tick = internalMutation({
  args: { mode: ingestMode, now: v.optional(v.number()) },
  returns: v.object({ scheduled: v.boolean() }),
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    if (process.env.INGEST_DISABLED === "1") return { scheduled: false };
    if (args.mode === "gameday" && !isGameDayET(now)) return { scheduled: false };
    await ctx.scheduler.runAfter(0, internal.ingest.pull, { mode: args.mode });
    return { scheduled: true };
  },
});

/** Convenience for `npx convex run ingest:pullNow '{"mode":"full"}'`. */
export const pullNow = internalAction({
  args: { mode: v.optional(ingestMode), season: v.optional(v.number()), week: v.optional(v.number()) },
  returns: pullResult,
  handler: async (ctx, args): Promise<PullResult> =>
    ctx.runAction(internal.ingest.pull, {
      mode: args.mode ?? "full",
      season: args.season,
      week: args.week,
    }),
});
