/**
 * Server-side Convex access for React Server Components and route handlers.
 *
 * `preloadAuthQuery` gives a fast first paint (the client component then takes
 * over the subscription with `usePreloadedQuery`); `fetchAuthQuery` is for reads
 * whose result stays on the server. Both forward the Convex Auth token when the
 * visitor is signed in. Never perform side effects from GET handlers or server
 * components (CSRF) — mutations happen from client components or Server Actions.
 */
import { convexAuthNextjsToken } from "@convex-dev/auth/nextjs/server";
import { fetchQuery, preloadQuery } from "convex/nextjs";
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";

export async function convexToken(): Promise<string | undefined> {
  return convexAuthNextjsToken();
}

export async function fetchAuthQuery<Query extends FunctionReference<"query">>(
  query: Query,
  args: FunctionArgs<Query>,
): Promise<FunctionReturnType<Query>> {
  const token = await convexToken();
  return fetchQuery(query, args, { token });
}

export async function preloadAuthQuery<Query extends FunctionReference<"query">>(
  query: Query,
  args: FunctionArgs<Query>,
) {
  const token = await convexToken();
  return preloadQuery(query, args, { token });
}
