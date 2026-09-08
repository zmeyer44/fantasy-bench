import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Convex function tests run with `convex-test` in the Edge Runtime, separately from
 * the Postgres-backed suite in vitest.config.ts. `npm run test:convex`.
 */
export default defineConfig({
  resolve: { alias: { "@": path.resolve(process.cwd()) } },
  test: {
    environment: "edge-runtime",
    include: ["convex/**/*.test.ts"],
    server: { deps: { inline: ["convex-test"] } },
    testTimeout: 60_000,
  },
});
