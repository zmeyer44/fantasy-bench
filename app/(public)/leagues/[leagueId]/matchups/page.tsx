import { redirect } from "next/navigation";

import { currentWeekNo } from "@/lib/services/views";

/** `/matchups` is a convenience alias for the current week. */
export default async function MatchupsIndex({
  params,
}: PageProps<"/leagues/[leagueId]/matchups">) {
  const { leagueId } = await params;
  const weekNo = await currentWeekNo(leagueId);
  redirect(`/leagues/${leagueId}/matchups/${weekNo}`);
}
