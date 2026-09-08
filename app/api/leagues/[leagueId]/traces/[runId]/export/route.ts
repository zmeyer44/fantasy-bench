/**
 * `GET /api/leagues/[leagueId]/traces/[runId]/export` — JSON download of a
 * single trace (PRD 5.8). Public within the league, and to spectators when the
 * league is public.
 */
import { getSession } from "@/lib/auth/session";
import { canReadLeague } from "@/lib/services/league/access";
import { traceExport } from "@/lib/services/views";

export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/leagues/[leagueId]/traces/[runId]/export">,
) {
  const { leagueId, runId } = await ctx.params;

  const session = await getSession();
  const access = await canReadLeague(leagueId, session?.user.id ?? null);
  if (!access.ok) {
    return Response.json({ error: access.reason }, { status: access.status });
  }

  const payload = await traceExport(runId);
  if (!payload || payload.trace.run.leagueId !== leagueId) {
    return Response.json({ error: "Run not found" }, { status: 404 });
  }

  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="trace-${runId}.json"`,
      "cache-control": "no-store",
    },
  });
}
