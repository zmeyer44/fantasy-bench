import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { readOrNull } from "@/components/league/convex-errors";
import { TradesFeed } from "@/components/trades/trades-feed";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { fetchAuthQuery, preloadAuthQuery } from "@/lib/convex/server";

export const metadata: Metadata = { title: "Trades" };

const STATUSES = new Set([
  "proposed",
  "countered",
  "accepted",
  "rejected",
  "expired",
  "in_review",
  "vetoed",
  "completed",
  "cancelled",
]);

/**
 * The negotiation feed (PRD 5.6): every proposal in the league, filterable by
 * team, week and status. Filters live in the query string, so a filtered view
 * is shareable and the preload asks Convex for exactly that page.
 */
export default async function TradesPage({
  params,
  searchParams,
}: PageProps<"/leagues/[leagueId]/trades">) {
  const { leagueId } = await params;
  const query = await searchParams;

  const view = await readOrNull(() =>
    fetchAuthQuery(api.leagues.get, { leagueId: leagueId as Id<"leagues"> }),
  );
  if (!view) notFound();

  const teamFilter = single(query.team);
  const weekFilter = Number(single(query.week));
  const statusFilter = single(query.status);

  const preloaded = await preloadAuthQuery(api.trades.list, {
    leagueId: leagueId as Id<"leagues">,
    ...(teamFilter ? { teamId: teamFilter as Id<"teams"> } : {}),
    ...(Number.isFinite(weekFilter) && weekFilter > 0 ? { weekNo: weekFilter } : {}),
    ...(statusFilter && STATUSES.has(statusFilter)
      ? { status: statusFilter as Doc<"trades">["status"] }
      : {}),
    limit: 100,
  });

  const seasonWeeks = view.rules?.seasonWeeks ?? 17;

  return (
    <TradesFeed
      leagueId={leagueId}
      preloaded={preloaded}
      teams={view.teams.map((team) => ({ id: team._id, name: team.name }))}
      weeks={Array.from({ length: seasonWeeks }, (_, index) => index + 1)}
      fairnessFloor={view.rules?.fairnessFloor}
    />
  );
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
