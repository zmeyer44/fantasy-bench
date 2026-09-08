"use client";

import { ConvexAuthNextjsProvider } from "@convex-dev/auth/nextjs";
import { ConvexReactClient } from "convex/react";
import type { ReactNode } from "react";

/**
 * Convex client for the browser. Reads go through reactive `useQuery`
 * subscriptions; Convex Auth attaches the session token when signed in and
 * leaves requests anonymous otherwise (public leagues are readable anonymously).
 */
const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

export function ConvexClientProvider({ children }: { children: ReactNode }) {
  return <ConvexAuthNextjsProvider client={convex}>{children}</ConvexAuthNextjsProvider>;
}
