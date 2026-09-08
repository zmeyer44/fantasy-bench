import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { readOrNull } from "@/components/league/convex-errors";
import { TraceFilters } from "@/components/traces/trace-filters";
import { TraceList, type TraceFilterValues } from "@/components/traces/trace-list";
import type { RunListItem, RunStatus } from "@/components/traces/run-tags";
import { PageHeader } from "@/components/ui";
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

  const [teamCards, models, weeks] = await Promise.all([
    readOrNull(() => fetchAuthQuery(api.views.teams, { leagueId: id })),
    readOrNull(() => fetchAuthQuery(api.runs.modelOptions, { leagueId: id })),
    readOrNull(() => fetchAuthQuery(api.weeks.list, { leagueId: id })),
  ]);
  if (!teamCards || !models || !weeks) notFound();

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
  // before `usePaginatedQuery` attaches its subscription. The player matches for
  // the term are a live query inside `TraceList` (`runs.searchPlayers`).
  const paginationOpts = { numItems: PAGE_SIZE, cursor: null };
  const first = q
    ? await readOrNull(() =>
        fetchAuthQuery(api.runs.search, { leagueId: id, ...filters, q, paginationOpts }),
      )
    : await readOrNull(() =>
        fetchAuthQuery(api.runs.list, { leagueId: id, ...filters, paginationOpts }),
      );

  const basePath = `/leagues/${leagueId}/traces`;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Audit trail"
        title="Traces"
        description="Every agent run in this league. Search matches player names, tool names, and any text in a step."
      />

      <TraceFilters
        basePath={basePath}
        teams={teamCards.map((team) => ({ id: team.id, name: team.name }))}
        models={models}
        weeks={weeks.map((week) => week.weekNo)}
      />

      <TraceList
        leagueId={leagueId}
        filters={filters}
        q={q}
        initialRuns={first?.page ?? []}
      />
    </div>
  );
}
