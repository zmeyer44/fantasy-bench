import { fetchRequestHandler } from "@trpc/server/adapters/fetch";

import { createTRPCContext } from "@/lib/trpc/init";
import { appRouter } from "@/lib/trpc/routers/_app";

function handler(req: Request) {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext: ({ req: request }) => createTRPCContext({ headers: request.headers }),
    onError({ error, path }) {
      if (process.env.NODE_ENV !== "production") {
        console.error(`tRPC error on ${path ?? "<no-path>"}:`, error);
      }
    },
  });
}

export { handler as GET, handler as POST };
