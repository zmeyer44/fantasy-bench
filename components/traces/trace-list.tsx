"use client";

import { usePaginatedQuery, useQuery } from "convex/react";

import { TraceRow } from "@/components/traces/trace-row";
import { Button, EmptyState } from "@/components/ui";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { RunListItem, RunStatus } from "@/components/traces/run-tags";

export type TraceFilterValues = {
  teamId?: Id<"teams">;
  windowType?: RunListItem["windowType"];
  weekNo?: number;
  status?: RunStatus;
  modelId?: string;
};

const PAGE_SIZE = 25;

/**
 * The paginated trace list.
 *
 * `runs.list` (or `runs.search` when the URL carries `?q=`) is a Convex
 * paginated query, so the old numbered pager becomes a growing list with a
 * "load more" button — page sizes are hints, and there is no total to count.
 * `initialRuns` is the same first page fetched on the server, so the list is
 * real content before the subscription attaches rather than a spinner.
 *
 * The "Player matches" line above the list is its own live query
 * (`runs.searchPlayers`), so it tracks the term the way the list does.
 */
export function TraceList({
  leagueId,
  filters,
  q,
  initialRuns,
}: {
  leagueId: string;
  filters: TraceFilterValues;
  q: string | undefined;
  initialRuns: RunListItem[];
}) {
  const searching = Boolean(q);
  const args = { leagueId: leagueId as Id<"leagues">, ...filters };

  const listed = usePaginatedQuery(api.runs.list, searching ? "skip" : args, {
    initialNumItems: PAGE_SIZE,
  });
  const found = usePaginatedQuery(
    api.runs.search,
    searching ? { ...args, q: q as string } : "skip",
    { initialNumItems: PAGE_SIZE },
  );

  // Skipped when the URL carries no term, so an unfiltered list runs one query.
  const matchedPlayers = useQuery(
    api.runs.searchPlayers,
    searching ? { leagueId: leagueId as Id<"leagues">, q: q as string } : "skip",
  );

  const { results, status, isLoading, loadMore } = searching ? found : listed;
  const firstPage = status === "LoadingFirstPage";
  const runs: RunListItem[] = firstPage ? initialRuns : results;

  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border pb-2">
        <h2 className="eyebrow text-foreground">
          {runs.length}
          {status === "Exhausted" ? "" : "+"} run{runs.length === 1 ? "" : "s"}
        </h2>
        {searching ? (
          <p className="font-mono text-[10px] text-ink-faint">Matching “{q}”</p>
        ) : null}
      </div>

      {matchedPlayers && matchedPlayers.length > 0 ? (
        <p className="border-b border-border py-2 font-mono text-[10px] leading-relaxed text-ink-faint">
          Player matches:{" "}
          {matchedPlayers
            .map(
              (player) =>
                `${player.fullName} (${player.position}${player.nflTeam ? ` · ${player.nflTeam}` : ""})`,
            )
            .join(", ")}
        </p>
      ) : null}

      {runs.length === 0 ? (
        <div className="pt-4">
          <EmptyState
            title="No matching runs"
            description={
              q
                ? `Nothing matched “${q}”. Try a player's full name, a tool name like set_lineup, or a phrase from a rationale.`
                : "Runs appear here as soon as a decision window opens."
            }
          />
        </div>
      ) : (
        <div>
          {runs.map((run) => (
            <TraceRow key={run.id} run={run} leagueId={leagueId} />
          ))}
        </div>
      )}

      {status === "CanLoadMore" || status === "LoadingMore" ? (
        <div className="flex justify-center pt-4">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={isLoading}
            onClick={() => loadMore(PAGE_SIZE)}
          >
            {status === "LoadingMore" ? "Loading…" : "Load more"}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
