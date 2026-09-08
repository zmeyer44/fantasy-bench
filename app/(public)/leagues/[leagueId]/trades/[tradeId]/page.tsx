import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { readOrNull } from "@/components/league/convex-errors";
import { TradeDetail } from "@/components/trades/trade-detail";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { fetchAuthQuery, preloadAuthQuery } from "@/lib/convex/server";

export async function generateMetadata({
  params,
}: PageProps<"/leagues/[leagueId]/trades/[tradeId]">): Promise<Metadata> {
  const { leagueId, tradeId } = await params;
  const trade = await readOrNull(() =>
    fetchAuthQuery(api.trades.get, {
      leagueId: leagueId as Id<"leagues">,
      tradeId: tradeId as Id<"trades">,
    }),
  );
  return {
    title: trade ? `${trade.proposerTeamName} ↔ ${trade.recipientTeamName}` : "Trade",
  };
}

/** One proposal, live: fairness, timeline, and the owners' veto panel. */
export default async function TradeDetailPage({
  params,
}: PageProps<"/leagues/[leagueId]/trades/[tradeId]">) {
  const { leagueId, tradeId } = await params;

  const view = await readOrNull(() =>
    fetchAuthQuery(api.leagues.get, { leagueId: leagueId as Id<"leagues"> }),
  );
  if (!view) notFound();

  const preloaded = await readOrNull(() =>
    preloadAuthQuery(api.trades.get, {
      leagueId: leagueId as Id<"leagues">,
      tradeId: tradeId as Id<"trades">,
    }),
  );
  if (!preloaded) notFound();

  return (
    <TradeDetail
      leagueId={leagueId}
      preloaded={preloaded}
      teamNames={view.teams.map((team) => ({ id: team._id, name: team.name }))}
      fairnessFloor={view.rules?.fairnessFloor}
      // Owners (and the commissioner) vote on a flagged trade; spectators read it.
      canVote={view.role === "owner" || view.role === "commissioner"}
    />
  );
}
