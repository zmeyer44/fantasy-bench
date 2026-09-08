import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { JoinByCode } from "@/components/league/join-by-code";
import { Button, Card, CardBody, CardHeader, EmptyState } from "@/components/ui";
import { getSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { teams } from "@/lib/db/schema";
import { getMembership } from "@/lib/services/league/queries";
import { getLeagueByJoinCode } from "@/lib/services/league/rules";
import { and, eq, isNull, sql } from "drizzle-orm";

export const metadata: Metadata = { title: "Join a league" };

export default async function JoinPage({ params }: PageProps<"/leagues/join/[code]">) {
  const { code } = await params;
  const league = await getLeagueByJoinCode(code);
  if (!league) notFound();

  const session = await getSession();
  const membership = session ? await getMembership(league.id, session.user.id) : undefined;

  const [{ open } = { open: 0 }] = await db
    .select({ open: sql<number>`count(*)::int` })
    .from(teams)
    .where(and(eq(teams.leagueId, league.id), isNull(teams.ownerUserId)));

  return (
    <div className="mx-auto max-w-lg px-4 py-16">
      <Card>
        <CardHeader
          title={league.name}
          description={`${league.season} season · ${league.teamCount} teams · ${league.status.replace("_", " ")}`}
        />
        <CardBody>
          {membership ? (
            <EmptyState
              title="You are already in this league"
              action={
                <Link href={`/leagues/${league.id}`}>
                  <Button size="sm">Open the league</Button>
                </Link>
              }
            />
          ) : !session ? (
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
                <Link href={`/leagues/${league.id}`}>
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
