import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { readOrNull } from "@/components/league/convex-errors";
import { TeamsGrid } from "@/components/league/teams-grid";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { preloadAuthQuery } from "@/lib/convex/server";

export const metadata: Metadata = { title: "Teams" };

export default async function TeamsPage({ params }: PageProps<"/leagues/[leagueId]/teams">) {
  const { leagueId } = await params;
  const preloaded = await readOrNull(() =>
    preloadAuthQuery(api.views.teams, { leagueId: leagueId as Id<"leagues"> }),
  );
  if (!preloaded) notFound();

  return <TeamsGrid leagueId={leagueId} preloaded={preloaded} />;
}
