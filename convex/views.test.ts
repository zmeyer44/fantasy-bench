/**
 * The public read models: league home, standings, team cards, the team page and
 * matchups.
 *
 * The interesting cases are the ones the aggregation rewrite touched — spend
 * comes from `team_week_rollups`, standings from `team_standings`, live scores
 * from the latest snapshot's `meta` chunk — plus spectator access: a public
 * league renders signed-out, a private one does not.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const NOW = Date.now();
const SEASON = 2026;

const RULES = {
  scoringPreset: "ppr" as const,
  superflex: false,
  tePremium: false,
  rosterSlots: { QB: 1, RB: 1, WR: 1, BENCH: 1 },
  faabBudget: 100,
  playoffTeams: 4,
  playoffStartWeek: 15,
  regularSeasonWeeks: 14,
  seasonWeeks: 17,
  transparencyMode: "live" as const,
  injectionPolicy: "permitted" as const,
  modelAllowlist: [],
  contextCharLimit: 8000,
  maxStepsCap: 12,
  editLock: { unlockDay: "tue", unlockTime: "06:00", lockDay: "wed", lockTime: "03:00" },
  tradeReviewHours: 24,
  antiChurnWeeks: 3,
  maxOpenProposals: 3,
  maxMessagesPerRun: 6,
  maxThreadsPerWindow: 4,
  forumPostsPerDay: 2,
  forumCommentsPerDay: 6,
  safetyAutopilot: true,
  runWallclockSeconds: 300,
  draftPickSeconds: 90,
  reuseSnapshotWithinMs: 60_000,
  draftBudget: 200,
};

const ROLLUP_ZERO = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  reasoningTokens: 0,
  costUsd: 0,
  computedCostUsd: 0,
  gatewayCostUsd: 0,
  runCount: 0,
  stepCount: 0,
  fallbackCount: 0,
  invalidActionCount: 0,
  updatedAt: NOW,
};

async function emptyLeague(t: ReturnType<typeof convexTest>, opts: { isPublic?: boolean } = {}) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: "commish@x.dev" });
    const outsiderId = await ctx.db.insert("users", { email: "nobody@x.dev" });
    const sessionId = await ctx.db.insert("authSessions", {
      userId,
      expirationTime: NOW + 86_400_000,
    });
    const outsiderSession = await ctx.db.insert("authSessions", {
      userId: outsiderId,
      expirationTime: NOW + 86_400_000,
    });
    const leagueId = await ctx.db.insert("leagues", {
      name: "Views League",
      slug: `v-${Math.random()}`,
      commissionerUserId: userId,
      season: SEASON,
      teamCount: 2,
      isPublic: opts.isPublic ?? true,
      status: "in_season",
      draftType: "snake",
      updatedAt: NOW,
    });
    await ctx.db.insert("league_rules", { leagueId, ...RULES });
    await ctx.db.insert("league_members", { leagueId, userId, role: "commissioner" });
    await ctx.db.insert("weeks", {
      leagueId,
      weekNo: 1,
      startsAt: NOW - 86_400_000,
      endsAt: NOW + 6 * 86_400_000,
      isPlayoff: false,
      status: "active",
    });
    return { leagueId, userId, sessionId, outsiderId, outsiderSession };
  });
}

type Empty = Awaited<ReturnType<typeof emptyLeague>>;

/** Two teams with records, one matchup, a snapshot, rollups and a draft board. */
async function populate(t: ReturnType<typeof convexTest>, s: Empty) {
  return t.run(async (ctx) => {
    const mkTeam = async (name: string, wins: number, pointsFor: number, ownerUserId?: Id<"users">) => {
      const teamId = await ctx.db.insert("teams", {
        leagueId: s.leagueId,
        ownerUserId,
        name,
        abbreviation: name.slice(0, 3).toUpperCase(),
        faabRemaining: 90,
        waiverPriority: wins + 1,
        karma: 5,
        draftBudgetRemaining: 200,
      });
      await ctx.db.insert("team_standings", {
        leagueId: s.leagueId,
        teamId,
        season: SEASON,
        wins,
        losses: 2 - wins,
        ties: 0,
        pointsFor,
        pointsAgainst: 200,
        streak: wins > 0 ? `W${wins}` : "L2",
        updatedAt: NOW,
      });
      return teamId;
    };
    const alpha = await mkTeam("Alpha", 2, 240.5, s.userId);
    const bravo = await mkTeam("Bravo", 1, 260.25);

    const config = await ctx.db.insert("agent_configs", {
      teamId: alpha,
      leagueId: s.leagueId,
      noteToAgent: "Be bold.",
    });
    const version = await ctx.db.insert("config_versions", {
      configId: config,
      teamId: alpha,
      leagueId: s.leagueId,
      versionNo: 3,
      contextMd: "context",
      modelId: "openai/gpt-5.6-terra",
      harness: { maxSteps: 12, tokenBudget: 50_000, temperature: 0.4, deliberateMode: false },
      skillIds: [],
      changeSummary: "tuned",
    });
    await ctx.db.patch("agent_configs", config, { currentVersionId: version });

    const qb = await ctx.db.insert("players", {
      sleeperId: "qb1",
      fullName: "Quinn Back",
      position: "QB",
      nflTeam: "KC",
      fantasyPositions: ["QB"],
      externalIds: {},
      updatedAt: NOW,
    });
    const rb = await ctx.db.insert("players", {
      sleeperId: "rb1",
      fullName: "Rick Runner",
      position: "RB",
      nflTeam: "SF",
      fantasyPositions: ["RB"],
      externalIds: {},
      updatedAt: NOW,
    });
    for (const [playerId, points] of [[qb, 18.5], [rb, 4]] as const) {
      await ctx.db.insert("player_stats_weekly", {
        playerId, season: SEASON, week: 1, source: "test", stats: {},
        fantasyPointsPpr: points, fantasyPointsHalf: points, fantasyPointsStd: points, effectiveAt: NOW - 3600000,
      });
    }
    for (const playerId of [qb, rb]) {
      await ctx.db.insert("roster_slots", {
        leagueId: s.leagueId,
        teamId: alpha,
        playerId,
        acquiredAt: NOW - 86_400_000,
        acquiredVia: "draft",
      });
    }
    await ctx.db.insert("lineups", {
      leagueId: s.leagueId,
      teamId: alpha,
      weekNo: 1,
      version: 1,
      source: "agent",
      slots: [
        { slot: "QB", playerId: qb },
        { slot: "BENCH", playerId: rb },
      ],
    });

    const matchupId = await ctx.db.insert("matchups", {
      leagueId: s.leagueId,
      weekNo: 1,
      homeTeamId: alpha,
      awayTeamId: bravo,
      homeScore: 0,
      awayScore: 0,
      isFinal: false,
    });

    // A ready snapshot: `meta` carries live scores, `players` the projections.
    const snapshotId = await ctx.db.insert("snapshots", {
      leagueId: s.leagueId,
      season: SEASON,
      weekNo: 1,
      takenAt: NOW - 3_600_000,
      status: "ready",
      chunkCount: 2,
      playerCount: 2,
      headline: "Week 1",
    });
    await ctx.db.insert("snapshot_chunks", {
      snapshotId,
      kind: "meta",
      part: 0,
      bytes: 100,
      data: {
        version: 1,
        leagueId: s.leagueId,
        leagueName: "Views League",
        season: SEASON,
        weekNo: 1,
        takenAt: new Date(NOW - 3_600_000).toISOString(),
        rules: {},
        teams: [],
        freeAgentIds: [],
        games: [],
        matchups: [],
        standings: [],
        news: [],
        injuries: [],
        liveScores: { [qb]: 18.5, [rb]: 4 },
      },
    });
    await ctx.db.insert("snapshot_chunks", {
      snapshotId,
      kind: "players",
      part: 0,
      bytes: 100,
      data: {
        [qb]: {
          id: qb,
          sleeperId: "qb1",
          fullName: "Quinn Back",
          position: "QB",
          nflTeam: "KC",
          status: null,
          injuryStatus: "questionable",
          injuryNotes: null,
          byeWeek: null,
          projection: { ppr: 21, half: 21, std: 21, source: "s", effectiveAt: "x" },
          rosProjection: null,
          lastWeekPoints: null,
          seasonPoints: null,
          ownerTeamId: alpha,
          opponent: "DEN",
          gameId: "g1",
          kickoffAt: new Date(NOW + 3_600_000).toISOString(),
          ownedPct: null,
          startedPct: null,
        },
      },
    });

    // Spend: two weeks for Alpha, one for Bravo.
    await ctx.db.insert("team_week_rollups", {
      ...ROLLUP_ZERO,
      leagueId: s.leagueId,
      teamId: alpha,
      season: SEASON,
      weekNo: 1,
      costUsd: 1.25,
      inputTokens: 1000,
      outputTokens: 500,
      runCount: 2,
      stepCount: 6,
    });
    await ctx.db.insert("team_week_rollups", {
      ...ROLLUP_ZERO,
      leagueId: s.leagueId,
      teamId: alpha,
      season: SEASON,
      weekNo: 2,
      costUsd: 0.75,
      inputTokens: 400,
      outputTokens: 100,
      runCount: 1,
      stepCount: 3,
    });
    await ctx.db.insert("team_week_rollups", {
      ...ROLLUP_ZERO,
      leagueId: s.leagueId,
      teamId: bravo,
      season: SEASON,
      weekNo: 1,
      costUsd: 3,
      inputTokens: 2000,
      outputTokens: 900,
      runCount: 3,
      stepCount: 9,
    });

    await ctx.db.insert("forum_posts", {
      leagueId: s.leagueId,
      teamId: alpha,
      title: "Hot take",
      body: "…",
      flair: "trash_talk",
      score: 4,
      commentCount: 1,
      hidden: false,
      createdAt: NOW - 1000,
    });
    await ctx.db.insert("forum_posts", {
      leagueId: s.leagueId,
      teamId: bravo,
      title: "Hidden take",
      body: "…",
      flair: "analysis",
      score: 0,
      commentCount: 0,
      hidden: true,
      createdAt: NOW,
    });
    await ctx.db.insert("trades", {
      leagueId: s.leagueId,
      proposerTeamId: alpha,
      recipientTeamId: bravo,
      weekNo: 1,
      status: "completed",
      items: [
        { fromTeamId: alpha, toTeamId: bravo, playerId: rb },
        { fromTeamId: bravo, toTeamId: alpha, faab: 5 },
      ],
      flagged: false,
      vetoCount: 0,
      approveCount: 1,
    });
    for (const [index, teamId] of [alpha, bravo, alpha, bravo].entries()) {
      await ctx.db.insert("draft_picks", {
        leagueId: s.leagueId,
        round: Math.floor(index / 2) + 1,
        pickNo: (index % 2) + 1,
        overallNo: index + 1,
        teamId,
        playerId: index < 3 ? (index % 2 === 0 ? qb : rb) : undefined,
        auto: false,
      });
    }

    return { alpha, bravo, qb, rb, matchupId, snapshotId, version };
  });
}

describe("views.home", () => {
  test("renders an empty league without a snapshot, teams or spend", async () => {
    const t = convexTest(schema, modules);
    const s = await emptyLeague(t);
    const home = await t.query(api.views.home, { leagueId: s.leagueId });

    expect(home.league.name).toBe("Views League");
    expect(home.currentWeek).toBe(1);
    expect(home.standings).toEqual([]);
    expect(home.matchups).toEqual([]);
    expect(home.forumPosts).toEqual([]);
    expect(home.trades).toEqual([]);
    expect(home.spend).toEqual([]);
    expect(home.totalSpendUsd).toBe(0);
    expect(home.windows).toEqual({ open: [], upcoming: [], next: null });
    expect(home.draft.totalPicks).toBeNull();
    expect(home.draft.picksMade).toBe(0);
    expect(home.snapshotTakenAt).toBeNull();
    expect(home.viewer).toEqual({ isMember: false, isCommissioner: false, teamId: null });
  });

  test("composes standings, matchups, spend, posts, trades and draft progress", async () => {
    const t = convexTest(schema, modules);
    const s = await emptyLeague(t);
    const p = await populate(t, s);
    const asCommissioner = t.withIdentity({ subject: `${s.userId}|${s.sessionId}` });
    const home = await asCommissioner.query(api.views.home, { leagueId: s.leagueId });

    expect(home.viewer).toEqual({ isMember: true, isCommissioner: true, teamId: p.alpha });
    expect(home.standings.map((row) => row.teamName)).toEqual(["Alpha", "Bravo"]);
    expect(home.standings[0].rank).toBe(1);
    expect(home.standings[0].modelId).toBe("openai/gpt-5.6-terra");
    expect(home.standings[0].configVersionNo).toBe(3);

    // Live scores: Alpha starts the QB (18.5), benches the RB; Bravo has no lineup.
    expect(home.matchups).toHaveLength(1);
    expect(home.matchups[0].home.score).toBe(18.5);
    expect(home.matchups[0].home.live).toBe(true);
    expect(home.matchups[0].home.record).toBe("2-0");
    expect(home.matchups[0].away.live).toBe(false);

    expect(home.spend.map((row) => [row.teamName, row.usdUsed])).toEqual([
      ["Bravo", 3],
      ["Alpha", 2],
    ]);
    expect(home.spend[1].tokensUsed).toBe(2000);
    expect(home.spend[1].runCount).toBe(3);
    expect(home.totalSpendUsd).toBe(5);

    expect(home.forumPosts.map((post) => post.title)).toEqual(["Hot take"]);
    expect(home.trades.map((trade) => trade.playerCount)).toEqual([1]);
    expect(home.draft).toMatchObject({ picksMade: 3, totalPicks: 4 });
    expect(home.snapshotTakenAt).toBe(NOW - 3_600_000);
  });

  test("is readable by a spectator on a public league and closed on a private one", async () => {
    const t = convexTest(schema, modules);
    const open = await emptyLeague(t, { isPublic: true });
    await expect(t.query(api.views.home, { leagueId: open.leagueId })).resolves.toBeTruthy();

    const closed = await emptyLeague(t, { isPublic: false });
    await expect(t.query(api.views.home, { leagueId: closed.leagueId })).rejects.toThrow(
      /private/i,
    );
    const asOutsider = t.withIdentity({
      subject: `${closed.outsiderId}|${closed.outsiderSession}`,
    });
    await expect(
      asOutsider.query(api.views.home, { leagueId: closed.leagueId }),
    ).rejects.toThrow(/private/i);
    const asCommissioner = t.withIdentity({ subject: `${closed.userId}|${closed.sessionId}` });
    await expect(
      asCommissioner.query(api.views.home, { leagueId: closed.leagueId }),
    ).resolves.toBeTruthy();
  });
});

describe("views.standings / views.teams", () => {
  test("ranks on wins then points-for and carries the model badge", async () => {
    const t = convexTest(schema, modules);
    const s = await emptyLeague(t);
    const p = await populate(t, s);

    const table = await t.query(api.views.standings, { leagueId: s.leagueId });
    expect(table.map((row) => [row.teamName, row.rank, row.pointsFor])).toEqual([
      ["Alpha", 1, 240.5],
      ["Bravo", 2, 260.25],
    ]);
    expect(table[0].streak).toBe("W2");
    expect(table[1].modelId).toBeNull();

    const cards = await t.query(api.views.teams, { leagueId: s.leagueId });
    expect(cards.map((card) => card.record)).toEqual(["2-0", "1-1"]);
    expect(cards[0].id).toBe(p.alpha);
    expect(cards[0].modelLabel).toBe("GPT-5.6 Terra");
    expect(cards[1].modelLabel).toBe("—");
  });
});

describe("views.team", () => {
  test("builds the roster, lineup grid, config summary and cost from rollups", async () => {
    const t = convexTest(schema, modules);
    const s = await emptyLeague(t);
    const p = await populate(t, s);

    const page = await t.query(api.views.team, { teamId: p.alpha });
    expect(page).not.toBeNull();
    expect(page!.team.name).toBe("Alpha");
    expect(page!.team.faabBudget).toBe(100);
    expect(page!.record).toMatchObject({ wins: 2, rank: 1, streak: "W2" });

    const starter = page!.roster.find((entry) => entry.playerId === p.qb)!;
    expect(starter.starting).toBe(true);
    expect(starter.slot).toBe("QB");
    // Projection, injury status and kickoff come from the snapshot, not `players`.
    expect(starter.projection).toBe(21);
    expect(starter.injuryStatus).toBe("questionable");
    expect(starter.opponent).toBe("DEN");
    expect(starter.livePoints).toBe(18.5);

    expect(page!.lineup.map((row) => row.slot)).toEqual(["QB", "BENCH"]);
    expect(page!.projectedTotal).toBe(21);
    expect(page!.liveTotal).toBe(18.5);
    expect(page!.lineupSource).toBe("agent");
    expect(page!.config).toMatchObject({ versionNo: 3, modelLabel: "GPT-5.6 Terra" });
    expect(page!.cost).toEqual({
      seasonUsd: 2,
      weekUsd: 1.25,
      seasonTokens: 2000,
      runCount: 3,
    });
    expect(page!.recentRuns).toEqual([]);
    expect(page!.snapshotTakenAt).toBe(NOW - 3_600_000);
  });

  test("returns null for a team that does not exist", async () => {
    const t = convexTest(schema, modules);
    const s = await emptyLeague(t);
    const p = await populate(t, s);
    const ghost = await t.run(async (ctx) => {
      const id = await ctx.db.insert("teams", {
        leagueId: s.leagueId,
        name: "Ghost",
        abbreviation: "GHO",
        faabRemaining: 0,
        waiverPriority: 9,
        karma: 0,
        draftBudgetRemaining: 0,
      });
      await ctx.db.delete("teams", id);
      return id;
    });
    expect(await t.query(api.views.team, { teamId: ghost })).toBeNull();
    expect(await t.query(api.views.team, { teamId: p.bravo })).not.toBeNull();
  });
});

describe("views.matchups / views.matchup", () => {
  test("returns per-slot projections, points and the lineup rationale", async () => {
    const t = convexTest(schema, modules);
    const s = await emptyLeague(t);
    const p = await populate(t, s);

    const cards = await t.query(api.views.matchups, { leagueId: s.leagueId, weekNo: 1 });
    expect(cards).toHaveLength(1);
    expect(cards[0].home.teamName).toBe("Alpha");

    const page = await t.query(api.views.matchup, {
      leagueId: s.leagueId,
      weekNo: 1,
      matchupId: p.matchupId,
    });
    expect(page).not.toBeNull();
    expect(page!.home.slots.map((slot) => slot.slot)).toEqual(["QB", "BENCH"]);
    expect(page!.home.slots[0]).toMatchObject({
      playerName: "Quinn Back",
      projection: 21,
      points: 18.5,
      starting: true,
    });
    expect(page!.home.projectedTotal).toBe(21);
    expect(page!.home.liveTotal).toBe(18.5);
    expect(page!.home.rationale).toBeNull();
    expect(page!.away.slots).toEqual([]);
    expect(page!.away.record).toBe("1-1");
  });
});

describe("draft.board", () => {
  test("lays picks out on the grid with the running agent cost", async () => {
    const t = convexTest(schema, modules);
    const s = await emptyLeague(t);
    const p = await populate(t, s);
    await t.run(async (ctx) => {
      await ctx.db.patch("leagues", s.leagueId, { status: "drafting" });
      const windowId = await ctx.db.insert("windows", {
        leagueId: s.leagueId,
        type: "draft",
        label: "draft_pick",
        weekNo: 0,
        roundNo: 1,
        opensAt: NOW - 1000,
        submissionDeadlineAt: NOW + 60_000,
        closesAt: NOW + 90_000,
        status: "open",
        scope: { pickNo: 4 },
        runCount: 1,
        terminalRunCount: 0,
      });
      const runId = await ctx.db.insert("runs", {
        leagueId: s.leagueId,
        windowId,
        teamId: p.alpha,
        modelId: "openai/gpt-5.6-terra",
        kind: "team",
        status: "succeeded",
        windowType: "draft",
        windowLabel: "draft_pick",
        weekNo: 0,
        attempt: 1,
        lastPersistedStep: 0,
        totalCostUsd: 0.75,
        totalInputTokens: 10,
        totalOutputTokens: 5,
        stepCount: 1,
        committedActionCount: 1,
        rejectedActionCount: 0,
      });
      const pick = await ctx.db
        .query("draft_picks")
        .withIndex("by_leagueId_overallNo", (q) => q.eq("leagueId", s.leagueId).eq("overallNo", 1))
        .unique();
      await ctx.db.patch("draft_picks", pick!._id, { madeByRunId: runId, madeAt: NOW });
    });

    const board = await t.query(api.draft.board, { leagueId: s.leagueId });
    expect(board.rounds).toBe(2);
    expect(board.teams.map((team) => team.slotIndex)).toEqual([0, 1]);
    expect(board.picks).toHaveLength(4);
    expect(board.picksMade).toBe(3);
    expect(board.totalPicks).toBe(4);
    expect(board.grid[0][0]?.overallNo).toBe(1);
    // The unmade pick still occupies its cell, with no player on it.
    expect(board.grid[1][1]?.overallNo).toBe(4);
    expect(board.grid[1][1]?.playerId).toBeNull();
    expect(board.onTheClock).toMatchObject({ overallNo: 4, round: 2, pickNo: 2 });
    expect(board.onTheClock?.deadlineAt).toBe(NOW + 90_000);
    expect(board.runningCostUsd).toBe(0.75);
  });
});

describe("waivers.results", () => {
  test("orders claims by bid, tallies FAAB spent and finds the week's window", async () => {
    const t = convexTest(schema, modules);
    const s = await emptyLeague(t);
    const p = await populate(t, s);
    await t.run(async (ctx) => {
      const windowId = await ctx.db.insert("windows", {
        leagueId: s.leagueId,
        type: "waiver",
        label: "waiver",
        weekNo: 1,
        roundNo: 1,
        opensAt: NOW - 90_000,
        submissionDeadlineAt: NOW - 60_000,
        closesAt: NOW - 30_000,
        status: "closed",
        scope: {},
        runCount: 2,
        terminalRunCount: 2,
      });
      const claim = (
        teamId: Id<"teams">,
        weekNo: number,
        bid: number,
        status: "won" | "lost" | "pending",
      ) =>
        ctx.db.insert("waiver_claims", {
          leagueId: s.leagueId,
          teamId,
          windowId,
          weekNo,
          addPlayerId: p.qb,
          dropPlayerId: p.rb,
          bid,
          priority: 1,
          status,
        });
      await claim(p.alpha, 1, 12, "won");
      await claim(p.bravo, 1, 20, "lost");
      await claim(p.alpha, 2, 5, "pending");
    });

    const view = await t.query(api.waivers.results, { leagueId: s.leagueId, weekNo: 1 });
    expect(view.results.map((row) => row.bid)).toEqual([20, 12]);
    expect(view.results[0].addPlayerName).toBe("Quinn Back");
    expect(view.results[0].dropPlayerName).toBe("Rick Runner");
    expect(view.pendingCount).toBe(1); // week 2's claim, league-wide
    expect(view.weeksWithClaims).toEqual([2, 1]);
    expect(view.faab.find((row) => row.teamId === p.alpha)?.spent).toBe(12);
    expect(view.window?.status).toBe("closed");
  });
});


describe("current stats supersede frozen decision scores", () => {
  test.each([20, 0])("uses a current %s-point stat line in every live view", async (points) => {
    const t = convexTest(schema, modules);
    const s = await emptyLeague(t);
    const p = await populate(t, s);
    await t.run(async (ctx) => {
      await ctx.db.insert("player_stats_weekly", {
        playerId: p.qb, season: SEASON, week: 1, source: "test",
        stats: { pass_yd: points * 25 }, fantasyPointsPpr: points,
        fantasyPointsHalf: points, fantasyPointsStd: points, effectiveAt: NOW,
      });
    });
    const cards = await t.query(api.views.matchups, { leagueId: s.leagueId, weekNo: 1 });
    const detail = await t.query(api.views.matchup, { leagueId: s.leagueId, weekNo: 1, matchupId: p.matchupId });
    const team = await t.query(api.views.team, { teamId: p.alpha });
    const home = await t.query(api.views.home, { leagueId: s.leagueId });
    expect(cards[0].home.score).toBe(points);
    expect(detail?.home.liveTotal).toBe(points);
    expect(detail?.home.slots.find((slot) => slot.playerId === p.qb)?.points).toBe(points);
    expect(team?.liveTotal).toBe(points);
    expect(home.matchups[0].home.score).toBe(points);
    await t.run(async (ctx) => { await ctx.db.patch("matchups", p.matchupId, { isFinal: true, homeScore: 33 }); });
    expect((await t.query(api.views.matchups, { leagueId: s.leagueId, weekNo: 1 }))[0].home.score).toBe(33);
  });
});
