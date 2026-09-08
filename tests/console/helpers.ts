/**
 * Fixtures for the owner-console suite.
 *
 * Everything is created through the real services where one exists, and through
 * plain inserts where the owning package's service is still a stub.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import {
  leagueMembers,
  leagueRules,
  runs,
  snapshots,
  teams,
  usageEvents,
  windows,
  user,
} from "@/lib/db/schema";
import type { LeagueRules } from "@/lib/db/types";
import { createLeague } from "@/lib/services/league";
import { emptyDigest, type SnapshotPayload } from "@/lib/snapshot/types";
import { fromET } from "@/lib/time";

import { db } from "../setup";

/** Tuesday 2026-09-08 10:00 ET — inside the default edit window (Tue 06:00 → Wed 03:00). */
export const TUE_10_ET = fromET({ year: 2026, month: 9, day: 8, hour: 10 });
/** Friday 2026-09-11 10:00 ET — outside it. */
export const FRI_10_ET = fromET({ year: 2026, month: 9, day: 11, hour: 10 });

export async function makeUser(name = "Test Owner") {
  const [row] = await db
    .insert(user)
    .values({ id: randomUUID(), name, email: `u-${randomUUID()}@example.test` })
    .returning();
  return row;
}

export type Fixture = Awaited<ReturnType<typeof makeLeague>>;

/** A league with a commissioner, an owned team 1 and a second owner on team 2. */
export async function makeLeague(overrides: Partial<LeagueRules> = {}) {
  const commissioner = await makeUser("Commish");
  const owner = await makeUser("Owner One");
  const other = await makeUser("Owner Two");

  const { league, teams: created } = await createLeague({
    name: `Console League ${randomUUID().slice(0, 8)}`,
    commissionerUserId: commissioner.id,
    teamCount: 8,
    season: 2026,
  });

  await db.insert(leagueMembers).values([
    { leagueId: league.id, userId: owner.id, role: "owner" },
    { leagueId: league.id, userId: other.id, role: "owner" },
  ]);

  await db.update(teams).set({ ownerUserId: owner.id }).where(eq(teams.id, created[0].id));
  await db.update(teams).set({ ownerUserId: other.id }).where(eq(teams.id, created[1].id));

  if (Object.keys(overrides).length > 0) {
    await db
      .update(leagueRules)
      .set(overrides)
      .where(eq(leagueRules.leagueId, league.id));
  }

  const rules = await db.query.leagueRules.findFirst({
    where: eq(leagueRules.leagueId, league.id),
  });

  return {
    league,
    rules: rules!,
    commissioner,
    owner,
    other,
    team: created[0],
    otherTeam: created[1],
    teams: created,
  };
}

function emptyPayload(leagueId: string, weekNo: number): SnapshotPayload {
  return {
    version: 1,
    leagueId,
    leagueName: "Console League",
    season: 2026,
    weekNo,
    takenAt: new Date().toISOString(),
    rules: {
      scoringPreset: "ppr",
      superflex: false,
      tePremium: false,
      rosterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DEF: 1, BENCH: 6 },
      faabBudget: 100,
      injectionPolicy: "permitted",
      transparencyMode: "live",
      regularSeasonWeeks: 14,
      playoffStartWeek: 15,
      maxOpenProposals: 3,
      maxMessagesPerRun: 6,
      maxThreadsPerWindow: 4,
      forumPostsPerDay: 2,
      forumCommentsPerDay: 6,
      antiChurnWeeks: 3,
    },
    teams: [],
    players: {},
    freeAgentIds: [],
    games: [],
    matchups: [],
    standings: [],
    news: [],
    injuries: [],
    liveScores: {},
  };
}

/** A window + snapshot for a week, so runs and usage events can hang off it. */
export async function makeWindow(leagueId: string, weekNo: number, label = "lineup_sun_early") {
  const opensAt = new Date(Date.UTC(2026, 8, 6 + (weekNo - 1) * 7, 13, 0, 0));
  const [snapshot] = await db
    .insert(snapshots)
    .values({
      leagueId,
      season: 2026,
      weekNo,
      digest: emptyDigest(),
      payload: emptyPayload(leagueId, weekNo),
    })
    .returning();

  const [win] = await db
    .insert(windows)
    .values({
      leagueId,
      type: "lineup",
      label,
      weekNo,
      opensAt,
      submissionDeadlineAt: new Date(opensAt.getTime() + 3 * 3_600_000),
      closesAt: new Date(opensAt.getTime() + 4 * 3_600_000),
      snapshotId: snapshot.id,
      status: "closed",
    })
    .returning();

  return { window: win, snapshot };
}

/** A run plus one usage event per step, with the given per-step cost/tokens. */
export async function makeRunWithUsage(args: {
  leagueId: string;
  teamId: string;
  windowId: string;
  modelId: string;
  steps: number;
  costPerStepUsd: number;
  inputTokensPerStep?: number;
  outputTokensPerStep?: number;
  gatewayCostPerStepUsd?: number | null;
}) {
  const inputTokens = args.inputTokensPerStep ?? 1_000;
  const outputTokens = args.outputTokensPerStep ?? 200;

  const [run] = await db
    .insert(runs)
    .values({
      windowId: args.windowId,
      teamId: args.teamId,
      leagueId: args.leagueId,
      modelId: args.modelId,
      status: "succeeded",
      outcome: "lineup_set",
      stepCount: args.steps,
      totalCostUsd: args.costPerStepUsd * args.steps,
      totalInputTokens: inputTokens * args.steps,
      totalOutputTokens: outputTokens * args.steps,
    })
    .returning();

  await db.insert(usageEvents).values(
    Array.from({ length: args.steps }, (_, i) => ({
      runId: run.id,
      stepIndex: i,
      teamId: args.teamId,
      leagueId: args.leagueId,
      modelId: args.modelId,
      provider: args.modelId.split("/")[0],
      inputTokens,
      outputTokens,
      costUsd: args.costPerStepUsd,
      gatewayCostUsd: args.gatewayCostPerStepUsd ?? null,
    })),
  );

  return run;
}
