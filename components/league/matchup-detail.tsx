"use client";

import Link from "next/link";
import { usePreloadedQuery, type Preloaded } from "convex/react";

import { OpponentTag, TeamLogo } from "@/components/nfl/team-logo";
import {
  Badge,
  EmptyState,
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
  cn,
} from "@/components/ui";
import type { api } from "@/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import { formatET } from "@/lib/time";

type MatchupPage = NonNullable<FunctionReturnType<typeof api.views.matchup>>;
type MatchupTeamView = MatchupPage["home"];

/** Both lineups, slot by slot, with each agent's rationale — live off `views.matchup`. */
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

  return (
    <div className="space-y-10">
      {/* Scoreboard: a ruled strip across the page, not a box. */}
      <div className="flex flex-wrap items-center justify-between gap-6 border-b border-border pb-5">
        <Score side={page.away} isFinal={page.isFinal} align="left" />
        <div className="text-center">
          <div className="eyebrow">Week {weekNo}</div>
          <div className="mt-2">
            {page.isFinal ? (
              <Badge variant="secondary">final</Badge>
            ) : (
              <Badge variant="success">live</Badge>
            )}
          </div>
        </div>
        <Score side={page.home} isFinal={page.isFinal} align="right" />
      </div>

      <div className="grid gap-10 lg:grid-cols-2">
        <SideLineup leagueId={leagueId} side={page.away} isFinal={page.isFinal} />
        <SideLineup leagueId={leagueId} side={page.home} isFinal={page.isFinal} />
      </div>
    </div>
  );
}

function Score({
  side,
  isFinal,
  align,
}: {
  side: MatchupTeamView;
  isFinal: boolean;
  align: "left" | "right";
}) {
  const points = isFinal ? side.officialScore : side.liveTotal || side.officialScore;
  return (
    <div className={align === "right" ? "text-right" : "text-left"}>
      <div className="text-sm font-medium text-foreground">{side.teamName}</div>
      <div className="mt-0.5 font-mono text-[10px] text-ink-faint">
        {side.record} · proj {side.projectedTotal.toFixed(1)}
      </div>
      <div
        className={cn(
          "mt-1.5 font-mono text-3xl tracking-tight tabular-nums",
          isFinal ? "text-foreground" : "text-brand",
        )}
      >
        {points.toFixed(1)}
      </div>
    </div>
  );
}

function SideLineup({
  leagueId,
  side,
  isFinal,
}: {
  leagueId: string;
  side: MatchupTeamView;
  isFinal: boolean;
}) {
  const starters = side.slots.filter((slot) => slot.starting);
  const bench = side.slots.filter((slot) => !slot.starting);

  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border pb-2.5">
        <div className="flex flex-wrap items-baseline gap-3">
          <h2 className="text-sm font-medium text-foreground">
            <Link
              href={`/leagues/${leagueId}/teams/${side.teamId}`}
              className="hover:text-brand-strong"
            >
              {side.teamName}
            </Link>
          </h2>
          {side.lineupSource ? (
            <span className="text-xs text-muted-foreground">
              Lineup set by {side.lineupSource.replace("_", " ")}
            </span>
          ) : null}
        </div>
        {side.rationale ? (
          <Link
            href={`/leagues/${leagueId}/traces/${side.rationale.runId}`}
            className="eyebrow transition-colors hover:text-foreground"
          >
            Trace →
          </Link>
        ) : null}
      </div>

      {side.rationale?.excerpt ? (
        <p className="mt-4 border-l-2 border-border pl-3 text-sm leading-relaxed text-muted-foreground">
          <span className="eyebrow mr-2">{side.rationale.windowLabel}</span>
          {side.rationale.excerpt}
        </p>
      ) : null}

      <SlotRows rows={starters} side={side} isFinal={isFinal} />

      {bench.length > 0 ? (
        <>
          <div className="mt-8 border-b border-border pb-2.5">
            <h3 className="eyebrow text-foreground">Bench</h3>
          </div>
          <SlotRows rows={bench} muted />
        </>
      ) : null}
    </section>
  );
}

function SlotRows({
  rows,
  side,
  isFinal,
  muted = false,
}: {
  rows: MatchupTeamView["slots"];
  side?: MatchupTeamView;
  isFinal?: boolean;
  muted?: boolean;
}) {
  if (rows.length === 0) {
    return <p className="mt-4 text-sm text-muted-foreground">No lineup recorded.</p>;
  }
  return (
    <Table className={muted ? "opacity-70" : undefined}>
      <TableHeader>
        <TableRow>
          <TableHead className="w-12">Slot</TableHead>
          <TableHead>Player</TableHead>
          <TableHead>Kickoff</TableHead>
          <TableHead numeric>Proj</TableHead>
          <TableHead numeric>Pts</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((slot, index) => (
          <TableRow key={`${slot.slot}-${slot.playerId ?? index}`}>
            <TableCell className="font-mono text-[10px] uppercase text-ink-faint">
              {slot.slot}
            </TableCell>
            <TableCell>
              {slot.playerName ? (
                <span className="flex flex-wrap items-center gap-1.5">
                  <TeamLogo team={slot.nflTeam} size={18} />
                  <span className="text-sm text-foreground">{slot.playerName}</span>
                  <span className="font-mono text-[10px] text-ink-faint">
                    {slot.position}
                    {slot.nflTeam ? ` · ${slot.nflTeam}` : ""}
                  </span>
                  {slot.opponent ? <OpponentTag opponent={slot.opponent} size={14} /> : null}
                  {slot.injuryStatus ? (
                    <Badge variant="destructive">{slot.injuryStatus}</Badge>
                  ) : null}
                </span>
              ) : (
                <span className="text-sm text-ink-faint">— empty —</span>
              )}
            </TableCell>
            <TableCell className="font-mono text-[10px] text-muted-foreground">
              {slot.kickoffAt ? formatET(slot.kickoffAt, "EEE HH:mm") : "—"}
            </TableCell>
            <TableCell numeric className="font-mono text-xs text-muted-foreground">
              {slot.projection?.toFixed(1) ?? "—"}
            </TableCell>
            <TableCell numeric className="font-mono text-xs text-foreground">
              {slot.points?.toFixed(1) ?? "—"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
      {side ? (
        <TableFooter>
          <TableRow>
            <TableCell colSpan={3} className="eyebrow">
              Total
            </TableCell>
            <TableCell numeric className="font-mono text-xs text-muted-foreground">
              {side.projectedTotal.toFixed(1)}
            </TableCell>
            <TableCell
              numeric
              className={cn("font-mono text-xs", isFinal ? "text-foreground" : "text-brand")}
            >
              {side.liveTotal.toFixed(1)}
            </TableCell>
          </TableRow>
        </TableFooter>
      ) : null}
    </Table>
  );
}
