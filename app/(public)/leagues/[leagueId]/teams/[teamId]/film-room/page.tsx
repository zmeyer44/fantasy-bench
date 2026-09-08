import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ConfigNav } from "@/components/config/config-nav";
import { formatUsd } from "@/components/cost/format";
import { CounterfactualPanel } from "@/components/film-room/counterfactual";
import { LineupCompare } from "@/components/film-room/lineup-compare";
import { NoteToAgentBox } from "@/components/film-room/note-box";
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
  cn,
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

const RUN_TONE: Record<string, "accent" | "warning" | "danger" | "outline"> = {
  succeeded: "accent",
  partial: "warning",
  fallback: "warning",
  failed: "danger",
  timed_out: "danger",
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
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href={base} className="hover:text-ink">
            {data.team.name}
          </Link>
        }
        title={`Film room · week ${data.weekNo}`}
        description="What your agent did last week, how well it did it, and what it cost."
        actions={
          data.result ? (
            <Badge tone={data.result.won ? "accent" : data.result.lost ? "danger" : "outline"}>
              {data.result.pointsFor.toFixed(1)} – {data.result.pointsAgainst.toFixed(1)}
            </Badge>
          ) : (
            <Badge tone="outline">not scored</Badge>
          )
        }
      />

      <ConfigNav leagueId={leagueId} teamId={teamId} />

      {weekOptions.length > 1 ? (
        <div className="flex flex-wrap items-center gap-1">
          <span className="eyebrow mr-2">Week</span>
          {weekOptions.map((week) => (
            <Link
              key={week}
              href={`${base}/film-room?week=${week}`}
              className={cn(
                "rounded border px-2 py-0.5 font-mono text-xs",
                week === data.weekNo
                  ? "border-accent bg-accent-soft text-accent-strong"
                  : "border-line text-ink-muted hover:text-ink",
              )}
            >
              {week}
            </Link>
          ))}
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader
              title="Runs"
              description={`${data.runs.length} run${data.runs.length === 1 ? "" : "s"} in week ${data.weekNo}.`}
            />
            {data.runs.length === 0 ? (
              <CardBody>
                <EmptyState
                  title="No runs this week"
                  description="Runs appear here once the scheduler opens a window for this team."
                />
              </CardBody>
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Window</TH>
                    <TH>Opened</TH>
                    <TH>Status</TH>
                    <TH>Outcome</TH>
                    <TH numeric>Steps</TH>
                    <TH numeric>Cost</TH>
                    <TH />
                  </TR>
                </THead>
                <TBody>
                  {data.runs.map((run) => (
                    <TR key={run.runId}>
                      <TD className="font-mono text-xs">{run.windowLabel}</TD>
                      <TD className="whitespace-nowrap font-mono text-xs text-ink-muted">
                        {formatET(run.opensAt, "EEE HH:mm")} ET
                      </TD>
                      <TD>
                        <Badge tone={RUN_TONE[run.status] ?? "outline"}>{run.status}</Badge>
                        {run.fallback ? (
                          <Badge tone="warning" className="ml-1">
                            {run.fallback}
                          </Badge>
                        ) : null}
                      </TD>
                      <TD className="text-xs text-ink-muted">{run.outcome ?? "—"}</TD>
                      <TD numeric className="font-mono text-xs">
                        {run.stepCount}
                      </TD>
                      <TD numeric className="font-mono text-xs">
                        {formatUsd(run.costUsd)}
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
              title="Lineup efficiency"
              description={
                data.efficiency
                  ? `Snapshot taken ${formatET(data.efficiency.snapshotTakenAt, "EEE MMM d, HH:mm")} ET.`
                  : undefined
              }
              action={
                data.efficiency ? (
                  <Badge tone={data.efficiency.efficiency >= 0.95 ? "accent" : "warning"}>
                    {(data.efficiency.efficiency * 100).toFixed(1)}%
                  </Badge>
                ) : null
              }
            />
            {data.efficiency ? (
              <>
                <CardBody className="p-0">
                  <LineupCompare efficiency={data.efficiency} />
                </CardBody>
                <CardFooter>
                  {data.efficiency.pointsLeftOnBench.toFixed(2)} points left on the bench.
                </CardFooter>
              </>
            ) : (
              <CardBody>
                <p className="text-sm text-ink-muted">
                  n/a — {data.efficiencyUnavailableReason ?? "no snapshot for this week."}
                </p>
              </CardBody>
            )}
          </Card>

          <div className="grid gap-6 md:grid-cols-2">
            <Card>
              <CardHeader title="Waivers" description={`Week ${data.weekNo} claims.`} />
              {data.waivers.length === 0 ? (
                <CardBody>
                  <p className="text-sm text-ink-muted">No claims submitted.</p>
                </CardBody>
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>Add</TH>
                      <TH>Drop</TH>
                      <TH numeric>Bid</TH>
                      <TH>Result</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {data.waivers.map((claim) => (
                      <TR key={claim.id}>
                        <TD className="text-sm">{claim.addPlayerName ?? "—"}</TD>
                        <TD className="text-xs text-ink-muted">{claim.dropPlayerName ?? "—"}</TD>
                        <TD numeric className="font-mono text-xs">
                          ${claim.bid}
                        </TD>
                        <TD>
                          <Badge
                            tone={
                              claim.status === "won"
                                ? "accent"
                                : claim.status === "lost"
                                  ? "outline"
                                  : claim.status === "invalid"
                                    ? "danger"
                                    : "neutral"
                            }
                          >
                            {claim.status}
                          </Badge>
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </Card>

            <Card>
              <CardHeader title="Trades" description="Most recent, either direction." />
              {data.trades.length === 0 ? (
                <CardBody>
                  <p className="text-sm text-ink-muted">No trades involving this team.</p>
                </CardBody>
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>With</TH>
                      <TH>Dir</TH>
                      <TH>Status</TH>
                      <TH numeric>Fairness</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {data.trades.map((trade) => (
                      <TR key={trade.id}>
                        <TD className="text-sm">{trade.counterpartyName ?? "—"}</TD>
                        <TD className="font-mono text-[10px] uppercase text-ink-faint">
                          {trade.proposedByMe ? "sent" : "recv"}
                        </TD>
                        <TD>
                          <Badge tone={trade.flagged ? "danger" : "outline"}>{trade.status}</Badge>
                        </TD>
                        <TD numeric className="font-mono text-xs">
                          {trade.fairnessScore?.toFixed(2) ?? "—"}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </Card>
          </div>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Spend" description={`Week ${data.weekNo} vs budget.`} />
            <CardBody className="space-y-3">
              <Stat label="This week" value={formatUsd(data.spend.usd)} />
              <Stat label="Season to date" value={formatUsd(data.seasonSpend)} />
              <Stat label="Runs" value={String(data.spend.runCount)} />
              <Stat label="Steps" value={String(data.spend.stepCount)} />
              <div className="border-t border-line pt-3">
                <Meter
                  label="Weekly token cap"
                  used={data.budget.tokensUsed}
                  cap={data.budget.tokenCap}
                  format={(v) => v.toLocaleString()}
                />
                <div className="h-3" />
                <Meter
                  label="League USD hard cap"
                  used={data.budget.leagueUsdUsed}
                  cap={data.budget.leagueUsdCap}
                  format={formatUsd}
                />
              </div>
            </CardBody>
            <CardFooter>
              <Link
                href={`/leagues/${leagueId}/cost`}
                className="text-accent-strong underline underline-offset-2"
              >
                League cost dashboard →
              </Link>
            </CardFooter>
          </Card>

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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-xs uppercase tracking-wide text-ink-faint">{label}</span>
      <span className="font-mono text-sm tabular-nums text-ink">{value}</span>
    </div>
  );
}

function Meter({
  label,
  used,
  cap,
  format,
}: {
  label: string;
  used: number;
  cap: number | null;
  format: (value: number) => string;
}) {
  const pct = cap && cap > 0 ? Math.min(1, used / cap) : null;
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between">
        <span className="text-xs uppercase tracking-wide text-ink-faint">{label}</span>
        <span className="font-mono text-xs tabular-nums text-ink">
          {format(used)}
          {cap !== null ? ` / ${format(cap)}` : ""}
        </span>
      </div>
      {pct === null ? (
        <p className="text-xs text-ink-faint">No cap set.</p>
      ) : (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-muted">
          <div
            className={cn(
              "h-full rounded-full",
              pct >= 1 ? "bg-danger" : pct > 0.8 ? "bg-warning" : "bg-accent",
            )}
            style={{ width: `${Math.max(2, pct * 100)}%` }}
          />
        </div>
      )}
    </div>
  );
}
