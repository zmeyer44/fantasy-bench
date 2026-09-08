"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { createTRPCContext } from "@trpc/tanstack-react-query";
import { useState } from "react";
import superjson from "superjson";

import type { AppRouter } from "@/lib/trpc/routers/_app";

/**
 * `useTRPC()` returns an options proxy — call it inside TanStack Query hooks:
 *
 *   const trpc = useTRPC();
 *   const { data } = useQuery(trpc.league.listMine.queryOptions());
 *   const create = useMutation(trpc.league.create.mutationOptions());
 */
export const { TRPCProvider, useTRPC, useTRPCClient } = createTRPCContext<AppRouter>();

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Long enough that a client-side navigation does not refetch instantly.
        staleTime: 30_000,
        refetchOnWindowFocus: false,
      },
    },
  });
}

let browserQueryClient: QueryClient | undefined;

function getQueryClient() {
  if (typeof window === "undefined") return makeQueryClient();
  browserQueryClient ??= makeQueryClient();
  return browserQueryClient;
}

export function TRPCReactProvider({ children }: { children: React.ReactNode }) {
  const queryClient = getQueryClient();
  const [trpcClient] = useState(() =>
    createTRPCClient<AppRouter>({
      links: [
        // superjson lives on the LINK in tRPC 11, not on createTRPCClient.
        httpBatchLink({ url: "/api/trpc", transformer: superjson }),
      ],
    }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        {children}
      </TRPCProvider>
    </QueryClientProvider>
  );
}
