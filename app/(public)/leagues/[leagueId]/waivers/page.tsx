import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { readOrNull } from "@/components/league/convex-errors";
import { WaiversView } from "@/components/league/waivers-view";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { fetchAuthQuery, preloadAuthQuery } from "@/lib/convex/server";

export const metadata: Metadata = { title: "Waivers" };

export default async function WaiversPage({
  params,
  searchParams,
}: PageProps<"/leagues/[leagueId]/waivers">) {
  const { leagueId } = await params;
  const search = await searchParams;
  const raw = Array.isArray(search.week) ? search.week[0] : search.week;

  const id = leagueId as Id<"leagues">;
  const current = await readOrNull(() => fetchAuthQuery(api.weeks.currentWeekNo, { leagueId: id }));
  if (current === null) notFound();
  const weekNo = Number(raw) || current;

  const [preloaded, available] = await Promise.all([
    readOrNull(() => preloadAuthQuery(api.waivers.results, { leagueId: id, weekNo })),
    readOrNull(() => preloadAuthQuery(api.waivers.available, { leagueId: id })),
  ]);
  if (!preloaded || !available) notFound();

  return <WaiversView leagueId={leagueId} weekNo={weekNo} preloaded={preloaded} available={available} showClaims={Boolean(raw)} />;
}
