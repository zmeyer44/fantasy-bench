"use client";

import Link from "next/link";
import { usePreloadedQuery, type Preloaded } from "convex/react";
import { EmptyState, cn } from "@/components/ui";
import { PlayerHeadshot, PositionTag, TeamAvatar } from "./identity";
import type { api } from "@/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import { formatET } from "@/lib/time";
import { pairMatchupSlots } from "./matchup-slots";

type MatchupPage = NonNullable<FunctionReturnType<typeof api.views.matchup>>;
type Side = MatchupPage["home"];
type Slot = Side["slots"][number];

export function MatchupDetailView({
  leagueId,
  weekNo,
  preloaded,
}: {
  leagueId: string;
  weekNo: number;
  preloaded: Preloaded<typeof api.views.matchup>;
}) {
  const page = usePreloadedQuery(preloaded);
  if (!page) return <EmptyState title="Matchup not found" />;
  return <MatchupContent leagueId={leagueId} weekNo={weekNo} page={page} />;
}

export function MatchupContent({
  leagueId,
  weekNo,
  page,
}: {
  leagueId: string;
  weekNo: number;
  page: MatchupPage;
}) {
  const hasLive = [...page.away.slots, ...page.home.slots].some(
    (slot) => slot.points !== null,
  );
  const score = (side: Side) =>
    page.isFinal
      ? side.officialScore
      : side.slots.some((slot) => slot.starting && slot.points !== null)
        ? side.liveTotal
        : side.officialScore;
  const awayScore = score(page.away),
    homeScore = score(page.home);
  const margin = Math.abs(awayScore - homeScore);
  const leader = awayScore > homeScore ? page.away : page.home;
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <section
        aria-label="Matchup scoreboard"
        className="overflow-hidden rounded-xl border border-border bg-card"
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3 text-xs text-muted-foreground sm:px-6">
          <span>Week {weekNo} matchup</span>
          <span className={hasLive && !page.isFinal ? "text-brand" : ""}>
            {page.isFinal
              ? "Final"
              : hasLive
                ? "Scoring in progress"
                : "Upcoming"}
          </span>
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_28px_minmax(0,1fr)] items-stretch gap-2 px-3 py-5 sm:gap-5 sm:px-6 sm:py-6">
          <Score
            side={page.away}
            points={awayScore}
            leagueId={leagueId}
            leading={awayScore > homeScore}
          />
          <span className="self-center text-center font-mono text-xs text-muted-foreground">
            VS
          </span>
          <Score
            side={page.home}
            points={homeScore}
            leagueId={leagueId}
            leading={homeScore > awayScore}
            right
          />
        </div>
        <div className="border-t border-border bg-muted px-4 py-2.5 text-center text-xs text-muted-foreground">
          {margin > 0 ? (
            <>
              <span className="font-medium text-foreground">
                {leader.teamName}
              </span>{" "}
              {page.isFinal ? "won by" : "leads by"}{" "}
              <span className="font-mono text-brand">{margin.toFixed(2)}</span>
            </>
          ) : page.isFinal ? (
            "Matchup tied"
          ) : hasLive ? (
            "Matchup is tied"
          ) : (
            "Scores update as games are played"
          )}
        </div>
      </section>
      <Comparison
        title="Starters"
        away={page.away.slots.filter((s) => s.starting)}
        home={page.home.slots.filter((s) => s.starting)}
      />
      <Comparison
        title="Bench"
        away={page.away.slots.filter((s) => !s.starting)}
        home={page.home.slots.filter((s) => !s.starting)}
      />
      <div className="grid gap-6 sm:grid-cols-2">
        {[page.away, page.home].map((side) => (
          <section key={side.teamId} className="border-t border-border pt-4">
            <h3 className="text-sm font-medium">
              {side.teamName} · Agent’s take
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              {side.rationale?.excerpt ?? "No lineup rationale published yet."}
            </p>
            <div className="mt-3 flex gap-4 text-xs">
              <Link
                className="text-brand hover:underline"
                href={`/leagues/${leagueId}/teams/${side.teamId}`}
              >
                Full roster →
              </Link>
              {side.rationale ? (
                <Link
                  className="text-muted-foreground hover:text-foreground"
                  href={`/leagues/${leagueId}/traces/${side.rationale.runId}`}
                >
                  Decision trace →
                </Link>
              ) : null}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function Score({
  side,
  points,
  leagueId,
  leading,
  right = false,
}: {
  side: Side;
  points: number;
  leagueId: string;
  leading: boolean;
  right?: boolean;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col", right && "text-right")}>
      <div
        className={cn(
          "mb-3 flex items-center gap-3",
          right && "flex-row-reverse",
        )}
      >
        <TeamAvatar
          name={side.teamName}
          teamId={side.teamId}
          avatarUrl={side.avatarUrl}
          avatarTemplate={side.avatarTemplate}
          size={44}
        />
        <span className="font-mono text-xs text-muted-foreground">
          {side.record}
        </span>
      </div>
      <Link
        href={`/leagues/${leagueId}/teams/${side.teamId}`}
        className="block min-h-10 flex-1 text-sm font-semibold leading-tight hover:text-brand sm:min-h-6 sm:text-lg"
        style={{ overflowWrap: "anywhere" }}
      >
        {side.teamName}
      </Link>
      <div
        className={cn(
          "mt-2 font-mono text-3xl font-semibold tracking-tighter tabular-nums sm:text-5xl",
          leading && "text-brand",
        )}
      >
        {points.toFixed(2)}
      </div>
      <div className="mt-2 text-xs text-muted-foreground">
        <span className="font-mono">
          {side.slots.some((slot) => slot.starting && slot.projection !== null)
            ? side.projectedTotal.toFixed(2)
            : "—"}
        </span>{" "}
        projected
      </div>
    </div>
  );
}

function Comparison({
  title,
  away,
  home,
}: {
  title: string;
  away: Slot[];
  home: Slot[];
}) {
  const pairs = pairMatchupSlots(away, home);
  if (!pairs.length)
    return title === "Starters" ? (
      <EmptyState
        title="No lineups recorded"
        description="Your agents’ starting lineups will appear here."
      />
    ) : null;
  return (
    <section aria-label={`${title} comparison`}>
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-base font-semibold">{title}</h2>
        <span className="text-xs text-muted-foreground">
          Points <span className="ml-2">/ projected</span>
        </span>
      </div>
      <div className="divide-y divide-border border-y border-border">
        {pairs.map((pair) => (
          <div
            key={pair.key}
            className="grid grid-cols-[minmax(0,1fr)_36px_minmax(0,1fr)] items-stretch gap-1 sm:gap-3"
          >
            <PlayerCell
              slot={pair.away}
              leads={(pair.away?.points ?? 0) > (pair.home?.points ?? 0)}
            />
            <div className="flex items-center justify-center">
              <PositionTag slot={pair.label} />
            </div>
            <PlayerCell
              slot={pair.home}
              leads={(pair.home?.points ?? 0) > (pair.away?.points ?? 0)}
              right
            />
          </div>
        ))}
      </div>
    </section>
  );
}

function PlayerCell({
  slot,
  leads,
  right = false,
}: {
  slot?: Slot;
  leads: boolean;
  right?: boolean;
}) {
  return (
    <div
      className={cn(
        "min-w-0 px-1 py-3 sm:grid sm:items-center sm:gap-x-3 sm:px-3",
        right
          ? "sm:grid-cols-[60px_minmax(0,1fr)]"
          : "sm:grid-cols-[minmax(0,1fr)_60px]",
        leads && "bg-brand-soft/40",
        right && "text-right",
      )}
    >
      {slot?.playerName ? (
        <>
          <div
            className={cn(
              "flex items-center gap-2 sm:row-start-1",
              right ? "flex-row-reverse sm:col-start-2" : "sm:col-start-1",
            )}
          >
            <span className="inline-flex shrink-0">
              <PlayerHeadshot
                name={slot.playerName}
                sleeperId={slot.sleeperId}
                nflTeam={slot.nflTeam}
                position={slot.position}
                size={28}
              />
            </span>
            <div className="min-w-0 flex-1">
              <div
                className="text-xs font-medium leading-snug sm:text-sm"
                style={{ overflowWrap: "anywhere" }}
              >
                {slot.playerName}
              </div>
              <div className="mt-1 text-[11px] text-muted-foreground">
                {slot.position} · {slot.nflTeam ?? "FA"}
                {slot.injuryStatus ? (
                  <span className="ml-1 text-danger">{slot.injuryStatus}</span>
                ) : null}
              </div>
            </div>
          </div>
          <div
            className={cn(
              "mt-2 flex items-baseline gap-2 sm:row-span-2 sm:row-start-1 sm:mt-0 sm:flex-col sm:gap-0",
              right
                ? "justify-end sm:col-start-1 sm:items-start"
                : "sm:col-start-2 sm:items-end",
            )}
          >
            <span
              className={cn(
                "font-mono text-lg font-medium tabular-nums",
                leads && "text-brand",
              )}
            >
              {slot.points?.toFixed(2) ?? "—"}
            </span>
            <span className="font-mono text-[11px] text-muted-foreground">
              {slot.projection?.toFixed(2) ?? "—"}
            </span>
          </div>
          <div
            className={cn(
              "mt-1 text-[10px] leading-relaxed text-muted-foreground sm:row-start-2 sm:text-xs",
              right ? "sm:col-start-2" : "sm:col-start-1",
            )}
          >
            {slot.opponent ?? "Opponent TBD"}
            {slot.kickoffAt
              ? ` · ${formatET(slot.kickoffAt, "EEE h:mm a")} ET`
              : ""}
          </div>
        </>
      ) : (
        <div className="flex min-h-24 items-center justify-center text-xs text-muted-foreground">
          Empty slot
        </div>
      )}
    </div>
  );
}
