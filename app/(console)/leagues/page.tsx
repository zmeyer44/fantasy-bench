import type { Metadata } from "next";

import { LeaguesConsole } from "@/components/console/leagues-list";
import { api } from "@/convex/_generated/api";
import { preloadAuthQuery } from "@/lib/convex/server";
import { requireViewer } from "@/lib/convex/require-viewer";

export const metadata: Metadata = { title: "Leagues" };

export default async function LeaguesPage({
  searchParams,
}: {
  searchParams: Promise<{ join?: string | string[] }>;
}) {
  // `leagues.listMine` itself requires a session; the redirect keeps the page
  // from rendering an error for a signed-out visitor.
  await requireViewer("/leagues");
  const [preloaded, query] = await Promise.all([
    preloadAuthQuery(api.leagues.listMine, {}),
    searchParams,
  ]);

  return (
    <LeaguesConsole
      preloaded={preloaded}
      initialModal={query.join ? "join" : null}
    />
  );
}
