/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as auth from "../auth.js";
import type * as avatar_generation from "../avatar_generation.js";
import type * as commissioner from "../commissioner.js";
import type * as commissioner_agent from "../commissioner_agent.js";
import type * as configs from "../configs.js";
import type * as crons from "../crons.js";
import type * as custom_tools from "../custom_tools.js";
import type * as draft from "../draft.js";
import type * as draft_progression from "../draft_progression.js";
import type * as forum from "../forum.js";
import type * as gateway_keys from "../gateway_keys.js";
import type * as http from "../http.js";
import type * as ingest from "../ingest.js";
import type * as leagues from "../leagues.js";
import type * as ledger from "../ledger.js";
import type * as lib_agent_action from "../lib/agent_action.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_config_pure from "../lib/config_pure.js";
import type * as lib_defaults from "../lib/defaults.js";
import type * as lib_draft_pure from "../lib/draft_pure.js";
import type * as lib_errors from "../lib/errors.js";
import type * as lib_fairness_pure from "../lib/fairness_pure.js";
import type * as lib_lineup_pure from "../lib/lineup_pure.js";
import type * as lib_moderation_pure from "../lib/moderation_pure.js";
import type * as lib_pricing_pure from "../lib/pricing_pure.js";
import type * as lib_scoring_pure from "../lib/scoring_pure.js";
import type * as lib_scoring_table from "../lib/scoring_table.js";
import type * as lib_season from "../lib/season.js";
import type * as lib_secrets from "../lib/secrets.js";
import type * as lib_seed_secret from "../lib/seed_secret.js";
import type * as lib_social_pure from "../lib/social_pure.js";
import type * as lib_standings_pure from "../lib/standings_pure.js";
import type * as lib_templates from "../lib/templates.js";
import type * as lib_validators from "../lib/validators.js";
import type * as lib_views_shared from "../lib/views_shared.js";
import type * as lib_visibility from "../lib/visibility.js";
import type * as lineups from "../lineups.js";
import type * as messaging from "../messaging.js";
import type * as metrics from "../metrics.js";
import type * as providers_espn from "../providers/espn.js";
import type * as providers_fantasypros from "../providers/fantasypros.js";
import type * as providers_http from "../providers/http.js";
import type * as providers_index from "../providers/index.js";
import type * as providers_nflverse from "../providers/nflverse.js";
import type * as providers_sleeper from "../providers/sleeper.js";
import type * as providers_teams from "../providers/teams.js";
import type * as providers_types from "../providers/types.js";
import type * as runs from "../runs.js";
import type * as runtime_dev from "../runtime/dev.js";
import type * as runtime_execute from "../runtime/execute.js";
import type * as runtime_load from "../runtime/load.js";
import type * as runtime_mock_model from "../runtime/mock_model.js";
import type * as runtime_model from "../runtime/model.js";
import type * as runtime_pool from "../runtime/pool.js";
import type * as runtime_prompt from "../runtime/prompt.js";
import type * as runtime_tools_catalog from "../runtime/tools/catalog.js";
import type * as runtime_tools_context from "../runtime/tools/context.js";
import type * as runtime_tools_custom from "../runtime/tools/custom.js";
import type * as runtime_tools_draft from "../runtime/tools/draft.js";
import type * as runtime_tools_identity from "../runtime/tools/identity.js";
import type * as runtime_tools_index from "../runtime/tools/index.js";
import type * as runtime_tools_read from "../runtime/tools/read.js";
import type * as runtime_tools_write from "../runtime/tools/write.js";
import type * as runtime_types from "../runtime/types.js";
import type * as runtime_untrusted from "../runtime/untrusted.js";
import type * as scheduling from "../scheduling.js";
import type * as scoring from "../scoring.js";
import type * as season from "../season.js";
import type * as seed from "../seed.js";
import type * as seed_skills from "../seed/skills.js";
import type * as skills from "../skills.js";
import type * as snapshot from "../snapshot.js";
import type * as standings from "../standings.js";
import type * as team_identity from "../team_identity.js";
import type * as trades from "../trades.js";
import type * as transactions from "../transactions.js";
import type * as users from "../users.js";
import type * as views from "../views.js";
import type * as waivers from "../waivers.js";
import type * as weeks from "../weeks.js";
import type * as windows from "../windows.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  avatar_generation: typeof avatar_generation;
  commissioner: typeof commissioner;
  commissioner_agent: typeof commissioner_agent;
  configs: typeof configs;
  crons: typeof crons;
  custom_tools: typeof custom_tools;
  draft: typeof draft;
  draft_progression: typeof draft_progression;
  forum: typeof forum;
  gateway_keys: typeof gateway_keys;
  http: typeof http;
  ingest: typeof ingest;
  leagues: typeof leagues;
  ledger: typeof ledger;
  "lib/agent_action": typeof lib_agent_action;
  "lib/auth": typeof lib_auth;
  "lib/config_pure": typeof lib_config_pure;
  "lib/defaults": typeof lib_defaults;
  "lib/draft_pure": typeof lib_draft_pure;
  "lib/errors": typeof lib_errors;
  "lib/fairness_pure": typeof lib_fairness_pure;
  "lib/lineup_pure": typeof lib_lineup_pure;
  "lib/moderation_pure": typeof lib_moderation_pure;
  "lib/pricing_pure": typeof lib_pricing_pure;
  "lib/scoring_pure": typeof lib_scoring_pure;
  "lib/scoring_table": typeof lib_scoring_table;
  "lib/season": typeof lib_season;
  "lib/secrets": typeof lib_secrets;
  "lib/seed_secret": typeof lib_seed_secret;
  "lib/social_pure": typeof lib_social_pure;
  "lib/standings_pure": typeof lib_standings_pure;
  "lib/templates": typeof lib_templates;
  "lib/validators": typeof lib_validators;
  "lib/views_shared": typeof lib_views_shared;
  "lib/visibility": typeof lib_visibility;
  lineups: typeof lineups;
  messaging: typeof messaging;
  metrics: typeof metrics;
  "providers/espn": typeof providers_espn;
  "providers/fantasypros": typeof providers_fantasypros;
  "providers/http": typeof providers_http;
  "providers/index": typeof providers_index;
  "providers/nflverse": typeof providers_nflverse;
  "providers/sleeper": typeof providers_sleeper;
  "providers/teams": typeof providers_teams;
  "providers/types": typeof providers_types;
  runs: typeof runs;
  "runtime/dev": typeof runtime_dev;
  "runtime/execute": typeof runtime_execute;
  "runtime/load": typeof runtime_load;
  "runtime/mock_model": typeof runtime_mock_model;
  "runtime/model": typeof runtime_model;
  "runtime/pool": typeof runtime_pool;
  "runtime/prompt": typeof runtime_prompt;
  "runtime/tools/catalog": typeof runtime_tools_catalog;
  "runtime/tools/context": typeof runtime_tools_context;
  "runtime/tools/custom": typeof runtime_tools_custom;
  "runtime/tools/draft": typeof runtime_tools_draft;
  "runtime/tools/identity": typeof runtime_tools_identity;
  "runtime/tools/index": typeof runtime_tools_index;
  "runtime/tools/read": typeof runtime_tools_read;
  "runtime/tools/write": typeof runtime_tools_write;
  "runtime/types": typeof runtime_types;
  "runtime/untrusted": typeof runtime_untrusted;
  scheduling: typeof scheduling;
  scoring: typeof scoring;
  season: typeof season;
  seed: typeof seed;
  "seed/skills": typeof seed_skills;
  skills: typeof skills;
  snapshot: typeof snapshot;
  standings: typeof standings;
  team_identity: typeof team_identity;
  trades: typeof trades;
  transactions: typeof transactions;
  users: typeof users;
  views: typeof views;
  waivers: typeof waivers;
  weeks: typeof weeks;
  windows: typeof windows;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  runPool: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"runPool">;
};
