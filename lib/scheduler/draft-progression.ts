/**
 * Draft progression, driven by the tick (PRD §5.2).
 *
 * Snake: exactly one `draft` window is open at a time, scoped to the team on the
 * clock, with a pick clock from `league_rules.draft_pick_seconds`. At close the
 * platform auto-picks the best available player by the window snapshot's
 * projection. Snapshots are reused across picks inside
 * `league_rules.reuse_snapshot_within_ms` so a 12-team draft does not rebuild a
 * 400-player payload every four minutes.
 *
 * Auction: a nomination window for the nominating team, then a sealed-bid window
 * for every team, per lot.
 */
import { and, asc, count, eq, isNull, sql } from "drizzle-orm";

import { db, type DbOrTx } from "@/lib/db";
import { runCommissionerTask } from "@/lib/services/commissioner-agent";
import {
  auctionNominations,
  draftPicks,
  leagueRules,
  leagues,
  rosterSlots,
  teams,
  windows,
} from "@/lib/db/schema";
import type { League, LeagueRules, Window } from "@/lib/db/types";
import {
  bestAvailablePlayerId,
  draftedPlayerIds,
  finalizeDraft,
  nextPick,
  recordDraftPick,
  resolveAuctionLot,
} from "@/lib/services/draft";
import { loadSnapshot, takeSnapshot, latestSnapshotForLeague } from "@/lib/services/snapshot";
import { rosterCapacity } from "@/lib/services/waivers";
import type { SnapshotPayload } from "@/lib/snapshot/types";

import { createRunsForWindow, teamIdsForLeague, terminateOpenRuns } from "./runs";

export type DraftProgressReport = {
  opened: number;
  closed: number;
  autoPicks: number;
  finalized: boolean;
};

/** A run context for platform-made (auto) actions: no run, no step. */
const PLATFORM_CTX = {
  runId: "",
  stepIndex: 0,
  toolCallId: "",
  configVersionId: null,
  windowId: "",
  weekNo: 0,
};

/**
 * Reuse the newest snapshot when it is fresh enough, otherwise take a new one.
 * Returns the snapshot id and its payload (needed for auto-picks).
 */
async function snapshotForDraftWindow(
  league: League,
  rules: LeagueRules,
  now: Date,
  executor: DbOrTx,
): Promise<{ snapshotId: string; payload: SnapshotPayload }> {
  const latest = await latestSnapshotForLeague(league.id, executor);
  if (
    latest &&
    rules.reuseSnapshotWithinMs > 0 &&
    now.getTime() - latest.takenAt.getTime() <= rules.reuseSnapshotWithinMs
  ) {
    const loaded = await loadSnapshot(latest.id, executor);
    return { snapshotId: loaded.id, payload: loaded.payload };
  }
  const taken = await takeSnapshot({ leagueId: league.id, weekNo: 1, now }, executor);
  return { snapshotId: taken.snapshotId, payload: taken.payload };
}

function pickDeadlines(now: Date, pickSeconds: number): { closesAt: Date; submissionDeadlineAt: Date } {
  const closesAt = new Date(now.getTime() + pickSeconds * 1000);
  // A 4-minute clock cannot carry the 10-minute lead the weekly windows use.
  const lead = Math.min(60_000, Math.floor(pickSeconds * 1000 * 0.25));
  return { closesAt, submissionDeadlineAt: new Date(closesAt.getTime() - lead) };
}

/** Commissioner Agent draft recap (PRD 5.10); best-effort so a model outage never blocks finalization. */
async function publishDraftRecap(leagueId: string): Promise<void> {
  try {
    await runCommissionerTask("draft_recap", { leagueId });
  } catch (error) {
    console.error(`[draft] commissioner draft recap failed for league ${leagueId}:`, error);
  }
}

export async function progressDraft(
  leagueId: string,
  now: Date = new Date(),
  executor: DbOrTx = db,
): Promise<DraftProgressReport> {
  const report: DraftProgressReport = { opened: 0, closed: 0, autoPicks: 0, finalized: false };

  const league = await executor.query.leagues.findFirst({ where: eq(leagues.id, leagueId) });
  const rules = await executor.query.leagueRules.findFirst({
    where: eq(leagueRules.leagueId, leagueId),
  });
  if (!league || !rules || league.status !== "drafting") return report;
  if (league.draftScheduledAt && league.draftScheduledAt.getTime() > now.getTime()) return report;

  return league.draftType === "auction"
    ? progressAuction(league, rules, now, executor, report)
    : progressSnake(league, rules, now, executor, report);
}

// ------------------------------------------------------------------- snake

async function progressSnake(
  league: League,
  rules: LeagueRules,
  now: Date,
  executor: DbOrTx,
  report: DraftProgressReport,
): Promise<DraftProgressReport> {
  const open = await executor
    .select()
    .from(windows)
    .where(
      and(
        eq(windows.leagueId, league.id),
        eq(windows.type, "draft"),
        eq(windows.status, "open"),
      ),
    )
    .orderBy(asc(windows.opensAt));

  for (const window of open) {
    if (window.closesAt.getTime() > now.getTime()) return report; // still on the clock
    await closeSnakePickWindow(league, window, now, executor, report);
  }

  const pick = await nextPick(league.id, executor);
  if (!pick) {
    const snapshot = await snapshotForDraftWindow(league, rules, now, executor);
    await finalizeDraft(league.id, snapshot.payload, executor);
    report.finalized = true;
    await publishDraftRecap(league.id);
    return report;
  }

  const { snapshotId } = await snapshotForDraftWindow(league, rules, now, executor);
  const { closesAt, submissionDeadlineAt } = pickDeadlines(now, rules.draftPickSeconds);

  const [created] = await executor
    .insert(windows)
    .values({
      leagueId: league.id,
      type: "draft",
      label: "draft_pick",
      // Draft windows are not week-scoped; 0 keeps the (league,label,week,round)
      // uniqueness usable (NULLs would compare distinct in Postgres).
      weekNo: 0,
      roundNo: pick.overallNo,
      opensAt: now,
      submissionDeadlineAt,
      closesAt,
      snapshotId,
      status: "open",
      scope: {
        pickNo: pick.overallNo,
        round: pick.round,
        onTheClockTeamId: pick.teamId,
      },
    })
    .onConflictDoNothing({
      target: [windows.leagueId, windows.label, windows.weekNo, windows.roundNo],
    })
    .returning();

  if (created) {
    await createRunsForWindow(created, [pick.teamId], executor);
    report.opened++;
  }
  return report;
}

async function closeSnakePickWindow(
  league: League,
  window: Window,
  now: Date,
  executor: DbOrTx,
  report: DraftProgressReport,
): Promise<void> {
  await executor.update(windows).set({ status: "closing" }).where(eq(windows.id, window.id));

  const pick = await executor.query.draftPicks.findFirst({
    where: and(
      eq(draftPicks.leagueId, league.id),
      eq(draftPicks.overallNo, window.scope.pickNo ?? -1),
    ),
  });

  if (pick && pick.playerId === null) {
    const payload = window.snapshotId
      ? await loadSnapshot(window.snapshotId, executor)
          .then((s) => s.payload)
          .catch(() => null)
      : null;
    const playerId = await bestAvailablePlayerId(league.id, pick.teamId, payload, executor);
    if (playerId) {
      const result = await recordDraftPick(
        {
          leagueId: league.id,
          windowId: window.id,
          teamId: pick.teamId,
          playerId,
          ctx: { ...PLATFORM_CTX, windowId: window.id },
          auto: true,
          rationale: "Auto-pick: best available by projection after the pick clock expired.",
          now,
        },
        executor,
      );
      if (result.ok) report.autoPicks++;
    }
  }

  await terminateOpenRuns(window.id, now, executor);
  await executor.update(windows).set({ status: "closed" }).where(eq(windows.id, window.id));
  report.closed++;
}

// ----------------------------------------------------------------- auction

async function progressAuction(
  league: League,
  rules: LeagueRules,
  now: Date,
  executor: DbOrTx,
  report: DraftProgressReport,
): Promise<DraftProgressReport> {
  const open = await executor
    .select()
    .from(windows)
    .where(
      and(eq(windows.leagueId, league.id), eq(windows.type, "draft"), eq(windows.status, "open")),
    )
    .orderBy(asc(windows.opensAt));

  for (const window of open) {
    if (window.closesAt.getTime() > now.getTime()) return report;

    await executor.update(windows).set({ status: "closing" }).where(eq(windows.id, window.id));
    const lotNo = window.roundNo;
    const lot = await executor.query.auctionNominations.findFirst({
      where: and(eq(auctionNominations.leagueId, league.id), eq(auctionNominations.lotNo, lotNo)),
    });

    if (window.label === "auction_nominate" && lot && lot.status === "awaiting_nomination") {
      // Nobody nominated: the platform nominates the best available at $1.
      const payload = window.snapshotId
        ? await loadSnapshot(window.snapshotId, executor).then((s) => s.payload).catch(() => null)
        : null;
      const playerId = await bestAvailablePlayerId(
        league.id,
        lot.nominatingTeamId,
        payload,
        executor,
      );
      if (playerId) {
        await executor
          .update(auctionNominations)
          .set({ playerId, status: "open", openingBid: 1, windowId: window.id })
          .where(eq(auctionNominations.id, lot.id));
        report.autoPicks++;
      }
    } else if (window.label === "auction_bid" && lot && lot.status === "open") {
      await resolveAuctionLot(lot.id, now, executor);
      await createNextLot(league.id, lot.lotNo, executor);
    }

    await terminateOpenRuns(window.id, now, executor);
    await executor.update(windows).set({ status: "closed" }).where(eq(windows.id, window.id));
    report.closed++;
  }

  if (await auctionComplete(league.id, executor)) {
    const snapshot = await snapshotForDraftWindow(league, rules, now, executor);
    await finalizeDraft(league.id, snapshot.payload, executor);
    report.finalized = true;
    await publishDraftRecap(league.id);
    return report;
  }

  const lot = await executor.query.auctionNominations.findFirst({
    where: and(
      eq(auctionNominations.leagueId, league.id),
      sql`${auctionNominations.status} in ('awaiting_nomination', 'open')`,
    ),
    orderBy: asc(auctionNominations.lotNo),
  });
  if (!lot) return report;

  const { snapshotId } = await snapshotForDraftWindow(league, rules, now, executor);
  const { closesAt, submissionDeadlineAt } = pickDeadlines(now, rules.draftPickSeconds);
  const isNomination = lot.status === "awaiting_nomination";

  const [created] = await executor
    .insert(windows)
    .values({
      leagueId: league.id,
      type: "draft",
      label: isNomination ? "auction_nominate" : "auction_bid",
      weekNo: 0,
      roundNo: lot.lotNo,
      opensAt: now,
      submissionDeadlineAt,
      closesAt,
      snapshotId,
      status: "open",
      scope: isNomination
        ? { nominationTeamId: lot.nominatingTeamId, lotNo: lot.lotNo }
        : { lotNo: lot.lotNo, playerId: lot.playerId },
    })
    .onConflictDoNothing({
      target: [windows.leagueId, windows.label, windows.weekNo, windows.roundNo],
    })
    .returning();

  if (created) {
    const teamIds = isNomination
      ? [lot.nominatingTeamId]
      : await teamIdsForLeague(league.id, executor);
    await createRunsForWindow(created, teamIds, executor);
    report.opened++;
  }
  return report;
}

/** The next lot rotates the nomination to the next team in draft order. */
async function createNextLot(
  leagueId: string,
  previousLotNo: number,
  executor: DbOrTx,
): Promise<void> {
  if (await auctionComplete(leagueId, executor)) return;
  const leagueTeams = await executor
    .select({ id: teams.id })
    .from(teams)
    .where(eq(teams.leagueId, leagueId))
    .orderBy(asc(teams.createdAt), asc(teams.name));
  if (leagueTeams.length === 0) return;
  const nextTeam = leagueTeams[previousLotNo % leagueTeams.length].id;
  await executor
    .insert(auctionNominations)
    .values({
      leagueId,
      lotNo: previousLotNo + 1,
      nominatingTeamId: nextTeam,
      status: "awaiting_nomination",
    })
    .onConflictDoNothing({ target: [auctionNominations.leagueId, auctionNominations.lotNo] });
}

async function auctionComplete(leagueId: string, executor: DbOrTx): Promise<boolean> {
  const rules = await executor.query.leagueRules.findFirst({
    where: eq(leagueRules.leagueId, leagueId),
  });
  if (!rules) return false;
  const capacity = rosterCapacity(rules.rosterSlots);
  const leagueTeams = await executor
    .select({ id: teams.id })
    .from(teams)
    .where(eq(teams.leagueId, leagueId));
  const filled = await executor
    .select({ n: count() })
    .from(rosterSlots)
    .innerJoin(teams, eq(teams.id, rosterSlots.teamId))
    .where(eq(teams.leagueId, leagueId));
  return (filled[0]?.n ?? 0) >= capacity * leagueTeams.length;
}

/** How far along the draft is — used by the tick report and the draft page. */
export async function draftProgress(
  leagueId: string,
  executor: DbOrTx = db,
): Promise<{ made: number; total: number }> {
  const total = await executor
    .select({ n: count() })
    .from(draftPicks)
    .where(eq(draftPicks.leagueId, leagueId));
  const remaining = await executor
    .select({ n: count() })
    .from(draftPicks)
    .where(and(eq(draftPicks.leagueId, leagueId), isNull(draftPicks.playerId)));
  const totalN = Number(total[0]?.n ?? 0);
  return { made: totalN - Number(remaining[0]?.n ?? 0), total: totalN };
}

export async function drafted(leagueId: string, executor: DbOrTx = db): Promise<Set<string>> {
  return draftedPlayerIds(leagueId, executor);
}

