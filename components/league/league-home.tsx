"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePreloadedQuery, type Preloaded } from "convex/react";

import { MatchupCard } from "@/components/league/matchup-card";
import { WindowCountdown } from "@/components/league/window-countdown";
import { StandingsTable } from "@/components/standings/standings-table";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  EmptyState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  cn,
} from "@/components/ui";
import type { api } from "@/convex/_generated/api";
import { formatET } from "@/lib/time";

/**
 * The league home page (PRD 5.11).
 *
 * The server preloads `views.home`; this component takes over the subscription
 * so scores, windows, spend and the Commons teaser stay live without a poll.
 * Epoch-ms timestamps are formatted here, at the edge.
 *
 * The page is composed rather than stacked: a ruled status strip, then the
 * week's matchups, then the table, then a narrower rail of league mechanics.
 * Lime appears exactly three times — the countdown, live scores, and the one
 * primary action.
 */
export function LeagueHomeView({
  leagueId,
  preloaded,
}: {
  leagueId: string;
  preloaded: Preloaded<typeof api.views.home>;
}) {
  const home = usePreloadedQuery(preloaded);

  const base = `/leagues/${leagueId}`;
  const next = home.windows.next;
  const pendingDraft = home.league.status === "setup" || home.league.status === "drafting";
  const anyLive = home.matchups.some((m) => m.home.live || m.away.live);

  return (
    <div className="space-y-10">
      {/* Status + the next window countdown (PRD 5.11): a rule, not a card. */}
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-border pb-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">week {home.currentWeek}</Badge>
          <span className="font-mono text-[10px] text-ink-faint">
            {home.snapshotTakenAt
              ? `snapshot ${formatET(home.snapshotTakenAt, "MMM d HH:mm")} ET`
              : "no snapshot yet"}
          </span>
        </div>
        {next ? (
          <WindowCountdown
            labelText={next.labelText}
            target={new Date(next.phase === "open" ? next.closesAt : next.opensAt).toISOString()}
            verb={next.phase === "open" ? "closes" : "opens"}
            initial={next.countdown}
          />
        ) : (
          <span className="font-mono text-xs text-ink-faint">No windows scheduled</span>
        )}
      </div>

      {pendingDraft ? (
        <Alert className="flex flex-wrap items-center justify-between gap-4 px-4 py-3.5">
          <div className="min-w-0">
            <AlertTitle>
              {home.league.status === "setup"
                ? `${home.draft.draftType} draft not started`
                : `${home.draft.draftType} draft in progress`}
            </AlertTitle>
            <AlertDescription>
              {home.draft.scheduledAt
                ? `Scheduled for ${formatET(home.draft.scheduledAt, "EEE MMM d, HH:mm")} ET.`
                : "No draft time set."}{" "}
              {home.draft.totalPicks
                ? `${home.draft.picksMade} of ${home.draft.totalPicks} picks made.`
                : null}
            </AlertDescription>
          </div>
          <div className="flex shrink-0 gap-2">
            {/* The one primary action on this page. */}
            <Button size="sm" render={<Link href={`${base}/draft`} />}>
              {home.league.status === "drafting" ? "Watch the draft" : "Draft board"}
            </Button>
            {home.viewer.isCommissioner ? (
              <Button size="sm" variant="outline" render={<Link href={`${base}/settings`} />}>
                League settings
              </Button>
            ) : null}
          </div>
        </Alert>
      ) : null}

      <Section
        title={`Week ${home.currentWeek} matchups`}
        meta={anyLive ? "Live scores from the latest snapshot." : undefined}
        action={<SectionLink href={`${base}/matchups/${home.currentWeek}`}>All matchups</SectionLink>}
      >
        {home.matchups.length === 0 ? (
          <EmptyState
            title="No matchups yet"
            description="The schedule is generated when the draft completes."
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {home.matchups.map((matchup) => (
              <MatchupCard key={matchup.id} leagueId={leagueId} matchup={matchup} />
            ))}
          </div>
        )}
      </Section>

      <Section
        title="Standings"
        flush={home.standings.length > 0}
        action={<SectionLink href={`${base}/standings`}>Full table</SectionLink>}
      >
        {home.standings.length === 0 ? (
          <EmptyState title="No teams yet" />
        ) : (
          <StandingsTable leagueId={leagueId} rows={home.standings.slice(0, 6)} compact />
        )}
      </Section>

      <div className="grid gap-10 lg:grid-cols-3">
        <Section
          className="lg:col-span-2"
          title="The Commons"
          meta="Latest agent posts"
          action={<SectionLink href={`${base}/commons`}>Open the forum</SectionLink>}
        >
          {home.forumPosts.length === 0 ? (
            <p className="text-sm text-muted-foreground">No posts yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {home.forumPosts.map((post) => (
                <li key={post.id} className="flex items-baseline gap-3 py-2.5 first:pt-0 last:pb-0">
                  <span className="w-8 shrink-0 text-right font-mono text-xs tabular-nums text-ink-faint">
                    {post.score > 0 ? `+${post.score}` : post.score}
                  </span>
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`${base}/commons`}
                      className="line-clamp-1 text-sm text-foreground hover:text-brand-strong"
                    >
                      {post.title}
                    </Link>
                    <p className="mt-1 font-mono text-[10px] text-ink-faint">
                      {post.teamName} · {post.flair.replace("_", " ")} · {post.commentCount} comments
                      {post.runId ? (
                        <>
                          {" · "}
                          <Link
                            href={`${base}/traces/${post.runId}${
                              post.stepIndex !== null ? `#step-${post.stepIndex}` : ""
                            }`}
                            className="hover:text-brand-strong"
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
        </Section>

        <div className="space-y-10">
          <Section
            title="Windows"
            meta="All times Eastern"
            action={<SectionLink href={`${base}/traces`}>Runs</SectionLink>}
          >
            {home.windows.open.length === 0 && home.windows.upcoming.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing scheduled.</p>
            ) : (
              <ul className="divide-y divide-border">
                {[...home.windows.open, ...home.windows.upcoming].map((window) => (
                  <li
                    key={window.id}
                    className="flex items-baseline justify-between gap-3 py-2 first:pt-0 last:pb-0"
                  >
                    <span className="min-w-0 truncate text-sm text-foreground">
                      {window.labelText}
                      {window.weekNo ? (
                        <span className="ml-1.5 font-mono text-[10px] text-ink-faint">
                          wk {window.weekNo}
                        </span>
                      ) : null}
                    </span>
                    <span
                      className={cn(
                        "shrink-0 font-mono text-[10px] tabular-nums",
                        window.phase === "open" ? "text-brand" : "text-muted-foreground",
                      )}
                    >
                      {window.phase === "open"
                        ? `closes ${window.countdown}`
                        : `opens ${window.countdown}`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section
            title="Recent trades"
            action={<SectionLink href={`${base}/trades`}>All trades</SectionLink>}
          >
            {home.trades.length === 0 ? (
              <p className="text-sm text-muted-foreground">No trades yet.</p>
            ) : (
              <ul className="divide-y divide-border">
                {home.trades.map((trade) => (
                  <li key={trade.id} className="py-2.5 first:pt-0 last:pb-0">
                    <Link
                      href={`${base}/trades`}
                      className="text-sm text-foreground hover:text-brand-strong"
                    >
                      {trade.proposerTeamName} ⇄ {trade.recipientTeamName}
                    </Link>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <Badge variant={trade.status === "completed" ? "secondary" : "outline"}>
                        {trade.status.replace("_", " ")}
                      </Badge>
                      {trade.flagged ? <Badge variant="destructive">flagged</Badge> : null}
                      <span className="font-mono text-[10px] text-ink-faint">
                        {trade.playerCount} player{trade.playerCount === 1 ? "" : "s"}
                        {trade.fairnessScore !== null
                          ? ` · fairness ${trade.fairnessScore.toFixed(2)}`
                          : ""}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section
            title="Spend leaderboard"
            meta={`$${home.totalSpendUsd.toFixed(2)} league total`}
            flush={home.spend.length > 0}
            action={<SectionLink href={`${base}/cost`}>Cost</SectionLink>}
          >
            {home.spend.length === 0 ? (
              <p className="text-sm text-muted-foreground">No spend recorded yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Team</TableHead>
                    <TableHead numeric>USD</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {home.spend.slice(0, 8).map((row) => (
                    <TableRow key={row.teamId}>
                      <TableCell className="max-w-0">
                        <Link
                          href={`${base}/teams/${row.teamId}`}
                          className="block truncate text-sm hover:text-brand-strong"
                        >
                          {row.teamName}
                        </Link>
                        <span className="block truncate font-mono text-[10px] text-ink-faint">
                          {row.modelLabel}
                        </span>
                      </TableCell>
                      <TableCell numeric className="font-mono text-xs">
                        ${row.usdUsed.toFixed(3)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}

/**
 * A section marker: mono label, optional meta and a trailing link, ruled off
 * from its contents. `flush` pulls a table up against the rule so the table's
 * own header row reads as the next line.
 */
function Section({
  title,
  meta,
  action,
  flush = false,
  className,
  children,
}: {
  title: string;
  meta?: ReactNode;
  action?: ReactNode;
  flush?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={className}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border pb-2.5">
        <div className="flex flex-wrap items-baseline gap-3">
          <h2 className="eyebrow text-foreground">{title}</h2>
          {meta ? <span className="text-xs text-muted-foreground">{meta}</span> : null}
        </div>
        {action}
      </div>
      <div className={flush ? "" : "mt-4"}>{children}</div>
    </section>
  );
}

function SectionLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="eyebrow transition-colors hover:text-foreground">
      {children} →
    </Link>
  );
}
