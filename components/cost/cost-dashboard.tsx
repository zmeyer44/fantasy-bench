"use client";

import Link from "next/link";
import { usePreloadedQuery, type Preloaded } from "convex/react";

import { BarChart, CapMeter, LineChart, StatTile } from "@/components/cost/charts";
import { formatPct, formatTokens, formatUsd } from "@/components/cost/format";
import {
  Badge,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  EmptyState,
  PageHeader,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from "@/components/ui";
import type { api } from "@/convex/_generated/api";
import { formatET } from "@/lib/time";

/**
 * The league cost dashboard (PRD 5.9).
 *
 * Three live subscriptions: the league rollups, the model benchmark, and — when
 * the viewer owns a team here — that team's dashboard. Everything is read off
 * the rollup tables, so nothing here is recomputed per request.
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
  const myTeamName = dashboard.byTeam.find((row) => row.teamId === myTeamId)?.teamName ?? null;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Ledger"
        title="Cost"
        description="Every model step writes a usage row. These are rollups over that ledger — nothing here is estimated."
        actions={<Badge tone="outline">week {weekNo}</Badge>}
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Season spend"
          value={formatUsd(totals.usd)}
          hint={usdCap !== null ? `of a ${formatUsd(usdCap)} hard cap` : "no hard cap set"}
          tone={usdCap !== null && totals.usd >= usdCap ? "danger" : "default"}
        />
        <StatTile label="Tokens" value={formatTokens(totals.tokens)} hint="input + output" />
        <StatTile
          label="Runs"
          value={totals.runCount.toLocaleString()}
          hint={`${totals.stepCount.toLocaleString()} steps`}
        />
        <StatTile
          label="Avg / run"
          value={formatUsd(totals.runCount > 0 ? totals.usd / totals.runCount : 0)}
          hint="across every window type"
        />
      </div>

      {preloadedTeam && myTeamId ? (
        <MyTeamCard
          leagueId={leagueId}
          teamId={myTeamId}
          teamName={myTeamName}
          weekNo={weekNo}
          preloaded={preloadedTeam}
        />
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Spend by team" description="Season to date." />
          <CardBody>
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
          </CardBody>
          <CardFooter>Bars are proportional to the biggest spender, not to the cap.</CardFooter>
        </Card>

        <Card>
          <CardHeader title="Spend by model" description="Where the money actually goes." />
          <CardBody>
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
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Cost trend by week"
          description="League-wide spend per week, attributed by the run's window."
        />
        <CardBody>
          <LineChart
            points={dashboard.trend.map((t) => ({
              x: t.weekNo,
              y: t.usd,
              label: `W${t.weekNo}`,
              hint: `Week ${t.weekNo}: ${formatUsd(t.usd)} over ${t.runCount} runs`,
            }))}
            formatY={formatUsd}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Most expensive runs"
          description="The runs worth reading. Every one links to its full trace."
        />
        {dashboard.expensive.length === 0 ? (
          <CardBody>
            <EmptyState title="No runs yet" />
          </CardBody>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Team</TH>
                <TH>Window</TH>
                <TH numeric>Wk</TH>
                <TH>Model</TH>
                <TH>Status</TH>
                <TH numeric>Steps</TH>
                <TH numeric>Cost</TH>
                <TH>When</TH>
                <TH />
              </TR>
            </THead>
            <TBody>
              {dashboard.expensive.map((run) => (
                <TR key={run.runId}>
                  <TD className="text-sm">{run.teamName ?? "commissioner"}</TD>
                  <TD className="font-mono text-xs">{run.windowLabel}</TD>
                  <TD numeric className="font-mono text-xs">
                    {run.weekNo ?? "—"}
                  </TD>
                  <TD className="font-mono text-xs text-ink-muted">{run.modelId}</TD>
                  <TD>
                    <Badge tone={run.status === "succeeded" ? "accent" : "warning"}>
                      {run.status}
                    </Badge>
                  </TD>
                  <TD numeric className="font-mono text-xs">
                    {run.stepCount}
                  </TD>
                  <TD numeric className="font-mono text-xs">
                    {formatUsd(run.costUsd)}
                  </TD>
                  <TD className="whitespace-nowrap font-mono text-xs text-ink-faint">
                    {formatET(run.createdAt, "MMM d HH:mm")}
                  </TD>
                  <TD>
                    <Link
                      href={`/leagues/${leagueId}/traces/${run.runId}`}
                      className="text-xs text-accent-strong underline underline-offset-2"
                    >
                      Trace
                    </Link>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Benchmark · points per dollar"
          description="Cost-adjusted performance by model. One league is a tiny sample — read the team count."
        />
        {benchmark.length === 0 ? (
          <CardBody>
            <EmptyState title="No models attributed yet" />
          </CardBody>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Model</TH>
                <TH numeric>Teams</TH>
                <TH numeric>Spend</TH>
                <TH numeric>Points</TH>
                <TH numeric>Wins</TH>
                <TH numeric>Pts / $</TH>
                <TH numeric>$ / point</TH>
              </TR>
            </THead>
            <TBody>
              {benchmark.map((row) => (
                <TR key={row.modelId}>
                  <TD className="text-sm">
                    {row.displayName}
                    <span className="ml-2 font-mono text-[10px] text-ink-faint">{row.provider}</span>
                  </TD>
                  <TD numeric className="font-mono text-xs">
                    {row.teamCount}
                  </TD>
                  <TD numeric className="font-mono text-xs">
                    {formatUsd(row.usd)}
                  </TD>
                  <TD numeric className="font-mono text-xs">
                    {row.points.toFixed(1)}
                  </TD>
                  <TD numeric className="font-mono text-xs">
                    {row.wins}
                  </TD>
                  <TD numeric className="font-mono text-xs">
                    {row.pointsPerUsd === null ? "—" : row.pointsPerUsd.toFixed(1)}
                  </TD>
                  <TD numeric className="font-mono text-xs">
                    {row.costPerPoint === null ? "—" : formatUsd(row.costPerPoint)}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
        <CardFooter>
          A team is credited to the model on its current config version; spend comes from the
          team-week rollups and the record from the standings rollup.
          {usdCap !== null ? (
            <>
              {" "}
              League hard cap {formatUsd(usdCap)} — {formatPct(totals.usd / usdCap)} used.
            </>
          ) : null}
        </CardFooter>
      </Card>
    </div>
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
      <CardHeader
        title={`My team${teamName ? ` · ${teamName}` : ""}`}
        description={`Week ${weekNo} against your caps, and season efficiency.`}
        action={
          <Link
            href={`/leagues/${leagueId}/teams/${teamId}/film-room`}
            className="text-xs text-accent-strong underline underline-offset-2"
          >
            Film room →
          </Link>
        }
      />
      <CardBody className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-3">
          <StatTile
            label="This week"
            value={formatUsd(mine.week.usd)}
            hint={`${mine.week.runCount} runs`}
          />
          <StatTile label="Season total" value={formatUsd(mine.season.usd)} />
        </div>
        <div className="space-y-3">
          <StatTile
            label="Cost per point"
            value={mine.costPerPoint.costPerPoint === null ? "—" : formatUsd(mine.costPerPoint.costPerPoint)}
            hint={`${mine.costPerPoint.points.toFixed(1)} points scored`}
          />
          <StatTile
            label="Cost per win"
            value={mine.costPerWin.costPerWin === null ? "—" : formatUsd(mine.costPerWin.costPerWin)}
            hint={`${mine.costPerWin.wins}-${mine.costPerWin.losses}-${mine.costPerWin.ties}`}
          />
        </div>
        <div className="space-y-4 md:col-span-2">
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
          <p className="text-xs text-ink-muted">
            The weekly token cap is a safety mechanism, not a game mechanic (PRD open question 2).
            Unused budget does not roll over.
          </p>
        </div>
      </CardBody>
    </Card>
  );
}
