/**
 * `GET /api/leagues/[leagueId]/teams/[teamId]/traces/export` — JSON download of
 * every trace for a team (PRD 5.8 "all traces for a team/season").
 *
 * A season of traces is far more than one Convex query may return, so
 * `runs.exportTeamPage` is paginated and this handler walks it until `isDone`
 * or until the `TEAM_EXPORT_RUN_LIMIT` cap is hit; the payload still says
 * whether it was truncated, exactly as the Postgres version did.
 */
import { messageForError, statusForError } from "@/components/league/convex-errors";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { FunctionReturnType } from "convex/server";
import { fetchAuthQuery } from "@/lib/convex/server";

/** Mirrors `TEAM_EXPORT_RUN_LIMIT` in `convex/runs.ts` (not imported: that module is server-only). */
const TEAM_EXPORT_RUN_LIMIT = 200;
/** Runs per round trip. Each one carries its steps and overflow payloads. */
const RUNS_PER_PAGE = 10;

type TeamExportPage = FunctionReturnType<typeof api.runs.exportTeamPage>;

export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/leagues/[leagueId]/teams/[teamId]/traces/export">,
) {
  const { leagueId, teamId } = await ctx.params;

  const traces: TeamExportPage["page"] = [];
  let team: TeamExportPage["team"] | null = null;
  let exportedAt = new Date().toISOString();
  let cursor: string | null = null;
  let truncated = false;

  try {
    for (;;) {
      const page: TeamExportPage = await fetchAuthQuery(api.runs.exportTeamPage, {
        teamId: teamId as Id<"teams">,
        paginationOpts: { numItems: RUNS_PER_PAGE, cursor },
      });
      if (team === null) {
        team = page.team;
        exportedAt = page.exportedAt;
      }
      for (const trace of page.page) {
        if (traces.length >= TEAM_EXPORT_RUN_LIMIT) {
          truncated = true;
          break;
        }
        traces.push(trace);
      }
      if (truncated || page.isDone) break;
      cursor = page.continueCursor;
    }
  } catch (error) {
    return Response.json(
      { error: messageForError(error, "Team not found") },
      { status: statusForError(error) },
    );
  }

  if (!team || team.leagueId !== leagueId) {
    return Response.json({ error: "Team not found" }, { status: 404 });
  }

  const payload = {
    version: 1 as const,
    kind: "team" as const,
    exportedAt,
    team,
    runCount: traces.length,
    truncated,
    traces,
  };

  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="traces-${team.abbreviation}-${teamId}.json"`,
      "cache-control": "no-store",
    },
  });
}
