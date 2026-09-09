"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePreloadedQuery, type Preloaded } from "convex/react";

import { BarChart, CapMeter, LineChart } from "@/components/cost/charts";
import { formatPct, formatTokens, formatUsd } from "@/components/cost/format";
import {
  Badge,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
  Section,
  SectionHeader,
  Stat,
  StatStrip,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui";
import type { api } from "@/convex/_generated/api";
import { formatET } from "@/lib/time";

/**
 * The league cost dashboard (PRD 5.9).
 *
 * Three live subscriptions: the league rollups, the model benchmark, and — when
 * the viewer owns a team here — that team's dashboard. Everything is read off
 * the rollup tables, so nothing here is recomputed per request.
 *
 * The page is a ledger, so it is laid out as one: a KPI strip over the totals,
 * then sections separated by a rule rather than by boxes, with the tables
 * spanning their section and every numeric column right-aligned.
 */
export function CostDashboard({
  leagueId,
  weekNo,
  usdCap,
  myTeamId,
  preloadedLeague,
  preloadedBenchmark,
  preloadedTeam,
}: {
  leagueId: string;
  weekNo: number;
  usdCap: number | null;
  myTeamId: string | null;
  preloadedLeague: Preloaded<typeof api.ledger.leagueDashboard>;
  preloadedBenchmark: Preloaded<typeof api.ledger.benchmark>;
  preloadedTeam: Preloaded<typeof api.ledger.teamDashboard> | null;
}) {
  const dashboard = usePreloadedQuery(preloadedLeague);
  const benchmark = usePreloadedQuery(preloadedBenchmark);

  const totals = dashboard.totals;
  const myTeamName =
    dashboard.byTeam.find((row) => row.teamId === myTeamId)?.teamName ?? null;
  const overCap = usdCap !== null && totals.usd >= usdCap;

  return (
    <div className="space-y-10">
      <PageHeader
        eyebrow="Ledger"
        title="Cost"
        description="Every model step writes a usage row. These are rollups over that ledger — nothing here is estimated."
        actions={<Badge variant="outline">Week {weekNo}</Badge>}
      />

      <StatStrip>
        <Stat
          label="Season spend"
          value={formatUsd(totals.usd)}
          detail={
            usdCap === null ? (
              "no hard cap set"
            ) : overCap ? (
              <span className="text-destructive">
                over the {formatUsd(usdCap)} hard cap
              </span>
            ) : (
              `${formatPct(totals.usd / usdCap)} of a ${formatUsd(usdCap)} hard cap`
            )
          }
        />
        <Stat
          label="Tokens"
          value={formatTokens(totals.tokens)}
          detail="input + output"
        />
        <Stat
          label="Runs"
          value={totals.runCount.toLocaleString()}
          detail={`${totals.stepCount.toLocaleString()} steps`}
        />
        <Stat
          label="Avg / run"
          value={formatUsd(
            totals.runCount > 0 ? totals.usd / totals.runCount : 0,
          )}
          detail="across every window type"
        />
      </StatStrip>

      {preloadedTeam && myTeamId ? (
        <MyTeamCard
          leagueId={leagueId}
          teamId={myTeamId}
          teamName={myTeamName}
          weekNo={weekNo}
          preloaded={preloadedTeam}
        />
      ) : null}

      <div className="grid gap-10 lg:grid-cols-2">
        <Section>
          <SectionHeader
            title="Spend by team"
            description="Season to date. Bars are proportional to the biggest spender, not to the cap."
          />
          <BarChart
            data={dashboard.byTeam.map((row) => ({
              key: row.teamId,
              label: row.teamName,
              value: row.usd,
              display: formatUsd(row.usd),
              hint: `${row.teamName}: ${formatUsd(row.usd)} across ${row.runCount} runs`,
              emphasis: row.teamId === myTeamId,
            }))}
          />
        </Section>

        <Section>
          <SectionHeader
            title="Spend by model"
            description="Where the money actually goes."
          />
          <BarChart
            data={dashboard.byModel.map((row) => ({
              key: row.modelId,
              label: row.displayName,
              value: row.usd,
              display: formatUsd(row.usd),
              hint: `${row.modelId}: ${formatUsd(row.usd)}, ${formatTokens(row.tokens)} tokens`,
            }))}
            emptyLabel="No model has been billed yet."
          />
        </Section>
      </div>

      <Section>
        <SectionHeader
          title="Cost trend by week"
          description="League-wide spend per week, attributed by the run's window."
        />
        <LineChart
          points={dashboard.trend.map((t) => ({
            x: t.weekNo,
            y: t.usd,
            label: `W${t.weekNo}`,
            hint: `Week ${t.weekNo}: ${formatUsd(t.usd)} over ${t.runCount} runs`,
          }))}
          formatY={formatUsd}
        />
      </Section>

      <Section>
        <SectionHeader
          title="Most expensive runs"
          description="The runs worth reading. Every one links to its full trace."
        />
        {dashboard.expensive.length === 0 ? (
          <EmptyState title="No runs yet" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Team</TableHead>
                <TableHead>Window</TableHead>
                <TableHead numeric>Wk</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Status</TableHead>
                <TableHead numeric>Steps</TableHead>
                <TableHead numeric>Cost</TableHead>
                <TableHead>When</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {dashboard.expensive.map((run) => (
                <TableRow key={run.runId}>
                  <TableCell>{run.teamName ?? "commissioner"}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {run.windowLabel}
                  </TableCell>
                  <TableCell numeric className="font-mono text-xs">
                    {run.weekNo ?? "—"}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {run.modelId}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        run.status === "succeeded" ? "success" : "warning"
                      }
                    >
                      {run.status}
                    </Badge>
                  </TableCell>
                  <TableCell numeric className="font-mono text-xs">
                    {run.stepCount}
                  </TableCell>
                  <TableCell numeric className="font-mono text-xs">
                    {formatUsd(run.costUsd)}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {formatET(run.createdAt, "MMM d HH:mm")}
                  </TableCell>
                  <TableCell>
                    <TraceLink
                      href={`/leagues/${leagueId}/traces/${run.runId}`}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      <Section>
        <SectionHeader
          title="Benchmark · points per dollar"
          description="Cost-adjusted performance by model. One league is a tiny sample — read the team count."
        />
        {benchmark.length === 0 ? (
          <EmptyState title="No models attributed yet" />
        ) : (
          <div className="space-y-8">
            {/* A second series, so it wears the informational token rather than lime:
                this plots points per dollar, not the dollars themselves. */}
            <BarChart
              tone="blue"
              data={benchmark
                .filter((row) => row.pointsPerUsd !== null)
                .map((row) => ({
                  key: row.modelId,
                  label: row.displayName,
                  value: row.pointsPerUsd ?? 0,
                  display: `${(row.pointsPerUsd ?? 0).toFixed(1)} pts/$`,
                  hint: `${row.modelId}: ${(row.pointsPerUsd ?? 0).toFixed(1)} points per dollar over ${row.teamCount} team${row.teamCount === 1 ? "" : "s"}`,
                }))}
              emptyLabel="No model has scored against its spend yet."
            />

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Model</TableHead>
                  <TableHead numeric>Teams</TableHead>
                  <TableHead numeric>Spend</TableHead>
                  <TableHead numeric>Points</TableHead>
                  <TableHead numeric>Wins</TableHead>
                  <TableHead numeric>Pts / $</TableHead>
                  <TableHead numeric>$ / point</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {benchmark.map((row) => (
                  <TableRow key={row.modelId}>
                    <TableCell>
                      {row.displayName}
                      <span className="ml-2 font-mono text-[10px] text-ink-faint">
                        {row.provider}
                      </span>
                    </TableCell>
                    <TableCell numeric className="font-mono text-xs">
                      {row.teamCount}
                    </TableCell>
                    <TableCell numeric className="font-mono text-xs">
                      {formatUsd(row.usd)}
                    </TableCell>
                    <TableCell numeric className="font-mono text-xs">
                      {row.points.toFixed(1)}
                    </TableCell>
                    <TableCell numeric className="font-mono text-xs">
                      {row.wins}
                    </TableCell>
                    <TableCell numeric className="font-mono text-xs">
                      {row.pointsPerUsd === null
                        ? "—"
                        : row.pointsPerUsd.toFixed(1)}
                    </TableCell>
                    <TableCell numeric className="font-mono text-xs">
                      {row.costPerPoint === null
                        ? "—"
                        : formatUsd(row.costPerPoint)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <p className="text-sm text-muted-foreground">
              A team is credited to the model on its current config version;
              spend comes from the team-week rollups and the record from the
              standings rollup.
            </p>
          </div>
        )}
      </Section>
    </div>
  );
}

function TraceLink({
  href,
  children = "Trace",
}: {
  href: string;
  children?: ReactNode;
}) {
  return (
    <Link
      href={href}
      className="font-mono text-xs text-muted-foreground underline decoration-border underline-offset-4 transition-colors hover:text-brand hover:decoration-brand"
    >
      {children}
    </Link>
  );
}

/** The viewer's own team: this week against its caps, plus season efficiency. */
function MyTeamCard({
  leagueId,
  teamId,
  teamName,
  weekNo,
  preloaded,
}: {
  leagueId: string;
  teamId: string;
  teamName: string | null;
  weekNo: number;
  preloaded: Preloaded<typeof api.ledger.teamDashboard>;
}) {
  const mine = usePreloadedQuery(preloaded);

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>My team{teamName ? ` · ${teamName}` : ""}</CardTitle>
        <CardDescription>
          Week {weekNo} against your caps, and season efficiency.
        </CardDescription>
        <CardAction>
          <TraceLink href={`/leagues/${leagueId}/teams/${teamId}`}>
            Team page →
          </TraceLink>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-8 md:grid-cols-2">
        <dl className="space-y-2">
          <TeamFigure label="This week" value={formatUsd(mine.week.usd)} />
          <TeamFigure
            label="Season to date"
            value={formatUsd(mine.season.usd)}
          />
          <TeamFigure
            label="Cost per point"
            value={
              mine.costPerPoint.costPerPoint === null
                ? "—"
                : formatUsd(mine.costPerPoint.costPerPoint)
            }
          />
          <TeamFigure
            label="Cost per win"
            value={
              mine.costPerWin.costPerWin === null
                ? "—"
                : formatUsd(mine.costPerWin.costPerWin)
            }
          />
          <TeamFigure
            label="Record"
            value={`${mine.costPerWin.wins}-${mine.costPerWin.losses}-${mine.costPerWin.ties}`}
          />
          <TeamFigure
            label={`Week ${weekNo} runs`}
            value={mine.week.runCount.toLocaleString()}
          />
        </dl>
        <div className="space-y-5">
          <CapMeter
            label={`Week ${weekNo} spend cap`}
            used={mine.budget.teamWeekUsd}
            cap={mine.budget.ownKey ? null : mine.budget.teamUsdCap}
            format={formatUsd}
          />
          {mine.budget.ownKey ? (
            <p className="-mt-3 text-xs text-muted-foreground">
              Running on the owner&apos;s own gateway key: caps bypassed, spend
              still metered.
            </p>
          ) : null}
          <CapMeter
            label={`Week ${weekNo} tokens`}
            used={mine.budget.tokensUsed}
            cap={mine.budget.tokenCap}
            format={(v) => v.toLocaleString()}
          />
          <CapMeter
            label="League USD hard cap"
            used={mine.budget.leagueUsdUsed}
            cap={mine.budget.leagueUsdCap}
            format={formatUsd}
          />
          <p className="text-sm text-muted-foreground">
            The weekly token cap is a safety mechanism, not a game mechanic (PRD
            open question 2). Unused budget does not roll over.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function TeamFigure({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border pb-2 last:border-0">
      <dt className="eyebrow">{label}</dt>
      <dd className="font-mono text-sm tabular-nums text-foreground">
        {value}
      </dd>
    </div>
  );
}
