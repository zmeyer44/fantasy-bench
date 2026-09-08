import type { FunctionReturnType } from "convex/server";

import type { api } from "@/convex/_generated/api";

/** Exactly what `commissioner.settings` returns (league, rules, invite, log, models). */
export type CommissionerSettings = FunctionReturnType<typeof api.commissioner.settings>;

/**
 * One row of the Teams tab.
 *
 * `commissioner.settings` carries the roster itself (owner name *and* email,
 * the team's current model + config version, waiver priority), ordered by
 * waiver priority — the tab used `views.teams` as a stopgap, which is the
 * public standings card and has no owner email.
 */
export type SettingsTeam = CommissionerSettings["teams"][number];

/**
 * The console's props. Dates are epoch ms (Convex), and `league.id` is the
 * Convex `_id` restated under the name every mutation argument uses.
 */
export type SettingsData = Omit<CommissionerSettings, "league"> & {
  league: CommissionerSettings["league"] & { id: string };
};

/**
 * The default window templates (PRD 5.3). Overrides are keyed by these labels;
 * the scheduler package reads `league_rules.window_overrides` when it builds a
 * week's windows.
 */
export const WINDOW_TEMPLATES = [
  { label: "waiver", name: "Waiver", defaults: "Tue 06:00 → Wed 03:00" },
  { label: "trade_a", name: "Trade A", defaults: "Wed 09:00 → Wed 23:59" },
  { label: "trade_b", name: "Trade B", defaults: "Thu 09:00 → Thu 15:00" },
  { label: "lineup_tnf", name: "Lineup TNF", defaults: "Thu 16:00 → Thu 20:15" },
  { label: "lineup_sun_early", name: "Lineup Sun early", defaults: "Sun 09:00 → Sun 12:55" },
  { label: "lineup_sun_late", name: "Lineup Sun late", defaults: "Sun 14:00 → Sun 16:00" },
  { label: "lineup_mnf", name: "Lineup MNF", defaults: "Mon 16:00 → Mon 20:15" },
  { label: "forum", name: "Forum", defaults: "Daily 07:00, rolling" },
] as const;

export const WEEKDAY_OPTIONS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Weekday = (typeof WEEKDAY_OPTIONS)[number];

/**
 * The override shape the commissioner router accepts. `league_rules.window_overrides`
 * types its day fields as plain strings; the router narrows them to weekday keys,
 * so the form works in the narrow type and widens on read.
 */
export type WindowOverrideInput = {
  enabled?: boolean;
  opensDay?: Weekday;
  opensTime?: string;
  closesDay?: Weekday;
  closesTime?: string;
  submissionLeadMinutes?: number;
  rounds?: number;
};

export type WindowOverridesInput = Record<string, WindowOverrideInput>;
