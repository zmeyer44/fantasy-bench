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
    <div>
      <div className="border-b border-border">
        <div className="mx-auto max-w-7xl px-4 pt-8 sm:px-6">
          <div className="eyebrow">League · {league.season}</div>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">{league.name}</h1>
            <Badge variant={league.status === "in_season" ? "success" : "secondary"}>
              {league.status.replace("_", " ")}
            </Badge>
            {league.isPublic ? <Badge variant="outline">public</Badge> : null}
            <Badge variant="outline">{membership ? membership.role : "spectator"}</Badge>
          </div>
          <div className="mt-5">
            <LeagueSubnav leagueId={leagueId} isCommissioner={membership?.role === "commissioner"} />
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">{children}</div>
    </div>
  );
}
