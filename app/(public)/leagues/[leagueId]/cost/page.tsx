import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";

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
import { getSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { teams } from "@/lib/db/schema";
import { getLeagueById } from "@/lib/services/league";
import {
  benchmarkByModel,
  budgetStatus,
  costPerPoint,
  costPerWin,
  costTrendByWeek,
  leagueSpendByModel,
  leagueSpendByTeam,
  leagueSpendTotals,
  mostExpensiveRuns,
  teamSeasonSpend,
  teamWeekSpend,
} from "@/lib/services/cost";
import { currentLeagueWeek } from "@/lib/services/cost/film-room";
import { formatET } from "@/lib/time";

export const metadata: Metadata = { title: "Cost" };

/** The league cost dashboard (PRD 5.9). Public — spend is part of the transparency contract. */
export default async function CostPage({ params }: PageProps<"/leagues/[leagueId]/cost">) {
  const { leagueId } = await params;

  const league = await getLeagueById(leagueId);
  if (!league) notFound();

  const weekNo = await currentLeagueWeek(leagueId);

  const [totals, byTeam, byModel, expensive, trend, benchmark] = await Promise.all([
    leagueSpendTotals(leagueId),
    leagueSpendByTeam(leagueId),
    leagueSpendByModel(leagueId),
    mostExpensiveRuns(leagueId, 10),
    costTrendByWeek(leagueId),
    benchmarkByModel(leagueId),
  ]);

  const session = await getSession();
  const myTeam = session
    ? ((
        await db
          .select({ id: teams.id, name: teams.name })
          .from(teams)
          .where(and(eq(teams.leagueId, leagueId), eq(teams.ownerUserId, session.user.id)))
          .limit(1)
      )[0] ?? null)
    : null;

  const mine = myTeam
    ? await Promise.all([
        teamWeekSpend(myTeam.id, weekNo),
        teamSeasonSpend(myTeam.id),
        costPerPoint(myTeam.id),
        costPerWin(myTeam.id),
        budgetStatus(myTeam.id, weekNo),
      ])
    : null;

  const usdCap = league.rules?.leagueUsdHardCap ?? null;

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
        <StatTile label="Runs" value={totals.runCount.toLocaleString()} hint={`${totals.stepCount.toLocaleString()} steps`} />
        <StatTile
          label="Avg / run"
          value={formatUsd(totals.runCount > 0 ? totals.usd / totals.runCount : 0)}
          hint="across every window type"
        />
      </div>

      {myTeam && mine ? (
        <Card>
          <CardHeader
            title={`My team · ${myTeam.name}`}
            description={`Week ${weekNo} against your caps, and season efficiency.`}
            action={
              <Link
                href={`/leagues/${leagueId}/teams/${myTeam.id}/film-room`}
                className="text-xs text-accent-strong underline underline-offset-2"
              >
                Film room →
              </Link>
            }
          />
          <CardBody className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-3">
              <StatTile label="This week" value={formatUsd(mine[0].usd)} hint={`${mine[0].runCount} runs`} />
              <StatTile label="Season total" value={formatUsd(mine[1].usd)} />
            </div>
            <div className="space-y-3">
              <StatTile
                label="Cost per point"
                value={mine[2].costPerPoint === null ? "—" : formatUsd(mine[2].costPerPoint)}
                hint={`${mine[2].points.toFixed(1)} points scored`}
              />
              <StatTile
                label="Cost per win"
                value={mine[3].costPerWin === null ? "—" : formatUsd(mine[3].costPerWin)}
                hint={`${mine[3].wins}-${mine[3].losses}-${mine[3].ties}`}
              />
            </div>
            <div className="space-y-4 md:col-span-2">
              <CapMeter
                label={`Week ${weekNo} tokens`}
                used={mine[4].tokensUsed}
                cap={mine[4].tokenCap}
                format={(v) => v.toLocaleString()}
              />
              <CapMeter
                label="League USD hard cap"
                used={mine[4].leagueUsdUsed}
                cap={mine[4].leagueUsdCap}
                format={formatUsd}
              />
              <p className="text-xs text-ink-muted">
                The weekly token cap is a safety mechanism, not a game mechanic (PRD open question
                2). Unused budget does not roll over.
              </p>
            </div>
          </CardBody>
        </Card>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Spend by team" description="Season to date." />
          <CardBody>
            <BarChart
              data={byTeam.map((row) => ({
                key: row.teamId,
                label: row.teamName,
                value: row.usd,
                display: formatUsd(row.usd),
                hint: `${row.teamName}: ${formatUsd(row.usd)} across ${row.runCount} runs`,
                emphasis: row.teamId === myTeam?.id,
              }))}
            />
          </CardBody>
          <CardFooter>Bars are proportional to the biggest spender, not to the cap.</CardFooter>
        </Card>

        <Card>
          <CardHeader title="Spend by model" description="Where the money actually goes." />
          <CardBody>
            <BarChart
              data={byModel.map((row) => ({
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
            points={trend.map((t) => ({
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
        {expensive.length === 0 ? (
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
              {expensive.map((run) => (
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
                    <span className="ml-2 font-mono text-[10px] text-ink-faint">
                      {row.provider}
                    </span>
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
          A team is credited to the model it ran most this season; teams that have not run yet are
          credited to their current config&apos;s model.
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
