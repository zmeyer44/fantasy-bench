/**
 * Decision-window templates (PRD §5.3) — a port of `lib/scheduler/templates.ts`
 * with Dates replaced by epoch milliseconds.
 *
 * Templates are declared in **Eastern wall-clock time**; instants are derived
 * per week by walking forward from that week's Tuesday 06:00 ET anchor in ET
 * calendar space and converting once at the end. That is what makes a window
 * land at the same local time on both sides of the DST switch — a fixed offset
 * from a UTC anchor would drift by an hour in early November.
 *
 * The ET helpers below are the Convex-side equivalent of `lib/time.ts` (which
 * pulls in date-fns and is therefore not imported here); `convex/windows.test.ts`
 * asserts they agree with it instant for instant.
 */

export const ET = "America/New_York" as const;

export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export function weekdayIndex(day: Weekday): number {
  return WEEKDAYS.indexOf(day);
}

export type ETParts = {
  year: number;
  /** 1-12 (human month, NOT the JS 0-11 month). */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  ms: number;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
};

const ET_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: ET,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  weekday: "short",
});

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** View a UTC instant as Eastern wall-clock parts. */
export function toETParts(at: number): ETParts {
  const parts = ET_FORMAT.formatToParts(new Date(at));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second")),
    ms: at % 1000,
    weekday: WEEKDAY_INDEX[get("weekday")] ?? 0,
  };
}

/** UTC offset in minutes for an instant in Eastern time (-300 EST, -240 EDT). */
export function etOffsetMinutes(at: number): number {
  const p = toETParts(at);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(at / 1000) * 1000) / 60_000);
}

/**
 * Build a UTC epoch-ms instant from Eastern wall-clock parts.
 *
 * Two passes: guess with the offset that applies at the naive UTC instant, then
 * correct once with the offset that actually applies at the guess. That
 * converges for every instant except the hour that does not exist in spring
 * (where, like `TZDate`, it lands on the following hour).
 */
export function fromETParts(parts: {
  year: number;
  month: number;
  day: number;
  hour?: number;
  minute?: number;
  second?: number;
  ms?: number;
}): number {
  const naive = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
    parts.ms ?? 0,
  );
  let guess = naive - etOffsetMinutes(naive) * 60_000;
  const offset = etOffsetMinutes(guess);
  const corrected = naive - offset * 60_000;
  if (corrected !== guess && etOffsetMinutes(corrected) === offset) guess = corrected;
  return guess;
}

/** Minutes elapsed since Sunday 00:00 Eastern, 0…10079. */
export function minuteOfWeekET(at: number): number {
  const p = toETParts(at);
  return p.weekday * 1440 + p.hour * 60 + p.minute;
}

/** NFL weeks roll over Tuesday 06:00 ET (waiver open). */
export function weekStartET(at: number): number {
  return previousWeekdayAtET(at, "tue", 6, 0);
}

/** The most recent occurrence (at or before `from`) of `weekday` at `hh:mm` ET. */
export function previousWeekdayAtET(
  from: number,
  weekday: Weekday | number,
  hh: number,
  mm = 0,
): number {
  const target = typeof weekday === "number" ? weekday : weekdayIndex(weekday);
  const base = toETParts(from);
  for (let offset = 0; offset <= 8; offset++) {
    const probe = toETParts(
      fromETParts({ year: base.year, month: base.month, day: base.day - offset, hour: 12 }),
    );
    if (probe.weekday !== target) continue;
    const candidate = fromETParts({
      year: probe.year,
      month: probe.month,
      day: probe.day,
      hour: hh,
      minute: mm,
    });
    if (candidate <= from) return candidate;
  }
  throw new Error(`previousWeekdayAtET: could not resolve weekday ${String(weekday)}`);
}

/** The next occurrence (at or after `from`) of `weekday` at `hh:mm` ET. */
export function nextWeekdayAtET(
  from: number,
  weekday: Weekday | number,
  hh: number,
  mm = 0,
): number {
  const target = typeof weekday === "number" ? weekday : weekdayIndex(weekday);
  const base = toETParts(from);
  for (let offset = 0; offset <= 8; offset++) {
    const probe = toETParts(
      fromETParts({ year: base.year, month: base.month, day: base.day + offset, hour: 12 }),
    );
    if (probe.weekday !== target) continue;
    const candidate = fromETParts({
      year: probe.year,
      month: probe.month,
      day: probe.day,
      hour: hh,
      minute: mm,
    });
    if (candidate >= from) return candidate;
  }
  throw new Error(`nextWeekdayAtET: could not resolve weekday ${String(weekday)}`);
}

// ---------------------------------------------------------------- templates

export type WindowType = "draft" | "waiver" | "trade" | "lineup" | "forum" | "commissioner";

/**
 * Window-type parameters carried on `windows.scope`. Matches the schema's
 * `scope` validator (team ids are added by the draft scheduler, not here).
 */
export type TemplateScope = {
  gameDays?: string[];
  slots?: string[];
  rounds?: number;
  round?: number;
  dayIndex?: number;
  phase?: string;
};

export type WindowTemplate = {
  /** Stable key; also the `windows.label` and the override key. */
  label: string;
  type: WindowType;
  opensDay: Weekday;
  opensTime: string;
  closesDay: Weekday;
  closesTime: string;
  /** Runs must submit this many minutes before close (PRD 5.3 headroom). */
  submissionLeadMinutes: number;
  /** Negotiation rounds: the span is split into this many sub-windows. */
  rounds?: number;
  scope?: TemplateScope;
  /** Expand to one window per day of the league week (the forum window). */
  daily?: boolean;
  enabled?: boolean;
};

/** Commissioner overrides, keyed by template label (`league_rules.windowOverrides`). */
export type WindowOverrides = Record<
  string,
  {
    enabled?: boolean;
    opensDay?: string;
    opensTime?: string;
    closesDay?: string;
    closesTime?: string;
    submissionLeadMinutes?: number;
    rounds?: number;
  }
>;

export const DEFAULT_SUBMISSION_LEAD_MINUTES = 10;
export const DEFAULT_TRADE_ROUNDS = 3;

/**
 * The PRD §5.3 default table.
 *
 * Lineup scopes name the `dayBucket`s a run may touch: the Thursday window may
 * only move players in Thursday games, the Sunday-late window only late and
 * Monday games. `lineup_sun_early` has no `gameDays` — it is the full lineup.
 */
export const DEFAULT_WINDOW_TEMPLATES: readonly WindowTemplate[] = [
  {
    label: "waiver",
    type: "waiver",
    opensDay: "tue",
    opensTime: "06:00",
    closesDay: "wed",
    closesTime: "03:00",
    submissionLeadMinutes: DEFAULT_SUBMISSION_LEAD_MINUTES,
  },
  {
    label: "trade_a",
    type: "trade",
    opensDay: "wed",
    opensTime: "09:00",
    closesDay: "wed",
    closesTime: "23:59",
    submissionLeadMinutes: DEFAULT_SUBMISSION_LEAD_MINUTES,
    rounds: DEFAULT_TRADE_ROUNDS,
  },
  {
    label: "trade_b",
    type: "trade",
    opensDay: "thu",
    opensTime: "09:00",
    closesDay: "thu",
    closesTime: "15:00",
    submissionLeadMinutes: DEFAULT_SUBMISSION_LEAD_MINUTES,
    rounds: DEFAULT_TRADE_ROUNDS,
  },
  {
    label: "lineup_tnf",
    type: "lineup",
    opensDay: "thu",
    opensTime: "16:00",
    closesDay: "thu",
    closesTime: "20:15",
    submissionLeadMinutes: DEFAULT_SUBMISSION_LEAD_MINUTES,
    scope: { gameDays: ["thu"] },
  },
  {
    label: "lineup_sun_early",
    type: "lineup",
    opensDay: "sun",
    opensTime: "09:00",
    closesDay: "sun",
    closesTime: "12:55",
    submissionLeadMinutes: DEFAULT_SUBMISSION_LEAD_MINUTES,
    scope: {},
  },
  {
    label: "lineup_sun_late",
    type: "lineup",
    opensDay: "sun",
    opensTime: "14:00",
    closesDay: "sun",
    closesTime: "16:00",
    submissionLeadMinutes: DEFAULT_SUBMISSION_LEAD_MINUTES,
    scope: { gameDays: ["sun_late", "mon"] },
  },
  {
    label: "lineup_mnf",
    type: "lineup",
    opensDay: "mon",
    opensTime: "16:00",
    closesDay: "mon",
    closesTime: "20:15",
    submissionLeadMinutes: DEFAULT_SUBMISSION_LEAD_MINUTES,
    scope: { gameDays: ["mon"] },
  },
  {
    // Rolling daily forum window: opens 07:00 ET, runs until the next morning,
    // one run per team per day (PRD open question 3 — agents are always online).
    label: "forum",
    type: "forum",
    opensDay: "tue",
    opensTime: "07:00",
    closesDay: "wed",
    closesTime: "06:00",
    submissionLeadMinutes: DEFAULT_SUBMISSION_LEAD_MINUTES,
    daily: true,
  },
] as const;

/** The league week starts Tuesday 06:00 ET, so Tuesday is offset 0. */
const DAY_OFFSET_FROM_TUESDAY: Record<Weekday, number> = {
  tue: 0,
  wed: 1,
  thu: 2,
  fri: 3,
  sat: 4,
  sun: 5,
  mon: 6,
};

export function parseHhMm(value: string): { hh: number; mm: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) throw new Error(`Invalid HH:mm time: ${value}`);
  return { hh: Number(match[1]), mm: Number(match[2]) };
}

/**
 * An instant `dayOffset` days after the week anchor, at `time` Eastern.
 * The addition happens on the ET calendar, so the wall-clock time survives DST.
 */
export function etInstant(weekAnchor: number, dayOffset: number, time: string): number {
  const anchor = toETParts(weekAnchor);
  const { hh, mm } = parseHhMm(time);
  return fromETParts({
    year: anchor.year,
    month: anchor.month,
    day: anchor.day + dayOffset,
    hour: hh,
    minute: mm,
  });
}

export type ResolvedWindow = {
  label: string;
  type: WindowType;
  roundNo: number;
  /** Epoch ms. */
  opensAt: number;
  closesAt: number;
  submissionDeadlineAt: number;
  scope: TemplateScope;
};

function applyOverride(
  template: WindowTemplate,
  overrides: WindowOverrides | null | undefined,
): WindowTemplate {
  const override = overrides?.[template.label];
  if (!override) return template;
  return {
    ...template,
    opensDay: (override.opensDay as Weekday) ?? template.opensDay,
    opensTime: override.opensTime ?? template.opensTime,
    closesDay: (override.closesDay as Weekday) ?? template.closesDay,
    closesTime: override.closesTime ?? template.closesTime,
    submissionLeadMinutes: override.submissionLeadMinutes ?? template.submissionLeadMinutes,
    rounds: override.rounds ?? template.rounds,
    enabled: override.enabled ?? true,
  };
}

/**
 * Turn the templates into concrete UTC instants for one league week.
 *
 * `weekAnchor` is the week's Tuesday 06:00 ET (`weeks.startsAt`). Trade windows
 * expand into `rounds` equal sub-windows carrying `roundNo`; the forum window
 * expands into one window per day of the week.
 */
export function resolveWindowsForWeek(
  weekAnchor: number,
  overrides?: WindowOverrides | null,
  templates: readonly WindowTemplate[] = DEFAULT_WINDOW_TEMPLATES,
): ResolvedWindow[] {
  const out: ResolvedWindow[] = [];

  for (const raw of templates) {
    const template = applyOverride(raw, overrides);
    if (template.enabled === false) continue;

    const openOffset = DAY_OFFSET_FROM_TUESDAY[template.opensDay];
    let closeOffset = DAY_OFFSET_FROM_TUESDAY[template.closesDay];
    // A close "earlier in the week" than the open means it wraps to the next day.
    if (closeOffset < openOffset) closeOffset += 7;

    if (template.daily) {
      for (let day = 0; day < 7; day++) {
        const opensAt = etInstant(weekAnchor, openOffset + day, template.opensTime);
        const closesAt = etInstant(weekAnchor, closeOffset + day, template.closesTime);
        out.push(
          finalize(template, day + 1, opensAt, closesAt, {
            ...(template.scope ?? {}),
            dayIndex: day + 1,
          }),
        );
      }
      continue;
    }

    const opensAt = etInstant(weekAnchor, openOffset, template.opensTime);
    const closesAt = etInstant(weekAnchor, closeOffset, template.closesTime);
    const rounds = Math.max(1, template.rounds ?? 1);

    if (rounds === 1) {
      out.push(finalize(template, 1, opensAt, closesAt, template.scope ?? {}));
      continue;
    }

    // Negotiation rounds are sub-windows so one tick handles them (PRD 6.2).
    const span = closesAt - opensAt;
    const step = Math.floor(span / rounds);
    for (let round = 1; round <= rounds; round++) {
      const roundOpens = opensAt + step * (round - 1);
      const roundCloses = round === rounds ? closesAt : opensAt + step * round;
      out.push(
        finalize(template, round, roundOpens, roundCloses, {
          ...(template.scope ?? {}),
          rounds,
          round,
        }),
      );
    }
  }

  return out.sort((a, b) => a.opensAt - b.opensAt);
}

function finalize(
  template: WindowTemplate,
  roundNo: number,
  opensAt: number,
  closesAt: number,
  scope: TemplateScope,
): ResolvedWindow {
  const leadMs = Math.max(0, template.submissionLeadMinutes) * 60_000;
  const submissionDeadlineAt = Math.max(opensAt, closesAt - leadMs);
  return { label: template.label, type: template.type, roundNo, opensAt, submissionDeadlineAt, closesAt, scope };
}

export function templateByLabel(label: string): WindowTemplate | undefined {
  return DEFAULT_WINDOW_TEMPLATES.find((t) => t.label === label);
}

/**
 * `dayBucket` drives lineup-window scopes: a Sunday-late window may only touch
 * players in `sun_late` and `mon` games. Computed in Eastern, so it stays
 * correct across the DST switch inside the NFL season.
 */
export function dayBucketFor(kickoffAt: number): "thu" | "sun_early" | "sun_late" | "mon" | "other" {
  const et = toETParts(kickoffAt);
  if (et.weekday === 4) return "thu";
  if (et.weekday === 1) return "mon";
  if (et.weekday === 0) return et.hour < 16 ? "sun_early" : "sun_late";
  return "other";
}
