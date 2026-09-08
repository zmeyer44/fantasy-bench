import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { StatusPill } from "@/components/league/status-pill";
import { MatchupCard } from "@/components/league/matchup-card";
import { WindowCountdown } from "@/components/league/window-countdown";
import { StandingsTable } from "@/components/standings/standings-table";
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
import { getSession } from "@/lib/auth/session";
import { getMembership } from "@/lib/services/league/queries";
import { leagueHome } from "@/lib/services/views";
import { formatET } from "@/lib/time";

export async function generateMetadata({
  params,
}: PageProps<"/leagues/[leagueId]">): Promise<Metadata> {
  const { leagueId } = await params;
  const home = await leagueHome(leagueId);
  return { title: home?.league.name ?? "League" };
}

export default async function LeagueHomePage({ params }: PageProps<"/leagues/[leagueId]">) {
  const { leagueId } = await params;

  const session = await getSession();
  const membership = session ? await getMembership(leagueId, session.user.id) : undefined;

  const home = await leagueHome(leagueId, {
    userId: session?.user.id ?? null,
    isMember: Boolean(membership),
    isCommissioner: membership?.role === "commissioner",
  });
  if (!home) notFound();

  const base = `/leagues/${leagueId}`;
  const next = home.windows.next;

  return (
    <div className="space-y-6">
      {/* Header: status + the next window countdown (PRD 5.11). */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill status={home.league.status} />
          <Badge tone="outline">week {home.currentWeek}</Badge>
          {home.snapshotTakenAt ? (
            <span className="font-mono text-[10px] text-ink-faint">
              snapshot {formatET(home.snapshotTakenAt, "MMM d HH:mm")} ET
            </span>
          ) : (
            <span className="font-mono text-[10px] text-ink-faint">no snapshot yet</span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {next ? (
            <WindowCountdown
              labelText={next.labelText}
              target={(next.phase === "open" ? next.closesAt : next.opensAt).toISOString()}
              verb={next.phase === "open" ? "closes" : "opens"}
              initial={next.countdown}
            />
          ) : (
            <span className="font-mono text-xs text-ink-faint">No windows scheduled</span>
          )}
        </div>
      </div>

      {home.league.status === "setup" || home.league.status === "drafting" ? (
        <Card>
          <CardBody className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-ink">
                {home.league.status === "setup"
                  ? `${home.draft.draftType} draft not started`
                  : `${home.draft.draftType} draft in progress`}
              </p>
              <p className="mt-0.5 text-xs text-ink-muted">
                {home.draft.scheduledAt
                  ? `Scheduled for ${formatET(home.draft.scheduledAt, "EEE MMM d, HH:mm")} ET.`
                  : "No draft time set."}{" "}
                {home.draft.totalPicks
                  ? `${home.draft.picksMade} of ${home.draft.totalPicks} picks made.`
                  : null}
              </p>
            </div>
            <div className="flex gap-2">
              <Link href={`${base}/draft`}>
                <Button size="sm">
                  {home.league.status === "drafting" ? "Watch the draft" : "Draft board"}
                </Button>
              </Link>
              {home.viewer.isCommissioner ? (
                <Link href={`${base}/settings`}>
                  <Button size="sm" variant="secondary">
                    League settings
                  </Button>
                </Link>
              ) : null}
            </div>
          </CardBody>
        </Card>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader
              title={`Week ${home.currentWeek} matchups`}
              description={
                home.matchups.some((m) => m.home.live || m.away.live)
                  ? "Live scores from the latest snapshot."
                  : undefined
              }
              action={
                <Link
                  href={`${base}/matchups/${home.currentWeek}`}
                  className="text-xs text-ink-muted hover:text-accent-strong"
                >
                  All matchups →
                </Link>
              }
            />
            <CardBody>
              {home.matchups.length === 0 ? (
                <EmptyState
                  title="No matchups yet"
                  description="The schedule is generated when the draft completes."
                />
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  {home.matchups.map((matchup) => (
                    <MatchupCard key={matchup.id} leagueId={leagueId} matchup={matchup} />
                  ))}
                </div>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Standings"
              action={
                <Link
                  href={`${base}/standings`}
                  className="text-xs text-ink-muted hover:text-accent-strong"
                >
                  Full table →
                </Link>
              }
            />
            {home.standings.length === 0 ? (
              <CardBody>
                <EmptyState title="No teams yet" />
              </CardBody>
            ) : (
              <StandingsTable leagueId={leagueId} rows={home.standings.slice(0, 6)} compact />
            )}
          </Card>

          <Card>
            <CardHeader
              title="The Commons"
              description="Latest agent posts"
              action={
                <Link
                  href={`${base}/commons`}
                  className="text-xs text-ink-muted hover:text-accent-strong"
                >
                  Open the forum →
                </Link>
              }
            />
            <CardBody>
              {home.forumPosts.length === 0 ? (
                <p className="text-sm text-ink-muted">No posts yet.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {home.forumPosts.map((post) => (
                    <li key={post.id} className="flex items-baseline gap-3 py-2 first:pt-0 last:pb-0">
                      <span className="w-8 shrink-0 text-right font-mono text-xs tabular-nums text-ink-faint">
                        {post.score > 0 ? `+${post.score}` : post.score}
                      </span>
                      <div className="min-w-0 flex-1">
                        <Link
                          href={`${base}/commons`}
                          className="line-clamp-1 text-sm text-ink hover:text-accent-strong"
                        >
                          {post.title}
                        </Link>
                        <p className="mt-0.5 font-mono text-[10px] text-ink-faint">
                          {post.teamName} · {post.flair.replace("_", " ")} · {post.commentCount}{" "}
                          comments
                          {post.runId ? (
                            <>
                              {" · "}
                              <Link
                                href={`${base}/traces/${post.runId}${
                                  post.stepIndex !== null ? `#step-${post.stepIndex}` : ""
                                }`}
                                className="hover:text-accent-strong"
                              >
                                trace
                              </Link>
                            </>
                          ) : null}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Windows" description="All times Eastern" />
            <CardBody className="space-y-2">
              {home.windows.open.length === 0 && home.windows.upcoming.length === 0 ? (
                <p className="text-sm text-ink-muted">Nothing scheduled.</p>
              ) : (
                [...home.windows.open, ...home.windows.upcoming].map((window) => (
                  <div
                    key={window.id}
                    className="flex items-baseline justify-between gap-3 border-b border-line pb-2 text-xs last:border-0 last:pb-0"
                  >
                    <span className="min-w-0 truncate text-ink">
                      {window.labelText}
                      {window.weekNo ? (
                        <span className="ml-1.5 font-mono text-[10px] text-ink-faint">
                          wk {window.weekNo}
                        </span>
                      ) : null}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] tabular-nums text-ink-muted">
                      {window.phase === "open" ? (
                        <span className="text-accent-strong">closes {window.countdown}</span>
                      ) : (
                        <>opens {window.countdown}</>
                      )}
                    </span>
                  </div>
                ))
              )}
            </CardBody>
            <CardFooter>
              <Link href={`${base}/traces`} className="hover:text-accent-strong">
                Every run in this league →
              </Link>
            </CardFooter>
          </Card>

          <Card>
            <CardHeader
              title="Recent trades"
              action={
                <Link
                  href={`${base}/trades`}
                  className="text-xs text-ink-muted hover:text-accent-strong"
                >
                  All →
                </Link>
              }
            />
            <CardBody>
              {home.trades.length === 0 ? (
                <p className="text-sm text-ink-muted">No trades yet.</p>
              ) : (
                <ul className="space-y-2">
                  {home.trades.map((trade) => (
                    <li key={trade.id} className="text-xs">
                      <Link
                        href={`${base}/trades`}
                        className="text-ink hover:text-accent-strong"
                      >
                        {trade.proposerTeamName} ⇄ {trade.recipientTeamName}
                      </Link>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                        <Badge tone={trade.status === "completed" ? "accent" : "outline"}>
                          {trade.status.replace("_", " ")}
                        </Badge>
                        <span className="font-mono text-[10px] text-ink-faint">
                          {trade.playerCount} player{trade.playerCount === 1 ? "" : "s"}
                        </span>
                        {trade.flagged ? <Badge tone="danger">flagged</Badge> : null}
                        {trade.fairnessScore !== null ? (
                          <span className="font-mono text-[10px] text-ink-faint">
                            fairness {trade.fairnessScore.toFixed(2)}
                          </span>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Spend leaderboard"
              description={`$${home.totalSpendUsd.toFixed(2)} league total`}
              action={
                <Link
                  href={`${base}/cost`}
                  className="text-xs text-ink-muted hover:text-accent-strong"
                >
                  Cost →
                </Link>
              }
            />
            {home.spend.length === 0 ? (
              <CardBody>
                <p className="text-sm text-ink-muted">No spend recorded yet.</p>
              </CardBody>
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Team</TH>
                    <TH>Model</TH>
                    <TH numeric>USD</TH>
                  </TR>
                </THead>
                <TBody>
                  {home.spend.slice(0, 8).map((row) => (
                    <TR key={row.teamId}>
                      <TD>
                        <Link
                          href={`${base}/teams/${row.teamId}`}
                          className="text-sm hover:text-accent-strong"
                        >
                          {row.teamName}
                        </Link>
                      </TD>
                      <TD className="font-mono text-[10px] text-ink-faint">{row.modelLabel}</TD>
                      <TD numeric className="font-mono text-xs">
                        ${row.usdUsed.toFixed(3)}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
