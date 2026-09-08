"use client";

import Link from "next/link";
import { usePreloadedQuery, type Preloaded } from "convex/react";

import { shortModel } from "@/components/standings/standings-table";
import {
  Badge,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
} from "@/components/ui";
import type { api } from "@/convex/_generated/api";

/** One card per team, live off `views.teams`. */
export function TeamsGrid({
  leagueId,
  preloaded,
}: {
  leagueId: string;
  preloaded: Preloaded<typeof api.views.teams>;
}) {
  const cards = usePreloadedQuery(preloaded);

  if (cards.length === 0) {
    return <EmptyState title="No teams yet" />;
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {cards.map((team) => (
        <Card key={team.id} size="sm" className="transition-colors hover:border-line-strong">
          <CardHeader>
            <CardTitle>
              <Link
                href={`/leagues/${leagueId}/teams/${team.id}`}
                className="hover:text-brand-strong"
              >
                {team.name}
              </Link>
            </CardTitle>
            <CardDescription>{team.ownerName ?? "Unowned"}</CardDescription>
            <CardAction>
              <span className="font-mono text-xs tabular-nums text-muted-foreground">
                #{team.rank}
              </span>
            </CardAction>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-1.5">
              {team.modelId ? (
                <Badge variant="outline" title={team.modelId}>
                  {shortModel(team.modelId)}
                </Badge>
              ) : (
                <Badge variant="secondary">no model</Badge>
              )}
              {team.configVersionNo ? (
                <Badge variant="outline">config v{team.configVersionNo}</Badge>
              ) : null}
            </div>
            <dl className="grid grid-cols-4 gap-3 border-t border-border pt-3">
              <TeamStat label="Record" value={team.record} />
              <TeamStat label="PF" value={team.pointsFor.toFixed(0)} />
              <TeamStat label="Karma" value={String(team.karma)} />
              <TeamStat label="FAAB" value={`$${team.faabRemaining}`} />
            </dl>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function TeamStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="eyebrow">{label}</dt>
      <dd className="mt-1.5 truncate font-mono text-sm tabular-nums text-foreground">{value}</dd>
    </div>
  );
}
