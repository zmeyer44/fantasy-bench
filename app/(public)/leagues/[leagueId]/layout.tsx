import { notFound } from "next/navigation";

import { LeagueSubnav } from "@/components/league-subnav";
import { Badge } from "@/components/ui";
import { getSession } from "@/lib/auth/session";
import { getLeagueById } from "@/lib/services/league";
import { getMembership } from "@/lib/services/league/queries";

export default async function LeagueLayout({ children, params }: LayoutProps<"/leagues/[leagueId]">) {
  const { leagueId } = await params;
  const league = await getLeagueById(leagueId);
  if (!league) notFound();

  // Private leagues are members-only; public leagues render for spectators.
  const session = await getSession();
  const membership = session ? await getMembership(leagueId, session.user.id) : undefined;
  if (!league.isPublic && !membership) notFound();

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
        <LeagueSubnav leagueId={leagueId} />
      </div>

      <div className="pt-6">{children}</div>
    </div>
  );
}
