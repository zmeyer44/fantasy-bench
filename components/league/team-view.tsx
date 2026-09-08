"use client";

import Link from "next/link";
import { usePreloadedQuery, type Preloaded } from "convex/react";

import { RunTags } from "@/components/traces/run-tags";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  EmptyState,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from "@/components/ui";
import type { api } from "@/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import { formatET } from "@/lib/time";

type TeamPage = NonNullable<FunctionReturnType<typeof api.views.team>>;
type LineupRow = TeamPage["lineup"][number];

/** A team's roster, lineup, agent config and recent runs — live off `views.team`. */
export function TeamView({
  leagueId,
  teamId,
  preloaded,
}: {
  leagueId: string;
  teamId: string;
  preloaded: Preloaded<typeof api.views.team>;
}) {
  const page = usePreloadedQuery(preloaded);
  if (!page) return <EmptyState title="Team not found" />;

  const base = `/leagues/${leagueId}`;
  const teamBase = `${base}/teams/${teamId}`;
  const starters = page.lineup.filter((row) => row.starting);
  const bench = page.lineup.filter((row) => !row.starting);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-4">
        <div>
          <div className="eyebrow mb-2">
            {page.team.abbreviation} · {page.team.ownerName ?? "unowned"}
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">{page.team.name}</h1>
          <p className="mt-1 font-mono text-xs text-ink-muted">
            #{page.record.rank} · {page.record.wins}-{page.record.losses}
            {page.record.ties ? `-${page.record.ties}` : ""} · {page.record.pointsFor.toFixed(1)} PF
            · {page.record.streak} · karma {page.team.karma} · ${page.team.faabRemaining} of $
            {page.team.faabBudget} FAAB
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={`${teamBase}/config`}>
            <Button size="sm" variant="secondary">
              Config
            </Button>
          </Link>
          <Link href={`${teamBase}/config/versions`}>
            <Button size="sm" variant="secondary">
              Version history
            </Button>
          </Link>
          <Link href={`${teamBase}/film-room`}>
            <Button size="sm" variant="secondary">
              Film room
            </Button>
          </Link>
          <a href={`/api/leagues/${leagueId}/teams/${teamId}/traces/export`}>
            <Button size="sm" variant="ghost">
              Export traces
            </Button>
          </a>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader
              title={`Week ${page.weekNo} lineup`}
              description={
                page.lineupSource
                  ? `Set by ${page.lineupSource.replace("_", " ")}${
                      page.snapshotTakenAt
                        ? ` · projections as of ${formatET(page.snapshotTakenAt, "MMM d HH:mm")} ET`
                        : ""
                    }`
                  : "No lineup set for this week yet."
              }
              action={
                page.lineupSetByRunId ? (
                  <Link
                    href={`${base}/traces/${page.lineupSetByRunId}`}
                    className="text-xs text-ink-muted hover:text-accent-strong"
                  >
                    Trace →
                  </Link>
                ) : null
              }
            />
            {starters.length === 0 ? (
              <CardBody>
                <EmptyState title="No lineup yet" />
              </CardBody>
            ) : (
              <>
                <SlotTable rows={starters} />
                <CardFooter className="flex justify-between">
                  <span>
                    Projected{" "}
                    <span className="font-mono text-ink">{page.projectedTotal.toFixed(1)}</span>
                  </span>
                  <span>
                    Live <span className="font-mono text-ink">{page.liveTotal.toFixed(1)}</span>
                  </span>
                </CardFooter>
              </>
            )}
          </Card>

          <Card>
            <CardHeader title="Bench" description={`${bench.length} players`} />
            {bench.length === 0 ? (
              <CardBody>
                <p className="text-sm text-ink-muted">Nobody on the bench.</p>
              </CardBody>
            ) : (
              <SlotTable rows={bench} />
            )}
          </Card>

          <Card>
            <CardHeader
              title="Recent runs"
              action={
                <Link
                  href={`${base}/traces?team=${teamId}`}
                  className="text-xs text-ink-muted hover:text-accent-strong"
                >
                  All traces →
                </Link>
              }
            />
            <CardBody className="space-y-3">
              {page.recentRuns.length === 0 ? (
                <p className="text-sm text-ink-muted">This agent has not run yet.</p>
              ) : (
                page.recentRuns.map((run) => (
                  <div key={run.id} className="border-b border-line pb-3 last:border-0 last:pb-0">
                    <Link
                      href={`${base}/traces/${run.id}`}
                      className="font-mono text-sm text-ink hover:text-accent-strong"
                    >
                      {run.windowLabelText}
                      {run.weekNo ? ` · wk ${run.weekNo}` : ""}
                    </Link>
                    <div className="mt-1.5">
                      <RunTags run={run} leagueId={leagueId} showTeam={false} />
                    </div>
                    {run.rationale ? (
                      <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-ink-muted">
                        {run.rationale}
                      </p>
                    ) : null}
                  </div>
                ))
              )}
            </CardBody>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader
              title="Agent config"
              description={
                page.config.versionNo ? `Version ${page.config.versionNo}` : "No config version"
              }
              action={
                <Link
                  href={`${teamBase}/config`}
                  className="text-xs text-ink-muted hover:text-accent-strong"
                >
                  Edit →
                </Link>
              }
            />
            <CardBody className="space-y-2 text-sm">
              <Row label="Model" value={page.config.modelLabel} />
              <Row label="Max steps" value={String(page.config.harness?.maxSteps ?? "—")} />
              <Row
                label="Token budget"
                value={page.config.harness?.tokenBudget?.toLocaleString() ?? "—"}
              />
              <Row label="Temperature" value={String(page.config.harness?.temperature ?? "—")} />
              <Row label="Context" value={`${page.config.contextChars.toLocaleString()} chars`} />
              {page.config.changeSummary ? (
                <Row label="Last change" value={page.config.changeSummary} />
              ) : null}
              {page.config.createdAt ? (
                <Row label="Saved" value={`${formatET(page.config.createdAt, "MMM d HH:mm")} ET`} />
              ) : null}
              {page.config.hasPendingVersion ? (
                <div className="pt-1">
                  <Badge tone="warning">edit queued for next unlock</Badge>
                </div>
              ) : null}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Cost" />
            <CardBody className="space-y-2 text-sm">
              <Row label="Season" value={`$${page.cost.seasonUsd.toFixed(4)}`} />
              <Row label={`Week ${page.weekNo}`} value={`$${page.cost.weekUsd.toFixed(4)}`} />
              <Row label="Tokens" value={page.cost.seasonTokens.toLocaleString()} />
              <Row label="Runs" value={String(page.cost.runCount)} />
            </CardBody>
            <CardFooter>
              <Link href={`${base}/cost`} className="hover:text-accent-strong">
                League cost dashboard →
              </Link>
            </CardFooter>
          </Card>
        </div>
      </div>
    </div>
  );
}

function SlotTable({ rows }: { rows: LineupRow[] }) {
  return (
    <Table>
      <THead>
        <TR>
          <TH>Slot</TH>
          <TH>Player</TH>
          <TH>Opp</TH>
          <TH>Kickoff</TH>
          <TH numeric>Proj</TH>
          <TH numeric>Pts</TH>
        </TR>
      </THead>
      <TBody>
        {rows.map((row, index) => (
          <TR key={`${row.slot}-${row.entry?.playerId ?? index}`}>
            <TD className="font-mono text-[10px] uppercase text-ink-faint">{row.slot}</TD>
            <TD>
              {row.entry ? (
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm text-ink">{row.entry.fullName}</span>
                  <span className="font-mono text-[10px] text-ink-faint">
                    {row.entry.position}
                    {row.entry.nflTeam ? ` · ${row.entry.nflTeam}` : ""}
                  </span>
                  {row.entry.injuryStatus ? (
                    <Badge tone="danger">{row.entry.injuryStatus}</Badge>
                  ) : null}
                </span>
              ) : (
                <span className="text-sm text-ink-faint">— empty —</span>
              )}
            </TD>
            <TD className="font-mono text-[10px] text-ink-muted">{row.entry?.opponent ?? "—"}</TD>
            <TD className="font-mono text-[10px] text-ink-muted">
              {row.entry?.kickoffAt ? `${formatET(row.entry.kickoffAt, "EEE HH:mm")}` : "—"}
            </TD>
            <TD numeric className="font-mono text-xs">
              {row.entry?.projection?.toFixed(1) ?? "—"}
            </TD>
            <TD numeric className="font-mono text-xs text-ink">
              {row.entry?.livePoints?.toFixed(1) ?? "—"}
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line pb-2 last:border-0 last:pb-0">
      <dt className="eyebrow">{label}</dt>
      <dd className="text-right font-mono text-xs tabular-nums text-ink">{value}</dd>
    </div>
  );
}
