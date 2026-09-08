/**
 * Shared `returns` validators.
 *
 * Document validators are derived from `convex/schema.ts` (`table.validator.fields`)
 * so they cannot drift from the schema: adding a field to a table adds it here.
 * Composite view queries (`leagues.get`, `configs.get`) declare an explicit
 * TypeScript return type instead — see docs/CONVEX_CONVENTIONS.md.
 */
import { v, type Validator } from "convex/values";

import schema from "../schema";

const systemFields = <T extends string>(table: T) =>
  ({ _id: v.id(table), _creationTime: v.number() }) as const;

export const leagueDoc = v.object({
  ...systemFields("leagues"),
  ...schema.tables.leagues.validator.fields,
});

export const rulesDoc = v.object({
  ...systemFields("league_rules"),
  ...schema.tables.league_rules.validator.fields,
});

export const teamDoc = v.object({
  ...systemFields("teams"),
  ...schema.tables.teams.validator.fields,
});

export const membershipDoc = v.object({
  ...systemFields("league_members"),
  ...schema.tables.league_members.validator.fields,
});

export const weekDoc = v.object({
  ...systemFields("weeks"),
  ...schema.tables.weeks.validator.fields,
});

export const agentConfigDoc = v.object({
  ...systemFields("agent_configs"),
  ...schema.tables.agent_configs.validator.fields,
});

export const configVersionDoc = v.object({
  ...systemFields("config_versions"),
  ...schema.tables.config_versions.validator.fields,
});

export const skillDoc = v.object({
  ...systemFields("skills"),
  ...schema.tables.skills.validator.fields,
});

export const ruleChangeDoc = v.object({
  ...systemFields("league_rule_changes"),
  ...schema.tables.league_rule_changes.validator.fields,
});

/** The shape `.paginate()` returns, for queries that declare `returns`. */
export function paginationResult<T extends Validator<unknown, "required", string>>(item: T) {
  return v.object({
    page: v.array(item),
    isDone: v.boolean(),
    continueCursor: v.string(),
    splitCursor: v.optional(v.union(v.string(), v.null())),
    pageStatus: v.optional(
      v.union(v.literal("SplitRecommended"), v.literal("SplitRequired"), v.null()),
    ),
  });
}
