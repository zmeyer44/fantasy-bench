/**
 * Fixtures for the social suite: a league with owners, teams, rostered players
 * and a decision window, plus a way to mint agent run contexts.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import {
  leagueMembers,
  leagueRules,
  nflGames,
  playerProjections,
  players,
  rosterSlots,
  runs,
  teams,
  user,
  windows,
} from "@/lib/db/schema";
import type { AgentContext } from "@/lib/services/messaging";
import { createLeague } from "@/lib/services/league";

import { db } from "../setup";

export const SEASON = 2026;

export type SeededTeam = { id: string; name: string; ownerUserId: string };

export type SeededLeague = {
  leagueId: string;
  commissionerUserId: string;
  teams: SeededTeam[];
  windowId: string;
  weekNo: number;
  /** Rostered player ids by team id, in the order they were created. */
  roster: Record<string, string[]>;
  playerName: Map<string, string>;
};

export async function makeUser(name = "Owner"): Promise<string> {
  const id = randomUUID();
  await db.insert(user).values({ id, name, email: `${id}@example.test` });
  return id;
}

/**
 * A league with `teamCount` owned teams, `playersPerTeam` rostered players each
 * (QB/RB/WR/TE cycling), a projection row per player, and an open trade window.
 */
export async function seedLeague(opts?: {
  teamCount?: number;
  playersPerTeam?: number;
  weekNo?: number;
  rules?: Partial<typeof leagueRules.$inferInsert>;
  windowClosesAt?: Date;
}): Promise<SeededLeague> {
  const teamCount = opts?.teamCount ?? 4;
  const playersPerTeam = opts?.playersPerTeam ?? 4;
  const weekNo = opts?.weekNo ?? 3;

  const commissionerUserId = await makeUser("Commissioner");
  const { league, teams: created } = await createLeague({
    name: `Social League ${randomUUID().slice(0, 8)}`,
    commissionerUserId,
    teamCount: Math.max(8, teamCount),
    season: SEASON,
  });

  if (opts?.rules) {
    await db.update(leagueRules).set(opts.rules).where(eq(leagueRules.leagueId, league.id));
  }

  // Give the first `teamCount` teams human owners so veto votes have a quorum.
  const seeded: SeededTeam[] = [];
  for (let i = 0; i < teamCount; i++) {
    const team = created[i];
    const ownerUserId =
      i === 0 ? commissionerUserId : await makeUser(`Owner ${i + 1}`);
    if (i > 0) {
      await db
        .insert(leagueMembers)
        .values({ leagueId: league.id, userId: ownerUserId, role: "owner" });
    }
    await db.update(teams).set({ ownerUserId }).where(eq(teams.id, team.id));
    seeded.push({ id: team.id, name: team.name, ownerUserId });
  }

  const positions = ["QB", "RB", "WR", "TE"] as const;
  const roster: Record<string, string[]> = {};
  const playerName = new Map<string, string>();

  for (const [teamIndex, team] of seeded.entries()) {
    roster[team.id] = [];
    for (let p = 0; p < playersPerTeam; p++) {
      const position = positions[p % positions.length];
      const name = `${team.name} ${position}${p + 1}`;
      const [player] = await db
        .insert(players)
        .values({
          sleeperId: `sleeper-${randomUUID()}`,
          fullName: name,
          position,
          nflTeam: NFL_TEAMS[(teamIndex * playersPerTeam + p) % NFL_TEAMS.length],
        })
        .returning();
      playerName.set(player.id, name);
      roster[team.id].push(player.id);

      await db.insert(rosterSlots).values({
        teamId: team.id,
        playerId: player.id,
        acquiredVia: "draft",
      });
      // A descending projection ladder so trades have a clear value gradient.
      await db.insert(playerProjections).values({
        playerId: player.id,
        season: SEASON,
        week: weekNo,
        source: "test",
        projectedPointsPpr: 20 - p * 3,
        projectedPointsHalf: 18 - p * 3,
        projectedPointsStd: 16 - p * 3,
      });
    }
  }

  const now = new Date();
  const [window] = await db
    .insert(windows)
    .values({
      leagueId: league.id,
      type: "trade",
      label: "trade_a",
      weekNo,
      opensAt: now,
      submissionDeadlineAt: new Date(now.getTime() + 3_600_000),
      closesAt: opts?.windowClosesAt ?? new Date(now.getTime() + 7_200_000),
      status: "open",
    })
    .returning();

  return {
    leagueId: league.id,
    commissionerUserId,
    teams: seeded,
    windowId: window.id,
    weekNo,
    roster,
    playerName,
  };
}

const NFL_TEAMS = ["BUF", "MIA", "NE", "NYJ", "KC", "LAC", "DEN", "LV", "SF", "SEA", "DAL", "PHI"];

/** A `runs` row plus the `AgentContext` the write services expect. */
export async function makeRunContext(
  seed: SeededLeague,
  teamId: string,
  overrides?: Partial<AgentContext>,
): Promise<AgentContext> {
  const [run] = await db
    .insert(runs)
    .values({
      windowId: seed.windowId,
      teamId,
      leagueId: seed.leagueId,
      modelId: "mock/deterministic",
      kind: "team",
      status: "running",
      startedAt: new Date(),
    })
    .returning();

  return {
    runId: run.id,
    stepIndex: 1,
    toolCallId: `call-${randomUUID().slice(0, 8)}`,
    configVersionId: null,
    windowId: seed.windowId,
    weekNo: seed.weekNo,
    ...overrides,
  };
}

/** Mark a run finished so `getInboxForTeam`'s unread watermark moves. */
export async function finishRun(runId: string, finishedAt = new Date()): Promise<void> {
  await db
    .update(runs)
    .set({ status: "succeeded", finishedAt })
    .where(eq(runs.id, runId));
}

/** Schedule an NFL game so a player counts as locked. */
export async function scheduleGame(args: {
  week: number;
  homeTeam: string;
  awayTeam: string;
  kickoffAt: Date;
}): Promise<void> {
  await db.insert(nflGames).values({
    season: SEASON,
    week: args.week,
    gameId: `game-${randomUUID()}`,
    homeTeam: args.homeTeam,
    awayTeam: args.awayTeam,
    kickoffAt: args.kickoffAt,
    status: "scheduled",
  });
}
