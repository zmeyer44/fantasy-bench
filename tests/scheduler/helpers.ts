/**
 * Shared fixtures + factories for the scheduler suite.
 *
 * Everything here writes through the real services so the tests exercise the
 * same code paths the tick does.
 */
import { eq } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";

import { db } from "@/lib/db";
import {
  leagueRules,
  nflGames,
  playerProjections,
  players,
  playerStatsWeekly,
  rosterSlots,
  teams,
  user,
} from "@/lib/db/schema";
import type { NormalizedProjection } from "@/lib/providers/types";
import { createLeague } from "@/lib/services/league";
import type { StatLine } from "@/lib/db/schema";

export const FIXTURES = path.join(process.cwd(), "tests", "scheduler", "fixtures");

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8")) as T;
}

export function fixtureText(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), "utf8");
}

let userSeq = 0;

export async function createTestUser(email?: string): Promise<string> {
  const id = `test-user-${++userSeq}-${Math.random().toString(36).slice(2, 8)}`;
  await db.insert(user).values({
    id,
    name: "Test Owner",
    email: email ?? `${id}@example.test`,
    emailVerified: true,
  });
  return id;
}

export type TestLeague = {
  leagueId: string;
  userId: string;
  teamIds: string[];
  season: number;
};

export async function createTestLeague(
  opts: { teamCount?: number; season?: number; regularSeasonWeeks?: number } = {},
): Promise<TestLeague> {
  const userId = await createTestUser();
  const season = opts.season ?? 2026;
  const result = await createLeague({
    name: `Test League ${Math.random().toString(36).slice(2, 8)}`,
    commissionerUserId: userId,
    teamCount: opts.teamCount ?? 8,
    season,
    regularSeasonWeeks: opts.regularSeasonWeeks ?? 14,
    modelAllowlist: ["mock/scripted"],
  });
  return {
    leagueId: result.league.id,
    userId,
    teamIds: result.teams.map((t) => t.id),
    season,
  };
}

export type SeededPlayer = { id: string; sleeperId: string; position: string; nflTeam: string };

/**
 * A compact but realistic player universe: enough at every position for a
 * 12-team roster shape, spread across a handful of NFL teams.
 */
export async function seedPlayers(count = 120): Promise<SeededPlayer[]> {
  const positions: Array<{ pos: "QB" | "RB" | "WR" | "TE" | "K" | "DEF"; share: number }> = [
    { pos: "QB", share: 0.15 },
    { pos: "RB", share: 0.25 },
    { pos: "WR", share: 0.3 },
    { pos: "TE", share: 0.12 },
    { pos: "K", share: 0.09 },
    { pos: "DEF", share: 0.09 },
  ];
  const nflTeams = ["KC", "BUF", "SF", "DAL", "PHI", "DET", "BAL", "MIA"];
  const rows: Array<typeof players.$inferInsert> = [];
  let n = 0;
  for (const { pos, share } of positions) {
    const many = Math.max(2, Math.round(count * share));
    for (let i = 0; i < many; i++) {
      const nflTeam = nflTeams[n % nflTeams.length];
      rows.push({
        sleeperId: pos === "DEF" ? `${nflTeam}-${i}` : `p${++n}`,
        fullName: `${pos} Player ${i + 1}`,
        position: pos,
        nflTeam,
        searchRank: n,
        fantasyPositions: [pos],
        raw: {},
      });
      n++;
    }
  }
  const inserted = await db.insert(players).values(rows).returning({
    id: players.id,
    sleeperId: players.sleeperId,
    position: players.position,
    nflTeam: players.nflTeam,
  });
  return inserted.map((p) => ({
    id: p.id,
    sleeperId: p.sleeperId,
    position: p.position,
    nflTeam: p.nflTeam ?? "KC",
  }));
}

/** Descending projections so "best available" is deterministic. */
export async function seedProjections(
  seeded: SeededPlayer[],
  season: number,
  week: number,
  effectiveAt = new Date("2026-09-08T12:00:00Z"),
): Promise<void> {
  await db.insert(playerProjections).values(
    seeded.map((p, i) => ({
      playerId: p.id,
      season,
      week,
      source: "test",
      projectedPointsPpr: Math.max(1, 30 - i * 0.2),
      projectedPointsHalf: Math.max(1, 28 - i * 0.2),
      projectedPointsStd: Math.max(1, 26 - i * 0.2),
      stats: { pts_ppr: Math.max(1, 30 - i * 0.2) } as StatLine,
      effectiveAt,
    })),
  );
}

export async function seedStats(
  entries: Array<{ playerId: string; stats: StatLine; ppr: number }>,
  season: number,
  week: number,
): Promise<void> {
  if (entries.length === 0) return;
  await db.insert(playerStatsWeekly).values(
    entries.map((e) => ({
      playerId: e.playerId,
      season,
      week,
      source: "test",
      stats: e.stats,
      fantasyPointsPpr: e.ppr,
      fantasyPointsHalf: e.ppr,
      fantasyPointsStd: e.ppr,
    })),
  );
}

/**
 * A one-week NFL slate covering every `dayBucket`: a Thursday nighter, an early
 * and a late Sunday game, and Monday night.
 */
export async function seedGames(
  season: number,
  week: number,
  opts: { final?: boolean } = {},
): Promise<void> {
  const status = opts.final ? "final" : "scheduled";
  await db.insert(nflGames).values([
    {
      season,
      week,
      gameId: `${season}_${week}_KC_BUF`,
      homeTeam: "BUF",
      awayTeam: "KC",
      // Thu 2026-09-10 20:15 ET
      kickoffAt: new Date("2026-09-11T00:15:00Z"),
      status,
    },
    {
      season,
      week,
      gameId: `${season}_${week}_SF_DAL`,
      homeTeam: "DAL",
      awayTeam: "SF",
      // Sun 13:00 ET -> sun_early
      kickoffAt: new Date("2026-09-13T17:00:00Z"),
      status,
    },
    {
      season,
      week,
      gameId: `${season}_${week}_PHI_DET`,
      homeTeam: "DET",
      awayTeam: "PHI",
      // Sun 16:25 ET -> sun_late
      kickoffAt: new Date("2026-09-13T20:25:00Z"),
      status,
    },
    {
      season,
      week,
      gameId: `${season}_${week}_BAL_MIA`,
      homeTeam: "MIA",
      awayTeam: "BAL",
      // Mon 20:15 ET
      kickoffAt: new Date("2026-09-15T00:15:00Z"),
      status,
    },
  ]);
}

/** Give a team a legal 15-man roster from the seeded pool. */
export async function fillRoster(
  teamId: string,
  pool: SeededPlayer[],
  used: Set<string>,
  shape: Record<string, number> = { QB: 1, RB: 3, WR: 4, TE: 2, K: 1, DEF: 1 },
): Promise<string[]> {
  const chosen: string[] = [];
  for (const [pos, want] of Object.entries(shape)) {
    let taken = 0;
    for (const p of pool) {
      if (taken >= want) break;
      if (p.position !== pos || used.has(p.id)) continue;
      used.add(p.id);
      chosen.push(p.id);
      taken++;
    }
  }
  if (chosen.length > 0) {
    await db
      .insert(rosterSlots)
      .values(chosen.map((playerId) => ({ teamId, playerId, acquiredVia: "draft" as const })));
  }
  return chosen;
}

export async function setRules(
  leagueId: string,
  patch: Partial<typeof leagueRules.$inferInsert>,
): Promise<void> {
  await db.update(leagueRules).set(patch).where(eq(leagueRules.leagueId, leagueId));
}

export async function teamIds(leagueId: string): Promise<string[]> {
  const rows = await db
    .select({ id: teams.id })
    .from(teams)
    .where(eq(teams.leagueId, leagueId))
    .orderBy(teams.createdAt, teams.name);
  return rows.map((r) => r.id);
}

/** Normalized projection rows for provider-level ingestion tests. */
export function projectionRow(
  overrides: Partial<NormalizedProjection> & { sleeperId: string },
): NormalizedProjection {
  return {
    season: 2026,
    week: 1,
    position: "WR",
    team: "KC",
    opponent: "BUF",
    gameId: null,
    pointsPpr: 10,
    pointsHalf: 8,
    pointsStd: 6,
    stats: { pts_ppr: 10 },
    effectiveAt: new Date(),
    source: "test",
    ...overrides,
  };
}
