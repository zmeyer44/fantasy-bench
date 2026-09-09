import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import {
  ConfigEditor,
  type EditorTab,
} from "@/components/config/config-editor";
import { ConfigNav } from "@/components/config/config-nav";
import { readOrNull } from "@/components/league/convex-errors";
import { Badge, EmptyState, PageHeader } from "@/components/ui";
import { COOLDOWN_DAYS } from "@/convex/lib/visibility";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { DEFAULT_AGENT_CONTEXT, DEFAULT_HARNESS } from "@/convex/lib/defaults";
import { fetchAuthQuery } from "@/lib/convex/server";
import { leagueDefaultModelId } from "@/lib/models";
import { formatET } from "@/lib/time";

/**
 * `configs.get` carries the team, the league rules, the current and pending
 * versions, the edit-lock status and the viewer's write right in one read.
 */
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
}: PageProps<"/leagues/[leagueId]/teams/[teamId]/config">): Promise<Metadata> {
  const { leagueId, teamId } = await params;
  const view = await loadConfig(leagueId, teamId);
  return { title: view ? `${view.team.name} · Config` : "Config" };
}

/**
 * The config editor. Readable by anyone who can see the league — configs are
 * public (PRD 5.5) — but only the owner or commissioner gets working controls.
 */
export default async function ConfigPage({
  params,
  searchParams,
}: PageProps<"/leagues/[leagueId]/teams/[teamId]/config">) {
  const [{ leagueId, teamId }, query] = await Promise.all([
    params,
    searchParams,
  ]);
  const requestedTab = typeof query.tab === "string" ? query.tab : undefined;
  const initialTab: EditorTab =
    requestedTab === "tools" || requestedTab === "model"
      ? requestedTab
      : "prompt";

  const [view, currentWeekNo] = await Promise.all([
    loadConfig(leagueId, teamId),
    readOrNull(() =>
      fetchAuthQuery(api.weeks.currentWeekNo, {
        leagueId: leagueId as Id<"leagues">,
      }),
    ),
  ]);
  if (!view) notFound();

  const newest = view.pending ?? view.current;
  // A viewer outside the cooldown sees the newest *public* version instead.
  const hidden = newest?.redacted === true;
  const source = hidden ? view.latestPublic : newest;

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
        title="Edit agent"
        description={`The system prompt it runs with, the tools it can call, and the model behind it. Changes become public to the league ${COOLDOWN_DAYS} days after they are saved.`}
        actions={
          <div className="flex items-center gap-2">
            {view.current ? (
              <Badge variant="success">Live</Badge>
            ) : (
              <Badge variant="outline">Defaults</Badge>
            )}
            {view.pending ? (
              <Badge variant="warning">Changes pending</Badge>
            ) : null}
            {hidden ? <Badge variant="secondary">Private</Badge> : null}
          </div>
        }
      />

      <ConfigNav leagueId={leagueId} teamId={teamId} />

      {view.pending && !hidden ? (
        <p className="border-l-2 border-warning/50 pl-3 text-sm text-muted-foreground">
          You have saved changes waiting for the next unlock. Saving again
          replaces them; only the latest save takes effect.
        </p>
      ) : null}

      {hidden && newest ? (
        <p className="border-l-2 border-line-strong pl-3 text-sm text-muted-foreground">
          The latest changes are private until{" "}
          {formatET(newest.revealAt, "MMM d, HH:mm")} ET. Customizations become
          public {COOLDOWN_DAYS} days after they are saved.
          {source
            ? " Showing the latest public configuration."
            : " Nothing about this agent is public yet."}
        </p>
      ) : null}

      {hidden && !source ? (
        <EmptyState
          title="Under wraps"
          description={`${view.team.name}'s agent has nothing public yet. Check back after ${formatET(newest!.revealAt, "MMM d")}.`}
        />
      ) : (
        <ConfigEditor
          leagueId={leagueId}
          teamId={teamId}
          teamName={view.team.name}
          canEdit={view.canEdit}
          rules={{
            contextCharLimit: view.rules?.contextCharLimit ?? 8_000,
            modelAllowlist: view.rules?.modelAllowlist ?? [],
            maxStepsCap: view.rules?.maxStepsCap ?? 30,
            weeklyTokenCapPerTeam: view.rules?.weeklyTokenCapPerTeam ?? null,
          }}
          initialLock={{
            open: view.lock.open,
            nextChange: view.lock.nextChange,
          }}
          initialTab={initialTab}
          weekNo={currentWeekNo ?? 1}
          initial={{
            contextMd: source?.contextMd ?? DEFAULT_AGENT_CONTEXT,
            modelId: source?.modelId ?? leagueDefaultModelId(view.rules?.modelAllowlist),
            harness: source?.harness ?? DEFAULT_HARNESS,
            toolOverrides: source?.toolOverrides ?? [],
            skills: (source?.skills ?? []).map((s) => ({
              id: s._id,
              name: s.name,
              slug: s.slug,
              description: s.description ?? "",
              bodyMd: s.bodyMd,
            })),
            noteToAgent: view.config?.noteToAgent ?? "",
            hasPendingChanges: view.pending !== null,
          }}
        />
      )}
    </div>
  );
}
