/**
 * The database singleton.
 *
 * Next dev (and vitest watch) re-evaluate modules on every HMR pass; without
 * the `globalThis` cache each pass would open a fresh postgres.js pool and
 * exhaust connections within a few edits.
 */
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { env } from "@/lib/env";
import * as schema from "./schema";

export * as schema from "./schema";

export type Schema = typeof schema;
export type Db = PostgresJsDatabase<Schema> & { $client: postgres.Sql };
export type Tx = PgTransaction<
  PostgresJsQueryResultHKT,
  Schema,
  ExtractTablesWithRelations<Schema>
>;
/** Accept either the pool or an open transaction — services should take this. */
export type DbOrTx = Db | Tx;

type GlobalWithDb = typeof globalThis & {
  __fantasyBenchDb?: Db;
  __fantasyBenchSql?: postgres.Sql;
};

const globalRef = globalThis as GlobalWithDb;

function createClient(): postgres.Sql {
  return postgres(env.DATABASE_URL, {
    // Serverless-friendly; the local dev pool never needs to be large.
    max: process.env.NODE_ENV === "production" ? 10 : 5,
    idle_timeout: 20,
    max_lifetime: 60 * 30,
    // postgres.js parses `numeric` to string by default; drizzle's
    // `mode: "number"` handles the conversion, so leave the raw types alone.
    onnotice: () => {},
  });
}

/** Raw postgres.js client. Named `pgClient` to avoid colliding with drizzle's `sql` tag. */
export const pgClient: postgres.Sql = globalRef.__fantasyBenchSql ?? createClient();
export const db: Db = globalRef.__fantasyBenchDb ?? (drizzle(pgClient, { schema }) as Db);

if (process.env.NODE_ENV !== "production") {
  globalRef.__fantasyBenchSql = pgClient;
  globalRef.__fantasyBenchDb = db;
}

/**
 * Run `fn` inside a transaction unless one is already open.
 *
 * Services take a `DbOrTx` so they compose; this helper lets a caller open the
 * transaction without every service needing to know whether it is nested.
 */
export async function withTransaction<T>(
  fn: (tx: Tx) => Promise<T>,
  executor: DbOrTx = db,
): Promise<T> {
  if (isTransaction(executor)) return fn(executor);
  return (executor as Db).transaction(async (tx) => fn(tx as Tx));
}

function isTransaction(executor: DbOrTx): executor is Tx {
  return !("$client" in executor);
}
