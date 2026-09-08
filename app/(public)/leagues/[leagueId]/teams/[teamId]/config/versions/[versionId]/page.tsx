import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ConfigNav } from "@/components/config/config-nav";
import { DiffView } from "@/components/config/diff-view";
import { Markdown } from "@/components/config/markdown";
import { readOrNull } from "@/components/league/convex-errors";
import { Badge, Card, CardBody, CardHeader, PageHeader } from "@/components/ui";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { fetchAuthQuery } from "@/lib/convex/server";
import { findModel } from "@/lib/models";
import { formatET } from "@/lib/time";

/** The version plus the one before it; `configs.get` supplies the team header. */
async function load(leagueId: string, teamId: string, versionId: string) {
  const [pair, config] = await Promise.all([
    readOrNull(() =>
      fetchAuthQuery(api.configs.version, {
        leagueId: leagueId as Id<"leagues">,
        versionId: versionId as Id<"config_versions">,
      }),
    ),
    readOrNull(() =>
      fetchAuthQuery(api.configs.get, {
        leagueId: leagueId as Id<"leagues">,
        teamId: teamId as Id<"teams">,
      }),
    ),
  ]);
  // The version must belong to this team's config, not just to the league.
  if (!pair || !config || pair.version.teamId !== config.team._id) return null;
  return { ...pair, config };
}

export async function generateMetadata({
  params,
}: PageProps<"/leagues/[leagueId]/teams/[teamId]/config/versions/[versionId]">): Promise<Metadata> {
  const { leagueId, teamId, versionId } = await params;
  const loaded = await load(leagueId, teamId, versionId);
  return {
    title: loaded ? `${loaded.config.team.name} · v${loaded.version.versionNo}` : "Config version",
  };
}

/** One version, diffed against the version immediately before it. */
export default async function VersionDiffPage({
  params,
}: PageProps<"/leagues/[leagueId]/teams/[teamId]/config/versions/[versionId]">) {
  const { leagueId, teamId, versionId } = await params;

  const loaded = await load(leagueId, teamId, versionId);
  if (!loaded) notFound();

  const { version: current, previous, config: view } = loaded;
  const diff = previous
    ? await fetchAuthQuery(api.configs.diff, {
        leagueId: leagueId as Id<"leagues">,
        a: previous._id,
        b: current._id,
      })
    : null;

  const model = findModel(current.modelId);
  const base = `/leagues/${leagueId}/teams/${teamId}/config/versions`;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href={base} className="hover:text-ink">
            {view.team.name} · history
          </Link>
        }
        title={`Version ${current.versionNo}`}
        description={
          previous
            ? `Diffed against version ${previous.versionNo}.`
            : "The first version — nothing to diff against."
        }
        actions={
          <div className="flex items-center gap-2">
            {view.config?.currentVersionId === current._id ? (
              <Badge tone="accent">applied</Badge>
            ) : view.config?.pendingVersionId === current._id ? (
              <Badge tone="warning">queued</Badge>
            ) : null}
            <Badge tone="outline">{model?.displayName ?? current.modelId}</Badge>
          </div>
        }
      />

      <ConfigNav leagueId={leagueId} teamId={teamId} />

      <Card>
        <CardBody className="grid gap-3 text-sm sm:grid-cols-4">
          <Stat
            label="Saved"
            value={`${formatET(current.createdAt ?? current._creationTime, "MMM d, HH:mm")} ET`}
          />
          <Stat
            label="Applied"
            value={
              current.appliedAt ? `${formatET(current.appliedAt, "MMM d, HH:mm")} ET` : "never"
            }
          />
          <Stat label="Skills" value={String(current.skills.length)} />
          <Stat label="Summary" value={current.changeSummary ?? "—"} />
        </CardBody>
      </Card>

      {diff ? (
        <DiffView diff={diff} leagueId={leagueId} teamId={teamId} />
      ) : (
        <Card>
          <CardHeader title="Context" description="The initial configuration." />
          <CardBody>
            <Markdown>{current.contextMd}</Markdown>
          </CardBody>
        </Card>
      )}

      {previous ? (
        <div className="flex justify-between text-xs">
          <Link
            href={`${base}/${previous._id}`}
            className="text-accent-strong underline underline-offset-2"
          >
            ← Version {previous.versionNo}
          </Link>
          <Link
            href={`${base}/compare?a=${previous._id}&b=${current._id}`}
            className="text-accent-strong underline underline-offset-2"
          >
            Open in the comparison view →
          </Link>
        </div>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="eyebrow">{label}</div>
      <div className="mt-1 truncate font-mono text-xs text-ink">{value}</div>
    </div>
  );
}
