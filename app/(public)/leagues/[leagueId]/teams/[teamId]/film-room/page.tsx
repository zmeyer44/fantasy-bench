import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ConfigNav } from "@/components/config/config-nav";
import { CapMeter } from "@/components/cost/charts";
import { formatUsd } from "@/components/cost/format";
import { CounterfactualPanel } from "@/components/film-room/counterfactual";
import { LineupCompare } from "@/components/film-room/lineup-compare";
import { NoteToAgentBox } from "@/components/film-room/note-box";
import {
  Badge,
  type BadgeVariant,
  Button,
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
import { readOrNull } from "@/components/league/convex-errors";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { fetchAuthQuery } from "@/lib/convex/server";
import { getViewer } from "@/lib/convex/viewer";
import { formatET } from "@/lib/time";

export const metadata: Metadata = { title: "Film room" };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const RUN_VARIANT: Record<string, BadgeVariant> = {
  succeeded: "success",
  partial: "warning",
  fallback: "warning",
  failed: "destructive",
  timed_out: "destructive",
};

const CLAIM_VARIANT: Record<string, BadgeVariant> = {
  won: "success",
  lost: "outline",
  invalid: "destructive",
};

/** The owner's Tuesday landing page (PRD 5.5). */
export default async function FilmRoomPage({
  params,
  searchParams,
}: PageProps<"/leagues/[leagueId]/teams/[teamId]/film-room">) {
  const { leagueId, teamId } = await params;
  const query = await searchParams;
  const weekParam = Number(first(query.week));

  const [data, currentWeekNo] = await Promise.all([
    readOrNull(() =>
      fetchAuthQuery(api.metrics.filmRoom, {
        teamId: teamId as Id<"teams">,
        weekNo: Number.isFinite(weekParam) && weekParam > 0 ? weekParam : undefined,
      }),
    ),
    readOrNull(() =>
      fetchAuthQuery(api.weeks.currentWeekNo, { leagueId: leagueId as Id<"leagues"> }),
    ),
  ]);
  if (!data || data.leagueId !== leagueId) notFound();

  const viewer = await getViewer();
  const canEdit = viewer !== null && data.team.ownerUserId === viewer.userId;
  const base = `/leagues/${leagueId}/teams/${teamId}`;
  // The picker never offers a week the league has not reached yet.
  const weekOptions = data.availableWeeks.filter(
    (week) => currentWeekNo === null || week <= currentWeekNo,
  );

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={
          <Link href={base} className="transition-colors hover:text-brand-strong">
            {data.team.name}
          </Link>
        }
        title={`Film room · week ${data.weekNo}`}
        description="What your agent did last week, how well it did it, and what it cost."
        actions={
          data.result ? (
            <Badge variant={data.result.won ? "success" : data.result.lost ? "destructive" : "outline"}>
              {data.result.pointsFor.toFixed(1)} – {data.result.pointsAgainst.toFixed(1)}
            </Badge>
          ) : (
            <Badge variant="outline">not scored</Badge>
          )
        }
      />

      <ConfigNav leagueId={leagueId} teamId={teamId} />

      {weekOptions.length > 1 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="eyebrow mr-1">Week</span>
          {weekOptions.map((week) => (
            <Button
              key={week}
              size="xs"
              variant={week === data.weekNo ? "outline-brand" : "outline"}
              className="font-mono"
              render={<Link href={`${base}/film-room?week=${week}`} />}
            >
              {week}
            </Button>
          ))}
        </div>
      ) : null}

      <StatStrip>
        <Stat
          label="Points for"
          value={data.result ? data.result.pointsFor.toFixed(1) : "—"}
          detail={data.result ? `against ${data.result.pointsAgainst.toFixed(1)}` : "not scored yet"}
        />
        <Stat
          label="Lineup efficiency"
          value={data.efficiency ? `${(data.efficiency.efficiency * 100).toFixed(1)}%` : "—"}
          tone={data.efficiency && data.efficiency.efficiency >= 0.95 ? "brand" : "default"}
          detail={
            data.efficiency
              ? `${data.efficiency.pointsLeftOnBench.toFixed(2)} left on the bench`
              : (data.efficiencyUnavailableReason ?? "no snapshot")
          }
        />
        <Stat
          label="Week spend"
          value={formatUsd(data.spend.usd)}
          detail={`${data.spend.runCount} run${data.spend.runCount === 1 ? "" : "s"}, ${data.spend.stepCount} steps`}
        />
        <Stat
          label="Season spend"
          value={formatUsd(data.seasonSpend)}
          detail="every window, all weeks"
        />
      </StatStrip>

      <div className="grid gap-10 lg:grid-cols-3">
        <div className="space-y-10 lg:col-span-2">
          <Section>
            <SectionHeader
              title="Runs"
              description={`${data.runs.length} run${data.runs.length === 1 ? "" : "s"} in week ${data.weekNo}. Every one links to its full trace.`}
            />
            {data.runs.length === 0 ? (
              <EmptyState
                title="No runs this week"
                description="Runs appear here once the scheduler opens a window for this team."
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Window</TableHead>
                    <TableHead>Opened</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Outcome</TableHead>
                    <TableHead numeric>Steps</TableHead>
                    <TableHead numeric>Cost</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.runs.map((run) => (
                    <TableRow key={run.runId}>
                      <TableCell className="font-mono text-xs">{run.windowLabel}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {formatET(run.opensAt, "EEE HH:mm")} ET
                      </TableCell>
                      <TableCell>
                        <span className="flex items-center gap-1">
                          <Badge variant={RUN_VARIANT[run.status] ?? "outline"}>{run.status}</Badge>
                          {run.fallback ? <Badge variant="warning">{run.fallback}</Badge> : null}
                        </span>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{run.outcome ?? "—"}</TableCell>
                      <TableCell numeric className="font-mono text-xs">
                        {run.stepCount}
                      </TableCell>
                      <TableCell numeric className="font-mono text-xs">
                        {formatUsd(run.costUsd)}
                      </TableCell>
                      <TableCell>
                        <QuietLink href={`/leagues/${leagueId}/traces/${run.runId}`}>
                          Trace
                        </QuietLink>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Section>

          <Section>
            <SectionHeader
              title="Lineup efficiency"
              description={
                data.efficiency
                  ? `What the agent started against what it should have started. Snapshot taken ${formatET(data.efficiency.snapshotTakenAt, "EEE MMM d, HH:mm")} ET.`
                  : undefined
              }
              action={
                data.efficiency ? (
                  <Badge variant={data.efficiency.efficiency >= 0.95 ? "success" : "warning"}>
                    {(data.efficiency.efficiency * 100).toFixed(1)}%
                  </Badge>
                ) : null
              }
            />
            {data.efficiency ? (
              <div className="space-y-4">
                <LineupCompare efficiency={data.efficiency} />
                <p className="text-sm text-muted-foreground">
                  {data.efficiency.pointsLeftOnBench.toFixed(2)} points left on the bench.
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                n/a — {data.efficiencyUnavailableReason ?? "no snapshot for this week."}
              </p>
            )}
          </Section>

          <div className="grid gap-10 md:grid-cols-2">
            <Section>
              <SectionHeader title="Waivers" description={`Week ${data.weekNo} claims.`} />
              {data.waivers.length === 0 ? (
                <p className="text-sm text-muted-foreground">No claims submitted.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Add</TableHead>
                      <TableHead>Drop</TableHead>
                      <TableHead numeric>Bid</TableHead>
                      <TableHead>Result</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.waivers.map((claim) => (
                      <TableRow key={claim.id}>
                        <TableCell>{claim.addPlayerName ?? "—"}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {claim.dropPlayerName ?? "—"}
                        </TableCell>
                        <TableCell numeric className="font-mono text-xs">
                          ${claim.bid}
                        </TableCell>
                        <TableCell>
                          <Badge variant={CLAIM_VARIANT[claim.status] ?? "secondary"}>
                            {claim.status}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </Section>

            <Section>
              <SectionHeader title="Trades" description="Most recent, either direction." />
              {data.trades.length === 0 ? (
                <p className="text-sm text-muted-foreground">No trades involving this team.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>With</TableHead>
                      <TableHead>Dir</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead numeric>Fairness</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.trades.map((trade) => (
                      <TableRow key={trade.id}>
                        <TableCell>{trade.counterpartyName ?? "—"}</TableCell>
                        <TableCell className="font-mono text-[10px] tracking-wider text-ink-faint uppercase">
                          {trade.proposedByMe ? "sent" : "recv"}
                        </TableCell>
                        <TableCell>
                          <Badge variant={trade.flagged ? "destructive" : "outline"}>
                            {trade.status}
                          </Badge>
                        </TableCell>
                        <TableCell numeric className="font-mono text-xs">
                          {trade.fairnessScore?.toFixed(2) ?? "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </Section>
          </div>
        </div>

        <div className="space-y-10 lg:border-l lg:border-border lg:pl-8">
          <Section>
            <SectionHeader title="Budget" description={`Week ${data.weekNo} against the caps.`} />
            <div className="space-y-5">
              <CapMeter
                label="Weekly token cap"
                used={data.budget.tokensUsed}
                cap={data.budget.tokenCap}
                format={(v) => v.toLocaleString()}
              />
              <CapMeter
                label="League USD hard cap"
                used={data.budget.leagueUsdUsed}
                cap={data.budget.leagueUsdCap}
                format={formatUsd}
              />
              <QuietLink href={`/leagues/${leagueId}/cost`}>League cost dashboard →</QuietLink>
            </div>
          </Section>

          <CounterfactualPanel
            efficiency={data.efficiency}
            reason={data.efficiencyUnavailableReason}
          />

          <NoteToAgentBox
            leagueId={leagueId}
            teamId={teamId}
            initialNote={data.noteToAgent ?? ""}
            canEdit={canEdit}
          />
        </div>
      </div>
    </div>
  );
}

function QuietLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-block font-mono text-xs text-muted-foreground underline decoration-border underline-offset-4 transition-colors hover:text-brand hover:decoration-brand"
    >
      {children}
    </Link>
  );
}
