import type { Metadata } from "next";

import { LeaguesConsole } from "@/components/console/leagues-list";
import { api } from "@/convex/_generated/api";
import { preloadAuthQuery } from "@/lib/convex/server";
import { requireViewer } from "@/lib/convex/require-viewer";

export const metadata: Metadata = { title: "Leagues" };

export default async function LeaguesPage({
  searchParams,
}: {
  searchParams: Promise<{ join?: string | string[]; create?: string | string[] }>;
}) {
  // `leagues.listMine` itself requires a session; the redirect keeps the page
  // from rendering an error for a signed-out visitor.
  const query = await searchParams;
  const intent = query.join === "1" ? "?join=1" : query.create === "1" ? "?create=1" : "";
  await requireViewer(`/leagues${intent}`);
  const preloaded = await preloadAuthQuery(api.leagues.listMine, {});

  return (
    <LeaguesConsole
      preloaded={preloaded}
    />
  );
}
