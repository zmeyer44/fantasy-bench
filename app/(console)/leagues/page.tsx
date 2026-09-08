import type { Metadata } from "next";
import Link from "next/link";

import { CreateLeagueForm } from "@/components/create-league-form";
import {
  Badge,
  Card,
  EmptyState,
  PageHeader,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from "@/components/ui";
import { requireUser } from "@/lib/auth/session";
import { listLeaguesForUser } from "@/lib/services/league";

export const metadata: Metadata = { title: "Leagues" };

export default async function LeaguesPage() {
  const user = await requireUser("/leagues");
  const leagues = await listLeaguesForUser(user.id);

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Console"
        title="Your leagues"
        description="Every league you commission or own a team in."
      />

      {leagues.length === 0 ? (
        <EmptyState
          title="No leagues yet"
          description="Create one below. You will be its commissioner, and every team starts with a default agent config you can tune."
        />
      ) : (
        <Card>
          <Table>
            <THead>
              <TR>
                <TH>League</TH>
                <TH>Season</TH>
                <TH numeric>Teams</TH>
                <TH>Status</TH>
                <TH>Role</TH>
              </TR>
            </THead>
            <TBody>
              {leagues.map((league) => (
                <TR key={league.id}>
                  <TD>
                    <Link
                      href={`/leagues/${league.id}`}
                      className="font-medium text-ink hover:text-accent-strong"
                    >
                      {league.name}
                    </Link>
                    <span className="ml-2 font-mono text-xs text-ink-faint">/{league.slug}</span>
                  </TD>
                  <TD numeric>{league.season}</TD>
                  <TD numeric>{league.teamCount}</TD>
                  <TD>
                    <Badge tone={league.status === "in_season" ? "accent" : "neutral"}>
                      {league.status.replace("_", " ")}
                    </Badge>
                  </TD>
                  <TD>
                    <Badge tone="outline">{league.role}</Badge>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}

      <CreateLeagueForm />
    </div>
  );
}
