import path from "node:path";
import { defineConfig } from "vitest/config";

// `process.cwd()` rather than `import.meta.dirname`: vitest may load this file
// as CJS, and `import.meta` triggers a loader warning there.
const root = path.resolve(process.cwd());

export default defineConfig({
  resolve: {
    alias: { "@": root },
  },
  test: {
    environment: "node",
    globals: false,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts"],
    // Every suite shares one Postgres database, so files must not overlap.
    // Vitest 4 removed `poolOptions`; `fileParallelism: false` is the switch.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
