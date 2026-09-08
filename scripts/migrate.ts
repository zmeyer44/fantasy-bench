/**
 * Apply pending migrations from `lib/db/migrations` to `DATABASE_URL`.
 *
 * Used by `npm run db:migrate`, `npm run db:reset`, and the vitest setup file.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS_FOLDER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../lib/db/migrations",
);

export async function runMigrations(databaseUrl = process.env.DATABASE_URL): Promise<void> {
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const client = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await client.end({ timeout: 5 });
  }
}

const isDirectRun =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  const url = process.env.DATABASE_URL;
  runMigrations(url)
    .then(() => {
      console.log(`Migrations applied to ${url?.replace(/:[^:@/]*@/, ":***@")}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error("Migration failed:", err);
      process.exit(1);
    });
}
