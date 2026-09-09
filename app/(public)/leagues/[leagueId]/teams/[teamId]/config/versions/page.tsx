import { Lock } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ConfigNav } from "@/components/config/config-nav";
import { readOrNull } from "@/components/league/convex-errors";
import {
  Badge,
  EmptyState,
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { fetchAuthQuery } from "@/lib/convex/server";
import { COOLDOWN_DAYS } from "@/convex/lib/visibility";
import { formatET } from "@/lib/time";

/** Version history for one team's config. Public within the league (PRD 5.5). */
async function loadVersions(leagueId: string, teamId: string) {
  return readOrNull(() =>
    fetchAuthQuery(api.configs.versions, {
      leagueId: leagueId as Id<"leagues">,
      teamId: teamId as Id<"teams">,
    }),
  );
}

export async function generateMetadata({
  params,
}: PageProps<"/leagues/[leagueId]/teams/[teamId]/config/versions">): Promise<Metadata> {
  const { leagueId, teamId } = await params;
  const view = await loadVersions(leagueId, teamId);
  return { title: view ? `${view.team.name} · Config history` : "Config history" };
}

/** The changelog. Public within the league (PRD 5.5). */
export default async function VersionsPage({
  params,
}: PageProps<"/leagues/[leagueId]/teams/[teamId]/config/versions">) {
  const { leagueId, teamId } = await params;

  const view = await loadVersions(leagueId, teamId);
  if (!view) notFound();

  const base = `/leagues/${leagueId}/teams/${teamId}/config/versions`;
  const changedThisWeek = view.versions.filter((v) => v.changedThisWeek).length;

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={
          <Link
            href={`/leagues/${leagueId}/teams/${teamId}`}
            className="transition-colors hover:text-foreground"
          >
            {view.team.name}
          </Link>
        }
        title="Config history"
        description="Every save is an immutable version. Click one to diff it against the version before it."
        actions={
          changedThisWeek > 0 ? (
            <Badge variant="success">
              {changedThisWeek} change{changedThisWeek === 1 ? "" : "s"} this week
            </Badge>
          ) : (
            <Badge variant="outline">unchanged this week</Badge>
          )
        }
      />

      <ConfigNav leagueId={leagueId} teamId={teamId} />

      {view.versions.length === 0 ? (
        <EmptyState title="No versions yet" description="Save a config to start the changelog." />
      ) : (
        <section className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border pb-3">
            <div className="min-w-0">
              <h2 className="eyebrow text-foreground">
                {view.versions.length} version{view.versions.length === 1 ? "" : "s"}
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">Newest first.</p>
            </div>
            {view.versions.filter((v) => !v.redacted).length > 1 ? (
              <Link
                href={`${base}/compare?a=${view.versions.filter((v) => !v.redacted).at(-1)!._id}&b=${view.versions.filter((v) => !v.redacted)[0]._id}`}
                className="shrink-0 text-sm text-muted-foreground underline decoration-border underline-offset-4 transition-colors hover:text-foreground hover:decoration-brand"
              >
                Compare first ↔ latest
              </Link>
            ) : null}
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead numeric>#</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Saved</TableHead>
                <TableHead>By</TableHead>
                <TableHead>Model</TableHead>
                <TableHead numeric>Skills</TableHead>
                <TableHead>Change summary</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.versions.map((version) => (
                <TableRow key={version._id}>
                  <TableCell numeric className="font-mono text-xs">
                    {version.versionNo}
                  </TableCell>
                  <TableCell>
                    {version.isCurrent ? (
                      <Badge variant="success">applied</Badge>
                    ) : version.isPending ? (
                      <Badge variant="warning">queued</Badge>
                    ) : version.appliedAt ? (
                      <Badge variant="outline">superseded</Badge>
                    ) : (
                      <Badge variant="outline">never applied</Badge>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs whitespace-nowrap text-muted-foreground">
                    {formatET(version.createdAt ?? version._creationTime, "MMM d, HH:mm")} ET
                    {version.changedThisWeek ? (
                      <span className="ml-2 text-brand">new</span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {version.createdByName ?? "—"}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{version.modelDisplayName}</TableCell>
                  <TableCell numeric className="font-mono text-xs">
                    {version.redacted ? "—" : version.skillCount}
                  </TableCell>
                  <TableCell className="max-w-xs truncate text-muted-foreground">
                    {version.redacted ? (
                      <span className="inline-flex items-center gap-1.5">
                        <Lock className="size-3" aria-hidden />
                        private until {formatET(version.revealAt, "MMM d")}
                      </span>
                    ) : (
                      (version.changeSummary ?? "—")
                    )}
                  </TableCell>
                  <TableCell>
                    {version.redacted ? (
                      <span className="text-sm text-ink-faint">—</span>
                    ) : (
                      <Link
                        href={`${base}/${version._id}`}
                        className="text-sm text-muted-foreground underline decoration-border underline-offset-4 transition-colors hover:text-foreground hover:decoration-brand"
                      >
                        Diff
                      </Link>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <p className="text-sm text-ink-faint">
            Version rows are never updated except to stamp when they went live. A version saved
            during the edit lock stays queued until the window reopens. Content is private to the
            owner and commissioner for {COOLDOWN_DAYS} days after each save.
          </p>
        </section>
      )}
    </div>
  );
}
