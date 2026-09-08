import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ConfigEditor } from "@/components/config/config-editor";
import { ConfigNav } from "@/components/config/config-nav";
import { Badge, Card, CardBody, PageHeader } from "@/components/ui";
import { getSession } from "@/lib/auth/session";
import { DEFAULT_MODEL_ID } from "@/lib/models";
import {
  DEFAULT_HARNESS_SETTINGS,
  getConfigForTeam,
  getEditLockStatus,
} from "@/lib/services/config";
import { DEFAULT_AGENT_CONTEXT } from "@/lib/services/league";
import { formatET } from "@/lib/time";

export async function generateMetadata({
  params,
}: PageProps<"/leagues/[leagueId]/teams/[teamId]/config">): Promise<Metadata> {
  const { teamId } = await params;
  const view = await getConfigForTeam(teamId).catch(() => null);
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

  const view = await getConfigForTeam(teamId).catch(() => null);
  if (!view || view.team.leagueId !== leagueId) notFound();

  const session = await getSession();
  const userId = session?.user.id ?? null;
  const isCommissioner = view.league.commissionerUserId === userId;
  const canEdit = !!userId && (view.team.ownerUserId === userId || isCommissioner);

  const lock = await getEditLockStatus(leagueId);
  const nextChangeLabel = `${formatET(lock.nextChange, "EEE h:mm a")} ET`;

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
        canEdit={canEdit}
        rules={{
          contextCharLimit: view.rules?.contextCharLimit ?? 8_000,
          modelAllowlist: view.rules?.modelAllowlist ?? [],
          maxStepsCap: view.rules?.maxStepsCap ?? 30,
          weeklyTokenCapPerTeam: view.rules?.weeklyTokenCapPerTeam ?? null,
        }}
        lock={{ open: lock.open, nextChangeLabel }}
        nextVersionNo={nextVersionNo}
        initial={{
          contextMd: source?.contextMd ?? DEFAULT_AGENT_CONTEXT,
          modelId: source?.modelId ?? view.rules?.modelAllowlist?.[0] ?? DEFAULT_MODEL_ID,
          harness: source?.harness ?? DEFAULT_HARNESS_SETTINGS,
          skills: (source?.skills ?? []).map((s) => ({
            id: s.id,
            name: s.name,
            slug: s.slug,
            description: s.description,
            bodyMd: s.bodyMd,
          })),
          noteToAgent: view.config.noteToAgent ?? "",
          currentVersionNo: view.current?.versionNo ?? null,
          pendingVersionNo: view.pending?.versionNo ?? null,
        }}
      />
    </div>
  );
}
