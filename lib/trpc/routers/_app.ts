/**
 * Router registry.
 *
 * APPEND-ONLY: add exactly one line per domain router. Do not restructure this
 * file — several work packages edit it in parallel.
 */
import { router } from "@/lib/trpc/init";

import { leagueRouter } from "./league";

export const appRouter = router({
  league: leagueRouter,
});

export type AppRouter = typeof appRouter;
