"use client";

import { usePreloadedQuery, type Preloaded } from "convex/react";

import { StandingsTable } from "@/components/standings/standings-table";
import { Card, CardBody, CardHeader, EmptyState } from "@/components/ui";
import type { api } from "@/convex/_generated/api";

/** The standings table, live off `views.standings` (the `team_standings` rollup). */
export function StandingsView({
  leagueId,
  preloaded,
}: {
  leagueId: string;
  preloaded: Preloaded<typeof api.views.standings>;
}) {
  const rows = usePreloadedQuery(preloaded);

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
