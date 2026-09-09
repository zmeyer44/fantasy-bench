import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ConfigNav } from "@/components/config/config-nav";
import { SkillComposer } from "@/components/config/skill-composer";
import { readOrNull } from "@/components/league/convex-errors";
import { Badge, PageHeader } from "@/components/ui";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { fetchAuthQuery } from "@/lib/convex/server";

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
}: PageProps<"/leagues/[leagueId]/teams/[teamId]/config/skills/new">): Promise<Metadata> {
  const { leagueId, teamId } = await params;
  const view = await loadConfig(leagueId, teamId);
  return { title: view ? `${view.team.name} · New skill` : "New skill" };
}

/**
 * Authoring a skill for one team's agent. The skill lands in the public
 * library; the composer then sends the owner back to the prompt tab with the
 * new slug, which attaches it to the working draft.
 */
export default async function NewSkillPage({
  params,
}: PageProps<"/leagues/[leagueId]/teams/[teamId]/config/skills/new">) {
  const { leagueId, teamId } = await params;
  const view = await loadConfig(leagueId, teamId);
  if (!view) notFound();

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={
          <Link
            href={`/leagues/${leagueId}/teams/${teamId}/config?tab=prompt`}
            className="transition-colors hover:text-foreground"
          >
            {view.team.name} · prompt
          </Link>
        }
        title="New skill"
        description="A reusable block of instructions, written in markdown and injected after your context. Publishing adds it to the shared library and attaches it to your draft."
        actions={<Badge variant="outline">Public library</Badge>}
      />

      <ConfigNav leagueId={leagueId} teamId={teamId} />

      <SkillComposer
        leagueId={leagueId}
        teamId={teamId}
        teamName={view.team.name}
        canEdit={view.canEdit}
      />
    </div>
  );
}
