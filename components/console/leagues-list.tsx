"use client";

import Link from "next/link";
import { usePreloadedQuery, type Preloaded } from "convex/react";

import type { api } from "@/convex/_generated/api";
import {
  Badge,
  EmptyState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
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
        description="Enter an invite below to join a league, or create one and become its commissioner."
      />
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>League</TableHead>
          <TableHead numeric>Season</TableHead>
          <TableHead numeric>Teams</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Role</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {leagues.map((league) => (
          <TableRow key={league._id}>
            <TableCell>
              <Link
                href={`/leagues/${league._id}`}
                className="font-medium text-foreground transition-colors hover:text-brand"
              >
                {league.name}
              </Link>
              <span className="ml-2 font-mono text-xs text-ink-faint">/{league.slug}</span>
            </TableCell>
            <TableCell numeric className="font-mono text-xs">
              {league.season}
            </TableCell>
            <TableCell numeric className="font-mono text-xs">
              {league.teamCountActual}
            </TableCell>
            <TableCell>
              <Badge variant={league.status === "in_season" ? "success" : "secondary"}>
                {league.status.replace("_", " ")}
              </Badge>
            </TableCell>
            <TableCell>
              <Badge variant="outline">{league.role}</Badge>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
