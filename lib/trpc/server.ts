import { headers } from "next/headers";
import { cache } from "react";

import { createCallerFactory, createTRPCContext } from "./init";
import { appRouter } from "./routers/_app";

/** Per-request context, memoized so one RSC render resolves the session once. */
const createContext = cache(async () => {
  const heads = new Headers(await headers());
  heads.set("x-trpc-source", "rsc");
  return createTRPCContext({ headers: heads });
});

/**
 * Direct (no HTTP) caller for Server Components.
 *
 *   const { league, teams } = await api.league.get({ leagueId });
 */
export const api = createCallerFactory(appRouter)(createContext);

export { appRouter, type AppRouter } from "./routers/_app";
