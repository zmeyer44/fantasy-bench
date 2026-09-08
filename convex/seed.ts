/**
 * Seeding (docs/CONVEX_CONVENTIONS.md "Seed contract").
 *
 * Two entry points:
 *
 *  1. `seed.base` — idempotent, in-Convex, tiny: model prices from `lib/models.ts`
 *     and the three built-in skills. `npx convex run seed:base` (internal) or
 *     `seed.runBase({ secret })` from the seed script.
 *  2. `scripts/seed-convex.ts` — Node, imports `tests/golden/postgres-week1/*.json`
 *     through `seed.importBatch`. The 12 MB of fixtures never enter the deployment
 *     bundle, and the demo user is created through the real Convex Auth password
 *     flow rather than by writing `authAccounts` by hand.
 *
 * Everything public here is guarded by the `SEED_SECRET` deployment env var
 * (convex/lib/seed_secret.ts). It has to be public: `ConvexHttpClient` cannot call
 * `internal.*`. On a deployment without `SEED_SECRET` every one of these fails.
 */
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { appError } from "./lib/errors";
import { requireSeedSecret } from "./lib/seed_secret";
import { BUILTIN_SKILLS } from "./seed/skills";
import { MODEL_CATALOG } from "@/lib/models";

/** Fixed so re-running the seed never creates a second price row. */
const PRICES_EFFECTIVE_FROM = Date.parse("2026-01-01T00:00:00.000Z");

/**
 * Tables the importer and `reset` may touch. Convex Auth's tables (`users`,
 * `authSessions`, `authAccounts`, …) are deliberately absent: the demo account is
 * created through the password flow and must survive a reset, and hand-writing
 * auth rows would desynchronise the credential hashes.
 */
const APP_TABLES = [
  "leagues",
  "league_rules",
  "league_rule_changes",
  "league_members",
  "teams",
  "weeks",
  "matchups",
  "team_results",
  "team_standings",
  "players",
  "nfl_games",
  "player_stats_weekly",
  "player_projections",
  "player_projection_latest",
  "news_items",
  "injury_designations",
  "player_ownership",
  "custom_providers",
  "roster_slots",
  "lineups",
  "transactions",
  "agent_configs",
  "config_versions",
  "skills",
  "windows",
  "snapshots",
  "snapshot_digests",
  "snapshot_chunks",
  "runs",
  "run_steps",
  "run_step_payloads",
  "run_actions",
  "run_search_docs",
  "waiver_claims",
  "draft_picks",
  "auction_nominations",
  "auction_bids",
  "trades",
  "trade_events",
  "trade_votes",
  "threads",
  "messages",
  "forum_posts",
  "forum_comments",
  "forum_votes",
  "usage_events",
  "model_prices",
  "budgets",
  "team_week_rollups",
  "model_week_rollups",
  "league_week_rollups",
  "team_week_metrics",
  "ingest_state",
] as const;

type AppTable = (typeof APP_TABLES)[number];

const appTable = v.union(...APP_TABLES.map((t) => v.literal(t)));

function assertTable(table: string): AppTable {
  if (!(APP_TABLES as readonly string[]).includes(table)) {
    throw appError("BAD_REQUEST", `Table "${table}" is not importable.`);
  }
  return table as AppTable;
}

/**
 * TypeScript cannot narrow a union table name to a single document type, so the
 * row is cast at the boundary. The real check is Convex's own schema validation
 * on insert: a mis-shaped row fails the mutation.
 */
async function insertRow(
  ctx: MutationCtx,
  table: AppTable,
  row: Record<string, unknown>,
): Promise<string> {
  return ctx.db.insert(table, row as never);
}

// ------------------------------------------------------------------- seed:base

async function seedBase(ctx: MutationCtx): Promise<{ modelPrices: number; skills: number }> {
  for (const model of MODEL_CATALOG) {
    const existing = await ctx.db
      .query("model_prices")
      .withIndex("by_modelId_effectiveFrom", (q) =>
        q.eq("modelId", model.modelId).eq("effectiveFrom", PRICES_EFFECTIVE_FROM),
      )
      .unique();
    const row = {
      modelId: model.modelId,
      provider: model.provider,
      displayName: model.displayName,
      inputPerM: model.inputPerM,
      outputPerM: model.outputPerM,
      cachedInputPerM: model.cachedInputPerM ?? undefined,
      reasoningPerM: model.reasoningPerM ?? undefined,
      supportsReasoning: model.supportsReasoning,
      effectiveFrom: PRICES_EFFECTIVE_FROM,
    };
    if (existing) await ctx.db.patch("model_prices", existing._id, row);
    else await ctx.db.insert("model_prices", row);
  }

  const now = Date.now();
  for (const skill of BUILTIN_SKILLS) {
    const existing = await ctx.db
      .query("skills")
      .withIndex("by_slug", (q) => q.eq("slug", skill.slug))
      .unique();
    if (existing) {
      await ctx.db.patch("skills", existing._id, {
        name: skill.name,
        description: skill.description,
        bodyMd: skill.bodyMd,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("skills", {
        slug: skill.slug,
        name: skill.name,
        description: skill.description,
        bodyMd: skill.bodyMd,
        visibility: "public",
        usageCount: 0,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  return { modelPrices: MODEL_CATALOG.length, skills: BUILTIN_SKILLS.length };
}

const baseResult = v.object({ modelPrices: v.number(), skills: v.number() });

/** `npx convex run seed:base`. Idempotent. */
export const base = internalMutation({
  args: {},
  returns: baseResult,
  handler: async (ctx) => seedBase(ctx),
});

/** The same thing, reachable from `ConvexHttpClient` in `scripts/seed-convex.ts`. */
export const runBase = mutation({
  args: { secret: v.string() },
  returns: baseResult,
  handler: async (ctx, { secret }) => {
    requireSeedSecret(secret);
    return seedBase(ctx);
  },
});

// ------------------------------------------------------------------ seed:reset

/** Documents deleted per invocation; `reset` reschedules itself until the tables are empty. */
const RESET_BATCH = 2_000;
/** Documents deleted per `clearTable` call; the caller loops until `done`. */
const DELETE_BATCH = 1_000;

/**
 * Wipe every app table. Dev only: it refuses unless `SEED_SECRET` is set on the
 * deployment, which is the marker for "this is a scratch deployment".
 */
export const reset = internalMutation({
  args: {},
  returns: v.object({ deleted: v.number(), done: v.boolean() }),
  handler: async (ctx) => {
    if (!process.env.SEED_SECRET) {
      throw appError("FORBIDDEN", "seed:reset refuses to run without SEED_SECRET (dev only).");
    }

    let deleted = 0;
    for (const table of APP_TABLES) {
      if (deleted >= RESET_BATCH) break;
      // Bounded: at most RESET_BATCH documents are read per table per invocation.
      const rows = await ctx.db.query(table).take(RESET_BATCH - deleted);
      for (const row of rows) {
        await ctx.db.delete(table, row._id as Id<AppTable>);
        deleted += 1;
      }
    }

    const done = deleted < RESET_BATCH;
    if (!done) await ctx.scheduler.runAfter(0, internal.seed.reset, {});
    return { deleted, done };
  },
});

// ----------------------------------------------------------------- import path

/**
 * Insert a batch of already-shaped rows.
 *
 * `rows` is `v.array(v.any())` — the one place in the codebase outside the six
 * documented schema fields. It is deliberate: this mutation is generic over 50
 * tables, so no single validator can describe its payload, and every row is
 * validated anyway by Convex's schema validation on insert (which is stricter
 * than anything expressible here). The `table` argument is checked against an
 * allowlist, and the whole function is behind `SEED_SECRET`.
 *
 * Returns the new ids in input order so `scripts/seed-convex.ts` can build its
 * `legacyId -> Id<...>` map for the next table.
 */
export const importBatch = mutation({
  args: { secret: v.string(), table: v.string(), rows: v.array(v.any()) },
  returns: v.object({ ids: v.array(v.string()) }),
  handler: async (ctx, { secret, table, rows }) => {
    requireSeedSecret(secret);
    const target = assertTable(table);
    const ids: string[] = [];
    for (const row of rows) {
      ids.push(await insertRow(ctx, target, row as Record<string, unknown>));
    }
    return { ids };
  },
});

/**
 * `legacyId -> _id` for one page of a table, so a re-run can skip rows it already
 * imported. No table has a `by_legacyId` index (legacyId is temporary and goes in
 * the cleanup phase), so the scan is paginated rather than collected: the caller
 * loops on `continueCursor` until `isDone`.
 *
 * `legacyIds`, when given, narrows the returned map — the scan is the same.
 */
export const lookupLegacy = query({
  args: {
    secret: v.string(),
    table: appTable,
    legacyIds: v.optional(v.array(v.string())),
    cursor: v.optional(v.union(v.string(), v.null())),
    numItems: v.optional(v.number()),
  },
  returns: v.object({
    map: v.record(v.string(), v.string()),
    continueCursor: v.string(),
    isDone: v.boolean(),
  }),
  handler: async (ctx: QueryCtx, args) => {
    requireSeedSecret(args.secret);
    const wanted = args.legacyIds ? new Set(args.legacyIds) : null;
    const page = await ctx.db.query(args.table).paginate({
      numItems: Math.min(args.numItems ?? 500, 1_000),
      cursor: args.cursor ?? null,
    });

    const map: Record<string, string> = {};
    for (const row of page.page) {
      const legacyId = (row as { legacyId?: string }).legacyId;
      if (!legacyId) continue;
      if (wanted && !wanted.has(legacyId)) continue;
      map[legacyId] = row._id;
    }
    return { map, continueCursor: page.continueCursor, isDone: page.isDone };
  },
});

/**
 * One page of a table's row count. Convex allows a single paginated query per
 * function call, so the caller loops on `continueCursor` — `scripts/seed-convex.ts`
 * does this in its verification pass.
 */
export const tableCount = query({
  args: {
    secret: v.string(),
    table: appTable,
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.object({
    count: v.number(),
    continueCursor: v.string(),
    isDone: v.boolean(),
  }),
  handler: async (ctx: QueryCtx, { secret, table, cursor }) => {
    requireSeedSecret(secret);
    const page = await ctx.db.query(table).paginate({ numItems: 1_000, cursor: cursor ?? null });
    return { count: page.page.length, continueCursor: page.continueCursor, isDone: page.isDone };
  },
});

/**
 * Delete every document in one table, `DELETE_BATCH` at a time.
 *
 * The derived tables (`snapshot_chunks`, the three rollups, `team_standings`,
 * `run_search_docs`, `player_projection_latest`) carry no `legacyId`, so the
 * importer cannot tell an already-imported row from a new one. It clears them
 * before rewriting, which keeps `npm run seed:convex` idempotent end to end.
 *
 * Returns `done: false` while rows remain, so the caller loops.
 */
export const clearTable = mutation({
  args: { secret: v.string(), table: appTable },
  returns: v.object({ deleted: v.number(), done: v.boolean() }),
  handler: async (ctx, { secret, table }) => {
    requireSeedSecret(secret);
    const target = assertTable(table);
    // Bounded: at most DELETE_BATCH documents are read per call.
    const rows = await ctx.db.query(target).take(DELETE_BATCH);
    for (const row of rows) await ctx.db.delete(target, row._id as Id<AppTable>);
    return { deleted: rows.length, done: rows.length < DELETE_BATCH };
  },
});

/**
 * Patch already-imported rows.
 *
 * The golden dataset has two reference cycles that a single insert pass cannot
 * satisfy — `agent_configs.currentVersionId` <-> `config_versions.configId`, and
 * `windows.snapshotId` <-> `snapshots.windowId` — so the importer inserts the
 * first side without the pointer and fills it in here. It is also how the demo
 * user's `legacyId` gets stamped (`users` is not importable, only patchable).
 *
 * `rows` is `{ id, patch }` pairs; `v.any()` for the same reason as `importBatch`.
 */
export const patchBatch = mutation({
  args: {
    secret: v.string(),
    table: v.union(v.literal("users"), appTable),
    rows: v.array(v.any()),
  },
  returns: v.number(),
  handler: async (ctx, { secret, table, rows }) => {
    requireSeedSecret(secret);
    const target = table === "users" ? "users" : assertTable(table);
    for (const row of rows) {
      const { id, patch } = row as { id: string; patch: Record<string, unknown> };
      await ctx.db.patch(target, id as Id<AppTable | "users">, patch as never);
    }
    return rows.length;
  },
});

