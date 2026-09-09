import { Lock } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ConfigNav } from "@/components/config/config-nav";
import { ToolDetail } from "@/components/config/tool-detail";
import { toolRows } from "@/components/config/tool-model";
import { readOrNull } from "@/components/league/convex-errors";
import { Badge, EmptyState, PageHeader } from "@/components/ui";
import { COOLDOWN_DAYS } from "@/convex/lib/visibility";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  TOOL_BY_NAME,
  TOOL_CATALOG,
  TOOL_GROUP_LABELS,
} from "@/convex/runtime/tools/catalog";
import { fetchAuthQuery } from "@/lib/convex/server";
import { formatET } from "@/lib/time";

async function loadConfig(leagueId: string, teamId: string) {
  return readOrNull(() =>
    fetchAuthQuery(api.configs.get, {
      leagueId: leagueId as Id<"leagues">,
      teamId: teamId as Id<"teams">,
    }),
  );
}

export async function generateMetadata({
  params,
}: PageProps<"/leagues/[leagueId]/teams/[teamId]/config/tools/[toolName]">): Promise<Metadata> {
  const { leagueId, teamId, toolName } = await params;
  const view = await loadConfig(leagueId, teamId);
  return { title: view ? `${view.team.name} · ${toolName}` : toolName };
}

/**
 * One default tool for one team: the contract the model reads, and the owner's
 * customisation of it. Readable by anyone who can see the league, editable by
 * the owner or the commissioner. The customisation shown is the newest version's
 * (queued first, then live), or the latest public one during the cooldown.
 */
export default async function ToolDetailPage({
  params,
}: PageProps<"/leagues/[leagueId]/teams/[teamId]/config/tools/[toolName]">) {
  const { leagueId, teamId, toolName } = await params;
  const entry = TOOL_BY_NAME.get(toolName);
  if (!entry) notFound();

  const view = await loadConfig(leagueId, teamId);
  if (!view) notFound();

  const newest = view.pending ?? view.current;
  const hidden = newest?.redacted === true;
  const source = hidden ? view.latestPublic : newest;

  const rows = toolRows(source?.toolOverrides ?? []);
  const row = rows.find((r) => r.name === toolName);
  if (!row) notFound();

  const index = TOOL_CATALOG.findIndex((t) => t.name === toolName);
  const neighbor = (i: number) => {
    const t = TOOL_CATALOG[i];
    return t ? { name: t.name, summary: t.summary } : null;
  };
  const siblings = TOOL_CATALOG.filter(
    (t) => t.group === entry.group && t.name !== toolName,
  ).map((t) => ({ name: t.name, summary: t.summary }));

  const base = `/leagues/${leagueId}/teams/${teamId}`;
  const group = TOOL_GROUP_LABELS[entry.group];

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={
          <Link
            href={`${base}/config?tab=tools`}
            className="transition-colors hover:text-foreground"
          >
            {view.team.name} · tools
          </Link>
        }
        title={<span className="font-mono">{entry.name}</span>}
        description={entry.summary}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{group.title}</Badge>
            {entry.locked ? (
              <Badge variant="secondary">
                <Lock data-icon="inline-start" /> required
              </Badge>
            ) : null}
            {!row.enabled ? <Badge variant="warning">Off</Badge> : null}
            {row.enabled && row.guidance ? (
              <Badge variant="info">Guided</Badge>
            ) : null}
            {source && source._id === view.pending?._id ? (
              <Badge variant="warning">Changes pending</Badge>
            ) : null}
          </div>
        }
      />

      <ConfigNav leagueId={leagueId} teamId={teamId} />

      {hidden && newest ? (
        <p className="border-l-2 border-line-strong pl-3 text-sm text-muted-foreground">
          The latest changes are private until{" "}
          {formatET(newest.revealAt, "MMM d, HH:mm")} ET. Customizations become
          public {COOLDOWN_DAYS} days after they are saved.
          {source ? " Showing the latest public configuration." : ""}
        </p>
      ) : null}

      {hidden && !source ? (
        <EmptyState
          title="Under wraps"
          description={`${view.team.name}'s agent has nothing public yet. Check back after ${formatET(newest!.revealAt, "MMM d")}.`}
        />
      ) : (
        <ToolDetail
          key={`${row.name}:${source?._id ?? "defaults"}`}
          leagueId={leagueId}
          teamId={teamId}
          teamName={view.team.name}
          tool={row}
          canEdit={view.canEdit}
          lock={{ open: view.lock.open, nextChange: view.lock.nextChange }}
          siblings={siblings}
          previous={neighbor(index - 1)}
          next={neighbor(index + 1)}
        />
      )}
    </div>
  );
}
