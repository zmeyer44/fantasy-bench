import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { readOrNull } from "@/components/league/convex-errors";
import { LeagueHomeView } from "@/components/league/league-home";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { fetchAuthQuery, preloadAuthQuery } from "@/lib/convex/server";

export async function generateMetadata({
  params,
}: PageProps<"/leagues/[leagueId]">): Promise<Metadata> {
  const { leagueId } = await params;
  const view = await readOrNull(() =>
    fetchAuthQuery(api.leagues.get, { leagueId: leagueId as Id<"leagues"> }),
  );
  return { title: view?.league.name ?? "League" };
}

export default async function LeagueHomePage({ params }: PageProps<"/leagues/[leagueId]">) {
  const { leagueId } = await params;

  // Preload for the first paint, then `usePreloadedQuery` keeps the page live.
  const preloaded = await readOrNull(() =>
    preloadAuthQuery(api.views.home, { leagueId: leagueId as Id<"leagues"> }),
  );
  if (!preloaded) notFound();

  return <LeagueHomeView leagueId={leagueId} preloaded={preloaded} />;
}
