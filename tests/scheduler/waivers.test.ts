/**
 * FAAB waivers: validation at submit time, resolution at window close.
 */
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import { rosterSlots, teams, transactions, waiverClaims, windows } from "@/lib/db/schema";
import { materializeWindows } from "@/lib/scheduler/materialize";
import { openWindowNow } from "@/lib/scheduler/tick";
import {
  dropPlayer,
  getWaiverResults,
  processWaivers,
  rosterCapacity,
  submitWaiverClaims,
} from "@/lib/services/waivers";
import type { AgentContext } from "@/lib/services/messaging";

import { truncateAll } from "../setup";
import { createTestLeague, fillRoster, seedGames, seedPlayers, seedProjections } from "./helpers";

const NOW = new Date("2026-09-08T14:00:00Z");

function ctx(windowId: string): AgentContext {
  return {
    runId: "",
    stepIndex: 0,
    toolCallId: "tc-1",
    configVersionId: null,
    windowId,
    weekNo: 1,
  };
}

async function setup(teamCount = 8) {
  const league = await createTestLeague({ teamCount });
  const pool = await seedPlayers(160);
  await seedProjections(pool, league.season, 1);
  await seedGames(league.season, 1);
  await materializeWindows(league.leagueId, 1);

  const used = new Set<string>();
  const rosters: Record<string, string[]> = {};
  for (const teamId of league.teamIds) {
    rosters[teamId] = await fillRoster(teamId, pool, used);
  }
  const freeAgents = pool.filter((p) => !used.has(p.id));
  const opened = await openWindowNow(league.leagueId, "waiver", { weekNo: 1, now: NOW });
  return { league, pool, rosters, freeAgents, windowId: opened.windowId };
}

describe("rosterCapacity", () => {
  it("counts every slot in the shape", () => {
    expect(rosterCapacity({ QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DEF: 1, BENCH: 6 })).toBe(15);
  });
});

describe("submitWaiverClaims", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("accepts a legal claim and records the run", async () => {
    const { league, rosters, freeAgents, windowId } = await setup();
    const team = league.teamIds[0];
    const result = await submitWaiverClaims({
      leagueId: league.leagueId,
      teamId: team,
      windowId,
      weekNo: 1,
      claims: [{ addPlayerId: freeAgents[0].id, dropPlayerId: rosters[team][0], bid: 12 }],
      ctx: ctx(windowId),
    });
    expect(result.ok).toBe(true);
    const rows = await db.select().from(waiverClaims).where(eq(waiverClaims.teamId, team));
    expect(rows).toHaveLength(1);
    expect(rows[0].bid).toBe(12);
    expect(rows[0].status).toBe("pending");
  });

  it("rejects a bid above remaining FAAB", async () => {
    const { league, freeAgents, windowId } = await setup();
    const result = await submitWaiverClaims({
      leagueId: league.leagueId,
      teamId: league.teamIds[0],
      windowId,
      weekNo: 1,
      claims: [{ addPlayerId: freeAgents[0].id, bid: 1000 }],
      ctx: ctx(windowId),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("exceeds your remaining FAAB");
  });

  it("rejects a rostered player and a drop the team does not own", async () => {
    const { league, rosters, freeAgents, windowId } = await setup();
    const owned = rosters[league.teamIds[1]][0];
    const rostered = await submitWaiverClaims({
      leagueId: league.leagueId,
      teamId: league.teamIds[0],
      windowId,
      weekNo: 1,
      claims: [{ addPlayerId: owned, bid: 1 }],
      ctx: ctx(windowId),
    });
    expect(rostered.ok).toBe(false);
    if (!rostered.ok) expect(rostered.errors.join(" ")).toContain("not a free agent");

    const badDrop = await submitWaiverClaims({
      leagueId: league.leagueId,
      teamId: league.teamIds[0],
      windowId,
      weekNo: 1,
      claims: [{ addPlayerId: freeAgents[0].id, dropPlayerId: owned, bid: 1 }],
      ctx: ctx(windowId),
    });
    expect(badDrop.ok).toBe(false);
    if (!badDrop.ok) expect(badDrop.errors.join(" ")).toContain("not on your roster");
  });

  it("rejects claims that would overflow the roster", async () => {
    const { league, freeAgents, windowId } = await setup();
    // The roster is already full at 12, so an add with no drop is illegal.
    const result = await submitWaiverClaims({
      leagueId: league.leagueId,
      teamId: league.teamIds[0],
      windowId,
      weekNo: 1,
      claims: freeAgents.slice(0, 5).map((p) => ({ addPlayerId: p.id, bid: 1 })),
      ctx: ctx(windowId),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("Roster would exceed");
  });

  it("replaces an earlier claim for the same player", async () => {
    const { league, rosters, freeAgents, windowId } = await setup();
    const team = league.teamIds[0];
    const claim = { addPlayerId: freeAgents[0].id, dropPlayerId: rosters[team][0], bid: 5 };
    await submitWaiverClaims({
      leagueId: league.leagueId,
      teamId: team,
      windowId,
      weekNo: 1,
      claims: [claim],
      ctx: ctx(windowId),
    });
    await submitWaiverClaims({
      leagueId: league.leagueId,
      teamId: team,
      windowId,
      weekNo: 1,
      claims: [{ ...claim, bid: 25 }],
      ctx: ctx(windowId),
    });
    const rows = await db.select().from(waiverClaims).where(eq(waiverClaims.teamId, team));
    expect(rows).toHaveLength(1);
    expect(rows[0].bid).toBe(25);
  });

  it("refuses when the window is not an open waiver window", async () => {
    const { league, freeAgents, windowId } = await setup();
    await db.update(windows).set({ status: "closed" }).where(eq(windows.id, windowId));
    const result = await submitWaiverClaims({
      leagueId: league.leagueId,
      teamId: league.teamIds[0],
      windowId,
      weekNo: 1,
      claims: [{ addPlayerId: freeAgents[0].id, bid: 1 }],
      ctx: ctx(windowId),
    });
    expect(result.ok).toBe(false);
  });
});

describe("dropPlayer", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("drops immediately and writes a transaction", async () => {
    const { league, rosters, windowId } = await setup();
    const team = league.teamIds[0];
    const result = await dropPlayer({
      leagueId: league.leagueId,
      teamId: team,
      playerId: rosters[team][0],
      weekNo: 1,
      ctx: ctx(windowId),
      now: NOW,
    });
    expect(result.ok).toBe(true);
    const remaining = await db.select().from(rosterSlots).where(eq(rosterSlots.teamId, team));
    expect(remaining.some((r) => r.playerId === rosters[team][0])).toBe(false);
    const feed = await db.select().from(transactions).where(eq(transactions.teamId, team));
    expect(feed.some((t) => t.type === "drop")).toBe(true);
  });

  it("refuses to drop a player whose game has kicked off", async () => {
    const { league, rosters, windowId } = await setup();
    const team = league.teamIds[0];
    const result = await dropPlayer({
      leagueId: league.leagueId,
      teamId: team,
      playerId: rosters[team][0],
      weekNo: 1,
      ctx: ctx(windowId),
      // After the Monday nighter: every seeded game has started.
      now: new Date("2026-09-16T00:00:00Z"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("locked");
  });
});

describe("processWaivers", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("awards to the highest bid, debits FAAB and moves the roster", async () => {
    const { league, rosters, freeAgents, windowId } = await setup();
    const [a, b, c] = league.teamIds;
    const target = freeAgents[0].id;

    for (const [teamId, bid] of [
      [a, 10],
      [b, 30],
      [c, 20],
    ] as const) {
      await submitWaiverClaims({
        leagueId: league.leagueId,
        teamId,
        windowId,
        weekNo: 1,
        claims: [{ addPlayerId: target, dropPlayerId: rosters[teamId][0], bid }],
        ctx: ctx(windowId),
      });
    }

    const result = await processWaivers(windowId, NOW);
    expect(result.processed).toBe(3);
    expect(result.awarded).toBe(1);

    const winnerRoster = await db.select().from(rosterSlots).where(eq(rosterSlots.teamId, b));
    expect(winnerRoster.some((r) => r.playerId === target)).toBe(true);
    const winner = await db.query.teams.findFirst({ where: eq(teams.id, b) });
    expect(winner!.faabRemaining).toBe(70);
    const loser = await db.query.teams.findFirst({ where: eq(teams.id, a) });
    expect(loser!.faabRemaining).toBe(100);

    const results = await getWaiverResults(windowId);
    expect(results.filter((r) => r.status === "won")).toHaveLength(1);
    expect(results.filter((r) => r.status === "lost")).toHaveLength(2);
    expect(results.find((r) => r.status === "won")!.teamId).toBe(b);
  });

  it("breaks bid ties on waiver priority, worst record first", async () => {
    const { league, rosters, freeAgents, windowId } = await setup();
    const [a, b] = league.teamIds;
    // Team b holds priority 1 (worst record picks first).
    await db.update(teams).set({ waiverPriority: 5 }).where(eq(teams.id, a));
    await db.update(teams).set({ waiverPriority: 1 }).where(eq(teams.id, b));

    const target = freeAgents[0].id;
    for (const teamId of [a, b]) {
      await submitWaiverClaims({
        leagueId: league.leagueId,
        teamId,
        windowId,
        weekNo: 1,
        claims: [{ addPlayerId: target, dropPlayerId: rosters[teamId][0], bid: 15 }],
        ctx: ctx(windowId),
      });
    }
    await processWaivers(windowId, NOW);
    const results = await getWaiverResults(windowId);
    expect(results.find((r) => r.status === "won")!.teamId).toBe(b);
  });

  it("rotates the winner to the back of the priority order", async () => {
    const { league, rosters, freeAgents, windowId } = await setup();
    const winnerTeam = league.teamIds[3];
    await submitWaiverClaims({
      leagueId: league.leagueId,
      teamId: winnerTeam,
      windowId,
      weekNo: 1,
      claims: [{ addPlayerId: freeAgents[0].id, dropPlayerId: rosters[winnerTeam][0], bid: 9 }],
      ctx: ctx(windowId),
    });
    await processWaivers(windowId, NOW);
    const after = await db.select().from(teams).where(eq(teams.leagueId, league.leagueId));
    const winner = after.find((t) => t.id === winnerTeam)!;
    expect(winner.waiverPriority).toBe(after.length);
  });

  it("invalidates a claim whose drop player is gone by processing time", async () => {
    const { league, rosters, freeAgents, windowId } = await setup();
    const team = league.teamIds[0];
    const drop = rosters[team][0];
    await submitWaiverClaims({
      leagueId: league.leagueId,
      teamId: team,
      windowId,
      weekNo: 1,
      claims: [{ addPlayerId: freeAgents[0].id, dropPlayerId: drop, bid: 5 }],
      ctx: ctx(windowId),
    });
    await db
      .delete(rosterSlots)
      .where(and(eq(rosterSlots.teamId, team), eq(rosterSlots.playerId, drop)));

    await processWaivers(windowId, NOW);
    const results = await getWaiverResults(windowId);
    expect(results[0].status).toBe("invalid");
    expect(results[0].resultReason).toContain("no longer on the roster");
  });

  it("is a no-op when run twice", async () => {
    const { league, rosters, freeAgents, windowId } = await setup();
    const team = league.teamIds[0];
    await submitWaiverClaims({
      leagueId: league.leagueId,
      teamId: team,
      windowId,
      weekNo: 1,
      claims: [{ addPlayerId: freeAgents[0].id, dropPlayerId: rosters[team][0], bid: 7 }],
      ctx: ctx(windowId),
    });
    await processWaivers(windowId, NOW);
    const second = await processWaivers(windowId, NOW);
    expect(second.processed).toBe(0);
    const winner = await db.query.teams.findFirst({ where: eq(teams.id, team) });
    expect(winner!.faabRemaining).toBe(93);
  });
});
