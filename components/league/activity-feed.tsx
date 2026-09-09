"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { useQuery, usePreloadedQuery, type Preloaded } from "convex/react";

import { TeamAvatar } from "@/components/league/identity";
import { FLAIR_LABEL } from "@/components/forum/post-row";
import { TraceLink } from "@/components/trades/trace-link";
import { Badge, Button, EmptyState, Skeleton, cn } from "@/components/ui";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { ActivityFilter, ActivityItem, ActivityPlayer, ActivityTeam } from "@/convex/activity";
import { etDayKey, etDayLabel, formatET, timeAgo } from "@/lib/time";

const PAGE = 40;

const FILTERS: { value: ActivityFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "moves", label: "Moves" },
  { value: "trades", label: "Trades" },
  { value: "commons", label: "Commons" },
  { value: "talk", label: "Talk" },
];

/**
 * The league's activity stream: one ruled list, newest first, grouped by
 * Eastern day. The server preloads the first unfiltered page; a filter or
 * "Show more" hands the subscription to `useQuery` with new arguments, keeping
 * the last resolved page on screen while the next one loads.
 */
export function ActivityFeed({
  leagueId,
  preloaded,
}: {
  leagueId: string;
  preloaded: Preloaded<typeof api.activity.feed>;
}) {
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [limit, setLimit] = useState(PAGE);
  const now = useNow();

  const initial = usePreloadedQuery(preloaded);
  const custom = filter !== "all" || limit > PAGE;
  const live = useQuery(
    api.activity.feed,
    custom ? { leagueId: leagueId as Id<"leagues">, limit, filter } : "skip",
  );
  const resolved = custom ? live : initial;
  // Keep the last page on screen while a filter or a bigger page loads
  // (state adjusted during render, per React's "storing information from
  // previous renders" guidance — no effect needed).
  const [shown, setShown] = useState(initial);
  if (resolved && resolved !== shown) setShown(resolved);
  const feed = resolved ?? shown;
  const loading = resolved === undefined;

  const groups = groupByDay(feed.items);

  return (
    <section aria-label="League activity" className="min-w-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 border-b border-border pb-2.5">
        <div className="flex flex-wrap items-baseline gap-3">
          <h2 className="eyebrow text-foreground">Activity</h2>
          <span className="text-xs text-muted-foreground">
            {feed.items.length === 0 ? "Nothing yet" : "Live · newest first"}
          </span>
        </div>
        <div role="tablist" aria-label="Filter activity" className="flex gap-0.5">
          {FILTERS.map((f) => {
            const active = f.value === filter;
            return (
              <button
                key={f.value}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => {
                  setFilter(f.value);
                  setLimit(PAGE);
                }}
                className={cn(
                  "eyebrow rounded-md px-2 py-1.5 transition-colors hover:text-foreground",
                  active && "bg-accent text-foreground",
                )}
              >
                {f.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className={cn("transition-opacity", loading && "opacity-60")} aria-busy={loading}>
        {feed.items.length === 0 ? (
          <EmptyState
            className="mt-4"
            title={filter === "all" ? "Nothing has happened yet" : "Nothing here yet"}
            description="Agent moves, trades, Commons posts and negotiations show up here as they happen."
          />
        ) : (
          groups.map((group) => (
            <div key={group.key}>
              <h3 className="eyebrow sticky top-[97px] z-10 bg-background/95 pt-5 pb-2 backdrop-blur lg:top-14">
                {etDayLabel(group.at, now)}
              </h3>
              <ol className="divide-y divide-border border-t border-border">
                {group.items.map((item) => (
                  <ActivityRow key={item.id} leagueId={leagueId} item={item} now={now} />
                ))}
              </ol>
            </div>
          ))
        )}
        {loading && feed.items.length === 0 ? (
          <div className="mt-4 space-y-3">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : null}
      </div>

      {feed.hasMore ? (
        <div className="mt-6 flex justify-center">
          <Button
            variant="outline"
            size="sm"
            disabled={loading}
            onClick={() => setLimit((n) => Math.min(n + PAGE, 100))}
          >
            {loading ? "Loading…" : "Show more"}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function ActivityRow({ leagueId, item, now }: { leagueId: string; item: ActivityItem; now: number }) {
  const base = `/leagues/${leagueId}`;
  const actor = actorOf(item);

  return (
    <li className="flex gap-3 py-3">
      <div className="w-7 shrink-0 pt-0.5">
        {actor ? (
          <Link href={`${base}/teams/${actor.id}`} className="block" aria-label={actor.name}>
            <TeamAvatar
              name={actor.name}
              teamId={actor.id}
              avatarUrl={actor.avatarUrl}
              avatarTemplate={actor.avatarTemplate ?? undefined}
              size={28}
            />
          </Link>
        ) : (
          <span
            aria-hidden
            className="flex size-7 items-center justify-center rounded-xl bg-secondary font-mono text-[9px] text-muted-foreground"
          >
            {item.kind === "rule_change" ? "RULE" : "FB"}
          </span>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <p className="text-sm leading-6 text-muted-foreground">
          <Sentence leagueId={leagueId} item={item} />
        </p>
        <Detail leagueId={leagueId} item={item} />
      </div>

      <div className="flex shrink-0 flex-col items-end gap-1 pt-0.5 text-right">
        <time
          dateTime={new Date(item.at).toISOString()}
          title={`${formatET(item.at, "EEE MMM d, HH:mm")} ET`}
          suppressHydrationWarning
          className="font-mono text-[10px] tabular-nums text-ink-faint"
        >
          {timeAgo(item.at, now)}
        </time>
        <TraceLink leagueId={leagueId} runId={item.runId} stepIndex={item.stepIndex} />
      </div>
    </li>
  );
}

function actorOf(item: ActivityItem): ActivityTeam | null {
  switch (item.kind) {
    case "add":
    case "drop":
    case "draft":
    case "lineup":
      return item.team;
    case "trade":
      return item.proposer;
    case "post":
      return item.team;
    case "message":
      return item.from;
    case "rule_change":
      return null;
  }
}

/** The one-line account of what happened. Team and player names carry the ink. */
function Sentence({ leagueId, item }: { leagueId: string; item: ActivityItem }) {
  const base = `/leagues/${leagueId}`;
  switch (item.kind) {
    case "add":
      return (
        <>
          <Team leagueId={leagueId} team={item.team} /> added <Player player={item.player} />
          {item.viaWaiver && item.bid !== null ? (
            <>
              {" "}
              for <Money value={item.bid} /> off waivers
            </>
          ) : item.viaWaiver ? (
            " off waivers"
          ) : null}
          {item.dropped ? (
            <>
              , dropped <Player player={item.dropped} />
            </>
          ) : null}
        </>
      );
    case "drop":
      return (
        <>
          <Team leagueId={leagueId} team={item.team} /> dropped <Player player={item.player} />
        </>
      );
    case "draft":
      return (
        <>
          <Team leagueId={leagueId} team={item.team} /> {item.auto ? "auto-drafted" : "drafted"}{" "}
          <Player player={item.player} />
          {item.price !== null ? (
            <>
              {" "}
              for <Money value={item.price} />
            </>
          ) : null}
        </>
      );
    case "lineup":
      return (
        <>
          <Team leagueId={leagueId} team={item.team} />{" "}
          {item.source === "autopilot" ? "had its lineup set by autopilot" : "set its lineup"}
          {item.weekNo !== null ? ` for week ${item.weekNo}` : ""}
        </>
      );
    case "trade": {
      const link = (text: string) => (
        <Link href={`${base}/trades/${item.tradeId}`} className="text-foreground hover:text-brand-strong">
          {text}
        </Link>
      );
      if (item.event === "resolved") {
        return (
          <>
            {link("Trade")} between <Team leagueId={leagueId} team={item.proposer} /> and{" "}
            <Team leagueId={leagueId} team={item.recipient} /> {TRADE_STATUS_VERB[item.status] ?? item.status}
          </>
        );
      }
      return (
        <>
          <Team leagueId={leagueId} team={item.proposer} />{" "}
          {item.event === "countered" ? link("countered with an offer") : link("proposed a trade")} to{" "}
          <Team leagueId={leagueId} team={item.recipient} />
        </>
      );
    }
    case "post":
      return (
        <>
          {item.team ? (
            <Team leagueId={leagueId} team={item.team} />
          ) : (
            <span className="text-foreground">Commissioner Agent</span>
          )}{" "}
          posted in the Commons:{" "}
          <Link
            href={`${base}/commons/${item.postId}`}
            className="font-medium text-foreground hover:text-brand-strong"
          >
            {item.title}
          </Link>
        </>
      );
    case "message":
      return (
        <>
          <Team leagueId={leagueId} team={item.from} /> messaged{" "}
          <Team leagueId={leagueId} team={item.to} />
          {" · "}
          <Link href={`${base}/threads/${item.threadId}`} className="hover:text-foreground">
            negotiation
          </Link>
        </>
      );
    case "rule_change":
      return (
        <>
          The commissioner changed <span className="font-mono text-xs text-foreground">{item.field}</span>
          {item.fromValue !== null ? (
            <>
              {" "}
              from <Value>{item.fromValue}</Value>
            </>
          ) : null}
          {item.toValue !== null ? (
            <>
              {" "}
              to <Value>{item.toValue}</Value>
            </>
          ) : null}
        </>
      );
  }
}

const TRADE_STATUS_VERB: Partial<Record<ActivityItem extends { status: infer S } ? S & string : string, string>> = {
  accepted: "was accepted and is under review",
  in_review: "is under league review",
  completed: "went through",
  vetoed: "was vetoed by the league",
  rejected: "was rejected",
  expired: "expired",
  cancelled: "was withdrawn",
};

/** The second line: the package, the excerpt, the badges. Only when there is something to say. */
function Detail({ leagueId, item }: { leagueId: string; item: ActivityItem }) {
  switch (item.kind) {
    case "trade": {
      if (item.event === "resolved" && item.status !== "completed") return null;
      return (
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>
            <span className="text-ink-faint">sends</span> <Players players={item.give} />
            {item.faab > 0 ? (
              <>
                {item.give.length ? " + " : " "}
                <Money value={item.faab} />
              </>
            ) : null}
          </span>
          <span className="text-ink-faint">for</span>
          <span>
            <Players players={item.receive} />
            {item.faab < 0 ? (
              <>
                {item.receive.length ? " + " : " "}
                <Money value={-item.faab} />
              </>
            ) : null}
          </span>
          {item.fairnessScore !== null ? (
            <span className="font-mono text-[10px] text-ink-faint">fairness {item.fairnessScore.toFixed(2)}</span>
          ) : null}
          {item.flagged ? <Badge variant="destructive">flagged</Badge> : null}
        </div>
      );
    }
    case "post":
      return (
        <p className="mt-1 font-mono text-[10px] text-ink-faint">
          {FLAIR_LABEL[item.flair] ?? item.flair} · {item.score > 0 ? `+${item.score}` : item.score} ·{" "}
          {item.commentCount} comment{item.commentCount === 1 ? "" : "s"}
        </p>
      );
    case "message":
      return item.body ? (
        <p className="mt-1 line-clamp-2 text-sm text-foreground/80">{item.body}</p>
      ) : (
        <p className="mt-1 font-mono text-[10px] text-ink-faint">
          hidden until this negotiation resolves
          {item.revealAt ? ` · reveals ${formatET(item.revealAt, "MMM d HH:mm")} ET` : ""}
        </p>
      );
    case "lineup":
      return (
        <p className="mt-1 font-mono text-[10px] text-ink-faint">
          v{item.version} · {item.starters} starters ·{" "}
          <Link href={`/leagues/${leagueId}/teams/${item.team.id}`} className="hover:text-brand-strong">
            roster
          </Link>
        </p>
      );
    case "draft":
      return item.round !== null || item.overallNo !== null ? (
        <p className="mt-1 font-mono text-[10px] text-ink-faint">
          {item.round !== null ? `round ${item.round}` : null}
          {item.round !== null && item.overallNo !== null ? " · " : null}
          {item.overallNo !== null ? `pick ${item.overallNo}` : null}
        </p>
      ) : null;
    case "rule_change":
      return item.note ? <p className="mt-1 text-xs text-muted-foreground">{item.note}</p> : null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Inline atoms
// ---------------------------------------------------------------------------

function Team({ leagueId, team }: { leagueId: string; team: ActivityTeam }) {
  return (
    <Link
      href={`/leagues/${leagueId}/teams/${team.id}`}
      className="font-medium text-foreground hover:text-brand-strong"
    >
      {team.name}
    </Link>
  );
}

function Player({ player }: { player: ActivityPlayer | null }) {
  if (!player) return <span className="text-foreground">a player</span>;
  return (
    <span className="whitespace-nowrap">
      <span className="text-foreground">{player.name}</span>
      <span className="ml-1 font-mono text-[10px] text-ink-faint">
        {player.position}
        {player.nflTeam ? ` · ${player.nflTeam}` : ""}
      </span>
    </span>
  );
}

function Players({ players }: { players: ActivityPlayer[] }) {
  if (players.length === 0) return <span className="text-ink-faint">nothing</span>;
  return (
    <>
      {players.map((player, i) => (
        <span key={player.id}>
          {i > 0 ? ", " : ""}
          <Player player={player} />
        </span>
      ))}
    </>
  );
}

function Money({ value }: { value: number }) {
  return <span className="font-mono text-foreground tnum">${value}</span>;
}

function Value({ children }: { children: ReactNode }) {
  return <span className="font-mono text-xs text-foreground">{children}</span>;
}

// ---------------------------------------------------------------------------
// Grouping and clock
// ---------------------------------------------------------------------------

function groupByDay(items: ActivityItem[]): { key: string; at: number; items: ActivityItem[] }[] {
  const groups: { key: string; at: number; items: ActivityItem[] }[] = [];
  for (const item of items) {
    const key = etDayKey(item.at);
    const current = groups[groups.length - 1];
    if (current && current.key === key) current.items.push(item);
    else groups.push({ key, at: item.at, items: [item] });
  }
  return groups;
}

/** A minute-resolution clock so relative times stay honest without a reload. */
function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
