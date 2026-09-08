import type { ModelCatalogEntry } from "@/lib/models";
import type { League, LeagueRules } from "@/lib/db/types";
import type { LeagueRuleChange } from "@/lib/services/league/rules";

export type SettingsTeam = {
  id: string;
  name: string;
  abbreviation: string;
  ownerUserId: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
  modelId: string | null;
  configVersionNo: number | null;
};

export type SettingsData = {
  league: League;
  rules: LeagueRules;
  invite: { code: string; url: string };
  teams: SettingsTeam[];
  changes: Array<LeagueRuleChange & { userName: string | null }>;
  modelsInUse: Array<{ modelId: string; teamCount: number }>;
  catalog: readonly ModelCatalogEntry[];
  locked: boolean;
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
