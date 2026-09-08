import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { readOrNull } from "@/components/league/convex-errors";
import { StandingsView } from "@/components/standings/standings-view";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { preloadAuthQuery } from "@/lib/convex/server";

export const metadata: Metadata = { title: "Standings" };

export default async function StandingsPage({
  params,
}: PageProps<"/leagues/[leagueId]/standings">) {
  const { leagueId } = await params;
  const preloaded = await readOrNull(() =>
    preloadAuthQuery(api.views.standings, { leagueId: leagueId as Id<"leagues"> }),
  );
  if (!preloaded) notFound();

  return <StandingsView leagueId={leagueId} preloaded={preloaded} />;
}
