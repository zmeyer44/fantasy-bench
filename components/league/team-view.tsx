"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePreloadedQuery, type Preloaded } from "convex/react";

import { OpponentTag, TeamLogo } from "@/components/nfl/team-logo";
import { RunTags } from "@/components/traces/run-tags";
import {
  Badge,
  Button,
  EmptyState,
  PageHeader,
  Stat,
  StatStrip,
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
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
  const record = `${page.record.wins}-${page.record.losses}${
    page.record.ties ? `-${page.record.ties}` : ""
  }`;

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={`${page.team.abbreviation} · ${page.team.ownerName ?? "unowned"}`}
        title={page.team.name}
        actions={
          <>
            <Button size="sm" variant="outline" render={<Link href={`${teamBase}/config`} />}>
              Config
            </Button>
            <Button
              size="sm"
              variant="outline"
              render={<Link href={`${teamBase}/config/versions`} />}
            >
              Version history
            </Button>
            <Button size="sm" variant="outline" render={<Link href={`${teamBase}/film-room`} />}>
              Film room
            </Button>
            <Button
              size="sm"
              variant="ghost"
              render={<a href={`/api/leagues/${leagueId}/teams/${teamId}/traces/export`} />}
            >
              Export traces
            </Button>
          </>
        }
      />

      <StatStrip>
        <Stat label="Record" value={record} detail={`#${page.record.rank} · ${page.record.streak}`} />
        <Stat label="Points for" value={page.record.pointsFor.toFixed(1)} detail="Season total" />
        <Stat label="Karma" value={String(page.team.karma)} detail="Conduct score" />
        <Stat
          label="FAAB"
          value={`$${page.team.faabRemaining}`}
          detail={`of $${page.team.faabBudget}`}
        />
      </StatStrip>

      <div className="grid gap-10 lg:grid-cols-3">
        <div className="space-y-10 lg:col-span-2">
          <section>
            <SectionRule
              title={`Week ${page.weekNo} lineup`}
              meta={
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
                    className="eyebrow transition-colors hover:text-foreground"
                  >
                    Trace →
                  </Link>
                ) : null
              }
            />
            {starters.length === 0 ? (
              <div className="mt-4">
                <EmptyState title="No lineup yet" />
              </div>
            ) : (
              <SlotTable
                rows={starters}
                totals={{ projected: page.projectedTotal, live: page.liveTotal }}
              />
            )}
          </section>

          <section>
            <SectionRule title="Bench" meta={`${bench.length} players`} />
            {bench.length === 0 ? (
              <p className="mt-4 text-sm text-muted-foreground">Nobody on the bench.</p>
            ) : (
              <SlotTable rows={bench} />
            )}
          </section>

          <section>
            <SectionRule
              title="Recent runs"
              action={
                <Link
                  href={`${base}/traces?team=${teamId}`}
                  className="eyebrow transition-colors hover:text-foreground"
                >
                  All traces →
                </Link>
              }
            />
            <div className="mt-4">
              {page.recentRuns.length === 0 ? (
                <p className="text-sm text-muted-foreground">This agent has not run yet.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {page.recentRuns.map((run) => (
                    <li key={run.id} className="py-3 first:pt-0 last:pb-0">
                      <Link
                        href={`${base}/traces/${run.id}`}
                        className="font-mono text-sm text-foreground hover:text-brand-strong"
                      >
                        {run.windowLabelText}
                        {run.weekNo ? ` · wk ${run.weekNo}` : ""}
                      </Link>
                      <div className="mt-2">
                        <RunTags run={run} leagueId={leagueId} showTeam={false} />
                      </div>
                      {run.rationale ? (
                        <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-muted-foreground">
                          {run.rationale}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>

        <div className="space-y-10">
          <section>
            <SectionRule
              title="Agent config"
              meta={page.config.versionNo ? `Version ${page.config.versionNo}` : "No config version"}
              action={
                <Link
                  href={`${teamBase}/config`}
                  className="eyebrow transition-colors hover:text-foreground"
                >
                  Edit →
                </Link>
              }
            />
            <dl className="mt-4 divide-y divide-border">
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
            </dl>
            {page.config.hasPendingVersion ? (
              <div className="mt-3">
                <Badge variant="warning">edit queued for next unlock</Badge>
              </div>
            ) : null}
          </section>

          <section>
            <SectionRule
              title="Cost"
              action={
                <Link
                  href={`${base}/cost`}
                  className="eyebrow transition-colors hover:text-foreground"
                >
                  Dashboard →
                </Link>
              }
            />
            <dl className="mt-4 divide-y divide-border">
              <Row label="Season" value={`$${page.cost.seasonUsd.toFixed(4)}`} />
              <Row label={`Week ${page.weekNo}`} value={`$${page.cost.weekUsd.toFixed(4)}`} />
              <Row label="Tokens" value={page.cost.seasonTokens.toLocaleString()} />
              <Row label="Runs" value={String(page.cost.runCount)} />
            </dl>
          </section>
        </div>
      </div>
    </div>
  );
}

function SectionRule({
  title,
  meta,
  action,
}: {
  title: string;
  meta?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border pb-2.5">
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 className="eyebrow text-foreground">{title}</h2>
        {meta ? <span className="text-xs text-muted-foreground">{meta}</span> : null}
      </div>
      {action}
    </div>
  );
}

function SlotTable({
  rows,
  totals,
}: {
  rows: LineupRow[];
  totals?: { projected: number; live: number };
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-12">Slot</TableHead>
          <TableHead>Player</TableHead>
          <TableHead>Opp</TableHead>
          <TableHead>Kickoff</TableHead>
          <TableHead numeric>Proj</TableHead>
          <TableHead numeric>Pts</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, index) => (
          <TableRow key={`${row.slot}-${row.entry?.playerId ?? index}`}>
            <TableCell className="font-mono text-[10px] uppercase text-ink-faint">
              {row.slot}
            </TableCell>
            <TableCell>
              {row.entry ? (
                <span className="flex flex-wrap items-center gap-1.5">
                  <TeamLogo team={row.entry.nflTeam} size={18} />
                  <span className="text-sm text-foreground">{row.entry.fullName}</span>
                  <span className="font-mono text-[10px] text-ink-faint">
                    {row.entry.position}
                    {row.entry.nflTeam ? ` · ${row.entry.nflTeam}` : ""}
                  </span>
                  {row.entry.injuryStatus ? (
                    <Badge variant="destructive">{row.entry.injuryStatus}</Badge>
                  ) : null}
                </span>
              ) : (
                <span className="text-sm text-ink-faint">— empty —</span>
              )}
            </TableCell>
            <TableCell className="font-mono text-[10px] text-muted-foreground">
              {row.entry?.opponent ? <OpponentTag opponent={row.entry.opponent} /> : "—"}
            </TableCell>
            <TableCell className="font-mono text-[10px] text-muted-foreground">
              {row.entry?.kickoffAt ? formatET(row.entry.kickoffAt, "EEE HH:mm") : "—"}
            </TableCell>
            <TableCell numeric className="font-mono text-xs text-muted-foreground">
              {row.entry?.projection?.toFixed(1) ?? "—"}
            </TableCell>
            <TableCell numeric className="font-mono text-xs text-foreground">
              {row.entry?.livePoints?.toFixed(1) ?? "—"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
      {totals ? (
        <TableFooter>
          <TableRow>
            <TableCell colSpan={4} className="eyebrow">
              Total
            </TableCell>
            <TableCell numeric className="font-mono text-xs text-muted-foreground">
              {totals.projected.toFixed(1)}
            </TableCell>
            <TableCell numeric className="font-mono text-xs text-foreground">
              {totals.live.toFixed(1)}
            </TableCell>
          </TableRow>
        </TableFooter>
      ) : null}
    </Table>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2 first:pt-0 last:pb-0">
      <dt className="eyebrow">{label}</dt>
      <dd className="text-right font-mono text-xs tabular-nums text-foreground">{value}</dd>
    </div>
  );
}
