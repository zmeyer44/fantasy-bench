import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * The test suite: Convex functions under `convex-test`, in the Edge Runtime
 * (`docs/CONVEX_NOTES.md` §9). `npm test`.
 *
 * The `@` alias resolves the few pure modules the functions share with the UI
 * (`lib/models.ts`, `lib/time.ts`, `lib/snapshot/types.ts`).
 */
export default defineConfig({
  resolve: { alias: { "@": path.resolve(process.cwd()) } },
  test: {
    environment: "edge-runtime",
    include: ["convex/**/*.test.ts", "components/**/*.test.ts"],
    server: { deps: { inline: ["convex-test"] } },
    testTimeout: 60_000,
  },
});
