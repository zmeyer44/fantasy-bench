/**
 * Fixtures for the public-package suites. Everything is built directly against
 * the schema so these tests do not depend on other packages' services landing.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  agentConfigs,
  configVersions,
  runActions,
  runSteps,
  runs,
  players,
  teams,
  user,
  windows,
} from "@/lib/db/schema";
import type { Position } from "@/lib/db/types";
import { createLeague } from "@/lib/services/league";

export async function makeUser(name = "Test Owner", email = `u-${randomUUID()}@example.test`) {
  const [row] = await db.insert(user).values({ id: randomUUID(), name, email }).returning();
  return row;
}

export async function makeLeague(opts: { teamCount?: number; name?: string } = {}) {
  const commissioner = await makeUser("Commish");
  const result = await createLeague({
    name: opts.name ?? `League ${randomUUID().slice(0, 8)}`,
    commissionerUserId: commissioner.id,
    teamCount: opts.teamCount ?? 8,
    season: 2026,
  });
  return { ...result, commissioner };
}

export async function makePlayer(fullName: string, position: Position = "WR") {
  const [row] = await db
    .insert(players)
    .values({
      sleeperId: `sl-${randomUUID().slice(0, 12)}`,
      fullName,
      position,
      nflTeam: "SF",
    })
    .returning();
  return row;
}

export async function makeWindow(
  leagueId: string,
  opts: { type?: "lineup" | "waiver" | "trade" | "draft"; label?: string; weekNo?: number } = {},
) {
  const now = new Date();
  const [row] = await db
    .insert(windows)
    .values({
      leagueId,
      type: opts.type ?? "lineup",
      label: opts.label ?? "lineup_sun_early",
      weekNo: opts.weekNo ?? 1,
      opensAt: new Date(now.getTime() - 3_600_000),
      submissionDeadlineAt: new Date(now.getTime() + 1_800_000),
      closesAt: new Date(now.getTime() + 3_600_000),
      status: "open",
    })
    .returning();
  return row;
}

/** A run with one step and one committed action — the minimum a trace needs. */
export async function makeRun(args: {
  leagueId: string;
  windowId: string;
  teamId: string;
  modelId?: string;
  rationale?: string;
  stepText?: string;
  toolName?: string;
  actionPayload?: Record<string, unknown>;
  status?: "succeeded" | "failed" | "fallback" | "partial";
}) {
  const [run] = await db
    .insert(runs)
    .values({
      leagueId: args.leagueId,
      windowId: args.windowId,
      teamId: args.teamId,
      modelId: args.modelId ?? "mock/scripted",
      status: args.status ?? "succeeded",
      outcome: "lineup_set",
      rationale: args.rationale ?? null,
      stepCount: 1,
      totalCostUsd: 0.0123,
      startedAt: new Date(Date.now() - 5000),
      finishedAt: new Date(),
    })
    .returning();

  const toolCallId = `call-${randomUUID().slice(0, 8)}`;
  await db.insert(runSteps).values({
    runId: run.id,
    stepIndex: 0,
    modelId: run.modelId,
    text: args.stepText ?? "Setting the lineup.",
    messages: [{ role: "system", content: "You manage a fantasy football team." }],
    toolCalls: [
      {
        toolCallId,
        toolName: args.toolName ?? "set_lineup",
        input: args.actionPayload ?? {},
      },
    ],
    toolResults: [{ toolCallId, output: { ok: true } }],
    usage: { inputTokens: 100, outputTokens: 40 },
    costUsd: 0.0123,
  });

  await db.insert(runActions).values({
    runId: run.id,
    toolCallId,
    stepIndex: 0,
    actionType: args.toolName ?? "set_lineup",
    payload: args.actionPayload ?? {},
    validationResult: { ok: true },
    committedAt: new Date(),
  });

  return run;
}

/** The team's live config version row. */
export async function currentVersion(teamId: string) {
  const config = await db.query.agentConfigs.findFirst({
    where: eq(agentConfigs.teamId, teamId),
  });
  if (!config?.currentVersionId) return null;
  return db.query.configVersions.findFirst({
    where: eq(configVersions.id, config.currentVersionId),
  });
}

export async function teamsOf(leagueId: string) {
  return db.select().from(teams).where(eq(teams.leagueId, leagueId));
}
