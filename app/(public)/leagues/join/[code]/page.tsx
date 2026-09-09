import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { readOrNull } from "@/components/league/convex-errors";
import { JoinByCode } from "@/components/league/join-by-code";
import { Badge, Button, EmptyState } from "@/components/ui";
import { api } from "@/convex/_generated/api";
import { fetchAuthQuery } from "@/lib/convex/server";
import { getViewer } from "@/lib/convex/viewer";

export const metadata: Metadata = { title: "Join a league" };

export default async function JoinPage({
  params,
}: PageProps<"/leagues/join/[code]">) {
  const { code } = await params;

  // `leagues.byJoinCode` is readable by anyone holding the code and already
  // reports whether the viewer is a member and how many teams are unowned.
  const league = await readOrNull(() =>
    fetchAuthQuery(api.leagues.byJoinCode, { code }),
  );
  if (!league) notFound();

  const viewer = await getViewer();
  const open = league.openTeamCount;

  return (
    <div className="mx-auto max-w-lg px-4 py-16 sm:px-6">
      <div className="eyebrow-caps text-brand">Invitation</div>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight text-foreground">
        {league.name}
      </h1>
      <div className="mt-4 flex flex-wrap items-center gap-2 border-b border-border pb-5">
        <Badge variant="outline">{league.season} season</Badge>
        <Badge variant="outline">{league.teamCount} teams</Badge>
        <Badge
          variant={league.status === "in_season" ? "success" : "secondary"}
        >
          {league.status.replace("_", " ")}
        </Badge>
      </div>

      <div className="mt-8">
        {league.alreadyMember ? (
          <EmptyState
            title="You are already in this league"
            action={
              <Button
                size="sm"
                render={<Link href={`/leagues/${league.leagueId}`} />}
              >
                Open the league
              </Button>
            }
          />
        ) : !viewer ? (
          <EmptyState
            title="Sign in to join"
            description="Invite codes claim a team, so we need to know who you are."
            action={
              <Button
                size="sm"
                render={
                  <Link
                    href={`/login?next=${encodeURIComponent(`/leagues/join/${code}`)}`}
                  />
                }
              >
                Sign in
              </Button>
            }
          />
        ) : open === 0 ? (
          <EmptyState
            title="Every team is taken"
            description={
              league.isPublic
                ? "You can still watch this league as a spectator."
                : "This private league is full and is not open to spectators."
            }
            action={
              league.isPublic ? (
                <Button
                  size="sm"
                  variant="outline"
                  render={<Link href={`/leagues/${league.leagueId}`} />}
                >
                  Watch instead
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="space-y-5">
            <p className="text-sm text-muted-foreground">
              <span className="font-mono text-foreground tabular-nums">
                {open}
              </span>{" "}
              team
              {open === 1 ? "" : "s"} still unowned. Joining claims the
              lowest-numbered one and hands you its agent config — you tune the
              agent, the agent runs the team.
            </p>
            <JoinByCode code={code} leagueName={league.name} />
          </div>
        )}
      </div>
    </div>
  );
}
