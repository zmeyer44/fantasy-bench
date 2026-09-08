import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { SettingsConsole } from "@/components/settings/settings-console";
import type { SettingsData } from "@/components/settings/types";
import { Button, Card, CardBody, EmptyState, PageHeader } from "@/components/ui";
import { getSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { agentConfigs, configVersions, teams, user } from "@/lib/db/schema";
import { MODEL_CATALOG } from "@/lib/models";
import { getLeagueById, getMembership } from "@/lib/services/league/queries";
import {
  getRules,
  inviteLink,
  listRuleChanges,
  modelsInUse,
} from "@/lib/services/league/rules";
import { asc, eq } from "drizzle-orm";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage({
  params,
}: PageProps<"/leagues/[leagueId]/settings">) {
  const { leagueId } = await params;
  const league = await getLeagueById(leagueId);
  if (!league) notFound();

  const session = await getSession();
  const membership = session ? await getMembership(leagueId, session.user.id) : undefined;

  if (membership?.role !== "commissioner") {
    return <Forbidden leagueId={leagueId} signedIn={Boolean(session)} />;
  }

  const [rules, invite, changes, inUse, teamRows] = await Promise.all([
    getRules(leagueId),
    inviteLink(leagueId),
    listRuleChanges(leagueId, 200),
    modelsInUse(leagueId),
    db
      .select({
        id: teams.id,
        name: teams.name,
        abbreviation: teams.abbreviation,
        ownerUserId: teams.ownerUserId,
        ownerName: user.name,
        ownerEmail: user.email,
        modelId: configVersions.modelId,
        configVersionNo: configVersions.versionNo,
      })
      .from(teams)
      .leftJoin(user, eq(user.id, teams.ownerUserId))
      .leftJoin(agentConfigs, eq(agentConfigs.teamId, teams.id))
      .leftJoin(configVersions, eq(configVersions.id, agentConfigs.currentVersionId))
      .where(eq(teams.leagueId, leagueId))
      .orderBy(asc(teams.waiverPriority)),
  ]);

  const data: SettingsData = {
    league,
    rules,
    invite,
    teams: teamRows,
    changes,
    modelsInUse: inUse,
    catalog: MODEL_CATALOG,
    locked: rules.rulesLockedAt !== null || league.status !== "setup",
  };

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Commissioner"
        title="League settings"
        description="Rules are public and immutable once the draft begins, except budgets, conduct settings, the model allowlist and the schedule. Every change is logged."
      />
      <SettingsConsole data={data} />
    </div>
  );
}

/** 403, not 404: the route exists, this visitor just is not the commissioner. */
function Forbidden({ leagueId, signedIn }: { leagueId: string; signedIn: boolean }) {
  return (
    <Card>
      <CardBody>
        <EmptyState
          title="403 — commissioner only"
          description={
            signedIn
              ? "League settings are visible to the commissioner. Every rule change they make is published in the league's change log."
              : "Sign in as the commissioner to open this console."
          }
          action={
            <div className="flex gap-2">
              <Link href={`/leagues/${leagueId}`}>
                <Button size="sm" variant="secondary">
                  Back to the league
                </Button>
              </Link>
              {signedIn ? null : (
                <Link href={`/login?next=/leagues/${leagueId}/settings`}>
                  <Button size="sm">Sign in</Button>
                </Link>
              )}
            </div>
          }
        />
      </CardBody>
    </Card>
  );
}
