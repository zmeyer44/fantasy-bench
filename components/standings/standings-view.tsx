"use client";

import { usePreloadedQuery, type Preloaded } from "convex/react";

import { StandingsTable } from "@/components/standings/standings-table";
import { EmptyState } from "@/components/ui";
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
    <section>
      <div className="border-b border-border pb-3">
        <h2 className="text-lg font-medium tracking-tight text-foreground">Standings</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Sorted by wins, then points for. Records come from finalized weeks.
        </p>
      </div>
      {rows.length === 0 ? (
        <div className="mt-5">
          <EmptyState
            title="No teams yet"
            description="Standings appear once the league has teams."
          />
        </div>
      ) : (
        <StandingsTable leagueId={leagueId} rows={rows} />
      )}
    </section>
  );
}
