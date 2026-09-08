import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ConfigNav } from "@/components/config/config-nav";
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  PageHeader,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from "@/components/ui";
import { getConfigForTeam } from "@/lib/services/config";
import { formatET } from "@/lib/time";

export async function generateMetadata({
  params,
}: PageProps<"/leagues/[leagueId]/teams/[teamId]/config/versions">): Promise<Metadata> {
  const { teamId } = await params;
  const view = await getConfigForTeam(teamId).catch(() => null);
  return { title: view ? `${view.team.name} · Config history` : "Config history" };
}

/** The changelog. Public within the league (PRD 5.5). */
export default async function VersionsPage({
  params,
}: PageProps<"/leagues/[leagueId]/teams/[teamId]/config/versions">) {
  const { leagueId, teamId } = await params;

  const view = await getConfigForTeam(teamId).catch(() => null);
  if (!view || view.team.leagueId !== leagueId) notFound();

  const base = `/leagues/${leagueId}/teams/${teamId}/config/versions`;
  const changedThisWeek = view.versions.filter((v) => v.changedThisWeek).length;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href={`/leagues/${leagueId}/teams/${teamId}`} className="hover:text-ink">
            {view.team.name}
          </Link>
        }
        title="Config history"
        description="Every save is an immutable version. Click one to diff it against the version before it."
        actions={
          changedThisWeek > 0 ? (
            <Badge tone="accent">
              {changedThisWeek} change{changedThisWeek === 1 ? "" : "s"} this week
            </Badge>
          ) : (
            <Badge tone="outline">unchanged this week</Badge>
          )
        }
      />

      <ConfigNav leagueId={leagueId} teamId={teamId} />

      {view.versions.length === 0 ? (
        <EmptyState title="No versions yet" description="Save a config to start the changelog." />
      ) : (
        <Card>
          <CardHeader
            title={`${view.versions.length} version${view.versions.length === 1 ? "" : "s"}`}
            description="Newest first."
            action={
              view.versions.length > 1 ? (
                <Link
                  href={`${base}/compare?a=${view.versions.at(-1)!.id}&b=${view.versions[0].id}`}
                  className="text-xs text-accent-strong underline underline-offset-2"
                >
                  Compare first ↔ latest
                </Link>
              ) : null
            }
          />
          <Table>
            <THead>
              <TR>
                <TH numeric>#</TH>
                <TH>State</TH>
                <TH>Saved</TH>
                <TH>By</TH>
                <TH>Model</TH>
                <TH numeric>Skills</TH>
                <TH>Change summary</TH>
                <TH />
              </TR>
            </THead>
            <TBody>
              {view.versions.map((version) => (
                <TR key={version.id}>
                  <TD numeric className="font-mono text-xs">
                    {version.versionNo}
                  </TD>
                  <TD>
                    {version.isCurrent ? (
                      <Badge tone="accent">applied</Badge>
                    ) : version.isPending ? (
                      <Badge tone="warning">queued</Badge>
                    ) : version.appliedAt ? (
                      <Badge tone="outline">superseded</Badge>
                    ) : (
                      <Badge tone="outline">never applied</Badge>
                    )}
                  </TD>
                  <TD className="whitespace-nowrap font-mono text-xs text-ink-muted">
                    {formatET(version.createdAt, "MMM d, HH:mm")} ET
                    {version.changedThisWeek ? (
                      <span className="ml-2 text-accent-strong">new</span>
                    ) : null}
                  </TD>
                  <TD className="text-xs text-ink-muted">{version.createdByName ?? "—"}</TD>
                  <TD className="font-mono text-xs">{version.modelDisplayName}</TD>
                  <TD numeric className="font-mono text-xs">
                    {version.skillCount}
                  </TD>
                  <TD className="max-w-xs truncate text-xs text-ink-muted">
                    {version.changeSummary ?? "—"}
                  </TD>
                  <TD>
                    <Link
                      href={`${base}/${version.id}`}
                      className="text-xs text-accent-strong underline underline-offset-2"
                    >
                      Diff
                    </Link>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <CardBody className="border-t border-line text-xs text-ink-muted">
            Version rows are never updated except to stamp when they went live. A version saved
            during the edit lock stays queued until the window reopens.
          </CardBody>
        </Card>
      )}
    </div>
  );
}
