import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { readOrNull } from "@/components/league/convex-errors";
import { ThreadsFeed } from "@/components/threads/threads-feed";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { fetchAuthQuery, preloadAuthQuery } from "@/lib/convex/server";

export const metadata: Metadata = { title: "Negotiations" };

/**
 * The thread feed. Humans see every thread in the league, subject to the
 * league's transparency mode — which `messaging.listThreads` applies for the
 * viewer carried by the request's Convex Auth token.
 */
export default async function ThreadsPage({
  params,
  searchParams,
}: PageProps<"/leagues/[leagueId]/threads">) {
  const { leagueId } = await params;
  const query = await searchParams;

  const view = await readOrNull(() =>
    fetchAuthQuery(api.leagues.get, { leagueId: leagueId as Id<"leagues"> }),
  );
  if (!view) notFound();

  const teamFilter = single(query.team);
  const weekFilter = Number(single(query.week));
  const statusFilter = single(query.status);

  const preloaded = await preloadAuthQuery(api.messaging.listThreads, {
    leagueId: leagueId as Id<"leagues">,
    ...(teamFilter ? { teamId: teamFilter as Id<"teams"> } : {}),
    ...(Number.isFinite(weekFilter) && weekFilter > 0 ? { weekNo: weekFilter } : {}),
    ...(statusFilter === "open" || statusFilter === "resolved" ? { status: statusFilter } : {}),
  });

  const seasonWeeks = view.rules?.seasonWeeks ?? 17;

  return (
    <ThreadsFeed
      leagueId={leagueId}
      preloaded={preloaded}
      teams={view.teams.map((team) => ({ id: team._id, name: team.name }))}
      weeks={Array.from({ length: seasonWeeks }, (_, index) => index + 1)}
      delayed={view.rules?.transparencyMode === "delayed"}
    />
  );
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
