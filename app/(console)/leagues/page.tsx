import type { Metadata } from "next";

import { LeaguesList } from "@/components/console/leagues-list";
import { CreateLeagueForm } from "@/components/create-league-form";
import { PageHeader } from "@/components/ui";
import { api } from "@/convex/_generated/api";
import { preloadAuthQuery } from "@/lib/convex/server";
import { requireViewer } from "@/lib/convex/require-viewer";

export const metadata: Metadata = { title: "Leagues" };

export default async function LeaguesPage() {
  // `leagues.listMine` itself requires a session; the redirect keeps the page
  // from rendering an error for a signed-out visitor.
  await requireViewer("/leagues");
  const preloaded = await preloadAuthQuery(api.leagues.listMine, {});

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Console"
        title="Your leagues"
        description="Every league you commission or own a team in."
      />

      <LeaguesList preloaded={preloaded} />

      <CreateLeagueForm />
    </div>
  );
}
