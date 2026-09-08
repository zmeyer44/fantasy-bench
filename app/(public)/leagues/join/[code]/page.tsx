import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { readOrNull } from "@/components/league/convex-errors";
import { JoinByCode } from "@/components/league/join-by-code";
import { Button, Card, CardBody, CardHeader, EmptyState } from "@/components/ui";
import { api } from "@/convex/_generated/api";
import { fetchAuthQuery } from "@/lib/convex/server";
import { getViewer } from "@/lib/convex/viewer";

export const metadata: Metadata = { title: "Join a league" };

export default async function JoinPage({ params }: PageProps<"/leagues/join/[code]">) {
  const { code } = await params;

  // `leagues.byJoinCode` is readable by anyone holding the code and already
  // reports whether the viewer is a member and how many teams are unowned.
  const league = await readOrNull(() => fetchAuthQuery(api.leagues.byJoinCode, { code }));
  if (!league) notFound();

  const viewer = await getViewer();
  const open = league.openTeamCount;

  return (
    <div className="mx-auto max-w-lg px-4 py-16">
      <Card>
        <CardHeader
          title={league.name}
          description={`${league.season} season · ${league.teamCount} teams · ${league.status.replace("_", " ")}`}
        />
        <CardBody>
          {league.alreadyMember ? (
            <EmptyState
              title="You are already in this league"
              action={
                <Link href={`/leagues/${league.leagueId}`}>
                  <Button size="sm">Open the league</Button>
                </Link>
              }
            />
          ) : !viewer ? (
            <EmptyState
              title="Sign in to join"
              description="Invite codes claim a team, so we need to know who you are."
              action={
                <Link href={`/login?next=${encodeURIComponent(`/leagues/join/${code}`)}`}>
                  <Button size="sm">Sign in</Button>
                </Link>
              }
            />
          ) : open === 0 ? (
            <EmptyState
              title="Every team is taken"
              description="You can still watch this league as a spectator."
              action={
                <Link href={`/leagues/${league.leagueId}`}>
                  <Button size="sm" variant="secondary">
                    Watch instead
                  </Button>
                </Link>
              }
            />
          ) : (
            <div className="space-y-4 text-center">
              <p className="text-sm text-ink-muted">
                {open} team{open === 1 ? "" : "s"} still unowned. Joining claims the
                lowest-numbered one and hands you its agent config — you tune the agent, the agent
                runs the team.
              </p>
              <JoinByCode code={code} leagueName={league.name} />
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
