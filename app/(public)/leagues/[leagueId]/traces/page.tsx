import type { Metadata } from "next";
import Link from "next/link";

import { TraceFilters } from "@/components/traces/trace-filters";
import { TraceRow } from "@/components/traces/trace-row";
import { Card, CardBody, CardFooter, CardHeader, EmptyState } from "@/components/ui";
import { db } from "@/lib/db";
import { teams, weeks } from "@/lib/db/schema";
import type { RunStatus, WindowType } from "@/lib/db/types";
import { traceList, traceModelOptions } from "@/lib/services/views";
import { asc, eq } from "drizzle-orm";

export const metadata: Metadata = { title: "Traces" };

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

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function TracesPage({
  params,
  searchParams,
}: PageProps<"/leagues/[leagueId]/traces">) {
  const { leagueId } = await params;
  const search = await searchParams;

  const teamId = one(search.team);
  const windowRaw = one(search.window);
  const statusRaw = one(search.status);
  const weekRaw = one(search.week);
  const modelId = one(search.model);
  const q = one(search.q);
  const page = Math.max(1, Number(one(search.page) ?? 1) || 1);

  const [result, teamRows, weekRows, models] = await Promise.all([
    traceList({
      leagueId,
      teamId: teamId && /^[0-9a-f-]{36}$/i.test(teamId) ? teamId : undefined,
      windowType: WINDOW_TYPES.includes(windowRaw as WindowType)
        ? (windowRaw as WindowType)
        : undefined,
      status: STATUSES.includes(statusRaw as RunStatus) ? (statusRaw as RunStatus) : undefined,
      weekNo: weekRaw && Number.isInteger(Number(weekRaw)) ? Number(weekRaw) : undefined,
      modelId,
      q,
      page,
    }),
    db
      .select({ id: teams.id, name: teams.name })
      .from(teams)
      .where(eq(teams.leagueId, leagueId))
      .orderBy(asc(teams.name)),
    db
      .select({ weekNo: weeks.weekNo })
      .from(weeks)
      .where(eq(weeks.leagueId, leagueId))
      .orderBy(asc(weeks.weekNo)),
    traceModelOptions(leagueId),
  ]);

  const basePath = `/leagues/${leagueId}/traces`;
  const pageHref = (n: number) => {
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries(search)) {
      const v = one(value);
      if (v && key !== "page") next.set(key, v);
    }
    next.set("page", String(n));
    return `${basePath}?${next.toString()}`;
  };

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
            teams={teamRows}
            models={models}
            weeks={weekRows.map((w) => w.weekNo)}
          />
        </CardBody>
      </Card>

      {result.matchedPlayers.length > 0 ? (
        <p className="px-1 font-mono text-[10px] text-ink-faint">
          Player matches: {result.matchedPlayers.map((p) => `${p.fullName} (${p.position})`).join(", ")}
        </p>
      ) : null}

      <Card>
        <CardHeader
          title={`${result.total} run${result.total === 1 ? "" : "s"}`}
          description={
            result.pageCount > 1 ? `Page ${result.page} of ${result.pageCount}` : undefined
          }
        />
        {result.items.length === 0 ? (
          <CardBody>
            <EmptyState
              title="No matching runs"
              description={
                q
                  ? `Nothing matched “${q}”. Try a player's full name, a tool name like set_lineup, or a phrase from a rationale.`
                  : "Runs appear here as soon as a decision window opens."
              }
            />
          </CardBody>
        ) : (
          <div>
            {result.items.map((run) => (
              <TraceRow key={run.id} run={run} leagueId={leagueId} />
            ))}
          </div>
        )}
        {result.pageCount > 1 ? (
          <CardFooter className="flex items-center justify-between">
            {result.page > 1 ? (
              <Link href={pageHref(result.page - 1)} className="hover:text-accent-strong">
                ← Newer
              </Link>
            ) : (
              <span />
            )}
            <span className="font-mono">
              {result.page} / {result.pageCount}
            </span>
            {result.page < result.pageCount ? (
              <Link href={pageHref(result.page + 1)} className="hover:text-accent-strong">
                Older →
              </Link>
            ) : (
              <span />
            )}
          </CardFooter>
        ) : null}
      </Card>
    </div>
  );
}
