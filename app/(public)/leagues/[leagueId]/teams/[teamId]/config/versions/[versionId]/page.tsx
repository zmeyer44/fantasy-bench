import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ConfigNav } from "@/components/config/config-nav";
import { DiffView } from "@/components/config/diff-view";
import { Markdown } from "@/components/config/markdown";
import { Badge, Card, CardBody, CardHeader, PageHeader } from "@/components/ui";
import {
  diffVersionRows,
  getPreviousVersion,
  getVersion,
  getVersionContext,
} from "@/lib/services/config";
import { findModel } from "@/lib/models";
import { formatET } from "@/lib/time";

export async function generateMetadata({
  params,
}: PageProps<"/leagues/[leagueId]/teams/[teamId]/config/versions/[versionId]">): Promise<Metadata> {
  const { versionId } = await params;
  const ctx = await getVersionContext(versionId);
  return { title: ctx ? `${ctx.team.name} · v${ctx.version.versionNo}` : "Config version" };
}

/** One version, diffed against the version immediately before it. */
export default async function VersionDiffPage({
  params,
}: PageProps<"/leagues/[leagueId]/teams/[teamId]/config/versions/[versionId]">) {
  const { leagueId, teamId, versionId } = await params;

  const ctx = await getVersionContext(versionId);
  if (!ctx || ctx.team.id !== teamId || ctx.team.leagueId !== leagueId) notFound();

  const [previous, hydrated] = await Promise.all([
    getPreviousVersion(ctx.version),
    getVersion(versionId),
  ]);
  if (!hydrated) notFound();

  const current = ctx.version;
  const model = findModel(current.modelId);
  const base = `/leagues/${leagueId}/teams/${teamId}/config/versions`;
  const diff = previous ? diffVersionRows(previous, hydrated) : null;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href={base} className="hover:text-ink">
            {ctx.team.name} · history
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
            {ctx.config.currentVersionId === current.id ? (
              <Badge tone="accent">applied</Badge>
            ) : ctx.config.pendingVersionId === current.id ? (
              <Badge tone="warning">queued</Badge>
            ) : null}
            <Badge tone="outline">{model?.displayName ?? current.modelId}</Badge>
          </div>
        }
      />

      <ConfigNav leagueId={leagueId} teamId={teamId} />

      <Card>
        <CardBody className="grid gap-3 text-sm sm:grid-cols-4">
          <Stat label="Saved" value={`${formatET(current.createdAt, "MMM d, HH:mm")} ET`} />
          <Stat
            label="Applied"
            value={current.appliedAt ? `${formatET(current.appliedAt, "MMM d, HH:mm")} ET` : "never"}
          />
          <Stat label="Skills" value={String(hydrated.skills.length)} />
          <Stat label="Summary" value={current.changeSummary ?? "—"} />
        </CardBody>
      </Card>

      {diff ? (
        <DiffView diff={diff} leagueId={leagueId} teamId={teamId} />
      ) : (
        <Card>
          <CardHeader title="Context" description="The initial configuration." />
          <CardBody>
            <Markdown>{hydrated.contextMd}</Markdown>
          </CardBody>
        </Card>
      )}

      {previous ? (
        <div className="flex justify-between text-xs">
          <Link
            href={`${base}/${previous.id}`}
            className="text-accent-strong underline underline-offset-2"
          >
            ← Version {previous.versionNo}
          </Link>
          <Link
            href={`${base}/compare?a=${previous.id}&b=${current.id}`}
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
