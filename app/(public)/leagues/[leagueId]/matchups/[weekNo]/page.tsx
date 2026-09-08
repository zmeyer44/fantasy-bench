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
  const [preloaded, weeks] = await Promise.all([
    readOrNull(() => preloadAuthQuery(api.views.matchups, { leagueId: id, weekNo })),
    readOrNull(() => fetchAuthQuery(api.weeks.list, { leagueId: id })),
  ]);
  if (!preloaded || !weeks) notFound();

  // The picker lists the week rows the league actually has, rather than
  // `1..rules.seasonWeeks`: playoff weeks are rows too, and a league that has
  // not been fully materialised should not offer weeks that do not exist.
  return (
    <MatchupsWeekView
      leagueId={leagueId}
      weekNo={weekNo}
      weeks={weeks.map((week) => week.weekNo)}
      preloaded={preloaded}
    />
  );
}
