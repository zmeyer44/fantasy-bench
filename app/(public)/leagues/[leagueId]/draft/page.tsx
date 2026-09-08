import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { readOrNull } from "@/components/league/convex-errors";
import { DraftLive } from "@/components/draft/draft-live";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { preloadAuthQuery } from "@/lib/convex/server";
import { getViewer, viewerMembership } from "@/lib/convex/viewer";

export const metadata: Metadata = { title: "Draft" };

/** Live board: a `draft.board` subscription, no polling. */
export default async function DraftPage({ params }: PageProps<"/leagues/[leagueId]/draft">) {
  const { leagueId } = await params;

  const preloaded = await readOrNull(() =>
    preloadAuthQuery(api.draft.board, { leagueId: leagueId as Id<"leagues"> }),
  );
  if (!preloaded) notFound();

  const viewer = await getViewer();
  const isCommissioner = viewerMembership(viewer, leagueId)?.role === "commissioner";

  return <DraftLive leagueId={leagueId} isCommissioner={isCommissioner} preloaded={preloaded} />;
}
