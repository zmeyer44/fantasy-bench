/**
 * Drop and recreate the `public` schema on `DATABASE_URL`.
 *
 * `npm run db:reset` chains this with `db:migrate` and `db:seed`. It refuses to
 * run against anything that does not look like a local Fantasy Bench database.
 */
import postgres from "postgres";

const GUARD = /fantasy_bench(_test)?$/;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  if (!GUARD.test(new URL(url).pathname.replace(/^\//, ""))) {
    throw new Error(
      `Refusing to reset ${url}: database name must end in fantasy_bench or fantasy_bench_test`,
    );
  }
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await client.unsafe("drop schema if exists public cascade");
    await client.unsafe("drop schema if exists drizzle cascade");
    await client.unsafe("create schema public");
    console.log(`Reset schema on ${url}`);
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
