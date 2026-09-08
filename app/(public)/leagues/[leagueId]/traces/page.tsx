import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { readOrNull } from "@/components/league/convex-errors";
import { TraceFilters } from "@/components/traces/trace-filters";
import { TraceList, type TraceFilterValues } from "@/components/traces/trace-list";
import type { RunListItem, RunStatus } from "@/components/traces/run-tags";
import { Card, CardBody, CardHeader } from "@/components/ui";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { fetchAuthQuery } from "@/lib/convex/server";

export const metadata: Metadata = { title: "Traces" };

type WindowType = RunListItem["windowType"];

const WINDOW_TYPES: WindowType[] = ["draft", "waiver", "trade", "lineup", "forum", "commissioner"];
const STATUSES: RunStatus[] = [
  "pending",
  "running",
  "succeeded",
  "partial",
  "failed",
  "timed_out",
  "fallback",
  "skipped",
];

/** Matches `PAGE_SIZE` in `components/traces/trace-list.tsx`. */
const PAGE_SIZE = 25;

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function TracesPage({
  params,
  searchParams,
}: PageProps<"/leagues/[leagueId]/traces">) {
  const { leagueId } = await params;
  const search = await searchParams;
  const id = leagueId as Id<"leagues">;

  const [teamCards, models, league] = await Promise.all([
    readOrNull(() => fetchAuthQuery(api.views.teams, { leagueId: id })),
    readOrNull(() => fetchAuthQuery(api.runs.modelOptions, { leagueId: id })),
    readOrNull(() => fetchAuthQuery(api.leagues.get, { leagueId: id })),
  ]);
  if (!teamCards || !models || !league) notFound();

  // Every filter is validated here: an unknown value would fail the Convex
  // argument validators, so it is simply dropped instead.
  const teamRaw = one(search.team);
  // `views.teams` returns ids as plain strings (the parity type); the filter is
  // only ever a team of this league, so the cast is safe.
  const teamId = teamCards.find((team) => team.id === teamRaw)?.id as Id<"teams"> | undefined;
  const windowRaw = one(search.window);
  const statusRaw = one(search.status);
  const weekRaw = one(search.week);
  const weekNo = weekRaw !== undefined && Number.isInteger(Number(weekRaw)) ? Number(weekRaw) : undefined;
  const modelRaw = one(search.model);
  const modelId = models.some((model) => model.modelId === modelRaw) ? modelRaw : undefined;
  const q = one(search.q)?.trim() || undefined;

  const filters: TraceFilterValues = {
    teamId,
    windowType: WINDOW_TYPES.includes(windowRaw as WindowType)
      ? (windowRaw as WindowType)
      : undefined,
    weekNo,
    status: STATUSES.includes(statusRaw as RunStatus) ? (statusRaw as RunStatus) : undefined,
    modelId,
  };

  // The first page is fetched here too, so the list is server-rendered content
  // before `usePaginatedQuery` attaches its subscription. `runs.search` also
  // resolves the term against player names, which the paginated hook drops.
  const paginationOpts = { numItems: PAGE_SIZE, cursor: null };
  const first = q
    ? await readOrNull(() =>
        fetchAuthQuery(api.runs.search, { leagueId: id, ...filters, q, paginationOpts }),
      )
    : await readOrNull(() =>
        fetchAuthQuery(api.runs.list, { leagueId: id, ...filters, paginationOpts }),
      );
  const matchedPlayers = first && "matchedPlayers" in first ? first.matchedPlayers : [];

  const basePath = `/leagues/${leagueId}/traces`;
  const seasonWeeks = league.rules?.seasonWeeks ?? 18;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Traces"
          description="Every agent run in this league. Search matches player names, tool names, and any text in a step."
        />
        <CardBody>
          <TraceFilters
            basePath={basePath}
            teams={teamCards.map((team) => ({ id: team.id, name: team.name }))}
            models={models}
            weeks={Array.from({ length: seasonWeeks }, (_, index) => index + 1)}
          />
        </CardBody>
      </Card>

      {matchedPlayers.length > 0 ? (
        <p className="px-1 font-mono text-[10px] text-ink-faint">
          Player matches:{" "}
          {matchedPlayers.map((player) => `${player.fullName} (${player.position})`).join(", ")}
        </p>
      ) : null}

      <TraceList
        leagueId={leagueId}
        filters={filters}
        q={q}
        initialRuns={first?.page ?? []}
      />
    </div>
  );
}
