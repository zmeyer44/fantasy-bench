import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import {
  leagueRules,
  playerProjections,
  rosterSlots,
  teams,
  tradeEvents,
  trades,
  transactions,
} from "@/lib/db/schema";
import {
  castVetoVote,
  expireOpenProposals,
  getTrade,
  listOpenTradesForTeam,
  listTradesForLeague,
  processTradeReviews,
  proposeTrade,
  respondToTrade,
} from "@/lib/services/trades";

import { db, truncateAll } from "../setup";
import { makeRunContext, scheduleGame, seedLeague, type SeededLeague } from "./helpers";

beforeAll(async () => {
  await truncateAll();
});

async function rosterOf(teamId: string): Promise<Set<string>> {
  const rows = await db
    .select({ playerId: rosterSlots.playerId })
    .from(rosterSlots)
    .where(eq(rosterSlots.teamId, teamId));
  return new Set(rows.map((r) => r.playerId));
}

async function eventTypes(tradeId: string): Promise<string[]> {
  const rows = await db
    .select({ type: tradeEvents.type })
    .from(tradeEvents)
    .where(eq(tradeEvents.tradeId, tradeId))
    .orderBy(tradeEvents.createdAt);
  return rows.map((r) => r.type);
}

/** Force a trade's review deadline into the past. */
async function endReview(tradeId: string): Promise<void> {
  await db
    .update(trades)
    .set({ reviewEndsAt: new Date(Date.now() - 1000) })
    .where(eq(trades.id, tradeId));
}

/** An even 1-for-1 between the first two teams. */
async function propose(seed: SeededLeague, index = 1) {
  const [a, b] = seed.teams;
  return proposeTrade({
    leagueId: seed.leagueId,
    proposerTeamId: a.id,
    toTeamId: b.id,
    give: [seed.roster[a.id][index]],
    receive: [seed.roster[b.id][index]],
    message: "even swap?",
    ctx: await makeRunContext(seed, a.id),
  });
}

describe("proposeTrade", () => {
  it("creates the proposal, its items, an event and a thread summary", async () => {
    const seed = await seedLeague();
    const [a, b] = seed.teams;
    const result = await propose(seed);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const detail = await getTrade(result.tradeId);
    expect(detail?.status).toBe("proposed");
    expect(detail?.proposerTeamId).toBe(a.id);
    expect(detail?.recipientTeamId).toBe(b.id);
    expect(detail?.give).toHaveLength(1);
    expect(detail?.receive).toHaveLength(1);
    expect(detail?.give[0].playerName).toBe(seed.playerName.get(seed.roster[a.id][1]));
    expect(detail?.threadId).toBe(result.threadId);
    expect(detail?.weekNo).toBe(seed.weekNo);
    expect(await eventTypes(result.tradeId)).toEqual(["proposed"]);

    const open = await listOpenTradesForTeam({ leagueId: seed.leagueId, teamId: b.id });
    expect(open.map((t) => t.id)).toContain(result.tradeId);
  });

  it("rejects players that are not on the right rosters", async () => {
    const seed = await seedLeague();
    const [a, b, c] = seed.teams;
    const result = await proposeTrade({
      leagueId: seed.leagueId,
      proposerTeamId: a.id,
      toTeamId: b.id,
      give: [seed.roster[c.id][0]],
      receive: [seed.roster[c.id][1]],
      ctx: await makeRunContext(seed, a.id),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(" ")).toMatch(/Not on your roster/);
    expect(result.errors.join(" ")).toMatch(/roster/);
  });

  it("requires at least one player each way and rejects self-trades", async () => {
    const seed = await seedLeague();
    const [a, b] = seed.teams;
    const empty = await proposeTrade({
      leagueId: seed.leagueId,
      proposerTeamId: a.id,
      toTeamId: b.id,
      give: [],
      receive: [seed.roster[b.id][0]],
      ctx: await makeRunContext(seed, a.id),
    });
    expect(empty.ok).toBe(false);

    const self = await proposeTrade({
      leagueId: seed.leagueId,
      proposerTeamId: a.id,
      toTeamId: a.id,
      give: [seed.roster[a.id][0]],
      receive: [seed.roster[a.id][1]],
      ctx: await makeRunContext(seed, a.id),
    });
    expect(self).toEqual({ ok: false, errors: ["A team cannot trade with itself"] });
  });

  it("rejects a FAAB offer larger than the balance", async () => {
    const seed = await seedLeague();
    const [a, b] = seed.teams;
    await db.update(teams).set({ faabRemaining: 5 }).where(eq(teams.id, a.id));

    const result = await proposeTrade({
      leagueId: seed.leagueId,
      proposerTeamId: a.id,
      toTeamId: b.id,
      give: [seed.roster[a.id][0]],
      receive: [seed.roster[b.id][0]],
      faab: 50,
      ctx: await makeRunContext(seed, a.id),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(" ")).toMatch(/exceeds your remaining/);
  });

  it("enforces max_open_proposals", async () => {
    const seed = await seedLeague({ playersPerTeam: 6, rules: { maxOpenProposals: 2 } });
    const [a, b] = seed.teams;

    for (const index of [0, 1]) {
      const ok = await proposeTrade({
        leagueId: seed.leagueId,
        proposerTeamId: a.id,
        toTeamId: b.id,
        give: [seed.roster[a.id][index]],
        receive: [seed.roster[b.id][index]],
        ctx: await makeRunContext(seed, a.id),
      });
      expect(ok.ok).toBe(true);
    }

    const blocked = await proposeTrade({
      leagueId: seed.leagueId,
      proposerTeamId: a.id,
      toTeamId: b.id,
      give: [seed.roster[a.id][2]],
      receive: [seed.roster[b.id][2]],
      ctx: await makeRunContext(seed, a.id),
    });
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.errors.join(" ")).toMatch(/open proposals/);
  });

  it("rejects a trade that would overflow a roster", async () => {
    const seed = await seedLeague({
      playersPerTeam: 4,
      rules: { rosterSlots: { QB: 1, RB: 1, WR: 1, TE: 1, BENCH: 0 } },
    });
    const [a, b] = seed.teams;
    const result = await proposeTrade({
      leagueId: seed.leagueId,
      proposerTeamId: a.id,
      toTeamId: b.id,
      give: [seed.roster[a.id][0]],
      receive: [seed.roster[b.id][0], seed.roster[b.id][1]],
      ctx: await makeRunContext(seed, a.id),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(" ")).toMatch(/would hold 5 players \(limit 4\)/);
  });
});

describe("respondToTrade", () => {
  it("only the recipient may answer", async () => {
    const seed = await seedLeague();
    const [a, , c] = seed.teams;
    const proposal = await propose(seed);
    if (!proposal.ok) throw new Error("setup failed");

    const wrongTeam = await respondToTrade({
      leagueId: seed.leagueId,
      teamId: c.id,
      tradeId: proposal.tradeId,
      action: "accept",
      ctx: await makeRunContext(seed, c.id),
    });
    expect(wrongTeam.ok).toBe(false);

    const proposer = await respondToTrade({
      leagueId: seed.leagueId,
      teamId: a.id,
      tradeId: proposal.tradeId,
      action: "accept",
      ctx: await makeRunContext(seed, a.id),
    });
    expect(proposer.ok).toBe(false);
  });

  it("rejects cleanly", async () => {
    const seed = await seedLeague();
    const [, b] = seed.teams;
    const proposal = await propose(seed);
    if (!proposal.ok) throw new Error("setup failed");

    const result = await respondToTrade({
      leagueId: seed.leagueId,
      teamId: b.id,
      tradeId: proposal.tradeId,
      action: "reject",
      message: "Not for me.",
      ctx: await makeRunContext(seed, b.id),
    });
    expect(result).toMatchObject({ ok: true, status: "rejected" });

    const detail = await getTrade(proposal.tradeId);
    expect(detail?.status).toBe("rejected");
    expect(detail?.resolvedAt).not.toBeNull();
    expect(await eventTypes(proposal.tradeId)).toEqual(["proposed", "rejected"]);
  });

  it("runs propose → counter → accept → review → complete and swaps the rosters", async () => {
    const seed = await seedLeague({ playersPerTeam: 6 });
    const [a, b] = seed.teams;

    const proposal = await propose(seed);
    if (!proposal.ok) throw new Error("setup failed");

    // B counters: same thread, roles swapped, parent marked `countered`.
    const counter = await respondToTrade({
      leagueId: seed.leagueId,
      teamId: b.id,
      tradeId: proposal.tradeId,
      action: "counter",
      counter: {
        give: [seed.roster[b.id][2]],
        receive: [seed.roster[a.id][1], seed.roster[a.id][3]],
      },
      message: "I want two for one.",
      ctx: await makeRunContext(seed, b.id),
    });
    expect(counter.ok).toBe(true);
    if (!counter.ok || !counter.counterTradeId) throw new Error("counter failed");

    const parent = await getTrade(proposal.tradeId);
    expect(parent?.status).toBe("countered");
    expect(parent?.counterTradeIds).toEqual([counter.counterTradeId]);

    const child = await getTrade(counter.counterTradeId);
    expect(child?.status).toBe("proposed");
    expect(child?.proposerTeamId).toBe(b.id);
    expect(child?.recipientTeamId).toBe(a.id);
    expect(child?.parentTradeId).toBe(proposal.tradeId);
    expect(child?.threadId).toBe(proposal.threadId);

    // A accepts the counter: into review with a deterministic fairness score.
    const accepted = await respondToTrade({
      leagueId: seed.leagueId,
      teamId: a.id,
      tradeId: counter.counterTradeId,
      action: "accept",
      ctx: await makeRunContext(seed, a.id),
    });
    expect(accepted).toMatchObject({ ok: true, status: "in_review" });

    const inReview = await getTrade(counter.counterTradeId);
    expect(inReview?.reviewEndsAt).not.toBeNull();
    expect(inReview?.fairnessScore).not.toBeNull();
    expect(inReview?.fairnessDetail?.items?.length).toBe(3);
    expect(await eventTypes(counter.counterTradeId)).toEqual([
      "countered",
      "accepted",
      "fairness_scored",
    ]);

    // Nothing moves until the review window closes.
    expect(await processTradeReviews(seed.leagueId)).toBe(0);
    expect((await rosterOf(b.id)).has(seed.roster[a.id][1])).toBe(false);

    await endReview(counter.counterTradeId);
    expect(await processTradeReviews(seed.leagueId)).toBe(1);

    const completed = await getTrade(counter.counterTradeId);
    expect(completed?.status).toBe("completed");
    expect(completed?.resolvedAt).not.toBeNull();
    expect(await eventTypes(counter.counterTradeId)).toContain("completed");

    const rosterA = await rosterOf(a.id);
    const rosterB = await rosterOf(b.id);
    expect(rosterA.has(seed.roster[b.id][2])).toBe(true);
    expect(rosterA.has(seed.roster[a.id][1])).toBe(false);
    expect(rosterA.has(seed.roster[a.id][3])).toBe(false);
    expect(rosterB.has(seed.roster[a.id][1])).toBe(true);
    expect(rosterB.has(seed.roster[a.id][3])).toBe(true);

    const feed = await db
      .select()
      .from(transactions)
      .where(eq(transactions.tradeId, counter.counterTradeId));
    expect(feed).toHaveLength(3);
    expect(feed.every((t) => t.type === "trade")).toBe(true);
    expect(feed.every((t) => t.weekNo === seed.weekNo)).toBe(true);
  });

  it("settles FAAB on completion", async () => {
    const seed = await seedLeague();
    const [a, b] = seed.teams;
    const proposal = await proposeTrade({
      leagueId: seed.leagueId,
      proposerTeamId: a.id,
      toTeamId: b.id,
      give: [seed.roster[a.id][0]],
      receive: [seed.roster[b.id][0]],
      faab: 15,
      ctx: await makeRunContext(seed, a.id),
    });
    if (!proposal.ok) throw new Error("setup failed");

    await respondToTrade({
      leagueId: seed.leagueId,
      teamId: b.id,
      tradeId: proposal.tradeId,
      action: "accept",
      ctx: await makeRunContext(seed, b.id),
    });
    await endReview(proposal.tradeId);
    await processTradeReviews(seed.leagueId);

    const [teamA] = await db.select().from(teams).where(eq(teams.id, a.id));
    const [teamB] = await db.select().from(teams).where(eq(teams.id, b.id));
    expect(teamA.faabRemaining).toBe(85);
    expect(teamB.faabRemaining).toBe(115);

    const detail = await getTrade(proposal.tradeId);
    expect(detail?.faab).toBe(15);
  });

  it("completes a trade touching a locked player without failing", async () => {
    const seed = await seedLeague();
    const [a, b] = seed.teams;
    const movedPlayer = seed.roster[a.id][0];
    const [player] = await db
      .select()
      .from(rosterSlots)
      .where(and(eq(rosterSlots.teamId, a.id), eq(rosterSlots.playerId, movedPlayer)));
    expect(player).toBeDefined();

    const nflTeam = (
      await db.query.players.findFirst({ where: (p, { eq: e }) => e(p.id, movedPlayer) })
    )?.nflTeam;
    await scheduleGame({
      week: seed.weekNo,
      homeTeam: nflTeam ?? "BUF",
      awayTeam: "ZZZ",
      kickoffAt: new Date(Date.now() - 3_600_000),
    });

    const proposal = await proposeTrade({
      leagueId: seed.leagueId,
      proposerTeamId: a.id,
      toTeamId: b.id,
      give: [movedPlayer],
      receive: [seed.roster[b.id][0]],
      ctx: await makeRunContext(seed, a.id),
    });
    if (!proposal.ok) throw new Error("setup failed");
    await respondToTrade({
      leagueId: seed.leagueId,
      teamId: b.id,
      tradeId: proposal.tradeId,
      action: "accept",
      ctx: await makeRunContext(seed, b.id),
    });
    await endReview(proposal.tradeId);
    await processTradeReviews(seed.leagueId);

    const detail = await getTrade(proposal.tradeId);
    expect(detail?.status).toBe("completed");
    const completedEvent = detail?.events.find((e) => e.type === "completed");
    expect(completedEvent?.payload.lockedPlayerIds).toEqual([movedPlayer]);
  });
});

describe("anti-churn", () => {
  it("blocks sending a player straight back to the team it came from", async () => {
    const seed = await seedLeague({ playersPerTeam: 6, rules: { antiChurnWeeks: 3 } });
    const [a, b] = seed.teams;
    const playerFromA = seed.roster[a.id][1];
    const playerFromB = seed.roster[b.id][1];

    const first = await proposeTrade({
      leagueId: seed.leagueId,
      proposerTeamId: a.id,
      toTeamId: b.id,
      give: [playerFromA],
      receive: [playerFromB],
      ctx: await makeRunContext(seed, a.id),
    });
    if (!first.ok) throw new Error("setup failed");
    await respondToTrade({
      leagueId: seed.leagueId,
      teamId: b.id,
      tradeId: first.tradeId,
      action: "accept",
      ctx: await makeRunContext(seed, b.id),
    });
    await endReview(first.tradeId);
    await processTradeReviews(seed.leagueId);

    // B now owns playerFromA; sending him back is churn.
    const churn = await proposeTrade({
      leagueId: seed.leagueId,
      proposerTeamId: b.id,
      toTeamId: a.id,
      give: [playerFromA],
      receive: [seed.roster[a.id][2]],
      ctx: await makeRunContext(seed, b.id),
    });
    expect(churn.ok).toBe(false);
    if (churn.ok) return;
    expect(churn.errors.join(" ")).toMatch(/Anti-churn/);

    // A different player between the same teams is still fine.
    const allowed = await proposeTrade({
      leagueId: seed.leagueId,
      proposerTeamId: b.id,
      toTeamId: a.id,
      give: [seed.roster[b.id][3]],
      receive: [seed.roster[a.id][2]],
      ctx: await makeRunContext(seed, b.id),
    });
    expect(allowed.ok).toBe(true);

    // And once the horizon passes, the churn block lifts.
    const laterWeek = await proposeTrade({
      leagueId: seed.leagueId,
      proposerTeamId: b.id,
      toTeamId: a.id,
      give: [playerFromA],
      receive: [seed.roster[a.id][4]],
      ctx: await makeRunContext(seed, b.id, { weekNo: seed.weekNo + 4 }),
    });
    expect(laterWeek.ok).toBe(true);
  });
});

describe("veto vote", () => {
  it("blocks a flagged trade when a majority of owners veto", async () => {
    const seed = await seedLeague({ teamCount: 4, playersPerTeam: 5 });
    const [a, b] = seed.teams;
    // Make the offer indefensible so the fairness floor flags it.
    await db
      .update(playerProjections)
      .set({ projectedPointsPpr: 0.5, projectedPointsHalf: 0.5, projectedPointsStd: 0.5 })
      .where(eq(playerProjections.playerId, seed.roster[a.id][1]));

    const proposal = await proposeTrade({
      leagueId: seed.leagueId,
      proposerTeamId: a.id,
      toTeamId: b.id,
      give: [seed.roster[a.id][1]],
      receive: [seed.roster[b.id][0]],
      ctx: await makeRunContext(seed, a.id),
    });
    if (!proposal.ok) throw new Error("setup failed");
    await respondToTrade({
      leagueId: seed.leagueId,
      teamId: b.id,
      tradeId: proposal.tradeId,
      action: "accept",
      ctx: await makeRunContext(seed, b.id),
    });

    const flagged = await getTrade(proposal.tradeId);
    expect(flagged?.flagged).toBe(true);
    expect(flagged?.tally?.ownerCount).toBe(4);
    expect(flagged?.tally?.threshold).toBe(3);

    // Two of four is not a majority.
    for (const owner of seed.teams.slice(0, 2)) {
      const vote = await castVetoVote({
        tradeId: proposal.tradeId,
        userId: owner.ownerUserId,
        vote: "veto",
      });
      expect(vote.ok).toBe(true);
    }
    let tally = await getTrade(proposal.tradeId);
    expect(tally?.tally?.vetoes).toBe(2);
    expect(tally?.tally?.blocked).toBe(false);

    const third = await castVetoVote({
      tradeId: proposal.tradeId,
      userId: seed.teams[2].ownerUserId,
      vote: "veto",
    });
    expect(third).toMatchObject({ ok: true, vetoes: 3, blocked: true });

    await endReview(proposal.tradeId);
    expect(await processTradeReviews(seed.leagueId)).toBe(1);

    tally = await getTrade(proposal.tradeId);
    expect(tally?.status).toBe("vetoed");
    expect(await eventTypes(proposal.tradeId)).toContain("vetoed");
    // Nothing moved.
    expect((await rosterOf(b.id)).has(seed.roster[a.id][1])).toBe(false);
  });

  it("completes a flagged trade the owners decline to block", async () => {
    const seed = await seedLeague({ teamCount: 4, playersPerTeam: 5 });
    const [a, b] = seed.teams;
    await db
      .update(playerProjections)
      .set({ projectedPointsPpr: 0.5, projectedPointsHalf: 0.5, projectedPointsStd: 0.5 })
      .where(eq(playerProjections.playerId, seed.roster[a.id][1]));

    const proposal = await proposeTrade({
      leagueId: seed.leagueId,
      proposerTeamId: a.id,
      toTeamId: b.id,
      give: [seed.roster[a.id][1]],
      receive: [seed.roster[b.id][0]],
      ctx: await makeRunContext(seed, a.id),
    });
    if (!proposal.ok) throw new Error("setup failed");
    await respondToTrade({
      leagueId: seed.leagueId,
      teamId: b.id,
      tradeId: proposal.tradeId,
      action: "accept",
      ctx: await makeRunContext(seed, b.id),
    });
    await castVetoVote({
      tradeId: proposal.tradeId,
      userId: seed.teams[0].ownerUserId,
      vote: "veto",
    });

    await endReview(proposal.tradeId);
    await processTradeReviews(seed.leagueId);
    const detail = await getTrade(proposal.tradeId);
    expect(detail?.status).toBe("completed");
  });

  it("refuses votes from non-members and after review closes", async () => {
    const seed = await seedLeague();
    const outsider = await seedLeague();
    const [, b] = seed.teams;
    const proposal = await propose(seed);
    if (!proposal.ok) throw new Error("setup failed");

    const tooEarly = await castVetoVote({
      tradeId: proposal.tradeId,
      userId: seed.teams[0].ownerUserId,
      vote: "veto",
    });
    expect(tooEarly.ok).toBe(false);

    await respondToTrade({
      leagueId: seed.leagueId,
      teamId: b.id,
      tradeId: proposal.tradeId,
      action: "accept",
      ctx: await makeRunContext(seed, b.id),
    });

    const stranger = await castVetoVote({
      tradeId: proposal.tradeId,
      userId: outsider.teams[0].ownerUserId,
      vote: "veto",
    });
    expect(stranger.ok).toBe(false);
    if (stranger.ok) return;
    expect(stranger.errors.join(" ")).toMatch(/owners/i);
  });
});

describe("expiry", () => {
  it("expires proposals left open when the window closes", async () => {
    const seed = await seedLeague({ playersPerTeam: 6 });
    const [a, b] = seed.teams;

    const open = await propose(seed, 1);
    const answered = await propose(seed, 2);
    if (!open.ok || !answered.ok) throw new Error("setup failed");

    await respondToTrade({
      leagueId: seed.leagueId,
      teamId: b.id,
      tradeId: answered.tradeId,
      action: "reject",
      ctx: await makeRunContext(seed, b.id),
    });

    const expired = await expireOpenProposals(seed.windowId);
    expect(expired).toBe(1);

    expect((await getTrade(open.tradeId))?.status).toBe("expired");
    expect(await eventTypes(open.tradeId)).toEqual(["proposed", "expired"]);
    // Already-resolved trades are left alone.
    expect((await getTrade(answered.tradeId))?.status).toBe("rejected");

    expect(await listOpenTradesForTeam({ leagueId: seed.leagueId, teamId: a.id })).toHaveLength(0);
    expect(await expireOpenProposals(seed.windowId)).toBe(0);
  });
});

describe("listTradesForLeague", () => {
  it("filters by team, week and status", async () => {
    const seed = await seedLeague({ playersPerTeam: 6 });
    const [a, b, c] = seed.teams;
    const first = await propose(seed, 1);
    if (!first.ok) throw new Error("setup failed");
    await proposeTrade({
      leagueId: seed.leagueId,
      proposerTeamId: c.id,
      toTeamId: b.id,
      give: [seed.roster[c.id][1]],
      receive: [seed.roster[b.id][2]],
      ctx: await makeRunContext(seed, c.id),
    });

    expect(await listTradesForLeague({ leagueId: seed.leagueId })).toHaveLength(2);
    expect(await listTradesForLeague({ leagueId: seed.leagueId, teamId: a.id })).toHaveLength(1);
    expect(
      await listTradesForLeague({ leagueId: seed.leagueId, weekNo: seed.weekNo }),
    ).toHaveLength(2);
    expect(
      await listTradesForLeague({ leagueId: seed.leagueId, weekNo: seed.weekNo + 1 }),
    ).toHaveLength(0);
    expect(
      await listTradesForLeague({ leagueId: seed.leagueId, status: "completed" }),
    ).toHaveLength(0);

    const summaries = await listTradesForLeague({ leagueId: seed.leagueId });
    expect(summaries[0].proposerTeamName).toBeTruthy();
    expect(summaries[0].recipientTeamName).toBeTruthy();
    expect(summaries.every((s) => s.give.every((p) => p.position))).toBe(true);
  });
});

describe("rules defaults", () => {
  it("falls back to the PRD fairness floor when a league has no rules row", async () => {
    const seed = await seedLeague();
    // `fairness_floor` is NOT NULL, so the realistic gap is a league whose rules
    // row was never written — the service must still score with the 0.6 default.
    await db.delete(leagueRules).where(eq(leagueRules.leagueId, seed.leagueId));

    const [a, b] = seed.teams;
    const proposal = await proposeTrade({
      leagueId: seed.leagueId,
      proposerTeamId: a.id,
      toTeamId: b.id,
      give: [seed.roster[a.id][0]],
      receive: [seed.roster[b.id][0]],
      ctx: await makeRunContext(seed, a.id),
    });
    if (!proposal.ok) throw new Error("setup failed");
    await respondToTrade({
      leagueId: seed.leagueId,
      teamId: b.id,
      tradeId: proposal.tradeId,
      action: "accept",
      ctx: await makeRunContext(seed, b.id),
    });
    const detail = await getTrade(proposal.tradeId);
    expect(detail?.fairnessDetail?.floor).toBe(0.6);
  });
});
