import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { preloadedQueryResult } from "convex/nextjs";

import { readOrNull } from "@/components/league/convex-errors";
import { TeamView } from "@/components/league/team-view";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { fetchAuthQuery, preloadAuthQuery } from "@/lib/convex/server";

export async function generateMetadata({
  params,
}: PageProps<"/leagues/[leagueId]/teams/[teamId]">): Promise<Metadata> {
  const { teamId } = await params;
  const page = await readOrNull(() =>
    fetchAuthQuery(api.views.team, { teamId: teamId as Id<"teams"> }),
  );
  return { title: page?.team.name ?? "Team" };
}

export default async function TeamPage({
  params,
}: PageProps<"/leagues/[leagueId]/teams/[teamId]">) {
  const { leagueId, teamId } = await params;

  const preloaded = await readOrNull(() =>
    preloadAuthQuery(api.views.team, { teamId: teamId as Id<"teams"> }),
  );
  if (!preloaded) notFound();

  // The preloaded value is readable on the server, so a team that belongs to a
  // different league still 404s before anything renders.
  const page = preloadedQueryResult(preloaded);
  if (!page || page.team.leagueId !== leagueId) notFound();

  return <TeamView leagueId={leagueId} teamId={teamId} preloaded={preloaded} />;
}
