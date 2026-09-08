import { defineApp } from "convex/server";
import workpool from "@convex-dev/workpool/convex.config.js";

const app = defineApp();
// One pool for agent-run execution (PRD 5.4 / migration plan §4). Parallelism is
// configured where the pool is instantiated (convex/runtime/pool.ts).
app.use(workpool, { name: "runPool" });

export default app;
