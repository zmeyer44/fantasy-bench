"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePreloadedQuery, type Preloaded } from "convex/react";

import { ActivityFeed } from "@/components/league/activity-feed";
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
  cn,
} from "@/components/ui";
import type { api } from "@/convex/_generated/api";
import { formatET } from "@/lib/time";

/**
 * The league home page (PRD 5.11): the activity feed, framed by the week.
 *
 * The server preloads `views.home` and the first page of `activity.feed`; the
 * client takes over both subscriptions so the stream, scores and windows stay
 * live without a poll. Epoch-ms timestamps are formatted here, at the edge.
 *
 * Layout: a ruled status strip, then the feed with a rail of the week's
 * matchups, the top of the table and the window schedule. Lime appears in the
 * countdown, live scores, and the one primary action.
 */
export function LeagueHomeView({
  leagueId,
  preloaded,
  activity,
}: {
  leagueId: string;
  preloaded: Preloaded<typeof api.views.home>;
  activity: Preloaded<typeof api.activity.feed>;
}) {
  const home = usePreloadedQuery(preloaded);

  const base = `/leagues/${leagueId}`;
  const next = home.windows.next;
  const pendingDraft =
    home.league.status === "setup" || home.league.status === "drafting";
  const anyLive = home.matchups.some((m) => m.home.live || m.away.live);
  const viewerMatchup = home.viewer.teamId
    ? home.matchups.find((matchup) =>
        matchup.home.teamId === home.viewer.teamId || matchup.away.teamId === home.viewer.teamId,
      )
    : undefined;
  // On a bye (odd team count, playoff seed bye) the featured game is someone else's.
  const featuredMatchup = viewerMatchup
    ?? home.matchups.find((matchup) => matchup.home.live || matchup.away.live)
    ?? home.matchups[0];

  return (
    <div className="space-y-10">
      {/* Status + the next window countdown (PRD 5.11): a rule, not a card. */}
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-border pb-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">Week {home.currentWeek}</Badge>
          <span className="font-mono text-[10px] text-ink-faint">
            {home.snapshotTakenAt
              ? `snapshot ${formatET(home.snapshotTakenAt, "MMM d HH:mm")} ET`
              : "no snapshot yet"}
          </span>
        </div>
        {next ? (
          <WindowCountdown
            labelText={next.labelText}
            target={new Date(
              next.phase === "open" ? next.closesAt : next.opensAt,
            ).toISOString()}
            verb={next.phase === "open" ? "closes" : "opens"}
            initial={next.countdown}
          />
        ) : (
          <span className="font-mono text-xs text-ink-faint">
            No windows scheduled
          </span>
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
              {home.league.status === "drafting"
                ? "Watch the draft"
                : "Draft board"}
            </Button>
            {home.viewer.isCommissioner ? (
              <Button
                size="sm"
                variant="outline"
                render={<Link href={`${base}/settings`} />}
              >
                League settings
              </Button>
            ) : null}
          </div>
        </Alert>
      ) : null}

      {featuredMatchup ? (
        <Section
          className="lg:hidden"
          title={viewerMatchup ? "Your matchup" : `Week ${home.currentWeek} matchup`}
          action={<SectionLink href={`${base}/matchups/${home.currentWeek}`}>All matchups</SectionLink>}
        >
          <MatchupCard leagueId={leagueId} matchup={featuredMatchup} />
        </Section>
      ) : null}

      <div className="grid grid-cols-[minmax(0,1fr)] gap-10 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <ActivityFeed leagueId={leagueId} preloaded={activity} />

        <aside className="min-w-0 space-y-10">
          <Section
            title={`Week ${home.currentWeek}`}
            meta={anyLive ? "Live" : undefined}
            action={
              <SectionLink href={`${base}/matchups/${home.currentWeek}`}>
                Matchups
              </SectionLink>
            }
          >
            {home.matchups.length === 0 ? (
              <EmptyState
                title="No matchups yet"
                description="The schedule is generated when the draft completes."
                className="py-8"
              />
            ) : (
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
                {home.matchups.map((matchup) => (
                  <MatchupCard
                    key={matchup.id}
                    leagueId={leagueId}
                    matchup={matchup}
                  />
                ))}
              </div>
            )}
          </Section>

          <Section
            title="Standings"
            flush={home.standings.length > 0}
            action={
              <SectionLink href={`${base}/standings`}>Full table</SectionLink>
            }
          >
            {home.standings.length === 0 ? (
              <EmptyState title="No teams yet" className="py-8" />
            ) : (
              <StandingsTable
                leagueId={leagueId}
                rows={home.standings.slice(0, 6)}
                compact
              />
            )}
          </Section>

          <Section
            title="Windows"
            meta="Eastern"
            action={<SectionLink href={`${base}/traces`}>Runs</SectionLink>}
          >
            {home.windows.open.length === 0 &&
            home.windows.upcoming.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nothing scheduled.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {[...home.windows.open, ...home.windows.upcoming].map(
                  (window) => (
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
                          window.phase === "open"
                            ? "text-brand"
                            : "text-muted-foreground",
                        )}
                      >
                        {window.phase === "open"
                          ? `closes ${window.countdown}`
                          : `opens ${window.countdown}`}
                      </span>
                    </li>
                  ),
                )}
              </ul>
            )}
          </Section>
        </aside>
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
          {meta ? (
            <span className="text-xs text-muted-foreground">{meta}</span>
          ) : null}
        </div>
        {action}
      </div>
      <div className={flush ? "" : "mt-4"}>{children}</div>
    </section>
  );
}

function SectionLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      className="eyebrow transition-colors hover:text-foreground"
    >
      {children} →
    </Link>
  );
}
