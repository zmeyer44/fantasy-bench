/**
 * Window templates and materialisation.
 *
 * The templates are a port, so the first job of this file is parity: the Convex
 * ET helpers must produce the same instants as `lib/time.ts` + `lib/scheduler`,
 * including across the DST switch, where every window has to keep its Eastern
 * wall-clock time while its UTC offset moves.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import {
  DEFAULT_SUBMISSION_LEAD_MINUTES,
  resolveWindowsForWeek as legacyResolve,
} from "../lib/scheduler/templates";
import { fromET, minuteOfWeekET as legacyMinuteOfWeek, nextWeekdayAtET as legacyNext } from "../lib/time";
import { api, internal } from "./_generated/api";
import {
  DEFAULT_WINDOW_TEMPLATES,
  dayBucketFor,
  etInstant,
  fromETParts,
  minuteOfWeekET,
  nextWeekdayAtET,
  resolveWindowsForWeek,
  templateByLabel,
} from "./lib/templates";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

/** Tuesday 06:00 ET in a normal (EDT) September week. */
const SEPTEMBER_ANCHOR = fromETParts({ year: 2026, month: 9, day: 8, hour: 6 });
/** Tuesday 06:00 ET of the week DST ends (Sunday 2026-11-01). */
const DST_ANCHOR = fromETParts({ year: 2026, month: 10, day: 27, hour: 6 });

function byLabel(windows: ReturnType<typeof resolveWindowsForWeek>, label: string, round = 1) {
  const found = windows.find((w) => w.label === label && w.roundNo === round);
  if (!found) throw new Error(`no window ${label}#${round}`);
  return found;
}

const RULES = {
  scoringPreset: "ppr" as const,
  superflex: false,
  tePremium: false,
  rosterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DEF: 1, BENCH: 6 },
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

async function seedLeague(
  t: ReturnType<typeof convexTest>,
  opts: { isPublic?: boolean; anchor?: number } = {},
) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: "commish@x.dev" });
    const sessionId = await ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 86_400_000,
    });
    const leagueId = await ctx.db.insert("leagues", {
      name: "Windows",
      slug: `w-${Math.random()}`,
      commissionerUserId: userId,
      season: 2026,
      teamCount: 2,
      isPublic: opts.isPublic ?? true,
      status: "in_season",
      draftType: "snake",
      updatedAt: Date.now(),
    });
    await ctx.db.insert("league_rules", { leagueId, ...RULES });
    await ctx.db.insert("league_members", { leagueId, userId, role: "commissioner" });
    const anchor = opts.anchor ?? SEPTEMBER_ANCHOR;
    await ctx.db.insert("weeks", {
      leagueId,
      weekNo: 1,
      startsAt: anchor,
      endsAt: anchor + 7 * 86_400_000,
      isPlayoff: false,
      status: "active",
    });
    return { leagueId, userId, sessionId, anchor };
  });
}

describe("ET helpers", () => {
  test("agree with lib/time.ts instant for instant", () => {
    const probe = fromET({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 });
    expect(fromETParts({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 })).toBe(
      probe.getTime(),
    );
    expect(minuteOfWeekET(probe.getTime())).toBe(legacyMinuteOfWeek(probe));
    expect(nextWeekdayAtET(probe.getTime(), "tue", 6, 0)).toBe(
      legacyNext(probe, "tue", 6, 0).getTime(),
    );
  });

  test("adds days on the ET calendar, not in fixed 24h blocks", () => {
    // Saturday 10:00 EDT + 2 days lands on Monday 10:00 EST (a 49-hour gap).
    const saturday = fromETParts({ year: 2026, month: 10, day: 31, hour: 10 });
    expect(etInstant(saturday, 2, "10:00") - saturday).toBe(49 * 60 * 60 * 1000);
  });

  test("buckets kickoffs by Eastern day, including the 16:00 boundary", () => {
    expect(dayBucketFor(Date.parse("2026-09-11T00:15:00Z"))).toBe("thu");
    expect(dayBucketFor(Date.parse("2026-09-13T17:00:00Z"))).toBe("sun_early");
    expect(dayBucketFor(Date.parse("2026-09-13T20:00:00Z"))).toBe("sun_late");
    expect(dayBucketFor(Date.parse("2026-09-15T00:15:00Z"))).toBe("mon");
    expect(dayBucketFor(Date.parse("2026-09-12T17:00:00Z"))).toBe("other");
    // DST week: 21:00Z is 16:00 EST — late; 20:00Z is 15:00 EST — early.
    expect(dayBucketFor(Date.parse("2026-11-01T21:00:00Z"))).toBe("sun_late");
    expect(dayBucketFor(Date.parse("2026-11-01T20:00:00Z"))).toBe("sun_early");
  });
});

describe("the PRD 5.3 default table", () => {
  const windows = resolveWindowsForWeek(SEPTEMBER_ANCHOR);

  test("puts every window at its Eastern wall-clock time", () => {
    expect(new Date(byLabel(windows, "waiver").opensAt).toISOString()).toBe(
      "2026-09-08T10:00:00.000Z",
    );
    expect(new Date(byLabel(windows, "waiver").closesAt).toISOString()).toBe(
      "2026-09-09T07:00:00.000Z",
    );
    expect(new Date(byLabel(windows, "lineup_tnf").opensAt).toISOString()).toBe(
      "2026-09-10T20:00:00.000Z",
    );
    expect(new Date(byLabel(windows, "lineup_sun_early").closesAt).toISOString()).toBe(
      "2026-09-13T16:55:00.000Z",
    );
    expect(new Date(byLabel(windows, "lineup_mnf").closesAt).toISOString()).toBe(
      "2026-09-15T00:15:00.000Z",
    );
  });

  test("gives every window a submission deadline 10 minutes before close", () => {
    for (const w of windows) {
      expect(w.closesAt - w.submissionDeadlineAt).toBe(DEFAULT_SUBMISSION_LEAD_MINUTES * 60_000);
      expect(w.submissionDeadlineAt).toBeGreaterThan(w.opensAt);
    }
  });

  test("carries the game-day scope each lineup window may touch", () => {
    expect(byLabel(windows, "lineup_tnf").scope.gameDays).toEqual(["thu"]);
    expect(byLabel(windows, "lineup_sun_late").scope.gameDays).toEqual(["sun_late", "mon"]);
    expect(byLabel(windows, "lineup_mnf").scope.gameDays).toEqual(["mon"]);
    expect(byLabel(windows, "lineup_sun_early").scope.gameDays).toBeUndefined();
  });

  test("splits trade windows into three contiguous rounds", () => {
    const rounds = windows
      .filter((w) => w.label === "trade_a")
      .sort((a, b) => a.roundNo - b.roundNo);
    expect(rounds).toHaveLength(3);
    expect(new Date(rounds[0].opensAt).toISOString()).toBe("2026-09-09T13:00:00.000Z");
    expect(rounds[0].closesAt).toBe(rounds[1].opensAt);
    expect(rounds[1].closesAt).toBe(rounds[2].opensAt);
    expect(new Date(rounds[2].closesAt).toISOString()).toBe("2026-09-10T03:59:00.000Z");
    expect(rounds[1].scope.round).toBe(2);
  });

  test("expands the forum window to one per day of the league week", () => {
    const forum = windows.filter((w) => w.label === "forum");
    expect(forum).toHaveLength(7);
    expect(new Date(forum[0].opensAt).toISOString()).toBe("2026-09-08T11:00:00.000Z");
    expect(new Set(forum.map((w) => w.roundNo)).size).toBe(7);
    expect(forum[3].scope.dayIndex).toBe(4);
  });

  test("looks a template up by label", () => {
    expect(templateByLabel("waiver")?.type).toBe("waiver");
    expect(templateByLabel("nope")).toBeUndefined();
    expect(DEFAULT_WINDOW_TEMPLATES).toHaveLength(8);
  });
});

describe("DST week", () => {
  const windows = resolveWindowsForWeek(DST_ANCHOR);

  test("keeps pre-switch windows on EDT and post-switch windows on EST", () => {
    expect(new Date(byLabel(windows, "waiver").opensAt).toISOString()).toBe(
      "2026-10-27T10:00:00.000Z",
    );
    expect(new Date(byLabel(windows, "lineup_tnf").opensAt).toISOString()).toBe(
      "2026-10-29T20:00:00.000Z",
    );
    expect(new Date(byLabel(windows, "lineup_sun_early").opensAt).toISOString()).toBe(
      "2026-11-01T14:00:00.000Z",
    );
    expect(new Date(byLabel(windows, "lineup_mnf").opensAt).toISOString()).toBe(
      "2026-11-02T21:00:00.000Z",
    );
  });

  test("matches the Postgres-era resolver exactly, both weeks", () => {
    for (const anchor of [SEPTEMBER_ANCHOR, DST_ANCHOR]) {
      const ours = resolveWindowsForWeek(anchor);
      const legacy = legacyResolve(new Date(anchor));
      expect(ours).toHaveLength(legacy.length);
      for (let i = 0; i < ours.length; i++) {
        expect([ours[i].label, ours[i].roundNo, ours[i].opensAt, ours[i].closesAt]).toEqual([
          legacy[i].label,
          legacy[i].roundNo,
          legacy[i].opensAt.getTime(),
          legacy[i].closesAt.getTime(),
        ]);
      }
    }
  });
});

describe("commissioner overrides", () => {
  test("move a window, change its lead time, disable it or re-round it", () => {
    const moved = byLabel(
      resolveWindowsForWeek(SEPTEMBER_ANCHOR, {
        waiver: {
          opensTime: "07:30",
          closesDay: "wed",
          closesTime: "04:00",
          submissionLeadMinutes: 30,
        },
      }),
      "waiver",
    );
    expect(new Date(moved.opensAt).toISOString()).toBe("2026-09-08T11:30:00.000Z");
    expect(moved.closesAt - moved.submissionDeadlineAt).toBe(30 * 60_000);

    expect(
      resolveWindowsForWeek(SEPTEMBER_ANCHOR, { lineup_mnf: { enabled: false } }).some(
        (w) => w.label === "lineup_mnf",
      ),
    ).toBe(false);
    expect(
      resolveWindowsForWeek(SEPTEMBER_ANCHOR, { trade_b: { rounds: 5 } }).filter(
        (w) => w.label === "trade_b",
      ),
    ).toHaveLength(5);
  });
});

describe("windows.materializeWindows", () => {
  test("is idempotent", async () => {
    const t = convexTest(schema, modules);
    const s = await seedLeague(t);

    const first = await t.mutation(internal.windows.materializeWindows, {
      leagueId: s.leagueId,
      weekNo: 1,
    });
    expect(first).toEqual({ weekNo: 1, created: 18, existing: 0 });

    const second = await t.mutation(internal.windows.materializeWindows, {
      leagueId: s.leagueId,
      weekNo: 1,
    });
    expect(second).toEqual({ weekNo: 1, created: 0, existing: 18 });

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("windows")
        .withIndex("by_leagueId_weekNo_type", (q) =>
          q.eq("leagueId", s.leagueId).eq("weekNo", 1),
        )
        .collect(),
    );
    expect(rows).toHaveLength(18);
    expect(rows.every((row) => row.status === "scheduled")).toBe(true);
    expect(rows.every((row) => row.runCount === 0 && row.terminalRunCount === 0)).toBe(true);
  });

  test("does nothing for a week that does not exist", async () => {
    const t = convexTest(schema, modules);
    const s = await seedLeague(t);
    expect(
      await t.mutation(internal.windows.materializeWindows, { leagueId: s.leagueId, weekNo: 9 }),
    ).toEqual({ weekNo: 9, created: 0, existing: 0 });
  });
});

describe("windows.forWeek / windows.schedule", () => {
  test("decorates each window with its phase and countdown", async () => {
    const t = convexTest(schema, modules);
    const s = await seedLeague(t);
    await t.mutation(internal.windows.materializeWindows, { leagueId: s.leagueId, weekNo: 1 });

    const rows = await t.query(api.windows.forWeek, { leagueId: s.leagueId, weekNo: 1 });
    expect(rows).toHaveLength(18);
    expect(rows[0].label).toBe("waiver");
    expect(rows[0].labelText).toBe("Waiver");
    expect(rows.map((r) => r.opensAt)).toEqual([...rows.map((r) => r.opensAt)].sort((a, b) => a - b));
    for (const row of rows) expect(["past", "open", "upcoming"]).toContain(row.phase);
    expect(rows[0].runCount).toBe(0);
  });

  test("splits open from upcoming windows around now", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const s = await seedLeague(t);
    await t.run(async (ctx) => {
      const base = {
        leagueId: s.leagueId,
        type: "lineup" as const,
        weekNo: 1,
        roundNo: 1,
        status: "open" as const,
        scope: {},
        runCount: 3,
        terminalRunCount: 1,
      };
      await ctx.db.insert("windows", {
        ...base,
        label: "open_now",
        opensAt: now - 60_000,
        submissionDeadlineAt: now + 60_000,
        closesAt: now + 120_000,
      });
      await ctx.db.insert("windows", {
        ...base,
        label: "later",
        status: "scheduled",
        opensAt: now + 3_600_000,
        submissionDeadlineAt: now + 7_000_000,
        closesAt: now + 7_200_000,
      });
    });

    const schedule = await t.query(api.windows.schedule, { leagueId: s.leagueId });
    expect(schedule.open.map((w) => w.label)).toEqual(["open_now"]);
    expect(schedule.open[0].runCount).toBe(3);
    expect(schedule.open[0].terminalRunCount).toBe(1);
    expect(schedule.upcoming.map((w) => w.label)).toEqual(["later"]);
    expect(schedule.next?.label).toBe("open_now");
    expect(schedule.upcoming[0].countdown).toMatch(/^(1h 0m|59m)$/);
  });

  test("refuses a private league to a signed-out reader", async () => {
    const t = convexTest(schema, modules);
    const s = await seedLeague(t, { isPublic: false });
    await expect(
      t.query(api.windows.forWeek, { leagueId: s.leagueId, weekNo: 1 }),
    ).rejects.toThrow(/private/i);

    const asCommissioner = t.withIdentity({ subject: `${s.userId}|${s.sessionId}` });
    await expect(
      asCommissioner.query(api.windows.forWeek, { leagueId: s.leagueId, weekNo: 1 }),
    ).resolves.toBeInstanceOf(Array);
  });
});
