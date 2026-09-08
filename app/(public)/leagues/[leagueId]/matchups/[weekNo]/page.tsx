import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { readOrNull } from "@/components/league/convex-errors";
import { MatchupsWeekView } from "@/components/league/matchups-week";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { fetchAuthQuery, preloadAuthQuery } from "@/lib/convex/server";

export async function generateMetadata({
  params,
}: PageProps<"/leagues/[leagueId]/matchups/[weekNo]">): Promise<Metadata> {
  const { weekNo } = await params;
  return { title: `Week ${weekNo} matchups` };
}

export default async function WeekMatchupsPage({
  params,
}: PageProps<"/leagues/[leagueId]/matchups/[weekNo]">) {
  const { leagueId, weekNo: weekParam } = await params;
  const weekNo = Number(weekParam);
  if (!Number.isInteger(weekNo) || weekNo < 1 || weekNo > 18) notFound();

  const id = leagueId as Id<"leagues">;
  const [preloaded, league] = await Promise.all([
    readOrNull(() => preloadAuthQuery(api.views.matchups, { leagueId: id, weekNo })),
    readOrNull(() => fetchAuthQuery(api.leagues.get, { leagueId: id })),
  ]);
  if (!preloaded || !league) notFound();

  // No Convex query lists a league's week rows; the rule set is the source of
  // truth for how many weeks exist, and the seed materialises exactly that many.
  const seasonWeeks = league.rules?.seasonWeeks ?? 18;
  const weeks = Array.from({ length: seasonWeeks }, (_, index) => index + 1);

  return (
    <MatchupsWeekView
      leagueId={leagueId}
      weekNo={weekNo}
      weeks={weeks}
      preloaded={preloaded}
    />
  );
}
