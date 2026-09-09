import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ConfigNav } from "@/components/config/config-nav";
import { DiffView } from "@/components/config/diff-view";
import { Markdown } from "@/components/config/markdown";
import { readOrNull } from "@/components/league/convex-errors";
import {
  Badge,
  EmptyState,
  PageHeader,
  Stat,
  StatStrip,
} from "@/components/ui";
import { COOLDOWN_DAYS } from "@/convex/lib/visibility";
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
    title: loaded
      ? `${loaded.config.team.name} · v${loaded.version.versionNo}`
      : "Config version",
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
  const diff =
    previous && !current.redacted
      ? await fetchAuthQuery(api.configs.diff, {
          leagueId: leagueId as Id<"leagues">,
          a: previous._id,
          b: current._id,
        })
      : null;

  const model = findModel(current.modelId);
  const base = `/leagues/${leagueId}/teams/${teamId}/config/versions`;

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={
          <Link href={base} className="transition-colors hover:text-foreground">
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
              <Badge variant="success">Applied</Badge>
            ) : view.config?.pendingVersionId === current._id ? (
              <Badge variant="warning">Queued</Badge>
            ) : null}
            <Badge variant="outline">
              {model?.displayName ?? current.modelId}
            </Badge>
          </div>
        }
      />

      <ConfigNav leagueId={leagueId} teamId={teamId} />

      {current.redacted ? (
        <EmptyState
          title={`Private until ${formatET(current.revealAt, "MMM d, HH:mm")} ET`}
          description={`The owner's context, skills, tool customizations and harness for version ${current.versionNo} become public ${COOLDOWN_DAYS} days after it was saved.`}
        />
      ) : (
        <>
          <StatStrip>
            <Stat
              label="Saved"
              value={
                <span className="text-base">
                  {formatET(
                    current.createdAt ?? current._creationTime,
                    "MMM d, HH:mm",
                  )}{" "}
                  ET
                </span>
              }
            />
            <Stat
              label="Applied"
              value={
                <span className="text-base">
                  {current.appliedAt
                    ? `${formatET(current.appliedAt, "MMM d, HH:mm")} ET`
                    : "never"}
                </span>
              }
            />
            <Stat label="Skills" value={current.skills.length} />
            <Stat
              label="Summary"
              value={
                <span className="line-clamp-2 text-base font-sans">
                  {current.changeSummary ?? "—"}
                </span>
              }
            />
          </StatStrip>

          {diff ? (
            <DiffView diff={diff} leagueId={leagueId} teamId={teamId} />
          ) : (
            <section className="space-y-4">
              <div className="border-b border-border pb-3">
                <h2 className="eyebrow text-foreground">Context</h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  The initial configuration.
                </p>
              </div>
              <Markdown>{current.contextMd}</Markdown>
            </section>
          )}
        </>
      )}

      {previous ? (
        <div className="flex flex-wrap justify-between gap-3 border-t border-border pt-5">
          <Link
            href={`${base}/${previous._id}`}
            className="text-sm text-muted-foreground underline decoration-border underline-offset-4 transition-colors hover:text-foreground hover:decoration-brand"
          >
            ← Version {previous.versionNo}
          </Link>
          <Link
            href={`${base}/compare?a=${previous._id}&b=${current._id}`}
            className="text-sm text-muted-foreground underline decoration-border underline-offset-4 transition-colors hover:text-foreground hover:decoration-brand"
          >
            Open in the comparison view →
          </Link>
        </div>
      ) : null}
    </div>
  );
}
