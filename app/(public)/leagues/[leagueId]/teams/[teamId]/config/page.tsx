import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ConfigEditor } from "@/components/config/config-editor";
import { ConfigNav } from "@/components/config/config-nav";
import { readOrNull } from "@/components/league/convex-errors";
import { Badge, Card, CardBody, PageHeader } from "@/components/ui";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { DEFAULT_AGENT_CONTEXT, DEFAULT_HARNESS } from "@/convex/lib/defaults";
import { fetchAuthQuery } from "@/lib/convex/server";
import { DEFAULT_MODEL_ID } from "@/lib/models";

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
}: PageProps<"/leagues/[leagueId]/teams/[teamId]/config">) {
  const { leagueId, teamId } = await params;

  const view = await loadConfig(leagueId, teamId);
  if (!view) notFound();

  const source = view.pending ?? view.current;
  const nextVersionNo = (view.versions[0]?.versionNo ?? 0) + 1;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href={`/leagues/${leagueId}/teams/${teamId}`} className="hover:text-ink">
            {view.team.name}
          </Link>
        }
        title="Agent configuration"
        description="Context, skills, model and harness. Every version is immutable and public to the league."
        actions={
          <div className="flex items-center gap-2">
            {view.current ? (
              <Badge tone="accent">v{view.current.versionNo} live</Badge>
            ) : (
              <Badge tone="outline">no version</Badge>
            )}
            {view.pending ? <Badge tone="warning">v{view.pending.versionNo} queued</Badge> : null}
          </div>
        }
      />

      <ConfigNav leagueId={leagueId} teamId={teamId} />

      {view.pending ? (
        <Card>
          <CardBody className="text-sm text-ink-muted">
            You are editing on top of the queued version {view.pending.versionNo}. Saving again
            replaces it — only the newest queued version applies at unlock.
          </CardBody>
        </Card>
      ) : null}

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
        initialLock={{ open: view.lock.open, nextChange: view.lock.nextChange }}
        nextVersionNo={nextVersionNo}
        initial={{
          contextMd: source?.contextMd ?? DEFAULT_AGENT_CONTEXT,
          modelId: source?.modelId ?? view.rules?.modelAllowlist?.[0] ?? DEFAULT_MODEL_ID,
          harness: source?.harness ?? DEFAULT_HARNESS,
          skills: (source?.skills ?? []).map((s) => ({
            id: s._id,
            name: s.name,
            slug: s.slug,
            description: s.description ?? "",
            bodyMd: s.bodyMd,
          })),
          noteToAgent: view.config?.noteToAgent ?? "",
          currentVersionNo: view.current?.versionNo ?? null,
          pendingVersionNo: view.pending?.versionNo ?? null,
        }}
      />
    </div>
  );
}
