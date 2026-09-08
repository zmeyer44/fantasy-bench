import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { preloadedQueryResult } from "convex/nextjs";

import { readOrNull } from "@/components/league/convex-errors";
import { MatchupDetailView } from "@/components/league/matchup-detail";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { preloadAuthQuery } from "@/lib/convex/server";

export async function generateMetadata({
  params,
}: PageProps<"/leagues/[leagueId]/matchups/[weekNo]/[matchupId]">): Promise<Metadata> {
  const { weekNo } = await params;
  return { title: `Week ${weekNo} matchup` };
}

export default async function MatchupDetailPage({
  params,
}: PageProps<"/leagues/[leagueId]/matchups/[weekNo]/[matchupId]">) {
  const { leagueId, weekNo: weekParam, matchupId } = await params;
  const weekNo = Number(weekParam);
  if (!Number.isInteger(weekNo)) notFound();

  const preloaded = await readOrNull(() =>
    preloadAuthQuery(api.views.matchup, {
      leagueId: leagueId as Id<"leagues">,
      weekNo,
      matchupId: matchupId as Id<"matchups">,
    }),
  );
  if (!preloaded || preloadedQueryResult(preloaded) === null) notFound();

  return <MatchupDetailView leagueId={leagueId} weekNo={weekNo} preloaded={preloaded} />;
}
