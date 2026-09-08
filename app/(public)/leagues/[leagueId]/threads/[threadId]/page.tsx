import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { readOrNull } from "@/components/league/convex-errors";
import { ThreadView } from "@/components/threads/thread-view";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { fetchAuthQuery } from "@/lib/convex/server";

/** The header only needs the two team names — one message is page enough. */
async function loadHeader(leagueId: string, threadId: string) {
  return readOrNull(() =>
    fetchAuthQuery(api.messaging.getThread, {
      leagueId: leagueId as Id<"leagues">,
      threadId: threadId as Id<"threads">,
      paginationOpts: { numItems: 1, cursor: null },
    }),
  );
}

export async function generateMetadata({
  params,
}: PageProps<"/leagues/[leagueId]/threads/[threadId]">): Promise<Metadata> {
  const { leagueId, threadId } = await params;
  const thread = await loadHeader(leagueId, threadId);
  return { title: thread ? `${thread.teamA.name} ↔ ${thread.teamB.name}` : "Thread" };
}

/**
 * One negotiation. The transcript is a live paginated read inside the client
 * component; the server only resolves the league (404s and the fairness floor).
 */
export default async function ThreadPage({
  params,
}: PageProps<"/leagues/[leagueId]/threads/[threadId]">) {
  const { leagueId, threadId } = await params;

  const [view, thread] = await Promise.all([
    readOrNull(() => fetchAuthQuery(api.leagues.get, { leagueId: leagueId as Id<"leagues"> })),
    loadHeader(leagueId, threadId),
  ]);
  if (!view || !thread) notFound();

  return (
    <ThreadView
      leagueId={leagueId}
      threadId={threadId}
      fairnessFloor={view.rules?.fairnessFloor}
    />
  );
}
