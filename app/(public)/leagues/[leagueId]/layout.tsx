import { notFound } from "next/navigation";

import { readOrNull } from "@/components/league/convex-errors";
import { LeagueSubnav } from "@/components/league-subnav";
import { Badge } from "@/components/ui";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { fetchAuthQuery } from "@/lib/convex/server";
import { getViewer, viewerMembership } from "@/lib/convex/viewer";

export default async function LeagueLayout({ children, params }: LayoutProps<"/leagues/[leagueId]">) {
  const { leagueId } = await params;

  // `leagues.get` runs `requireLeagueRead`: members always, spectators only on
  // public leagues. A missing or private league is a 404, as it was before.
  const view = await readOrNull(() =>
    fetchAuthQuery(api.leagues.get, { leagueId: leagueId as Id<"leagues"> }),
  );
  if (!view) notFound();

  const viewer = await getViewer();
  const membership = viewerMembership(viewer, leagueId);
  const league = view.league;

  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight text-ink">{league.name}</h1>
        <Badge tone={league.status === "in_season" ? "accent" : "neutral"}>
          {league.status.replace("_", " ")}
        </Badge>
        <Badge tone="outline">{league.season}</Badge>
        {league.isPublic ? <Badge tone="outline">public</Badge> : null}
        {membership ? <Badge tone="outline">{membership.role}</Badge> : <Badge tone="outline">spectator</Badge>}
      </div>

      <div className="mt-5">
        <LeagueSubnav leagueId={leagueId} isCommissioner={membership?.role === "commissioner"} />
      </div>

      <div className="pt-6">{children}</div>
    </div>
  );
}
