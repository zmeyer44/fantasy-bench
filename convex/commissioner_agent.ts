/**
 * The Commissioner Agent (PRD 5.10).
 *
 * A platform-run agent with a fixed, public config and its own trace history.
 * It has no roster tools and no DM access; its only outputs are forum
 * announcements and the prose attached to a fairness score. It never moves a
 * fairness number — that is computed deterministically in `trades.ts`.
 *
 * Shape in Convex: each task is one **internalAction** (it calls a model, so it
 * cannot be a mutation) that
 *   1. gathers its brief through an internalQuery,
 *   2. opens a `runs` row (`kind: 'commissioner'`, `teamId` unset) hanging off a
 *      reused `type: 'commissioner'` window,
 *   3. calls `generateText`, or produces deterministic canned text for a
 *      `mock/*` model id (and on any provider failure, so a week's recap is
 *      never lost),
 *   4. records the step through `recordStep` below,
 *   5. publishes the `##` sections as `announcement` posts via
 *      `internal.forum.createPost`, and finishes the run.
 *
 * `recordStep` records the trace step and delegates the usage/rollup write to
 * `internal.ledger.recordStep` (the single ledger writer). Every usage /
 * rollup write in this file goes through that one function so the swap is a
 * one-line change.
 *
 * Runtime: this file stays in the **default Convex runtime** — `ai` 7 and
 * `@ai-sdk/gateway` 4 bundle and run there (no `setTimeout`, no dynamic
 * `import()` on the paths we use), so the queries and mutations below can live
 * beside the actions. If that ever regresses, add `"use node"` here and move
 * them out.
 */
import { createGateway } from "@ai-sdk/gateway";
import { generateText } from "ai";
import { v } from "convex/values";

import { findModel } from "../lib/models";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { stepUsage } from "./schema";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const COMMISSIONER_CONTEXT_MD = `# Fantasy Bench — League Commissioner

You are the platform-run commissioner of an AI-agent fantasy football league.
Every team in this league is played by a language model with its own public
configuration; the humans are owners who tune those configs and watch.

## Your job
- Write the weekly recap: what actually happened, who won, what was decided badly.
- Publish power rankings 1..N with one sentence of justification each.
- Hand out two or three awards with a wink.
- Explain trade fairness scores in plain English when asked.
- Write draft recaps and season-end awards.

## Your constraints
- You never take roster actions: no lineups, no waivers, no trades.
- You never read direct messages between teams.
- You never change a fairness score. The score is computed deterministically;
  you only narrate it.
- Everything you write is published to the league forum under your own name and
  is permanent. Be accurate first, entertaining second.
- Data you are given is the whole truth available to you. Never invent a stat, a
  score, or a transaction. If a number is missing, say so plainly.

## Style
Dry, specific, a little arch. Short paragraphs. No emoji. Refer to teams by name.
Use markdown with \`##\` headings for each section you are asked to produce.`;

export type CommissionerConfig = {
  modelId: string;
  displayName: string;
  contextMd: string;
  temperature: number;
  maxOutputTokens: number;
};

/** Pinned gateway id; `mock/*` runs the scripted path with no API key. */
export function commissionerConfig(): CommissionerConfig {
  return {
    modelId: process.env.COMMISSIONER_MODEL_ID ?? "anthropic/claude-sonnet-4.5",
    displayName: "Commissioner",
    contextMd: COMMISSIONER_CONTEXT_MD,
    temperature: 0.4,
    maxOutputTokens: 2000,
  };
}

/** Model ids that resolve to the scripted text (no gateway key needed). */
export function isScriptedModelId(modelId: string): boolean {
  return modelId.startsWith("mock/");
}

export type CommissionerTask =
  | "weekly_recap"
  | "trade_narrative"
  | "draft_recap"
  | "season_awards"
  | "flagged_trades_digest";

export type CommissionerResult = {
  task: CommissionerTask;
  runId: Id<"runs">;
  /** Forum posts published by this task, in order. */
  postIds: Id<"forum_posts">[];
  text: string;
  costUsd: number;
  /** True when the deterministic canned text was used (mock model or failure). */
  scripted: boolean;
};

const commissionerResultValidator = v.object({
  task: v.string(),
  runId: v.id("runs"),
  postIds: v.array(v.id("forum_posts")),
  text: v.string(),
  costUsd: v.number(),
  scripted: v.boolean(),
});

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Feed rows read for a weekly brief. */
const MAX_BRIEF_TRANSACTIONS = 200;
/** Trades read per brief. */
const MAX_BRIEF_TRADES = 100;
/** Draft picks read for the draft recap (12 teams × 16 rounds = 192). */
const MAX_DRAFT_PICKS = 300;
/** Posts scanned for "top forum posts". */
const MAX_TOP_POSTS = 20;
/** Weeks summed when `team_standings` has not been materialised yet. */
const MAX_WEEK = 22;

// ---------------------------------------------------------------------------
// Sections (port of `splitSections` / `defaultTitle`)
// ---------------------------------------------------------------------------

export type Section = { title: string; body: string };

/** Split markdown into `##` sections; the whole text becomes one section if none. */
export function splitSections(text: string, fallbackTitle: string): Section[] {
  const lines = text.split("\n");
  const sections: Section[] = [];
  let title: string | null = null;
  let buffer: string[] = [];

  const flush = () => {
    const body = buffer.join("\n").trim();
    if (title === null && body.length === 0) return;
    sections.push({ title: (title ?? fallbackTitle).slice(0, 200), body });
    buffer = [];
  };

  for (const line of lines) {
    const heading = /^##\s+(.*)$/.exec(line.trim());
    if (heading) {
      flush();
      title = heading[1].trim().replace(/\s*[—-]\s*$/, "");
      continue;
    }
    buffer.push(line);
  }
  flush();

  const withBody = sections.filter((s) => s.body.length > 0);
  if (withBody.length > 0) return withBody;
  return [{ title: fallbackTitle, body: text.trim() }];
}

function defaultTitle(task: CommissionerTask, weekNo: number | null): string {
  switch (task) {
    case "weekly_recap":
      return `Week ${weekNo ?? "?"} Report`;
    case "draft_recap":
      return "Draft Recap";
    case "season_awards":
      return "Season Awards";
    case "flagged_trades_digest":
      return "Flagged Trades";
    case "trade_narrative":
      return "Trade Review";
  }
}

// ---------------------------------------------------------------------------
// Usage bookkeeping (pricing lives in convex/ledger.ts)
// ---------------------------------------------------------------------------

export type CommissionerUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
};

export const EMPTY_USAGE: CommissionerUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  reasoningTokens: 0,
};

/** Normalize an AI SDK 7 usage object into the ledger's four counters. */
export function normalizeUsage(usage: unknown): CommissionerUsage {
  const u = (usage ?? {}) as {
    inputTokens?: number;
    outputTokens?: number;
    inputTokenDetails?: { cacheReadTokens?: number };
    outputTokenDetails?: { reasoningTokens?: number };
  };
  return {
    inputTokens: u.inputTokens ?? 0,
    outputTokens: u.outputTokens ?? 0,
    cachedInputTokens: u.inputTokenDetails?.cacheReadTokens ?? 0,
    reasoningTokens: u.outputTokenDetails?.reasoningTokens ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Run plumbing
// ---------------------------------------------------------------------------

/**
 * Open a commissioner run.
 *
 * `runs.windowId` is required, so commissioner tasks get their own
 * `type: 'commissioner'` window, reused per (league, label, week) exactly as the
 * Postgres version did. The window is created `closed`: nothing schedules it.
 *
 * Index: `windows.by_leagueId_label_weekNo_roundNo`, `.unique()`.
 */
export const startRun = internalMutation({
  args: {
    leagueId: v.id("leagues"),
    weekNo: v.union(v.null(), v.number()),
    label: v.string(),
    modelId: v.string(),
  },
  returns: v.object({
    runId: v.id("runs"),
    windowId: v.id("windows"),
    season: v.number(),
    startedAt: v.number(),
  }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const league = await ctx.db.get("leagues", args.leagueId);
    if (!league) throw new Error("League not found");
    const weekNo = args.weekNo ?? 0;

    const existing = await ctx.db
      .query("windows")
      .withIndex("by_leagueId_label_weekNo_roundNo", (q) =>
        q
          .eq("leagueId", args.leagueId)
          .eq("label", args.label)
          .eq("weekNo", weekNo)
          .eq("roundNo", 1),
      )
      .unique();
    const windowId =
      existing?._id ??
      (await ctx.db.insert("windows", {
        leagueId: args.leagueId,
        type: "commissioner",
        label: args.label,
        weekNo,
        roundNo: 1,
        opensAt: now,
        submissionDeadlineAt: now,
        closesAt: now,
        status: "closed",
        scope: {},
        runCount: 0,
        terminalRunCount: 0,
      }));

    const runId = await ctx.db.insert("runs", {
      windowId,
      leagueId: args.leagueId,
      modelId: args.modelId,
      kind: "commissioner",
      status: "running",
      windowType: "commissioner",
      windowLabel: args.label,
      weekNo,
      attempt: 1,
      lastPersistedStep: -1,
      startedAt: now,
      totalCostUsd: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      stepCount: 0,
      committedActionCount: 0,
      rejectedActionCount: 0,
    });

    const window = await ctx.db.get("windows", windowId);
    if (window) {
      await ctx.db.patch("windows", windowId, { runCount: window.runCount + 1 });
    }

    return { runId, windowId, season: league.season, startedAt: now };
  },
});

/**
 * Append one model call to the trace and price it.
 *
 * **Temporary.** Phase 4 replaces the body with a call to
 * `internal.ledger.recordStep`; every usage/rollup write in this file goes
 * through here so that is a one-line change. Idempotent on
 * `(runId, stepIndex)` via `usage_events.by_runId_stepIndex`.
 */
export const recordStep = internalMutation({
  args: {
    runId: v.id("runs"),
    leagueId: v.id("leagues"),
    season: v.number(),
    weekNo: v.number(),
    stepIndex: v.number(),
    modelId: v.string(),
    system: v.string(),
    prompt: v.string(),
    text: v.string(),
    usage: stepUsage,
    finishReason: v.optional(v.string()),
    latencyMs: v.optional(v.number()),
  },
  returns: v.object({ costUsd: v.number() }),
  // Explicit annotation: this mutation cross-calls `internal.ledger.recordStep`,
  // and without it the generated `api` type collapses to `any` (type cycle).
  handler: async (ctx, args): Promise<{ costUsd: number }> => {
    const already = await ctx.db
      .query("usage_events")
      .withIndex("by_runId_stepIndex", (q) =>
        q.eq("runId", args.runId).eq("stepIndex", args.stepIndex),
      )
      .unique();
    if (already) return { costUsd: already.costUsd };

    // The shared ledger is the only writer of usage_events and the rollups
    // (PRD 5.9); it runs in this same transaction.
    const { costUsd }: { costUsd: number } = await ctx.runMutation(internal.ledger.recordStep, {
      runId: args.runId,
      stepIndex: args.stepIndex,
      modelId: args.modelId,
      usage: {
        inputTokens: Math.max(0, Math.round(args.usage.inputTokens)),
        outputTokens: Math.max(0, Math.round(args.usage.outputTokens)),
        cachedInputTokens: Math.max(0, Math.round(args.usage.cachedInputTokens)),
        reasoningTokens: Math.max(0, Math.round(args.usage.reasoningTokens)),
      },
      ...(args.latencyMs !== undefined ? { latencyMs: args.latencyMs } : {}),
    });

    await ctx.db.insert("run_steps", {
      runId: args.runId,
      leagueId: args.leagueId,
      stepIndex: args.stepIndex,
      modelId: args.modelId,
      text: args.text,
      responseMessages: [
        { role: "system", content: args.system },
        { role: "user", content: args.prompt },
      ],
      toolCalls: [],
      toolResults: [],
      usage: args.usage,
      finishReason: args.finishReason ?? "stop",
      ...(args.latencyMs !== undefined ? { latencyMs: args.latencyMs } : {}),
      costUsd,
      bytes: args.text.length + args.prompt.length + args.system.length,
    });

    const run = await ctx.db.get("runs", args.runId);
    if (run) {
      await ctx.db.patch("runs", args.runId, {
        lastPersistedStep: Math.max(run.lastPersistedStep, args.stepIndex),
      });
    }
    return { costUsd };
  },
});

/** Terminal status, totals and the searchable trace document. */
export const finishRun = internalMutation({
  args: {
    runId: v.id("runs"),
    status: v.union(v.literal("succeeded"), v.literal("failed"), v.literal("fallback")),
    outcome: v.string(),
    usage: stepUsage,
    costUsd: v.number(),
    stepCount: v.number(),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const run = await ctx.db.get("runs", args.runId);
    if (!run) return null;
    await ctx.db.patch("runs", args.runId, {
      status: args.status,
      finishedAt: Date.now(),
      outcome: args.outcome,
      totalCostUsd: args.costUsd,
      totalInputTokens: args.usage.inputTokens,
      totalOutputTokens: args.usage.outputTokens,
      stepCount: args.stepCount,
      ...(args.error ? { error: args.error } : {}),
    });
    const window = await ctx.db.get("windows", run.windowId);
    if (window) {
      await ctx.db.patch("windows", run.windowId, {
        terminalRunCount: window.terminalRunCount + 1,
      });
    }
    return null;
  },
});

// ---------------------------------------------------------------------------
// Briefs (the "whole truth available to you")
// ---------------------------------------------------------------------------

type StandingRow = {
  teamId: string;
  team: string;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
};

async function loadTeamNames(
  ctx: QueryCtx,
  leagueId: Id<"leagues">,
): Promise<{ teams: Doc<"teams">[]; nameOf: (id: Id<"teams"> | undefined) => string }> {
  // Bounded: one league has at most `teamCount` (≤ 14) teams.
  const teams = await ctx.db
    .query("teams")
    .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
    .collect();
  const byId = new Map(teams.map((t) => [t._id as string, t.name]));
  return { teams, nameOf: (id) => (id ? (byId.get(id as string) ?? "Unknown") : "Unknown") };
}

/**
 * Standings for the brief. Prefers the `team_standings` rollup; falls back to
 * summing `team_results` week by week (bounded by `MAX_WEEK` index ranges) for a
 * league whose rollup has not been materialised yet.
 */
async function loadStandings(
  ctx: QueryCtx,
  league: Doc<"leagues">,
  teams: Doc<"teams">[],
): Promise<StandingRow[]> {
  const nameOf = new Map(teams.map((t) => [t._id as string, t.name]));
  const rollups = await ctx.db
    .query("team_standings")
    .withIndex("by_leagueId_season", (q) =>
      q.eq("leagueId", league._id).eq("season", league.season),
    )
    .take(teams.length || 20);
  if (rollups.length > 0) {
    return rollups
      .map((row) => ({
        teamId: row.teamId as string,
        team: nameOf.get(row.teamId as string) ?? "Unknown",
        wins: row.wins,
        losses: row.losses,
        ties: row.ties,
        pointsFor: Math.round(row.pointsFor * 100) / 100,
      }))
      .sort((a, b) => b.wins - a.wins || b.pointsFor - a.pointsFor);
  }

  const totals = new Map<string, StandingRow>();
  for (const team of teams) {
    totals.set(team._id as string, {
      teamId: team._id as string,
      team: team.name,
      wins: 0,
      losses: 0,
      ties: 0,
      pointsFor: 0,
    });
  }
  for (let week = 1; week <= MAX_WEEK; week++) {
    const rows = await ctx.db
      .query("team_results")
      .withIndex("by_leagueId_weekNo", (q) =>
        q.eq("leagueId", league._id).eq("weekNo", week),
      )
      .take(teams.length || 20);
    for (const row of rows) {
      const entry = totals.get(row.teamId as string);
      if (!entry) continue;
      if (row.won) entry.wins += 1;
      if (row.lost) entry.losses += 1;
      if (row.tied) entry.ties += 1;
      entry.pointsFor += row.pointsFor;
    }
  }
  return [...totals.values()]
    .map((row) => ({ ...row, pointsFor: Math.round(row.pointsFor * 100) / 100 }))
    .sort((a, b) => b.wins - a.wins || b.pointsFor - a.pointsFor);
}

/**
 * The week's brief: matchups, standings, transactions, trades, top forum posts.
 *
 * Indexes/bounds: `matchups.by_leagueId_weekNo` (≤ teams/2), `team_standings` /
 * `team_results` (see `loadStandings`), `transactions.by_leagueId` take 200,
 * `trades.by_leagueId_weekNo` take 100, `forum_posts.by_leagueId_score` take 20.
 */
export const weeklyBrief = internalQuery({
  args: { leagueId: v.id("leagues"), weekNo: v.number() },
  handler: async (ctx, args) => {
    const league = await ctx.db.get("leagues", args.leagueId);
    const { teams, nameOf } = await loadTeamNames(ctx, args.leagueId);

    const matchups = await ctx.db
      .query("matchups")
      .withIndex("by_leagueId_weekNo", (q) =>
        q.eq("leagueId", args.leagueId).eq("weekNo", args.weekNo),
      )
      .take(teams.length || 20);

    const standings = league ? await loadStandings(ctx, league, teams) : [];

    const feed = await ctx.db
      .query("transactions")
      .withIndex("by_leagueId", (q) => q.eq("leagueId", args.leagueId))
      .order("desc")
      .take(MAX_BRIEF_TRANSACTIONS);
    const weekFeed = feed.filter((row) => row.weekNo === args.weekNo);
    const transactions: Array<{
      team: string;
      type: string;
      player: string | null;
      with: string | null;
    }> = [];
    for (const row of weekFeed) {
      const player = row.playerId ? await ctx.db.get("players", row.playerId) : null;
      transactions.push({
        team: nameOf(row.teamId),
        type: row.type,
        player: player?.fullName ?? null,
        with: row.relatedTeamId ? nameOf(row.relatedTeamId) : null,
      });
    }

    const tradeRows = await ctx.db
      .query("trades")
      .withIndex("by_leagueId_weekNo", (q) =>
        q.eq("leagueId", args.leagueId).eq("weekNo", args.weekNo),
      )
      .take(MAX_BRIEF_TRADES);

    const topPosts = await ctx.db
      .query("forum_posts")
      .withIndex("by_leagueId_score", (q) => q.eq("leagueId", args.leagueId))
      .order("desc")
      .take(MAX_TOP_POSTS);

    return {
      leagueName: league?.name ?? "the league",
      data: {
        week: args.weekNo,
        teams: teams.map((t) => ({ name: t.name, karma: t.karma })),
        matchups: matchups.map((m) => ({
          home: nameOf(m.homeTeamId),
          away: nameOf(m.awayTeamId),
          homeScore: m.homeScore ?? 0,
          awayScore: m.awayScore ?? 0,
          final: m.isFinal,
        })),
        standings,
        transactions,
        trades: tradeRows.map((t) => ({
          proposer: nameOf(t.proposerTeamId),
          recipient: nameOf(t.recipientTeamId),
          status: t.status,
          fairness: t.fairnessScore ?? null,
        })),
        topForumPosts: topPosts
          .filter((p) => !p.hidden)
          .slice(0, 5)
          .map((p) => ({
            title: p.title,
            score: p.score,
            team: p.teamId ? nameOf(p.teamId) : "Commissioner",
          })),
      },
    };
  },
});

/** One trade, shaped for the narrative prompt. */
export const tradeBrief = internalQuery({
  args: { tradeId: v.id("trades") },
  handler: async (ctx, args) => {
    const trade = await ctx.db.get("trades", args.tradeId);
    if (!trade) return null;
    const { nameOf } = await loadTeamNames(ctx, trade.leagueId);

    const items: Array<{
      player: string | null;
      position: string | null;
      faab: number | null;
      from: string;
      to: string;
    }> = [];
    for (const item of trade.items) {
      const player = item.playerId ? await ctx.db.get("players", item.playerId) : null;
      items.push({
        player: player?.fullName ?? null,
        position: player?.position ?? null,
        faab: item.faab ?? null,
        from: nameOf(item.fromTeamId),
        to: nameOf(item.toTeamId),
      });
    }

    return {
      leagueId: trade.leagueId,
      weekNo: trade.weekNo,
      data: {
        proposer: nameOf(trade.proposerTeamId),
        recipient: nameOf(trade.recipientTeamId),
        status: trade.status,
        fairnessScore: trade.fairnessScore ?? null,
        flagged: trade.flagged,
        fairnessDetail: trade.fairnessDetail ?? null,
        items,
      },
    };
  },
});

/** Every draft pick on record. Index: `transactions.by_leagueId`, take 300. */
export const draftBrief = internalQuery({
  args: { leagueId: v.id("leagues") },
  handler: async (ctx, args) => {
    const league = await ctx.db.get("leagues", args.leagueId);
    const { nameOf } = await loadTeamNames(ctx, args.leagueId);
    const rows = await ctx.db
      .query("transactions")
      .withIndex("by_leagueId", (q) => q.eq("leagueId", args.leagueId))
      .take(MAX_DRAFT_PICKS);

    const picks: Array<{
      team: string;
      player: string | null;
      position: string | null;
      details: unknown;
    }> = [];
    for (const row of rows) {
      if (row.type !== "draft") continue;
      const player = row.playerId ? await ctx.db.get("players", row.playerId) : null;
      picks.push({
        team: nameOf(row.teamId),
        player: player?.fullName ?? null,
        position: player?.position ?? null,
        details: row.details ?? null,
      });
    }
    return { league: league?.name ?? "League", picks };
  },
});

/** Season standings plus the completed-trade spread. */
export const seasonBrief = internalQuery({
  args: { leagueId: v.id("leagues") },
  handler: async (ctx, args) => {
    const league = await ctx.db.get("leagues", args.leagueId);
    const { teams } = await loadTeamNames(ctx, args.leagueId);
    const standings = league ? await loadStandings(ctx, league, teams) : [];
    const completed = await ctx.db
      .query("trades")
      .withIndex("by_leagueId_status", (q) =>
        q.eq("leagueId", args.leagueId).eq("status", "completed"),
      )
      .take(MAX_BRIEF_TRADES);
    return {
      league: league?.name ?? "League",
      season: league?.season ?? null,
      standings,
      completedTrades: completed.length,
      fairnessSpread: completed
        .map((t) => t.fairnessScore ?? null)
        .filter((s): s is number => s !== null),
    };
  },
});

/** Flagged trades owners may still act on. One index range per status, take 20. */
export const flaggedBrief = internalQuery({
  args: { leagueId: v.id("leagues") },
  handler: async (ctx, args) => {
    const { nameOf } = await loadTeamNames(ctx, args.leagueId);
    const rows: Doc<"trades">[] = [];
    for (const status of ["in_review", "vetoed", "completed"] as const) {
      const page = await ctx.db
        .query("trades")
        .withIndex("by_leagueId_status", (q) =>
          q.eq("leagueId", args.leagueId).eq("status", status),
        )
        .order("desc")
        .take(MAX_TOP_POSTS);
      rows.push(...page.filter((t) => t.flagged));
    }
    return {
      flagged: rows
        .sort((a, b) => b._creationTime - a._creationTime)
        .slice(0, 20)
        .map((t) => ({
          id: t._id as string,
          proposer: nameOf(t.proposerTeamId),
          recipient: nameOf(t.recipientTeamId),
          status: t.status,
          fairnessScore: t.fairnessScore ?? null,
          reviewEndsAt: t.reviewEndsAt ?? null,
        })),
    };
  },
});

// ---------------------------------------------------------------------------
// Scripted text (no gateway key needed; also the failure fallback)
// ---------------------------------------------------------------------------

type WeeklyData = {
  matchups: Array<{ home: string; away: string; homeScore: number; awayScore: number }>;
  standings: StandingRow[];
  trades: Array<{ proposer: string; recipient: string; status: string }>;
};

function scriptedWeeklyRecap(
  leagueName: string,
  data: WeeklyData,
  weekNo: number,
): string {
  const lines: string[] = [];
  lines.push(`## Week ${weekNo} Recap`);
  lines.push("");
  if (data.matchups.length === 0) {
    lines.push(`No matchups are on record for week ${weekNo} in ${leagueName}.`);
  } else {
    for (const m of data.matchups) {
      const winner = m.homeScore >= m.awayScore ? m.home : m.away;
      lines.push(`- ${m.home} ${m.homeScore} — ${m.awayScore} ${m.away}. ${winner} takes it.`);
    }
  }
  lines.push("");
  lines.push("## Power Rankings");
  lines.push("");
  data.standings.forEach((s, index) => {
    lines.push(`${index + 1}. **${s.team}** (${s.wins}-${s.losses}, ${s.pointsFor} PF)`);
  });
  if (data.standings.length === 0) lines.push("No results recorded yet.");
  lines.push("");
  lines.push("## Awards");
  lines.push("");
  lines.push(
    `- **Busiest desk**: ${data.trades.length} trade${data.trades.length === 1 ? "" : "s"} touched week ${weekNo}.`,
  );
  lines.push(`- **Top of the pile**: ${data.standings[0]?.team ?? "nobody yet"} leads the table.`);
  return lines.join("\n");
}

function scriptedTradeNarrative(data: {
  proposer: string;
  recipient: string;
  fairnessScore: number | null;
  flagged: boolean;
}): string {
  const score = data.fairnessScore ?? 0;
  return [
    `${data.proposer} and ${data.recipient} agreed a deal scoring ${score.toFixed(2)} on the`,
    `rest-of-season fairness scale. ${
      data.flagged
        ? "That is under the league's fairness floor, so the trade is flagged and owners may vote to veto it before the review window closes."
        : "That clears the league's fairness floor, so it processes automatically at the end of the review window."
    }`,
    "The score compares each side's projected rest-of-season value after positional scarcity and roster fit; it is computed deterministically and this note does not change it.",
  ].join(" ");
}

function scriptedDraftRecap(data: { league: string; picks: unknown[] }): string {
  return [
    "## Draft Recap",
    "",
    `${data.picks.length} picks are on record for ${data.league}.`,
    "",
    "## Best and Worst Picks",
    "",
    "- Judgement reserved until the results are in.",
  ].join("\n");
}

function scriptedSeasonAwards(data: {
  standings: StandingRow[];
  completedTrades: number;
}): string {
  return [
    "## Season Awards",
    "",
    `- **Champion of the regular season**: the top of the table after ${data.standings.length} teams' worth of results.`,
    `- **Dealmaker**: ${data.completedTrades} trade${data.completedTrades === 1 ? "" : "s"} completed this season.`,
  ].join("\n");
}

function scriptedFlaggedDigest(data: { flagged: unknown[] }): string {
  if (data.flagged.length === 0) {
    return ["## Flagged Trades", "", "No trades are currently flagged."].join("\n");
  }
  return [
    "## Flagged Trades",
    "",
    `${data.flagged.length} trade${data.flagged.length === 1 ? " is" : "s are"} flagged. Owners: a majority veto blocks a flagged trade before its review window closes.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

type PublishSpec = { title: string; body: string; flair: "announcement" };

async function runTask(
  ctx: ActionCtx,
  args: {
    task: CommissionerTask;
    leagueId: Id<"leagues">;
    weekNo: number | null;
    label: string;
    prompt: string;
    scripted: () => string;
    publish: (sections: Section[]) => PublishSpec[];
  },
): Promise<CommissionerResult> {
  const config = commissionerConfig();
  const modelId = config.modelId;
  const run = await ctx.runMutation(internal.commissioner_agent.startRun, {
    leagueId: args.leagueId,
    weekNo: args.weekNo,
    label: args.label,
    modelId,
  });

  let text = "";
  let usage: CommissionerUsage = { ...EMPTY_USAGE };
  let scripted = false;
  let finishReason = "stop";
  let error: string | null = null;
  const startedAt = Date.now();

  if (isScriptedModelId(modelId)) {
    // `mock/*` never calls a provider: deterministic text, still fully traced.
    text = args.scripted();
    scripted = true;
    finishReason = "scripted";
  } else {
    try {
      const gateway = createGateway({ apiKey: process.env.AI_GATEWAY_API_KEY });
      const result = await generateText({
        model: gateway(modelId),
        system: config.contextMd,
        prompt: args.prompt,
        temperature: config.temperature,
        maxOutputTokens: config.maxOutputTokens,
      });
      text = result.text;
      usage = normalizeUsage(result.usage);
      finishReason = result.finishReason ?? "stop";
    } catch (err) {
      // A missing gateway key or a provider outage must not lose the week's
      // recap: fall back to the deterministic text and record why.
      text = args.scripted();
      scripted = true;
      finishReason = "fallback";
      error = err instanceof Error ? err.message : String(err);
    }
  }

  if (text.trim().length === 0) {
    text = args.scripted();
    scripted = true;
  }

  const usageDoc = {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.inputTokens + usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    reasoningTokens: usage.reasoningTokens,
  };

  const { costUsd } = await ctx.runMutation(internal.commissioner_agent.recordStep, {
    runId: run.runId,
    leagueId: args.leagueId,
    season: run.season,
    weekNo: args.weekNo ?? 0,
    stepIndex: 0,
    modelId,
    system: config.contextMd,
    prompt: args.prompt,
    text,
    usage: usageDoc,
    finishReason,
    latencyMs: Date.now() - startedAt,
  });

  const postIds: Id<"forum_posts">[] = [];
  const sections = splitSections(text, defaultTitle(args.task, args.weekNo));
  const specs = args.publish(sections);
  for (const [index, spec] of specs.entries()) {
    const result = await ctx.runMutation(internal.forum.createPost, {
      leagueId: args.leagueId,
      teamId: null,
      title: spec.title,
      body: spec.body,
      flair: spec.flair,
      // The commissioner's run context: no config version, and the window is the
      // commissioner window opened for this task. The run id is what the
      // published post links back to.
      agentCtx: {
        runId: run.runId,
        stepIndex: 0,
        toolCallId: `commissioner:${args.task}:${index}`,
        windowId: run.windowId,
        weekNo: args.weekNo ?? 0,
      },
    });
    if (result.ok) postIds.push(result.postId);
  }

  await ctx.runMutation(internal.commissioner_agent.finishRun, {
    runId: run.runId,
    status: error ? "fallback" : "succeeded",
    outcome: error ? `${args.task}_fallback` : `${args.task}:${postIds.length}_posts`,
    usage: usageDoc,
    costUsd,
    stepCount: 1,
    ...(error ? { error } : {}),
  });
  await ctx.runMutation(internal.runs.upsertSearchDoc, { runId: run.runId });

  return { task: args.task, runId: run.runId, postIds, text, costUsd, scripted };
}

const announcement = (sections: Section[]): PublishSpec[] =>
  sections.map((section) => ({
    title: section.title,
    body: section.body,
    flair: "announcement" as const,
  }));

// ---------------------------------------------------------------------------
// The tasks
// ---------------------------------------------------------------------------

/** Recap + power rankings + awards, published as `announcement` posts. */
export const weeklyRecap = internalAction({
  args: { leagueId: v.id("leagues"), weekNo: v.number() },
  returns: commissionerResultValidator,
  handler: async (ctx, args): Promise<CommissionerResult> => {
    const brief = await ctx.runQuery(internal.commissioner_agent.weeklyBrief, args);
    return runTask(ctx, {
      task: "weekly_recap",
      leagueId: args.leagueId,
      weekNo: args.weekNo,
      label: `commissioner_weekly_${args.weekNo}`,
      prompt: [
        `Write the week ${args.weekNo} report for ${brief.leagueName}.`,
        "",
        "Produce exactly three markdown sections, each introduced by a `##` heading:",
        `## Week ${args.weekNo} Recap — what happened, two or three paragraphs.`,
        "## Power Rankings — a numbered list of every team with one sentence each.",
        "## Awards — two or three awards with a one-line justification.",
        "",
        "League data (the whole truth available to you):",
        "```json",
        JSON.stringify(brief.data, null, 2),
        "```",
      ].join("\n"),
      scripted: () =>
        scriptedWeeklyRecap(brief.leagueName, brief.data as WeeklyData, args.weekNo),
      publish: announcement,
    });
  },
});

/**
 * A one-paragraph narrative for a trade's already-computed fairness score.
 * Saved to `fairnessDetail.narrative`; the number never moves.
 *
 * Scheduled (best effort) by `trades.respond` on accept.
 */
export const tradeNarrative = internalAction({
  args: { tradeId: v.id("trades") },
  returns: v.union(v.null(), commissionerResultValidator),
  handler: async (ctx, args): Promise<CommissionerResult | null> => {
    const brief = await ctx.runQuery(internal.commissioner_agent.tradeBrief, args);
    if (!brief) return null;

    const result = await runTask(ctx, {
      task: "trade_narrative",
      leagueId: brief.leagueId,
      weekNo: brief.weekNo,
      label: `commissioner_trade_${(args.tradeId as string).slice(0, 8)}`,
      prompt: [
        "Explain this trade's fairness score in one paragraph for the league.",
        "The score is computed deterministically from rest-of-season projections,",
        "positional scarcity and roster fit. Do not propose a different number;",
        "explain what drove the one you are given, and say plainly whether the",
        "package looks lopsided.",
        "",
        "```json",
        JSON.stringify(brief.data, null, 2),
        "```",
      ].join("\n"),
      scripted: () => scriptedTradeNarrative(brief.data),
      publish: () => [],
    });

    await ctx.runMutation(internal.trades.attachNarrative, {
      tradeId: args.tradeId,
      narrative: result.text.trim(),
    });
    return result;
  },
});

export const draftRecap = internalAction({
  args: { leagueId: v.id("leagues") },
  returns: commissionerResultValidator,
  handler: async (ctx, args): Promise<CommissionerResult> => {
    const brief = await ctx.runQuery(internal.commissioner_agent.draftBrief, args);
    return runTask(ctx, {
      task: "draft_recap",
      leagueId: args.leagueId,
      weekNo: null,
      label: "commissioner_draft_recap",
      prompt: [
        "Write the draft recap. Two markdown sections:",
        "## Draft Recap — the shape of the draft, who chased whom.",
        "## Best and Worst Picks — three of each, one line apiece.",
        "",
        "```json",
        JSON.stringify(brief, null, 2),
        "```",
      ].join("\n"),
      scripted: () => scriptedDraftRecap(brief),
      publish: announcement,
    });
  },
});

export const seasonAwards = internalAction({
  args: { leagueId: v.id("leagues") },
  returns: commissionerResultValidator,
  handler: async (ctx, args): Promise<CommissionerResult> => {
    const brief = await ctx.runQuery(internal.commissioner_agent.seasonBrief, args);
    return runTask(ctx, {
      task: "season_awards",
      leagueId: args.leagueId,
      weekNo: null,
      label: "commissioner_season_awards",
      prompt: [
        "Write the season-ending awards. One markdown section:",
        "## Season Awards — five awards, each with a winner and one line of justification.",
        "",
        "```json",
        JSON.stringify(brief, null, 2),
        "```",
      ].join("\n"),
      scripted: () => scriptedSeasonAwards(brief),
      publish: announcement,
    });
  },
});

/** Publishes the open flagged trades so owners know a veto vote is live. */
export const flaggedTradesDigest = internalAction({
  args: { leagueId: v.id("leagues") },
  returns: commissionerResultValidator,
  handler: async (ctx, args): Promise<CommissionerResult> => {
    const brief = await ctx.runQuery(internal.commissioner_agent.flaggedBrief, args);
    return runTask(ctx, {
      task: "flagged_trades_digest",
      leagueId: args.leagueId,
      weekNo: null,
      label: "commissioner_flagged_digest",
      prompt: [
        "Write the flagged-trade digest. One markdown section:",
        "## Flagged Trades — one bullet per trade: the teams, the score, and what",
        "owners need to do (a majority veto blocks a flagged trade before its",
        "review period ends).",
        "",
        "```json",
        JSON.stringify(brief, null, 2),
        "```",
      ].join("\n"),
      scripted: () => scriptedFlaggedDigest(brief),
      publish: announcement,
    });
  },
});

/**
 * What the weekly tick runs (Phase 5 wires the trigger): the recap, then the
 * flagged-trade digest when it has anything to say.
 */
export const runWeekly = internalAction({
  args: { leagueId: v.id("leagues"), weekNo: v.number() },
  returns: v.array(commissionerResultValidator),
  handler: async (ctx, args): Promise<CommissionerResult[]> => {
    const results: CommissionerResult[] = [];
    results.push(
      await ctx.runAction(internal.commissioner_agent.weeklyRecap, {
        leagueId: args.leagueId,
        weekNo: args.weekNo,
      }),
    );
    const digest = await ctx.runAction(internal.commissioner_agent.flaggedTradesDigest, {
      leagueId: args.leagueId,
    });
    if (digest.postIds.length > 0) results.push(digest);
    return results;
  },
});
