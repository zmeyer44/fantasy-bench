/**
 * Decision-window templates (PRD §5.3).
 *
 * Templates are declared in **Eastern wall-clock time**; instants are derived
 * per week by walking forward from that week's Tuesday 06:00 ET anchor in ET
 * calendar space and converting once at the end. That is what makes a window
 * land at the same local time on both sides of the DST switch — a fixed offset
 * from a UTC anchor would drift by an hour in early November.
 *
 * Commissioners override any field per label through
 * `league_rules.window_overrides`.
 */
import type { WindowOverrides, WindowScope } from "@/lib/db/schema";
import type { WindowType } from "@/lib/db/types";
import { fromET, toET, type Weekday } from "@/lib/time";

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
  scope?: WindowScope;
  /** Expand to one window per day of the league week (the forum window). */
  daily?: boolean;
  enabled?: boolean;
};

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
export function etInstant(weekAnchor: Date, dayOffset: number, time: string): Date {
  const anchor = toET(weekAnchor);
  const { hh, mm } = parseHhMm(time);
  return fromET({
    year: anchor.getFullYear(),
    month: anchor.getMonth() + 1,
    day: anchor.getDate() + dayOffset,
    hour: hh,
    minute: mm,
  });
}

export type ResolvedWindow = {
  label: string;
  type: WindowType;
  roundNo: number;
  opensAt: Date;
  closesAt: Date;
  submissionDeadlineAt: Date;
  scope: WindowScope;
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
 * `weekAnchor` is the week's Tuesday 06:00 ET (`weeks.starts_at`). Trade windows
 * expand into `rounds` equal sub-windows carrying `round_no`; the forum window
 * expands into one window per day of the week.
 */
export function resolveWindowsForWeek(
  weekAnchor: Date,
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
    const span = closesAt.getTime() - opensAt.getTime();
    const step = Math.floor(span / rounds);
    for (let round = 1; round <= rounds; round++) {
      const roundOpens = new Date(opensAt.getTime() + step * (round - 1));
      const roundCloses =
        round === rounds ? closesAt : new Date(opensAt.getTime() + step * round);
      out.push(
        finalize(template, round, roundOpens, roundCloses, {
          ...(template.scope ?? {}),
          rounds,
          roundNo: round,
        }),
      );
    }
  }

  return out.sort((a, b) => a.opensAt.getTime() - b.opensAt.getTime());
}

function finalize(
  template: WindowTemplate,
  roundNo: number,
  opensAt: Date,
  closesAt: Date,
  scope: WindowScope,
): ResolvedWindow {
  const leadMs = Math.max(0, template.submissionLeadMinutes) * 60_000;
  const submissionDeadlineAt = new Date(
    Math.max(opensAt.getTime(), closesAt.getTime() - leadMs),
  );
  return {
    label: template.label,
    type: template.type,
    roundNo,
    opensAt,
    closesAt,
    submissionDeadlineAt,
    scope,
  };
}

export function templateByLabel(label: string): WindowTemplate | undefined {
  return DEFAULT_WINDOW_TEMPLATES.find((t) => t.label === label);
}
