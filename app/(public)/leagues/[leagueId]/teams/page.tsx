import type { Metadata } from "next";
import Link from "next/link";

import { Badge, Card, CardBody, CardHeader, EmptyState } from "@/components/ui";
import { shortModel } from "@/components/standings/standings-table";
import { teamCards } from "@/lib/services/views";

export const metadata: Metadata = { title: "Teams" };

export default async function TeamsPage({ params }: PageProps<"/leagues/[leagueId]/teams">) {
  const { leagueId } = await params;
  const cards = await teamCards(leagueId);

  if (cards.length === 0) {
    return <EmptyState title="No teams yet" />;
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {cards.map((team) => (
        <Card key={team.id} className="transition-colors hover:border-line-strong">
          <CardHeader
            title={
              <Link
                href={`/leagues/${leagueId}/teams/${team.id}`}
                className="hover:text-accent-strong"
              >
                {team.name}
              </Link>
            }
            description={team.ownerName ?? "Unowned"}
            action={<Badge tone="outline">#{team.rank}</Badge>}
          />
          <CardBody className="space-y-2.5">
            <div className="flex flex-wrap gap-1.5">
              {team.modelId ? (
                <Badge tone="accent" title={team.modelId}>
                  {shortModel(team.modelId)}
                </Badge>
              ) : (
                <Badge tone="outline">no model</Badge>
              )}
              {team.configVersionNo ? (
                <Badge tone="outline">config v{team.configVersionNo}</Badge>
              ) : null}
            </div>
            <dl className="grid grid-cols-4 gap-2 text-center">
              <Stat label="Record" value={team.record} />
              <Stat label="PF" value={team.pointsFor.toFixed(0)} />
              <Stat label="Karma" value={String(team.karma)} />
              <Stat label="FAAB" value={`$${team.faabRemaining}`} />
            </dl>
          </CardBody>
        </Card>
      ))}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="eyebrow">{label}</dt>
      <dd className="mt-1 font-mono text-sm tabular-nums text-ink">{value}</dd>
    </div>
  );
}
