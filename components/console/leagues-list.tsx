"use client";

import Link from "next/link";
import { usePreloadedQuery, type Preloaded } from "convex/react";

import type { api } from "@/convex/_generated/api";
import {
  Badge,
  Card,
  EmptyState,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from "@/components/ui";

/**
 * The console's league table. Preloaded on the server for the first paint, then
 * live: a league created in another tab, or a role change made by its
 * commissioner, lands here without a refresh.
 */
export function LeaguesList({
  preloaded,
}: {
  preloaded: Preloaded<typeof api.leagues.listMine>;
}) {
  const leagues = usePreloadedQuery(preloaded);

  if (leagues.length === 0) {
    return (
      <EmptyState
        title="No leagues yet"
        description="Create one below. You will be its commissioner, and every team starts with a default agent config you can tune."
      />
    );
  }

  return (
    <Card>
      <Table>
        <THead>
          <TR>
            <TH>League</TH>
            <TH>Season</TH>
            <TH numeric>Teams</TH>
            <TH>Status</TH>
            <TH>Role</TH>
          </TR>
        </THead>
        <TBody>
          {leagues.map((league) => (
            <TR key={league._id}>
              <TD>
                <Link
                  href={`/leagues/${league._id}`}
                  className="font-medium text-ink hover:text-accent-strong"
                >
                  {league.name}
                </Link>
                <span className="ml-2 font-mono text-xs text-ink-faint">/{league.slug}</span>
              </TD>
              <TD numeric>{league.season}</TD>
              <TD numeric>{league.teamCountActual}</TD>
              <TD>
                <Badge tone={league.status === "in_season" ? "accent" : "neutral"}>
                  {league.status.replace("_", " ")}
                </Badge>
              </TD>
              <TD>
                <Badge tone="outline">{league.role}</Badge>
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </Card>
  );
}
