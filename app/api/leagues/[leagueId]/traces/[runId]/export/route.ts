/**
 * `GET /api/leagues/[leagueId]/traces/[runId]/export` — JSON download of a
 * single trace (PRD 5.8). Public within the league, and to spectators when the
 * league is public: `runs.export` runs `requireLeagueRead` itself, so the route
 * only has to translate a thrown `ConvexError` into a status code.
 */
import { messageForError, statusForError } from "@/components/league/convex-errors";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { fetchAuthQuery } from "@/lib/convex/server";

export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/leagues/[leagueId]/traces/[runId]/export">,
) {
  const { leagueId, runId } = await ctx.params;

  let payload;
  try {
    payload = await fetchAuthQuery(api.runs.export, { runId: runId as Id<"runs"> });
  } catch (error) {
    return Response.json(
      { error: messageForError(error, "Run not found") },
      { status: statusForError(error) },
    );
  }

  if (payload.trace.run.leagueId !== leagueId) {
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
