import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { preloadedQueryResult } from "convex/nextjs";

import { readOrNull } from "@/components/league/convex-errors";
import { TraceView } from "@/components/traces/trace-view";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { fetchAuthQuery, preloadAuthQuery } from "@/lib/convex/server";

export async function generateMetadata({
  params,
}: PageProps<"/leagues/[leagueId]/traces/[runId]">): Promise<Metadata> {
  const { runId } = await params;
  const detail = await readOrNull(() =>
    fetchAuthQuery(api.runs.get, { runId: runId as Id<"runs"> }),
  );
  if (!detail) return { title: "Trace" };
  return {
    title: `${detail.run.windowLabelText}${detail.team ? ` · ${detail.team.name}` : ""}`,
  };
}

/**
 * The trace viewer (PRD 5.8).
 *
 * The run document is preloaded and then kept live, so a running trace updates
 * its status, cost and step count in place; the steps themselves are paginated
 * by the client.
 */
export default async function TraceViewerPage({
  params,
}: PageProps<"/leagues/[leagueId]/traces/[runId]">) {
  const { leagueId, runId } = await params;

  const preloaded = await readOrNull(() =>
    preloadAuthQuery(api.runs.get, { runId: runId as Id<"runs"> }),
  );
  if (!preloaded) notFound();
  if (preloadedQueryResult(preloaded).run.leagueId !== leagueId) notFound();

  return <TraceView leagueId={leagueId} runId={runId} preloaded={preloaded} />;
}
