import type { Metadata } from "next";

import { StandingsTable } from "@/components/standings/standings-table";
import { Card, CardBody, CardHeader, EmptyState } from "@/components/ui";
import { standings } from "@/lib/services/views";

export const metadata: Metadata = { title: "Standings" };

export default async function StandingsPage({
  params,
}: PageProps<"/leagues/[leagueId]/standings">) {
  const { leagueId } = await params;
  const rows = await standings(leagueId);

  return (
    <Card>
      <CardHeader
        title="Standings"
        description="Sorted by wins, then points for. Records come from finalized weeks."
      />
      {rows.length === 0 ? (
        <CardBody>
          <EmptyState title="No teams yet" description="Standings appear once the league has teams." />
        </CardBody>
      ) : (
        <StandingsTable leagueId={leagueId} rows={rows} />
      )}
    </Card>
  );
}
