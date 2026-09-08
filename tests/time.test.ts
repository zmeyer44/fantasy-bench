import { describe, expect, it } from "vitest";

import {
  DEFAULT_EDIT_LOCK,
  ET,
  etOffsetMinutes,
  formatET,
  fromET,
  isEDT,
  isWithinEditWindow,
  minuteOfWeekET,
  nextWeekdayAtET,
  previousWeekdayAtET,
  toET,
  weekStartET,
} from "@/lib/time";

describe("ET constants", () => {
  it("is America/New_York", () => {
    expect(ET).toBe("America/New_York");
  });
});

describe("fromET / toET across the DST boundary", () => {
  // 2026: DST starts Sun Mar 8, ends Sun Nov 1.
  it("treats early March as EST (UTC-5)", () => {
    const utc = fromET({ year: 2026, month: 3, day: 1, hour: 12, minute: 0 });
    expect(utc.toISOString()).toBe("2026-03-01T17:00:00.000Z");
    expect(etOffsetMinutes(utc)).toBe(-300);
    expect(isEDT(utc)).toBe(false);
  });

  it("treats mid-March as EDT (UTC-4)", () => {
    const utc = fromET({ year: 2026, month: 3, day: 15, hour: 12, minute: 0 });
    expect(utc.toISOString()).toBe("2026-03-15T16:00:00.000Z");
    expect(etOffsetMinutes(utc)).toBe(-240);
    expect(isEDT(utc)).toBe(true);
  });

  it("treats late October as EDT and November as EST", () => {
    const oct = fromET({ year: 2026, month: 10, day: 25, hour: 13, minute: 0 });
    expect(oct.toISOString()).toBe("2026-10-25T17:00:00.000Z");
    const nov = fromET({ year: 2026, month: 11, day: 8, hour: 13, minute: 0 });
    expect(nov.toISOString()).toBe("2026-11-08T18:00:00.000Z");
  });

  it("round-trips a UTC instant back to ET wall-clock parts", () => {
    const utc = new Date("2026-11-08T18:00:00.000Z");
    const et = toET(utc);
    expect(et.getFullYear()).toBe(2026);
    expect(et.getMonth() + 1).toBe(11);
    expect(et.getDate()).toBe(8);
    expect(et.getHours()).toBe(13);
  });

  it("formats in ET regardless of the host time zone", () => {
    expect(formatET(new Date("2026-03-15T16:00:00.000Z"), "yyyy-MM-dd HH:mm")).toBe(
      "2026-03-15 12:00",
    );
    expect(formatET(new Date("2026-03-01T17:00:00.000Z"), "yyyy-MM-dd HH:mm")).toBe(
      "2026-03-01 12:00",
    );
  });

  it("keeps the same wall-clock hour on both sides of the spring-forward", () => {
    // The week containing the spring-forward is 23 hours long in real time, but
    // 06:00 ET stays 06:00 ET.
    const before = nextWeekdayAtET(new Date("2026-03-03T00:00:00.000Z"), "tue", 6, 0);
    const after = nextWeekdayAtET(new Date("2026-03-10T00:00:00.000Z"), "tue", 6, 0);
    expect(formatET(before, "HH:mm")).toBe("06:00");
    expect(formatET(after, "HH:mm")).toBe("06:00");
    expect(before.toISOString()).toBe("2026-03-03T11:00:00.000Z"); // EST
    expect(after.toISOString()).toBe("2026-03-10T10:00:00.000Z"); // EDT
    const hours = (after.getTime() - before.getTime()) / 3_600_000;
    expect(hours).toBe(167);
  });
});

describe("nextWeekdayAtET / previousWeekdayAtET", () => {
  it("returns the same day when the time has not passed", () => {
    // 2026-09-08 is a Tuesday. 05:00 ET = 09:00 UTC (EDT).
    const from = new Date("2026-09-08T09:00:00.000Z");
    const next = nextWeekdayAtET(from, "tue", 6, 0);
    expect(next.toISOString()).toBe("2026-09-08T10:00:00.000Z");
  });

  it("rolls to the following week when the time has passed", () => {
    const from = new Date("2026-09-08T11:00:00.000Z"); // 07:00 ET Tuesday
    const next = nextWeekdayAtET(from, "tue", 6, 0);
    expect(next.toISOString()).toBe("2026-09-15T10:00:00.000Z");
  });

  it("finds the previous occurrence", () => {
    const from = new Date("2026-09-10T12:00:00.000Z"); // Thursday
    const prev = previousWeekdayAtET(from, "tue", 6, 0);
    expect(prev.toISOString()).toBe("2026-09-08T10:00:00.000Z");
  });

  it("weekStartET anchors on Tuesday 06:00 ET", () => {
    const start = weekStartET(new Date("2026-09-13T20:00:00.000Z")); // Sunday
    expect(formatET(start, "EEE HH:mm")).toBe("Tue 06:00");
  });
});

describe("isWithinEditWindow", () => {
  const at = (iso: string) => new Date(iso);

  it("is open from Tuesday 06:00 ET to Wednesday 03:00 ET", () => {
    expect(isWithinEditWindow(at("2026-09-08T10:00:00.000Z"))).toBe(true); // Tue 06:00
    expect(isWithinEditWindow(at("2026-09-08T23:00:00.000Z"))).toBe(true); // Tue 19:00
    expect(isWithinEditWindow(at("2026-09-09T06:59:00.000Z"))).toBe(true); // Wed 02:59
  });

  it("is closed outside the window", () => {
    expect(isWithinEditWindow(at("2026-09-08T09:59:00.000Z"))).toBe(false); // Tue 05:59
    expect(isWithinEditWindow(at("2026-09-09T07:01:00.000Z"))).toBe(false); // Wed 03:01
    expect(isWithinEditWindow(at("2026-09-13T18:00:00.000Z"))).toBe(false); // Sun 14:00
  });

  it("handles a window that wraps the week boundary", () => {
    const wrapping = { unlockDay: "sat", unlockTime: "22:00", lockDay: "mon", lockTime: "02:00" };
    expect(isWithinEditWindow(at("2026-09-13T03:00:00.000Z"), wrapping as never)).toBe(true); // Sat 23:00
    expect(isWithinEditWindow(at("2026-09-13T18:00:00.000Z"), wrapping as never)).toBe(true); // Sun 14:00
    expect(isWithinEditWindow(at("2026-09-14T12:00:00.000Z"), wrapping as never)).toBe(false); // Mon 08:00
  });

  it("uses the documented default lock", () => {
    expect(DEFAULT_EDIT_LOCK.unlockDay).toBe("tue");
    expect(DEFAULT_EDIT_LOCK.lockDay).toBe("wed");
  });

  it("computes minute-of-week in ET", () => {
    // Sunday 2026-09-13 00:00 ET = 04:00 UTC.
    expect(minuteOfWeekET(at("2026-09-13T04:00:00.000Z"))).toBe(0);
    expect(minuteOfWeekET(at("2026-09-13T05:30:00.000Z"))).toBe(90);
  });
});
