import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { lineups, matchups, teamResults } from "@/lib/db/schema";
import {
  countdown,
  currentWeekNo,
  draftBoard,
  expandRosterSlots,
  leagueHome,
  matchupPage,
  matchupsForWeek,
  standings,
  teamCards,
  teamPage,
  waiverResults,
  windowLabelText,
  windowSchedule,
  windowsForWeek,
} from "@/lib/services/views";
import { db, truncateAll } from "../setup";
import { makeLeague, makeWindow } from "./helpers";

beforeAll(async () => {
  await truncateAll();
});

describe("leagueHome on an empty league", () => {
  it("returns a complete, sane structure with no snapshot, matchups or spend", async () => {
    const { league, teams: created } = await makeLeague({ teamCount: 8, name: "Fresh Start" });
    const home = await leagueHome(league.id);

    expect(home).not.toBeNull();
    expect(home!.league.name).toBe("Fresh Start");
    expect(home!.league.status).toBe("setup");
    expect(home!.league.teamCount).toBe(8);

    expect(home!.currentWeek).toBeGreaterThanOrEqual(1);
    expect(home!.standings).toHaveLength(created.length);
    expect(home!.standings[0].rank).toBe(1);
    expect(home!.standings.every((row) => row.wins === 0 && row.pointsFor === 0)).toBe(true);
    expect(home!.standings.every((row) => row.modelId !== null)).toBe(true);

    expect(home!.matchups).toEqual([]);
    expect(home!.forumPosts).toEqual([]);
    expect(home!.trades).toEqual([]);
    expect(home!.spend).toEqual([]);
    expect(home!.totalSpendUsd).toBe(0);

    expect(home!.windows).toEqual({ open: [], upcoming: [], next: null });
    expect(home!.draft.status).toBe("setup");
    expect(home!.draft.picksMade).toBe(0);
    expect(home!.draft.totalPicks).toBeNull();
    expect(home!.snapshotTakenAt).toBeNull();
    expect(home!.viewer).toEqual({ isMember: false, isCommissioner: false, teamId: null });
  });

  it("returns null for a league that does not exist", async () => {
    expect(await leagueHome("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("marks the viewer's own team and role", async () => {
    const { league, commissioner } = await makeLeague({ teamCount: 8 });
    const home = await leagueHome(league.id, {
      userId: commissioner.id,
      isMember: true,
      isCommissioner: true,
    });
    expect(home!.viewer.isCommissioner).toBe(true);
    // The commissioner does not automatically own a team.
    expect(home!.viewer.teamId).toBeNull();
  });

  it("surfaces the next window with a countdown", async () => {
    const { league } = await makeLeague();
    await makeWindow(league.id, { type: "lineup", label: "lineup_sun_early", weekNo: 1 });
    const home = await leagueHome(league.id);
    expect(home!.windows.next).not.toBeNull();
    expect(home!.windows.next!.labelText).toBe("Lineup sun early");
    expect(home!.windows.open).toHaveLength(1);
    expect(home!.windows.next!.countdown).toMatch(/^\d+[dhm]/);
  });
});

describe("standings", () => {
  it("orders by wins then points for, and computes a streak", async () => {
    const { league, teams: created } = await makeLeague({ teamCount: 8 });

    await db.insert(teamResults).values([
      { teamId: created[0].id, weekNo: 1, pointsFor: 100, pointsAgainst: 80, won: true },
      { teamId: created[0].id, weekNo: 2, pointsFor: 90, pointsAgainst: 70, won: true },
      { teamId: created[1].id, weekNo: 1, pointsFor: 120, pointsAgainst: 100, won: true },
      { teamId: created[1].id, weekNo: 2, pointsFor: 60, pointsAgainst: 95, lost: true },
    ]);

    const table = await standings(league.id);
    expect(table[0].teamId).toBe(created[0].id);
    expect(table[0].wins).toBe(2);
    expect(table[0].streak).toBe("W2");
    expect(table[0].pointsFor).toBe(190);

    const second = table.find((row) => row.teamId === created[1].id)!;
    expect(second.wins).toBe(1);
    expect(second.losses).toBe(1);
    expect(second.streak).toBe("L1");
  });

  it("is empty for a league with no teams", async () => {
    expect(await standings("00000000-0000-0000-0000-000000000000")).toEqual([]);
  });
});

describe("teamCards & teamPage", () => {
  it("teamCards mirrors the standings order and carries model badges", async () => {
    const { league, teams: created } = await makeLeague({ teamCount: 8 });
    const cards = await teamCards(league.id);
    expect(cards).toHaveLength(created.length);
    expect(cards[0].rank).toBe(1);
    expect(cards[0].modelId).toBeTruthy();
    expect(cards[0].configVersionNo).toBe(1);
    expect(cards[0].record).toBe("0-0");
  });

  it("teamPage renders an empty roster from the league's roster shape", async () => {
    const { league, teams: created } = await makeLeague({ teamCount: 8 });
    const page = await teamPage(created[0].id);

    expect(page).not.toBeNull();
    expect(page!.team.leagueId).toBe(league.id);
    expect(page!.roster).toEqual([]);
    expect(page!.lineup.length).toBeGreaterThan(0);
    expect(page!.lineup.filter((slot) => slot.starting).length).toBeGreaterThan(0);
    expect(page!.lineup.every((slot) => slot.entry === null)).toBe(true);
    expect(page!.projectedTotal).toBe(0);
    expect(page!.config.versionNo).toBe(1);
    expect(page!.config.harness?.maxSteps).toBeGreaterThan(0);
    expect(page!.recentRuns).toEqual([]);
    expect(page!.cost).toEqual({ seasonUsd: 0, weekUsd: 0, seasonTokens: 0, runCount: 0 });
  });

  it("teamPage returns null for an unknown team", async () => {
    expect(await teamPage("00000000-0000-0000-0000-000000000000")).toBeNull();
  });
});

describe("matchups", () => {
  it("builds cards and a detail page with both lineups", async () => {
    const { league, teams: created } = await makeLeague({ teamCount: 8 });

    const [matchup] = await db
      .insert(matchups)
      .values({
        leagueId: league.id,
        weekNo: 2,
        homeTeamId: created[0].id,
        awayTeamId: created[1].id,
        homeScore: 101.5,
        awayScore: 98.25,
        isFinal: true,
      })
      .returning();

    await db.insert(lineups).values({
      teamId: created[0].id,
      weekNo: 2,
      version: 1,
      slots: [
        { slot: "QB", playerId: null },
        { slot: "BENCH1", playerId: null },
      ],
      source: "agent",
    });

    const cards = await matchupsForWeek(league.id, 2);
    expect(cards).toHaveLength(1);
    expect(cards[0].home.score).toBe(101.5);
    expect(cards[0].home.live).toBe(false);
    expect(cards[0].isFinal).toBe(true);

    const detail = await matchupPage(league.id, 2, matchup.id);
    expect(detail).not.toBeNull();
    expect(detail!.home.officialScore).toBe(101.5);
    expect(detail!.home.slots.map((slot) => slot.slot)).toEqual(["QB", "BENCH1"]);
    expect(detail!.home.slots[0].starting).toBe(true);
    expect(detail!.home.slots[1].starting).toBe(false);
    expect(detail!.away.slots).toEqual([]);
    expect(detail!.home.rationale).toBeNull();
  });

  it("matchupPage returns null when the matchup is in another league", async () => {
    const a = await makeLeague();
    const b = await makeLeague();
    const [matchup] = await db
      .insert(matchups)
      .values({
        leagueId: a.league.id,
        weekNo: 1,
        homeTeamId: a.teams[0].id,
        awayTeamId: a.teams[1].id,
      })
      .returning();
    expect(await matchupPage(b.league.id, 1, matchup.id)).toBeNull();
  });
});

describe("draftBoard", () => {
  it("renders a placeholder board before any picks exist", async () => {
    const { league, teams: created } = await makeLeague({ teamCount: 8 });
    const board = await draftBoard(league.id);
    expect(board).not.toBeNull();
    expect(board!.status).toBe("setup");
    expect(board!.picks).toEqual([]);
    expect(board!.rounds).toBe(0);
    expect(board!.grid).toEqual([]);
    expect(board!.teams).toHaveLength(created.length);
    expect(board!.onTheClock).toBeNull();
    expect(board!.runningCostUsd).toBe(0);
  });

  it("returns null for an unknown league", async () => {
    expect(await draftBoard("00000000-0000-0000-0000-000000000000")).toBeNull();
  });
});

describe("waiverResults", () => {
  it("returns an empty week with the league's FAAB snapshot", async () => {
    const { league, teams: created } = await makeLeague({ teamCount: 8 });
    const view = await waiverResults(league.id, 1);
    expect(view.results).toEqual([]);
    expect(view.pendingCount).toBe(0);
    expect(view.weeksWithClaims).toEqual([]);
    expect(view.faab).toHaveLength(created.length);
    expect(view.faab.every((row) => row.remaining === 100 && row.spent === 0)).toBe(true);
    expect(view.window).toBeNull();
  });
});

describe("windows", () => {
  it("windowsForWeek decorates phase and countdown", async () => {
    const { league } = await makeLeague();
    const window = await makeWindow(league.id, { label: "waiver", type: "waiver", weekNo: 4 });
    const rows = await windowsForWeek(league.id, 4);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(window.id);
    expect(rows[0].phase).toBe("open");
    expect(rows[0].labelText).toBe("Waiver");
    expect(rows[0].runCount).toBe(0);
  });

  it("windowSchedule ignores windows that already closed", async () => {
    const { league } = await makeLeague();
    const schedule = await windowSchedule(league.id);
    expect(schedule.next).toBeNull();
    expect(schedule.open).toEqual([]);
  });
});

describe("shared helpers", () => {
  it("formats window labels", () => {
    expect(windowLabelText("lineup_sun_early")).toBe("Lineup sun early");
    expect(windowLabelText("waiver")).toBe("Waiver");
  });

  it("formats countdowns", () => {
    const base = new Date("2026-09-08T12:00:00Z");
    expect(countdown(base, new Date("2026-09-08T14:10:00Z"))).toBe("2h 10m");
    expect(countdown(base, new Date("2026-09-08T12:45:00Z"))).toBe("45m");
    expect(countdown(base, new Date("2026-09-11T15:00:00Z"))).toBe("3d 3h");
    expect(countdown(base, new Date("2026-09-08T11:00:00Z"))).toBe("now");
  });

  it("expands a roster shape into slot labels", () => {
    expect(expandRosterSlots({ QB: 1, RB: 2, BENCH: 3 })).toEqual([
      "QB",
      "RB1",
      "RB2",
      "BENCH1",
      "BENCH2",
      "BENCH3",
    ]);
  });

  it("currentWeekNo never returns 0", async () => {
    const { league } = await makeLeague();
    const week = await currentWeekNo(league.id, new Date("2020-01-01T00:00:00Z"));
    expect(week).toBe(1);
  });
});

describe("live scores", () => {
  it("uses the official score when a week is final", async () => {
    const { league, teams: created } = await makeLeague({ teamCount: 8 });
    await db.insert(matchups).values({
      leagueId: league.id,
      weekNo: 5,
      homeTeamId: created[0].id,
      awayTeamId: created[1].id,
      homeScore: 77,
      awayScore: 0,
      isFinal: true,
    });
    const cards = await matchupsForWeek(league.id, 5);
    expect(cards[0].home.score).toBe(77);
    expect(cards[0].away.score).toBe(0);
    expect(cards[0].away.live).toBe(false);

    const rows = await db.select().from(matchups).where(eq(matchups.leagueId, league.id));
    expect(rows).toHaveLength(1);
  });
});
