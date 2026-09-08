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
import type * as commissioner from "../commissioner.js";
import type * as commissioner_agent from "../commissioner_agent.js";
import type * as configs from "../configs.js";
import type * as draft from "../draft.js";
import type * as forum from "../forum.js";
import type * as http from "../http.js";
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
import type * as lib_scoring_pure from "../lib/scoring_pure.js";
import type * as lib_season from "../lib/season.js";
import type * as lib_seed_secret from "../lib/seed_secret.js";
import type * as lib_social_pure from "../lib/social_pure.js";
import type * as lib_standings_pure from "../lib/standings_pure.js";
import type * as lib_templates from "../lib/templates.js";
import type * as lib_validators from "../lib/validators.js";
import type * as lib_views_shared from "../lib/views_shared.js";
import type * as lineups from "../lineups.js";
import type * as messaging from "../messaging.js";
import type * as metrics from "../metrics.js";
import type * as runs from "../runs.js";
import type * as scoring from "../scoring.js";
import type * as seed from "../seed.js";
import type * as seed_skills from "../seed/skills.js";
import type * as skills from "../skills.js";
import type * as snapshot from "../snapshot.js";
import type * as standings from "../standings.js";
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
  commissioner: typeof commissioner;
  commissioner_agent: typeof commissioner_agent;
  configs: typeof configs;
  draft: typeof draft;
  forum: typeof forum;
  http: typeof http;
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
  "lib/scoring_pure": typeof lib_scoring_pure;
  "lib/season": typeof lib_season;
  "lib/seed_secret": typeof lib_seed_secret;
  "lib/social_pure": typeof lib_social_pure;
  "lib/standings_pure": typeof lib_standings_pure;
  "lib/templates": typeof lib_templates;
  "lib/validators": typeof lib_validators;
  "lib/views_shared": typeof lib_views_shared;
  lineups: typeof lineups;
  messaging: typeof messaging;
  metrics: typeof metrics;
  runs: typeof runs;
  scoring: typeof scoring;
  seed: typeof seed;
  "seed/skills": typeof seed_skills;
  skills: typeof skills;
  snapshot: typeof snapshot;
  standings: typeof standings;
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
