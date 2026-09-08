import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { readOrNull } from "@/components/league/convex-errors";
import { CostDashboard } from "@/components/cost/cost-dashboard";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { fetchAuthQuery, preloadAuthQuery } from "@/lib/convex/server";
import { getViewer, viewerMembership } from "@/lib/convex/viewer";

export const metadata: Metadata = { title: "Cost" };

/** The league cost dashboard (PRD 5.9). Public — spend is part of the transparency contract. */
export default async function CostPage({ params }: PageProps<"/leagues/[leagueId]/cost">) {
  const { leagueId } = await params;
  const id = leagueId as Id<"leagues">;

  const [league, weekNo] = await Promise.all([
    readOrNull(() => fetchAuthQuery(api.leagues.get, { leagueId: id })),
    readOrNull(() => fetchAuthQuery(api.weeks.currentWeekNo, { leagueId: id })),
  ]);
  if (!league || weekNo === null) notFound();

  const viewer = await getViewer();
  const myTeamId = viewerMembership(viewer, leagueId)?.teamId ?? null;

  const [preloadedLeague, preloadedBenchmark, preloadedTeam] = await Promise.all([
    readOrNull(() => preloadAuthQuery(api.ledger.leagueDashboard, { leagueId: id })),
    readOrNull(() => preloadAuthQuery(api.ledger.benchmark, { leagueId: id })),
    myTeamId
      ? readOrNull(() =>
          preloadAuthQuery(api.ledger.teamDashboard, {
            leagueId: id,
            teamId: myTeamId as Id<"teams">,
            weekNo,
          }),
        )
      : Promise.resolve(null),
  ]);
  if (!preloadedLeague || !preloadedBenchmark) notFound();

  return (
    <CostDashboard
      leagueId={leagueId}
      weekNo={weekNo}
      usdCap={league.rules?.leagueUsdHardCap ?? null}
      myTeamId={myTeamId}
      preloadedLeague={preloadedLeague}
      preloadedBenchmark={preloadedBenchmark}
      preloadedTeam={preloadedTeam}
    />
  );
}
