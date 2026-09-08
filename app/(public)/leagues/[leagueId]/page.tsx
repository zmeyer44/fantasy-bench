import type { Metadata } from "next";
import { notFound } from "next/navigation";

import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from "@/components/ui";
import { db } from "@/lib/db";
import { teams } from "@/lib/db/schema";
import { getLeagueById } from "@/lib/services/league";
import { asc, eq } from "drizzle-orm";

export async function generateMetadata({
  params,
}: PageProps<"/leagues/[leagueId]">): Promise<Metadata> {
  const { leagueId } = await params;
  const league = await getLeagueById(leagueId);
  return { title: league?.name ?? "League" };
}

export default async function LeagueHomePage({ params }: PageProps<"/leagues/[leagueId]">) {
  const { leagueId } = await params;
  const league = await getLeagueById(leagueId);
  if (!league) notFound();

  const leagueTeams = await db
    .select()
    .from(teams)
    .where(eq(teams.leagueId, leagueId))
    .orderBy(asc(teams.waiverPriority));

  const rules = league.rules;

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="lg:col-span-2">
        <Card>
          <CardHeader
            title="Teams"
            description={`${leagueTeams.length} of ${league.teamCount} created`}
          />
          <Table>
            <THead>
              <TR>
                <TH>#</TH>
                <TH>Team</TH>
                <TH>Owner</TH>
                <TH numeric>FAAB</TH>
                <TH numeric>Karma</TH>
              </TR>
            </THead>
            <TBody>
              {leagueTeams.map((team) => (
                <TR key={team.id}>
                  <TD numeric className="font-mono text-xs text-ink-faint">
                    {team.waiverPriority}
                  </TD>
                  <TD className="font-medium">
                    {team.name}
                    <span className="ml-2 font-mono text-xs text-ink-faint">
                      {team.abbreviation}
                    </span>
                  </TD>
                  <TD>
                    {team.ownerUserId ? (
                      <Badge tone="accent">owned</Badge>
                    ) : (
                      <Badge tone="outline">open</Badge>
                    )}
                  </TD>
                  <TD numeric>${team.faabRemaining}</TD>
                  <TD numeric>{team.karma}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      </div>

      <div className="space-y-6">
        <Card>
          <CardHeader title="Rules" />
          <CardBody>
            <dl className="space-y-2 text-sm">
              <Row label="Scoring" value={rules?.scoringPreset?.replace("_", " ") ?? "—"} />
              <Row label="Draft" value={league.draftType} />
              <Row label="FAAB" value={`$${rules?.faabBudget ?? 0}`} />
              <Row label="Superflex" value={rules?.superflex ? "yes" : "no"} />
              <Row label="TE premium" value={rules?.tePremium ? "yes" : "no"} />
              <Row
                label="Regular season"
                value={`${rules?.regularSeasonWeeks ?? 14} weeks`}
              />
              <Row label="Playoff teams" value={String(rules?.playoffTeams ?? 6)} />
              <Row label="Transparency" value={rules?.transparencyMode ?? "live"} />
              <Row label="Injection policy" value={rules?.injectionPolicy ?? "permitted"} />
            </dl>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Roster" />
          <CardBody>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(rules?.rosterSlots ?? {}).map(([slot, count]) => (
                <Badge key={slot} tone="outline">
                  {slot} × {count}
                </Badge>
              ))}
            </div>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line pb-2 last:border-0 last:pb-0">
      <dt className="text-xs uppercase tracking-wide text-ink-faint">{label}</dt>
      <dd className="font-mono text-xs tabular-nums text-ink">{value}</dd>
    </div>
  );
}
