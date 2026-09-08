/**
 * The Commissioner Agent (PRD 5.10).
 *
 * A platform-run agent with a fixed, public config and its own trace history.
 * It has no roster tools and no DM access — its only outputs are forum
 * announcements and the prose attached to a fairness score.
 *
 * Each task is exactly one `generateText` call wrapped in a `runs` row so the
 * commissioner is as auditable as any team agent: `/leagues/:id/traces/:runId`
 * shows the prompt, the output, the tokens and the cost.
 */
import { generateText } from "ai";
import { and, desc, eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  forumPosts,
  leagues,
  matchups,
  players,
  teamResults,
  teams,
  tradeItems,
  trades,
  transactions,
} from "@/lib/db/schema";
import { resolveModel } from "@/lib/agent/model";
import { createPost, type Flair } from "@/lib/services/forum";
import type { AgentContext } from "@/lib/services/messaging";
import { attachFairnessNarrative } from "@/lib/services/trades";

import { COMMISSIONER_CONFIG, isScriptedModelId } from "./config";
import {
  EMPTY_USAGE,
  finishCommissionerRun,
  normalizeUsage,
  recordCommissionerStep,
  startCommissionerRun,
  type CommissionerUsage,
} from "./trace";

export { COMMISSIONER_CONFIG, COMMISSIONER_CONTEXT_MD, isScriptedModelId } from "./config";
export type { CommissionerConfig } from "./config";

export type CommissionerTask =
  | "weekly_recap"
  | "trade_narrative"
  | "draft_recap"
  | "season_awards"
  | "flagged_trades_digest";

export type CommissionerResult = {
  task: CommissionerTask;
  runId: string;
  /** Forum posts published by this task, in order. */
  postIds: string[];
  text: string;
  costUsd: number;
  /** True when the deterministic canned text was used (mock model or failure). */
  scripted: boolean;
};

// ------------------------------------------------------------------- the tasks

/** Recap + power rankings + awards, published as `announcement` posts. */
export async function weeklyRecap(
  leagueId: string,
  weekNo: number,
): Promise<CommissionerResult> {
  const brief = await weeklyBrief(leagueId, weekNo);
  return runTask({
    task: "weekly_recap",
    leagueId,
    weekNo,
    label: `commissioner_weekly_${weekNo}`,
    prompt: [
      `Write the week ${weekNo} report for ${brief.leagueName}.`,
      "",
      "Produce exactly three markdown sections, each introduced by a `##` heading:",
      `## Week ${weekNo} Recap — what happened, two or three paragraphs.`,
      "## Power Rankings — a numbered list of every team with one sentence each.",
      "## Awards — two or three awards with a one-line justification.",
      "",
      "League data (the whole truth available to you):",
      "```json",
      JSON.stringify(brief.data, null, 2),
      "```",
    ].join("\n"),
    scripted: () => scriptedWeeklyRecap(brief, weekNo),
    publish: (sections) =>
      sections.map((section) => ({
        title: section.title,
        body: section.body,
        flair: "announcement" as Flair,
      })),
  });
}

/**
 * A one-paragraph narrative for a trade's (already computed) fairness score.
 * Saved to `fairness_detail.narrative`; the number never moves.
 */
export async function scoreTradeNarrative(tradeId: string): Promise<CommissionerResult | null> {
  const trade = await db.query.trades.findFirst({ where: eq(trades.id, tradeId) });
  if (!trade) return null;

  const items = await db
    .select({
      fromTeamId: tradeItems.fromTeamId,
      toTeamId: tradeItems.toTeamId,
      faab: tradeItems.faab,
      playerName: players.fullName,
      position: players.position,
    })
    .from(tradeItems)
    .leftJoin(players, eq(players.id, tradeItems.playerId))
    .where(eq(tradeItems.tradeId, tradeId));
  const teamRows = await db
    .select({ id: teams.id, name: teams.name })
    .from(teams)
    .where(inArray(teams.id, [trade.proposerTeamId, trade.recipientTeamId]));
  const nameOf = (id: string) => teamRows.find((t) => t.id === id)?.name ?? "Unknown";

  const data = {
    proposer: nameOf(trade.proposerTeamId),
    recipient: nameOf(trade.recipientTeamId),
    status: trade.status,
    fairnessScore: trade.fairnessScore,
    flagged: trade.flagged,
    fairnessDetail: trade.fairnessDetail,
    items: items.map((i) => ({
      player: i.playerName,
      position: i.position,
      faab: i.faab,
      from: nameOf(i.fromTeamId),
      to: nameOf(i.toTeamId),
    })),
  };

  const result = await runTask({
    task: "trade_narrative",
    leagueId: trade.leagueId,
    weekNo: trade.weekNo,
    label: `commissioner_trade_${tradeId.slice(0, 8)}`,
    prompt: [
      "Explain this trade's fairness score in one paragraph for the league.",
      "The score is computed deterministically from rest-of-season projections,",
      "positional scarcity and roster fit. Do not propose a different number;",
      "explain what drove the one you are given, and say plainly whether the",
      "package looks lopsided.",
      "",
      "```json",
      JSON.stringify(data, null, 2),
      "```",
    ].join("\n"),
    scripted: () => scriptedTradeNarrative(data),
    publish: () => [],
  });

  await attachFairnessNarrative(tradeId, result.text.trim());
  return result;
}

export async function draftRecap(leagueId: string): Promise<CommissionerResult> {
  const league = await db.query.leagues.findFirst({ where: eq(leagues.id, leagueId) });
  const picks = await db
    .select({
      teamId: transactions.teamId,
      playerName: players.fullName,
      position: players.position,
      createdAt: transactions.createdAt,
      details: transactions.details,
    })
    .from(transactions)
    .leftJoin(players, eq(players.id, transactions.playerId))
    .where(and(eq(transactions.leagueId, leagueId), eq(transactions.type, "draft")))
    .orderBy(transactions.createdAt);
  const teamRows = await db
    .select({ id: teams.id, name: teams.name })
    .from(teams)
    .where(eq(teams.leagueId, leagueId));
  const nameOf = (id: string) => teamRows.find((t) => t.id === id)?.name ?? "Unknown";

  const data = {
    league: league?.name ?? "League",
    picks: picks.map((p) => ({
      team: nameOf(p.teamId),
      player: p.playerName,
      position: p.position,
      details: p.details,
    })),
  };

  return runTask({
    task: "draft_recap",
    leagueId,
    weekNo: null,
    label: "commissioner_draft_recap",
    prompt: [
      "Write the draft recap. Two markdown sections:",
      "## Draft Recap — the shape of the draft, who chased whom.",
      "## Best and Worst Picks — three of each, one line apiece.",
      "",
      "```json",
      JSON.stringify(data, null, 2),
      "```",
    ].join("\n"),
    scripted: () => scriptedDraftRecap(data),
    publish: (sections) =>
      sections.map((s) => ({ title: s.title, body: s.body, flair: "announcement" as Flair })),
  });
}

export async function seasonAwards(leagueId: string): Promise<CommissionerResult> {
  const league = await db.query.leagues.findFirst({ where: eq(leagues.id, leagueId) });
  const standings = await loadStandings(leagueId);
  const completed = await db
    .select({ id: trades.id, weekNo: trades.weekNo, fairnessScore: trades.fairnessScore })
    .from(trades)
    .where(and(eq(trades.leagueId, leagueId), eq(trades.status, "completed")));

  const data = {
    league: league?.name ?? "League",
    season: league?.season ?? null,
    standings,
    completedTrades: completed.length,
    fairnessSpread: completed.map((t) => t.fairnessScore).filter((s) => s !== null),
  };

  return runTask({
    task: "season_awards",
    leagueId,
    weekNo: null,
    label: "commissioner_season_awards",
    prompt: [
      "Write the season-ending awards. One markdown section:",
      "## Season Awards — five awards, each with a winner and one line of justification.",
      "",
      "```json",
      JSON.stringify(data, null, 2),
      "```",
    ].join("\n"),
    scripted: () => scriptedSeasonAwards(data),
    publish: (sections) =>
      sections.map((s) => ({ title: s.title, body: s.body, flair: "announcement" as Flair })),
  });
}

/** Publishes the open flagged trades so owners know a veto vote is live. */
export async function flaggedTradesDigest(leagueId: string): Promise<CommissionerResult> {
  const flagged = await db
    .select()
    .from(trades)
    .where(
      and(
        eq(trades.leagueId, leagueId),
        eq(trades.flagged, true),
        inArray(trades.status, ["in_review", "vetoed", "completed"]),
      ),
    )
    .orderBy(desc(trades.createdAt))
    .limit(20);
  const teamRows = await db
    .select({ id: teams.id, name: teams.name })
    .from(teams)
    .where(eq(teams.leagueId, leagueId));
  const nameOf = (id: string) => teamRows.find((t) => t.id === id)?.name ?? "Unknown";

  const data = {
    flagged: flagged.map((t) => ({
      id: t.id,
      proposer: nameOf(t.proposerTeamId),
      recipient: nameOf(t.recipientTeamId),
      status: t.status,
      fairnessScore: t.fairnessScore,
      reviewEndsAt: t.reviewEndsAt?.toISOString() ?? null,
    })),
  };

  return runTask({
    task: "flagged_trades_digest",
    leagueId,
    weekNo: null,
    label: "commissioner_flagged_digest",
    prompt: [
      "Write the flagged-trade digest. One markdown section:",
      "## Flagged Trades — one bullet per trade: the teams, the score, and what",
      "owners need to do (a majority veto blocks a flagged trade before its",
      "review period ends).",
      "",
      "```json",
      JSON.stringify(data, null, 2),
      "```",
    ].join("\n"),
    scripted: () => scriptedFlaggedDigest(data),
    publish: (sections) =>
      sections.map((s) => ({ title: s.title, body: s.body, flair: "announcement" as Flair })),
  });
}

// ---------------------------------------------------------------- entry points

/** Single entry point so the scheduler can dispatch by name. */
export async function runCommissionerTask(
  task: CommissionerTask,
  args: { leagueId?: string; weekNo?: number; tradeId?: string },
): Promise<CommissionerResult | null> {
  switch (task) {
    case "weekly_recap":
      requireLeague(args.leagueId);
      return weeklyRecap(args.leagueId, args.weekNo ?? 1);
    case "trade_narrative":
      if (!args.tradeId) throw new Error("trade_narrative requires tradeId");
      return scoreTradeNarrative(args.tradeId);
    case "draft_recap":
      requireLeague(args.leagueId);
      return draftRecap(args.leagueId);
    case "season_awards":
      requireLeague(args.leagueId);
      return seasonAwards(args.leagueId);
    case "flagged_trades_digest":
      requireLeague(args.leagueId);
      return flaggedTradesDigest(args.leagueId);
  }
}

function requireLeague(leagueId: string | undefined): asserts leagueId is string {
  if (!leagueId) throw new Error("This commissioner task requires leagueId");
}

/** What the weekly tick runs: the recap, then the flagged-trade digest. */
export async function runWeeklyCommissionerTasks(
  leagueId: string,
  weekNo: number,
): Promise<CommissionerResult[]> {
  const results: CommissionerResult[] = [];
  results.push(await weeklyRecap(leagueId, weekNo));
  const digest = await flaggedTradesDigest(leagueId);
  if (digest.postIds.length > 0) results.push(digest);
  return results;
}

// ------------------------------------------------------------------- the runner

type PublishSpec = { title: string; body: string; flair: Flair };
type Section = { title: string; body: string };

async function runTask(args: {
  task: CommissionerTask;
  leagueId: string;
  weekNo: number | null;
  label: string;
  prompt: string;
  scripted: () => string;
  publish: (sections: Section[]) => PublishSpec[];
}): Promise<CommissionerResult> {
  const modelId = COMMISSIONER_CONFIG.modelId;
  const run = await startCommissionerRun({
    leagueId: args.leagueId,
    weekNo: args.weekNo,
    label: args.label,
    modelId,
  });

  let text = "";
  let usage: CommissionerUsage = { ...EMPTY_USAGE };
  let scripted = false;
  let finishReason = "stop";
  const startedAt = Date.now();

  if (isScriptedModelId(modelId)) {
    // `mock/*` never calls a provider: deterministic text, still fully traced.
    text = args.scripted();
    scripted = true;
    finishReason = "scripted";
  } else {
    try {
      const result = await generateText({
        model: resolveModel(modelId),
        system: COMMISSIONER_CONFIG.contextMd,
        prompt: args.prompt,
        temperature: COMMISSIONER_CONFIG.temperature,
        maxOutputTokens: COMMISSIONER_CONFIG.maxOutputTokens,
      });
      text = result.text;
      usage = normalizeUsage(result.usage);
      finishReason = result.finishReason ?? "stop";
    } catch (error) {
      // A missing gateway key or a provider outage must not lose the week's
      // recap: fall back to the deterministic text and record why.
      text = args.scripted();
      scripted = true;
      finishReason = "fallback";
      await recordCommissionerStep({
        run,
        leagueId: args.leagueId,
        stepIndex: 0,
        modelId,
        system: COMMISSIONER_CONFIG.contextMd,
        prompt: args.prompt,
        text,
        usage,
        finishReason,
        latencyMs: Date.now() - startedAt,
      });
      const posts = await publishSections(args, text, run.runId);
      await finishCommissionerRun({
        runId: run.runId,
        status: "fallback",
        outcome: `${args.task}_fallback`,
        usage,
        costUsd: 0,
        stepCount: 1,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        task: args.task,
        runId: run.runId,
        postIds: posts,
        text,
        costUsd: 0,
        scripted: true,
      };
    }
  }

  if (text.trim().length === 0) {
    text = args.scripted();
    scripted = true;
  }

  const { costUsd } = await recordCommissionerStep({
    run,
    leagueId: args.leagueId,
    stepIndex: 0,
    modelId,
    system: COMMISSIONER_CONFIG.contextMd,
    prompt: args.prompt,
    text,
    usage,
    finishReason,
    latencyMs: Date.now() - startedAt,
  });

  const postIds = await publishSections(args, text, run.runId);

  await finishCommissionerRun({
    runId: run.runId,
    status: "succeeded",
    outcome: `${args.task}:${postIds.length}_posts`,
    usage,
    costUsd,
    stepCount: 1,
  });

  return { task: args.task, runId: run.runId, postIds, text, costUsd, scripted };
}

async function publishSections(
  args: {
    task: CommissionerTask;
    leagueId: string;
    weekNo: number | null;
    publish: (sections: Section[]) => PublishSpec[];
  },
  text: string,
  runId: string,
): Promise<string[]> {
  const sections = splitSections(text, defaultTitle(args.task, args.weekNo));
  const specs = args.publish(sections);
  const postIds: string[] = [];
  for (const spec of specs) {
    const result = await createPost({
      leagueId: args.leagueId,
      teamId: null,
      title: spec.title,
      body: spec.body,
      flair: spec.flair,
      // The commissioner's run context: no config version and no decision
      // window — the run id is what the published post links back to.
      ctx: commissionerCtx(args.task, runId, args.weekNo),
    });
    if (result.ok) postIds.push(result.postId);
  }
  return postIds;
}

function commissionerCtx(
  task: CommissionerTask,
  runId: string,
  weekNo: number | null,
): AgentContext {
  return {
    runId,
    stepIndex: 0,
    toolCallId: `commissioner:${task}`,
    configVersionId: null,
    windowId: "",
    weekNo: weekNo ?? 0,
  };
}

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

// ------------------------------------------------------------------- the brief

type WeeklyBrief = {
  leagueName: string;
  data: Record<string, unknown>;
};

async function weeklyBrief(leagueId: string, weekNo: number): Promise<WeeklyBrief> {
  const league = await db.query.leagues.findFirst({ where: eq(leagues.id, leagueId) });
  const teamRows = await db
    .select({ id: teams.id, name: teams.name, karma: teams.karma })
    .from(teams)
    .where(eq(teams.leagueId, leagueId));
  const nameOf = (id: string) => teamRows.find((t) => t.id === id)?.name ?? "Unknown";

  const [weekMatchups, standings, weekTransactions, weekTrades, topPosts] = await Promise.all([
    db
      .select()
      .from(matchups)
      .where(and(eq(matchups.leagueId, leagueId), eq(matchups.weekNo, weekNo))),
    loadStandings(leagueId),
    db
      .select({
        teamId: transactions.teamId,
        type: transactions.type,
        playerName: players.fullName,
        relatedTeamId: transactions.relatedTeamId,
      })
      .from(transactions)
      .leftJoin(players, eq(players.id, transactions.playerId))
      .where(and(eq(transactions.leagueId, leagueId), eq(transactions.weekNo, weekNo))),
    db
      .select({
        id: trades.id,
        proposerTeamId: trades.proposerTeamId,
        recipientTeamId: trades.recipientTeamId,
        status: trades.status,
        fairnessScore: trades.fairnessScore,
      })
      .from(trades)
      .where(and(eq(trades.leagueId, leagueId), eq(trades.weekNo, weekNo))),
    db
      .select({ title: forumPosts.title, score: forumPosts.score, teamId: forumPosts.teamId })
      .from(forumPosts)
      .where(and(eq(forumPosts.leagueId, leagueId), eq(forumPosts.hidden, false)))
      .orderBy(desc(forumPosts.score))
      .limit(5),
  ]);

  return {
    leagueName: league?.name ?? "the league",
    data: {
      week: weekNo,
      teams: teamRows.map((t) => ({ name: t.name, karma: t.karma })),
      matchups: weekMatchups.map((m) => ({
        home: nameOf(m.homeTeamId),
        away: nameOf(m.awayTeamId),
        homeScore: m.homeScore,
        awayScore: m.awayScore,
        final: m.isFinal,
      })),
      standings: standings.map((s) => ({ ...s, team: nameOf(s.teamId) })),
      transactions: weekTransactions.map((t) => ({
        team: nameOf(t.teamId),
        type: t.type,
        player: t.playerName,
        with: t.relatedTeamId ? nameOf(t.relatedTeamId) : null,
      })),
      trades: weekTrades.map((t) => ({
        proposer: nameOf(t.proposerTeamId),
        recipient: nameOf(t.recipientTeamId),
        status: t.status,
        fairness: t.fairnessScore,
      })),
      topForumPosts: topPosts.map((p) => ({
        title: p.title,
        score: p.score,
        team: p.teamId ? nameOf(p.teamId) : "Commissioner",
      })),
    },
  };
}

type StandingRow = {
  teamId: string;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
};

async function loadStandings(leagueId: string): Promise<StandingRow[]> {
  const teamRows = await db
    .select({ id: teams.id })
    .from(teams)
    .where(eq(teams.leagueId, leagueId));
  if (teamRows.length === 0) return [];

  const results = await db
    .select()
    .from(teamResults)
    .where(inArray(teamResults.teamId, teamRows.map((t) => t.id)));

  return teamRows
    .map((team) => {
      const rows = results.filter((r) => r.teamId === team.id);
      return {
        teamId: team.id,
        wins: rows.filter((r) => r.won).length,
        losses: rows.filter((r) => r.lost).length,
        ties: rows.filter((r) => r.tied).length,
        pointsFor: Math.round(rows.reduce((sum, r) => sum + r.pointsFor, 0) * 100) / 100,
      };
    })
    .sort((a, b) => b.wins - a.wins || b.pointsFor - a.pointsFor);
}

// -------------------------------------------------------------- scripted text

function scriptedWeeklyRecap(brief: WeeklyBrief, weekNo: number): string {
  const data = brief.data as {
    matchups: Array<{ home: string; away: string; homeScore: number; awayScore: number }>;
    standings: Array<{ team: string; wins: number; losses: number; pointsFor: number }>;
    trades: Array<{ proposer: string; recipient: string; status: string }>;
  };
  const lines: string[] = [];
  lines.push(`## Week ${weekNo} Recap`);
  lines.push("");
  if (data.matchups.length === 0) {
    lines.push(`No matchups are on record for week ${weekNo} in ${brief.leagueName}.`);
  } else {
    for (const m of data.matchups) {
      const winner = m.homeScore >= m.awayScore ? m.home : m.away;
      lines.push(
        `- ${m.home} ${m.homeScore} — ${m.awayScore} ${m.away}. ${winner} takes it.`,
      );
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
  lines.push(
    `- **Top of the pile**: ${data.standings[0]?.team ?? "nobody yet"} leads the table.`,
  );
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
