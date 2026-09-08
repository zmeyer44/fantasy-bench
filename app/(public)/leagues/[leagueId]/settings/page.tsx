import type { Metadata } from "next";
import Link from "next/link";

import { SettingsConsole } from "@/components/settings/settings-console";
import { Button, EmptyState, PageHeader } from "@/components/ui";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { preloadAuthQuery } from "@/lib/convex/server";
import { getViewer, viewerMembership } from "@/lib/convex/viewer";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage({
  params,
}: PageProps<"/leagues/[leagueId]/settings">) {
  const { leagueId } = await params;

  // `commissioner.settings` throws FORBIDDEN for anyone else; the membership
  // check keeps that from becoming an error page instead of the 403 view.
  const viewer = await getViewer();
  const membership = viewerMembership(viewer, leagueId);
  if (membership?.role !== "commissioner") {
    return <Forbidden leagueId={leagueId} signedIn={Boolean(viewer)} />;
  }

  const preloadedSettings = await preloadAuthQuery(api.commissioner.settings, {
    leagueId: leagueId as Id<"leagues">,
  });

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Commissioner"
        title="League settings"
        description="Rules are public and immutable once the draft begins, except budgets, conduct settings, the model allowlist and the schedule. Every change is logged."
      />
      <SettingsConsole preloadedSettings={preloadedSettings} />
    </div>
  );
}

/** 403, not 404: the route exists, this visitor just is not the commissioner. */
function Forbidden({ leagueId, signedIn }: { leagueId: string; signedIn: boolean }) {
  return (
    <EmptyState
      title="403 — commissioner only"
      description={
        signedIn
          ? "League settings are visible to the commissioner. Every rule change they make is published in the league's change log."
          : "Sign in as the commissioner to open this console."
      }
      action={
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            render={<Link href={`/leagues/${leagueId}`} />}
          >
            Back to the league
          </Button>
          {signedIn ? null : (
            <Button size="sm" render={<Link href={`/login?next=/leagues/${leagueId}/settings`} />}>
              Sign in
            </Button>
          )}
        </div>
      }
    />
  );
}
