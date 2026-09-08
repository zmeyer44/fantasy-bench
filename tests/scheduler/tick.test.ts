/**
 * The tick. Opens windows (snapshot + one run per team), closes them (applying
 * the lineup fallback through the runtime package's contract), reaps expired
 * leases, dispatches pending runs, and does all of it idempotently.
 */
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The runtime package owns lineup logic; the tick only calls its contract.
vi.mock("@/lib/services/lineup", () => ({
  applySafetyAutopilot: vi.fn(async () => ({ slots: [], changed: true, filledSlots: ["RB1"] })),
  computeOptimalLineup: vi.fn(() => []),
  commitLineup: vi.fn(async () => ({ lineupId: "stub", version: 1 })),
  validateLineup: vi.fn(() => ({ ok: true })),
}));

import { db } from "@/lib/db";
import { runs, snapshots, weeks, windows } from "@/lib/db/schema";
import { materializeWindows } from "@/lib/scheduler/materialize";
import { closeWindowNow, currentWeekNo, openWindowNow, runTick } from "@/lib/scheduler/tick";
import { applySafetyAutopilot } from "@/lib/services/lineup";

import { truncateAll } from "../setup";
import { createTestLeague, fillRoster, seedGames, seedPlayers, seedProjections } from "./helpers";

/**
 * Tuesday 2026-09-08 06:30 ET — half an hour into the week-1 waiver window and
 * half an hour before the daily forum window opens, so exactly one window is
 * due. (Week 1 starts on the Tuesday after Labor Day; in 2026 that is
 * September 8 — see `weekBoundaries` in lib/services/league.)
 */
const TUESDAY_MORNING = new Date("2026-09-08T10:30:00Z");

async function inSeasonLeague(teamCount = 8) {
  const league = await createTestLeague({ teamCount });
  await db.update(weeks).set({ status: "upcoming" }).where(eq(weeks.leagueId, league.leagueId));
  const pool = await seedPlayers(160);
  await seedProjections(pool, league.season, 1);
  await seedGames(league.season, 1);
  const used = new Set<string>();
  for (const teamId of league.teamIds) await fillRoster(teamId, pool, used);
  // The tick only visits drafting / in-season leagues.
  await db.execute(
    (await import("drizzle-orm")).sql`update leagues set status = 'in_season' where id = ${league.leagueId}`,
  );
  return { league, pool };
}

describe("currentWeekNo", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("maps an instant to the league week that contains it", async () => {
    const league = await createTestLeague({ teamCount: 8 });
    expect(await currentWeekNo(league.leagueId, TUESDAY_MORNING)).toBe(1);
    expect(
      await currentWeekNo(league.leagueId, new Date("2026-09-16T11:00:00Z")),
    ).toBe(2);
    // Before the season starts, clamp to week 1.
    expect(await currentWeekNo(league.leagueId, new Date("2026-01-01T00:00:00Z"))).toBe(1);
  });
});

describe("runTick", () => {
  beforeEach(async () => {
    await truncateAll();
    vi.mocked(applySafetyAutopilot).mockClear();
  });

  it("materializes windows, opens the due one, snapshots it and creates one run per team", async () => {
    const { league } = await inSeasonLeague(8);
    const report = await runTick({ now: TUESDAY_MORNING, dispatch: false });

    const leagueReport = report.leagues.find((l) => l.leagueId === league.leagueId)!;
    expect(leagueReport.error).toBeUndefined();
    expect(leagueReport.weekNo).toBe(1);
    expect(leagueReport.materialized).toBeGreaterThan(0);
    expect(leagueReport.opened).toContain("waiver#1");

    const waiver = await db.query.windows.findFirst({
      where: and(eq(windows.leagueId, league.leagueId), eq(windows.label, "waiver")),
    });
    expect(waiver!.status).toBe("open");
    expect(waiver!.snapshotId).not.toBeNull();

    const snapshot = await db.query.snapshots.findFirst({
      where: eq(snapshots.id, waiver!.snapshotId!),
    });
    expect(snapshot!.windowId).toBe(waiver!.id);
    expect(Object.keys(snapshot!.payload.players).length).toBeGreaterThan(0);

    const created = await db.select().from(runs).where(eq(runs.windowId, waiver!.id));
    expect(created).toHaveLength(8);
    expect(created.every((r) => r.status === "pending")).toBe(true);
    expect(created.every((r) => r.modelId === "mock/scripted")).toBe(true);
  });

  it("is idempotent: a second tick creates no duplicates", async () => {
    const { league } = await inSeasonLeague(8);
    await runTick({ now: TUESDAY_MORNING, dispatch: false });
    const afterFirst = {
      windows: (await db.select().from(windows).where(eq(windows.leagueId, league.leagueId))).length,
      runs: (await db.select().from(runs).where(eq(runs.leagueId, league.leagueId))).length,
    };

    const second = await runTick({ now: TUESDAY_MORNING, dispatch: false });
    expect(second.leagues[0].materialized).toBe(0);
    expect(second.leagues[0].opened).toHaveLength(0);

    expect((await db.select().from(windows).where(eq(windows.leagueId, league.leagueId))).length).toBe(
      afterFirst.windows,
    );
    expect((await db.select().from(runs).where(eq(runs.leagueId, league.leagueId))).length).toBe(
      afterFirst.runs,
    );
  });

  it("closes a lineup window, terminates its runs and applies the safety autopilot", async () => {
    const { league } = await inSeasonLeague(8);
    await materializeWindows(league.leagueId, 1);
    const opened = await openWindowNow(league.leagueId, "lineup_sun_early", {
      weekNo: 1,
      now: TUESDAY_MORNING,
    });
    expect(opened.runsCreated).toBe(8);

    // Sunday 2026-09-06 14:00 ET: the 12:55 close has passed.
    const report = await closeWindowNow(opened.windowId, {
      now: new Date("2026-09-13T18:00:00Z"),
    });
    expect(report.closed).toContain("lineup_sun_early#1");
    expect(report.runsTerminated).toBe(8);
    // The autopilot must run for every team even though no run ever started.
    expect(vi.mocked(applySafetyAutopilot)).toHaveBeenCalledTimes(8);

    const window = await db.query.windows.findFirst({ where: eq(windows.id, opened.windowId) });
    expect(window!.status).toBe("closed");
    const closedRuns = await db.select().from(runs).where(eq(runs.windowId, opened.windowId));
    expect(closedRuns.every((r) => r.status === "skipped")).toBe(true);
  });

  it("reaps a run whose lease expired and applies its fallback", async () => {
    const { league } = await inSeasonLeague(8);
    const opened = await openWindowNow(league.leagueId, "lineup_sun_early", {
      weekNo: 1,
      now: TUESDAY_MORNING,
    });
    const [claimed] = await db.select().from(runs).where(eq(runs.windowId, opened.windowId));
    await db
      .update(runs)
      .set({
        status: "running",
        claimedAt: new Date("2026-09-13T13:00:00Z"),
        leaseExpiresAt: new Date("2026-09-13T13:05:00Z"),
      })
      .where(eq(runs.id, claimed.id));

    const report = await runTick({ now: new Date("2026-09-13T14:00:00Z"), dispatch: false });
    expect(report.reaped).toBe(1);
    const reaped = await db.query.runs.findFirst({ where: eq(runs.id, claimed.id) });
    expect(reaped!.status).toBe("timed_out");
    expect(reaped!.error).toContain("Lease expired");
    expect(vi.mocked(applySafetyAutopilot)).toHaveBeenCalled();
  });

  it("dispatches pending runs to the executor with the internal secret", async () => {
    const { league } = await inSeasonLeague(8);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response("{}", { status: 202 });
    }) as unknown as typeof fetch;

    const scheduled: Array<() => Promise<void>> = [];
    const report = await runTick({
      now: TUESDAY_MORNING,
      fetchImpl,
      schedule: (task) => void scheduled.push(task),
    });
    expect(report.dispatched).toBe(8);
    // Nothing has gone out until the scheduled callback runs — that is `after()`.
    expect(calls).toHaveLength(0);
    for (const task of scheduled) await task();
    expect(calls).toHaveLength(8);

    const pending = await db.select().from(runs).where(eq(runs.leagueId, league.leagueId));
    expect(calls[0].url).toContain(`/api/runs/`);
    expect(calls.map((c) => c.url).some((u) => u.endsWith(`/api/runs/${pending[0].id}/execute`))).toBe(
      true,
    );
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toMatch(/^Bearer /);
    expect(calls[0].init?.method).toBe("POST");
    // The tick never claims a run; the executor does.
    expect(pending.every((r) => r.status === "pending")).toBe(true);
  });

  it("does not dispatch a run whose submission deadline has passed", async () => {
    const { league } = await inSeasonLeague(8);
    const waiver = await openWindowNow(league.leagueId, "waiver", {
      weekNo: 1,
      now: TUESDAY_MORNING,
    });
    const waiverRuns = new Set(
      (await db.select({ id: runs.id }).from(runs).where(eq(runs.windowId, waiver.windowId))).map(
        (r) => r.id,
      ),
    );

    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response("{}");
    }) as unknown as typeof fetch;

    // Wednesday 02:59 ET: the waiver window is still open but its 02:50
    // submission deadline has passed, so its runs are no longer dispatchable.
    const scheduled: Array<() => Promise<void>> = [];
    await runTick({
      now: new Date("2026-09-09T06:59:00Z"),
      fetchImpl,
      leagueId: league.leagueId,
      schedule: (task) => void scheduled.push(task),
    });
    for (const task of scheduled) await task();

    expect(urls.some((u) => [...waiverRuns].some((id) => u.includes(id)))).toBe(false);
  });

  it("keeps going when one league throws", async () => {
    const { league } = await inSeasonLeague(8);
    // A league with no rules row blows up inside `tickLeague`.
    const broken = await createTestLeague({ teamCount: 8 });
    await db.execute(
      (await import("drizzle-orm")).sql`update leagues set status = 'in_season' where id = ${broken.leagueId}`,
    );
    await db.execute(
      (await import("drizzle-orm")).sql`delete from league_rules where league_id = ${broken.leagueId}`,
    );

    const report = await runTick({ now: TUESDAY_MORNING, dispatch: false });
    expect(report.leagues).toHaveLength(2);
    const healthy = report.leagues.find((l) => l.leagueId === league.leagueId)!;
    expect(healthy.opened.length).toBeGreaterThan(0);
  });
});
