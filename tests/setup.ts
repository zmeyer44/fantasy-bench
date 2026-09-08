/**
 * Test bootstrap: point at `fantasy_bench_test`, migrate once per process, and
 * expose `truncateAll()` for suites that need a clean slate.
 */
import { config as loadEnv } from "dotenv";
import path from "node:path";
import { afterAll, beforeAll } from "vitest";

loadEnv({ path: path.resolve(import.meta.dirname, "../.env.test"), quiet: true });

if (!process.env.DATABASE_URL?.includes("fantasy_bench_test")) {
  throw new Error(
    `Refusing to run tests against ${process.env.DATABASE_URL}. ` +
      "Set DATABASE_URL to the fantasy_bench_test database in .env.test.",
  );
}

// Imported after the env is loaded — lib/db reads DATABASE_URL at module init.
const { db, pgClient, schema } = await import("@/lib/db");

export { db, pgClient };

/**
 * Every application table, ordered only for readability — `TRUNCATE ... CASCADE`
 * handles the FK graph. `__drizzle_migrations` lives in the `drizzle` schema and
 * is deliberately left alone.
 */
export async function truncateAll(): Promise<void> {
  const rows = await pgClient<{ tablename: string }[]>`
    select tablename from pg_tables where schemaname = 'public'
  `;
  const names = rows.map((r) => `"public"."${r.tablename}"`);
  if (names.length === 0) return;
  await pgClient.unsafe(`truncate table ${names.join(", ")} restart identity cascade`);
}

let migrated = false;

/**
 * Tests push the *current* Drizzle schema straight to the test database instead of
 * replaying SQL migrations, so in-progress schema work is testable before a migration
 * is generated. Production and `npm run db:migrate` still use lib/db/migrations.
 */
beforeAll(async () => {
  if (migrated) return;
  const { pushSchema } = await import("drizzle-kit/api");
  // Start from an empty schema: pushSchema prompts interactively when a diff
  // would lose data, and a test database has nothing worth keeping.
  await pgClient.unsafe("drop schema if exists public cascade; create schema public;");
  await pgClient.unsafe("drop schema if exists drizzle cascade;");
  // drizzle-kit expects node-postgres style `{ rows }` from `execute`; postgres-js
  // returns the row array directly, so adapt it.
  const shim = {
    execute: async (query: unknown) => ({ rows: await db.execute(query as never) }),
  } as unknown as Parameters<typeof pushSchema>[1];
  const { apply } = await pushSchema(schema as Record<string, unknown>, shim);
  await apply();
  migrated = true;
});

afterAll(async () => {
  await pgClient.end({ timeout: 5 }).catch(() => {});
});
