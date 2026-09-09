/**
 * Eastern-time helpers.
 *
 * League time is always `America/New_York`. Everything is stored in UTC in the
 * database; these helpers are the only place that should know about ET.
 */
import { TZDate, tz, tzOffset } from "@date-fns/tz";
import { format as formatDateFns } from "date-fns";

export const ET = "America/New_York" as const;

/** Weekday keys used by window templates and the config edit lock. */
export const WEEKDAYS = [
  "sun",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** 0 = Sunday … 6 = Saturday (matches `Date.prototype.getDay()`). */
export function weekdayIndex(day: Weekday): number {
  return WEEKDAYS.indexOf(day);
}

export type ETParts = {
  year: number;
  /** 1-12 (human month, NOT the JS 0-11 month). */
  month: number;
  day: number;
  hour?: number;
  minute?: number;
  second?: number;
  ms?: number;
};

/** Current instant. Exists so tests and the scheduler can be given a clock. */
export function nowET(): TZDate {
  return TZDate.tz(ET);
}

/** View a UTC instant as an ET wall-clock date. */
export function toET(date: Date | number | string): TZDate {
  return new TZDate(date instanceof Date ? date : new Date(date), ET);
}

/** Build a UTC `Date` from Eastern wall-clock parts. */
export function fromET(parts: ETParts): Date {
  const d = new TZDate(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
    parts.ms ?? 0,
    ET,
  );
  return new Date(d.getTime());
}

/** Alias kept for the ARCHITECTURE.md naming (`etToUtc`). */
export const etToUtc = fromET;

/** Format an instant in Eastern time using date-fns tokens. */
export function formatET(date: Date | number | string, fmt = "yyyy-MM-dd HH:mm"): string {
  return formatDateFns(date, fmt, { in: tz(ET) });
}

/** UTC offset in minutes for an instant, in Eastern time (e.g. -300 EST, -240 EDT). */
export function etOffsetMinutes(date: Date): number {
  return tzOffset(ET, date);
}

/** True when the instant falls in Eastern Daylight Time. */
export function isEDT(date: Date): boolean {
  return etOffsetMinutes(date) === -240;
}

/**
 * The next occurrence (at or after `from`) of `weekday` at `hh:mm` Eastern.
 * If `from` already sits exactly on that wall-clock moment, `from` is returned.
 */
export function nextWeekdayAtET(
  from: Date,
  weekday: Weekday | number,
  hh: number,
  mm = 0,
): Date {
  const target = typeof weekday === "number" ? weekday : weekdayIndex(weekday);
  const et = toET(from);
  const baseYear = et.getFullYear();
  const baseMonth = et.getMonth() + 1;
  const baseDay = et.getDate();

  // Walk forward day by day in ET calendar space (max 8 days covers the wrap).
  for (let offset = 0; offset <= 8; offset++) {
    const probe = new TZDate(baseYear, baseMonth - 1, baseDay + offset, 12, 0, 0, 0, ET);
    if (probe.getDay() !== target) continue;
    const candidate = fromET({
      year: probe.getFullYear(),
      month: probe.getMonth() + 1,
      day: probe.getDate(),
      hour: hh,
      minute: mm,
    });
    if (candidate.getTime() >= from.getTime()) return candidate;
  }
  // Unreachable for a valid weekday, but keep the function total.
  throw new Error(`nextWeekdayAtET: could not resolve weekday ${String(weekday)}`);
}

/** The most recent occurrence (at or before `from`) of `weekday` at `hh:mm` ET. */
export function previousWeekdayAtET(
  from: Date,
  weekday: Weekday | number,
  hh: number,
  mm = 0,
): Date {
  const target = typeof weekday === "number" ? weekday : weekdayIndex(weekday);
  const et = toET(from);
  for (let offset = 0; offset <= 8; offset++) {
    const probe = new TZDate(
      et.getFullYear(),
      et.getMonth(),
      et.getDate() - offset,
      12,
      0,
      0,
      0,
      ET,
    );
    if (probe.getDay() !== target) continue;
    const candidate = fromET({
      year: probe.getFullYear(),
      month: probe.getMonth() + 1,
      day: probe.getDate(),
      hour: hh,
      minute: mm,
    });
    if (candidate.getTime() <= from.getTime()) return candidate;
  }
  throw new Error(`previousWeekdayAtET: could not resolve weekday ${String(weekday)}`);
}

/**
 * The recurring window during which owners may edit their agent config.
 * All fields are Eastern; times are `"HH:mm"`.
 */
export type EditLock = {
  unlockDay: Weekday;
  unlockTime: string;
  lockDay: Weekday;
  lockTime: string;
};

export const DEFAULT_EDIT_LOCK: EditLock = {
  unlockDay: "tue",
  unlockTime: "06:00",
  lockDay: "wed",
  lockTime: "03:00",
};

function parseHhMm(value: string): { hh: number; mm: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) throw new Error(`Invalid HH:mm time: ${value}`);
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (hh > 23 || mm > 59) throw new Error(`Invalid HH:mm time: ${value}`);
  return { hh, mm };
}

/** Minutes elapsed since Sunday 00:00 Eastern, 0…10079. */
export function minuteOfWeekET(date: Date): number {
  const et = toET(date);
  return et.getDay() * 1440 + et.getHours() * 60 + et.getMinutes();
}

function slotMinute(day: Weekday, time: string): number {
  const { hh, mm } = parseHhMm(time);
  return weekdayIndex(day) * 1440 + hh * 60 + mm;
}

/**
 * True when `now` falls inside the (recurring, weekly, wall-clock) edit window
 * `[unlockDay unlockTime, lockDay lockTime)`. Windows that wrap past Saturday
 * midnight are handled.
 */
export function isWithinEditWindow(now: Date, editLock: EditLock = DEFAULT_EDIT_LOCK): boolean {
  const current = minuteOfWeekET(now);
  const open = slotMinute(editLock.unlockDay, editLock.unlockTime);
  const close = slotMinute(editLock.lockDay, editLock.lockTime);
  if (open === close) return true; // degenerate: always open
  if (open < close) return current >= open && current < close;
  return current >= open || current < close; // wraps the week boundary
}

/** When the edit window next opens (or `now` if it is currently open). */
export function nextEditUnlock(now: Date, editLock: EditLock = DEFAULT_EDIT_LOCK): Date {
  if (isWithinEditWindow(now, editLock)) return now;
  const { hh, mm } = parseHhMm(editLock.unlockTime);
  return nextWeekdayAtET(now, editLock.unlockDay, hh, mm);
}

/** NFL weeks roll over Tuesday 06:00 ET (waiver open). */
export function weekStartET(now: Date): Date {
  return previousWeekdayAtET(now, "tue", 6, 0);
}

/**
 * How long ago an instant was, for feeds: "just now", "4m", "3h", "2d", then a
 * short ET date once it is more than a week old. Pure; `now` is injectable.
 */
export function timeAgo(at: number | Date, now: number | Date = Date.now()): string {
  const atMs = at instanceof Date ? at.getTime() : at;
  const nowMs = now instanceof Date ? now.getTime() : now;
  const seconds = Math.max(0, Math.round((nowMs - atMs) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return formatET(atMs, "MMM d");
}

/** The ET calendar day an instant falls on, as a stable key for grouping. */
export function etDayKey(at: number | Date): string {
  return formatET(at, "yyyy-MM-dd");
}

/** "Today", "Yesterday", or the ET date, for feed day headers. */
export function etDayLabel(at: number | Date, now: number | Date = Date.now()): string {
  const key = etDayKey(at);
  if (key === etDayKey(now)) return "Today";
  const nowMs = now instanceof Date ? now.getTime() : now;
  if (key === etDayKey(nowMs - 86_400_000)) return "Yesterday";
  return formatET(at, "EEEE, MMM d");
}
