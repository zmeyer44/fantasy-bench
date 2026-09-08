import { config as loadEnv } from "dotenv";
import { defineConfig } from "drizzle-kit";

// drizzle-kit runs this file directly, so it has to load the env itself.
loadEnv({ path: [".env.local", ".env"], quiet: true });

/**
 * `db:generate` / `db:push` read `DATABASE_URL` from `.env.local`, falling back
 * to the dev database.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./lib/db/schema/index.ts",
  out: "./lib/db/migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://localhost:5432/fantasy_bench",
  },
  strict: true,
  verbose: true,
});
