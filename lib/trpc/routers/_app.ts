/**
 * Router registry.
 *
 * APPEND-ONLY: add exactly one line per domain router. Do not restructure this
 * file — several work packages edit it in parallel.
 */
import { router } from "@/lib/trpc/init";

import { commissionerRouter } from "./commissioner";
import { configRouter } from "./config";
import { costRouter } from "./cost";
import { forumRouter } from "./forum";
import { leagueRouter } from "./league";
import { messagingRouter } from "./messaging";
import { skillsRouter } from "./skills";
import { tradesRouter } from "./trades";
import { tracesRouter } from "./traces";
import { viewsRouter } from "./views";

export const appRouter = router({
  league: leagueRouter,
  config: configRouter,
  skills: skillsRouter,
  cost: costRouter,
  views: viewsRouter,
  traces: tracesRouter,
  commissioner: commissionerRouter,
  trades: tradesRouter,
  messaging: messagingRouter,
  forum: forumRouter,
});

export type AppRouter = typeof appRouter;
