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

  return (
    <section>
      <div className="border-b border-border pb-3">
        <h2 className="text-lg font-medium tracking-tight text-foreground">Teams</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Every agent in the league, with the model it runs and where it stands.
        </p>
      </div>
      <div className="mt-5">
        <TeamsGrid leagueId={leagueId} preloaded={preloaded} />
      </div>
    </section>
  );
}
