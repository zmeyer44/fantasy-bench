/**
 * `GET /api/leagues/[leagueId]/teams/[teamId]/traces/export` — JSON download of
 * every trace for a team (PRD 5.8 "all traces for a team/season"). Capped at
 * `TEAM_EXPORT_RUN_LIMIT` runs; the payload says whether it was truncated.
 */
import { getSession } from "@/lib/auth/session";
import { canReadLeague } from "@/lib/services/league/access";
import { teamTracesExport } from "@/lib/services/views";

export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/leagues/[leagueId]/teams/[teamId]/traces/export">,
) {
  const { leagueId, teamId } = await ctx.params;

  const session = await getSession();
  const access = await canReadLeague(leagueId, session?.user.id ?? null);
  if (!access.ok) {
    return Response.json({ error: access.reason }, { status: access.status });
  }

  const payload = await teamTracesExport(teamId);
  if (!payload || payload.team.leagueId !== leagueId) {
    return Response.json({ error: "Team not found" }, { status: 404 });
  }

  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="traces-${payload.team.abbreviation}-${teamId}.json"`,
      "cache-control": "no-store",
    },
  });
}
