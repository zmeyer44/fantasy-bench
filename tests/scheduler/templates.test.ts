/**
 * Window templates. The interesting case is the week that contains the DST
 * switch: every window must keep its Eastern wall-clock time, which means the
 * UTC offset changes mid-week.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_SUBMISSION_LEAD_MINUTES,
  DEFAULT_WINDOW_TEMPLATES,
  etInstant,
  resolveWindowsForWeek,
  templateByLabel,
} from "@/lib/scheduler/templates";
import { fromET } from "@/lib/time";

/** Tuesday 06:00 ET in a normal (EDT) September week. */
const SEPTEMBER_ANCHOR = fromET({ year: 2026, month: 9, day: 8, hour: 6 });
/** Tuesday 06:00 ET of the week DST ends (Sunday 2026-11-01). */
const DST_ANCHOR = fromET({ year: 2026, month: 10, day: 27, hour: 6 });

function byLabel(windows: ReturnType<typeof resolveWindowsForWeek>, label: string, round = 1) {
  const found = windows.find((w) => w.label === label && w.roundNo === round);
  if (!found) throw new Error(`no window ${label}#${round}`);
  return found;
}

describe("the PRD 5.3 default table", () => {
  const windows = resolveWindowsForWeek(SEPTEMBER_ANCHOR);

  it("puts every window at its Eastern wall-clock time", () => {
    expect(byLabel(windows, "waiver").opensAt.toISOString()).toBe("2026-09-08T10:00:00.000Z");
    expect(byLabel(windows, "waiver").closesAt.toISOString()).toBe("2026-09-09T07:00:00.000Z");
    expect(byLabel(windows, "lineup_tnf").opensAt.toISOString()).toBe("2026-09-10T20:00:00.000Z");
    expect(byLabel(windows, "lineup_sun_early").closesAt.toISOString()).toBe(
      "2026-09-13T16:55:00.000Z",
    );
    expect(byLabel(windows, "lineup_mnf").closesAt.toISOString()).toBe("2026-09-15T00:15:00.000Z");
  });

  it("gives every window a submission deadline 10 minutes before close", () => {
    for (const w of windows) {
      const lead = w.closesAt.getTime() - w.submissionDeadlineAt.getTime();
      expect(lead).toBe(DEFAULT_SUBMISSION_LEAD_MINUTES * 60_000);
      expect(w.submissionDeadlineAt.getTime()).toBeGreaterThan(w.opensAt.getTime());
    }
  });

  it("carries the game-day scope each lineup window may touch", () => {
    expect(byLabel(windows, "lineup_tnf").scope.gameDays).toEqual(["thu"]);
    expect(byLabel(windows, "lineup_sun_late").scope.gameDays).toEqual(["sun_late", "mon"]);
    expect(byLabel(windows, "lineup_mnf").scope.gameDays).toEqual(["mon"]);
    // The Sunday-early window is the full lineup — no day restriction.
    expect(byLabel(windows, "lineup_sun_early").scope.gameDays).toBeUndefined();
  });

  it("splits trade windows into three contiguous rounds", () => {
    const rounds = windows.filter((w) => w.label === "trade_a").sort((a, b) => a.roundNo - b.roundNo);
    expect(rounds).toHaveLength(3);
    expect(rounds[0].opensAt.toISOString()).toBe("2026-09-09T13:00:00.000Z");
    expect(rounds[0].closesAt.getTime()).toBe(rounds[1].opensAt.getTime());
    expect(rounds[1].closesAt.getTime()).toBe(rounds[2].opensAt.getTime());
    // Wed 23:59 ET
    expect(rounds[2].closesAt.toISOString()).toBe("2026-09-10T03:59:00.000Z");
  });

  it("expands the forum window to one per day of the league week", () => {
    const forum = windows.filter((w) => w.label === "forum");
    expect(forum).toHaveLength(7);
    expect(forum[0].opensAt.toISOString()).toBe("2026-09-08T11:00:00.000Z");
    expect(new Set(forum.map((w) => w.roundNo)).size).toBe(7);
  });

  it("returns windows in open order", () => {
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i].opensAt.getTime()).toBeGreaterThanOrEqual(windows[i - 1].opensAt.getTime());
    }
  });
});

describe("DST week", () => {
  const windows = resolveWindowsForWeek(DST_ANCHOR);

  it("keeps pre-switch windows on EDT (UTC-4)", () => {
    expect(byLabel(windows, "waiver").opensAt.toISOString()).toBe("2026-10-27T10:00:00.000Z");
    // Thu 16:00 EDT
    expect(byLabel(windows, "lineup_tnf").opensAt.toISOString()).toBe("2026-10-29T20:00:00.000Z");
  });

  it("moves post-switch windows to EST (UTC-5)", () => {
    // Sun 09:00 EST, an hour later in UTC than the same window a week earlier.
    expect(byLabel(windows, "lineup_sun_early").opensAt.toISOString()).toBe(
      "2026-11-01T14:00:00.000Z",
    );
    // Mon 16:00 EST
    expect(byLabel(windows, "lineup_mnf").opensAt.toISOString()).toBe("2026-11-02T21:00:00.000Z");
  });

  it("makes the Sunday windows exactly one hour later in UTC than a normal week", () => {
    const normal = resolveWindowsForWeek(SEPTEMBER_ANCHOR);
    const normalHour = byLabel(normal, "lineup_sun_early").opensAt.getUTCHours();
    const dstHour = byLabel(windows, "lineup_sun_early").opensAt.getUTCHours();
    expect(dstHour - normalHour).toBe(1);
  });
});

describe("commissioner overrides", () => {
  it("moves a window and changes its lead time", () => {
    const windows = resolveWindowsForWeek(SEPTEMBER_ANCHOR, {
      waiver: { opensTime: "07:30", closesDay: "wed", closesTime: "04:00", submissionLeadMinutes: 30 },
    });
    const waiver = byLabel(windows, "waiver");
    expect(waiver.opensAt.toISOString()).toBe("2026-09-08T11:30:00.000Z");
    expect(waiver.closesAt.toISOString()).toBe("2026-09-09T08:00:00.000Z");
    expect(waiver.closesAt.getTime() - waiver.submissionDeadlineAt.getTime()).toBe(30 * 60_000);
  });

  it("disables a window entirely", () => {
    const windows = resolveWindowsForWeek(SEPTEMBER_ANCHOR, { lineup_mnf: { enabled: false } });
    expect(windows.some((w) => w.label === "lineup_mnf")).toBe(false);
  });

  it("changes the number of trade rounds", () => {
    const windows = resolveWindowsForWeek(SEPTEMBER_ANCHOR, { trade_b: { rounds: 5 } });
    expect(windows.filter((w) => w.label === "trade_b")).toHaveLength(5);
  });
});

describe("template helpers", () => {
  it("looks a template up by label", () => {
    expect(templateByLabel("waiver")?.type).toBe("waiver");
    expect(templateByLabel("nope")).toBeUndefined();
    expect(DEFAULT_WINDOW_TEMPLATES).toHaveLength(8);
  });

  it("adds days on the ET calendar, not in fixed 24h blocks", () => {
    // Saturday 10:00 EDT + 2 days lands on Monday 10:00 EST (a 49-hour gap).
    const saturday = fromET({ year: 2026, month: 10, day: 31, hour: 10 });
    const monday = etInstant(saturday, 2, "10:00");
    expect(monday.getTime() - saturday.getTime()).toBe(49 * 60 * 60 * 1000);
  });
});
