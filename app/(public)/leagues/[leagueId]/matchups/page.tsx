import { notFound, redirect } from "next/navigation";

import { readOrNull } from "@/components/league/convex-errors";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { fetchAuthQuery } from "@/lib/convex/server";

/** `/matchups` is a convenience alias for the current week. */
export default async function MatchupsIndex({
  params,
}: PageProps<"/leagues/[leagueId]/matchups">) {
  const { leagueId } = await params;
  const weekNo = await readOrNull(() =>
    fetchAuthQuery(api.weeks.currentWeekNo, { leagueId: leagueId as Id<"leagues"> }),
  );
  if (weekNo === null) notFound();
  redirect(`/leagues/${leagueId}/matchups/${weekNo}`);
}
