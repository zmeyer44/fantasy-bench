/**
 * `/api/cron/ingest` — every 15 minutes (see vercel.json).
 *
 * Thin by design (docs/ARCHITECTURE.md): auth, pick the plan, call the
 * ingesters, report counts. Which set runs when lives in
 * `lib/providers/ingest-plan`.
 */
import { type NextRequest } from "next/server";

import { defaultProjectionProvider } from "@/lib/providers";
import { fullIngestPlan, planFor } from "@/lib/providers/ingest-plan";
import {
  ingestInjuriesAndNews,
  ingestOwnership,
  ingestPlayers,
  ingestProjections,
  ingestSchedule,
  ingestStats,
} from "@/lib/providers/ingest";
import { fetchState } from "@/lib/providers/sleeper";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

function authorized(request: NextRequest): boolean {
  const expected = process.env.CRON_SECRET ?? "dev-cron-secret";
  return (request.headers.get("authorization") ?? "") === `Bearer ${expected}`;
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!authorized(request)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const params = request.nextUrl.searchParams;
  const plan = params.get("all") === "1" ? fullIngestPlan() : planFor(now);

  // Sleeper's state endpoint is the cheapest way to learn the live week.
  const state = await fetchState();
  const season = Number(params.get("season")) || state?.season || now.getUTCFullYear();
  const week = Number(params.get("week")) || state?.week || 1;

  const counts: Record<string, unknown> = { season, week, plan: plan.reason };

  try {
    if (plan.players) counts.players = await ingestPlayers();
    if (plan.schedule) counts.schedule = await ingestSchedule(season, { weeks: [week, week + 1] });
    if (plan.projections) {
      counts.projections = await ingestProjections(season, week, {
        provider: defaultProjectionProvider(),
      });
    }
    if (plan.stats) counts.stats = await ingestStats(season, week);
    if (plan.news) counts.newsAndInjuries = await ingestInjuriesAndNews({ season, week });
    if (plan.ownership) counts.ownership = await ingestOwnership(season, week);
  } catch (err) {
    console.error("[cron/ingest] failed", err);
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err), counts },
      { status: 500 },
    );
  }

  return Response.json({ ok: true, ...counts });
}
