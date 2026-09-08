import type { ReactNode } from "react";
import Link from "next/link";

import { TeamLogo } from "@/components/nfl/team-logo";

import {
  Badge,
  EmptyState,
  Stat,
  StatStrip,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  cn,
} from "@/components/ui";
import type { api } from "@/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import { formatET } from "@/lib/time";

export type DraftBoardData = FunctionReturnType<typeof api.draft.board>;
type DraftPick = DraftBoardData["picks"][number];

const RECENT_PICKS = 24;

/** Order grid (rounds × teams) + the pick list with rationales. Presentational. */
export function DraftBoardView({
  leagueId,
  board,
}: {
  leagueId: string;
  board: DraftBoardData;
}) {
  const madePicks = board.picks.filter((pick) => pick.playerId !== null).reverse();
  // A full draft is 150+ picks with rationales; show the latest two rounds'
  // worth by default and keep the rest behind a native disclosure.
  const recentPicks = madePicks.slice(0, RECENT_PICKS);
  const olderPicks = madePicks.slice(RECENT_PICKS);

  return (
    <div className="space-y-10">
      <StatStrip className="sm:grid-cols-3">
        <Stat
          label="On the clock"
          tone={board.onTheClock ? "brand" : "default"}
          value={
            <span className="block truncate text-lg">
              {board.onTheClock ? board.onTheClock.teamName : "—"}
            </span>
          }
          detail={
            board.onTheClock
              ? `Round ${board.onTheClock.round}, pick ${board.onTheClock.pickNo} (#${board.onTheClock.overallNo})${
                  board.onTheClock.deadlineAt
                    ? ` · until ${formatET(board.onTheClock.deadlineAt, "HH:mm:ss")} ET`
                    : ""
                }`
              : board.status === "complete" || board.picksMade === board.totalPicks
                ? "Draft complete"
                : "Not started"
          }
        />
        <Stat
          label="Progress"
          value={<span className="block text-lg">{`${board.picksMade} / ${board.totalPicks || "—"}`}</span>}
          detail={`${board.draftType} draft · ${board.rounds || 0} rounds`}
        />
        <Stat
          label="Running cost"
          value={<span className="block text-lg">${board.runningCostUsd.toFixed(4)}</span>}
          detail="Across every draft run"
        />
      </StatStrip>

      <section>
        <SectionRule title="Order" meta="Rounds × teams" />
        {board.rounds === 0 || board.teams.length === 0 ? (
          <div className="mt-4">
            <EmptyState
              title="No draft order yet"
              description="The board is generated when the commissioner starts the draft."
            />
          </div>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="sticky left-0 z-10 bg-background">R</TableHead>
                  {board.teams.map((team) => (
                    <TableHead key={team.id} title={team.name}>
                      {team.abbreviation}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {board.grid.map((row, roundIndex) => (
                  <TableRow key={roundIndex}>
                    <TableCell className="sticky left-0 z-10 bg-background font-mono text-[10px] text-ink-faint">
                      {roundIndex + 1}
                    </TableCell>
                    {row.map((pick, slotIndex) => {
                      const onClock =
                        board.onTheClock && pick && pick.overallNo === board.onTheClock.overallNo;
                      return (
                        <TableCell
                          key={slotIndex}
                          className={cn(
                            "border-l border-border align-top",
                            // The clock is the live thing on this page, so it
                            // gets the page's lime.
                            onClock && "bg-brand-soft",
                          )}
                        >
                          {pick?.playerName ? (
                            <span className="flex items-start gap-1.5">
                              <TeamLogo team={pick.nflTeam} size={18} className="mt-px" />
                              <span className="min-w-0">
                              <span className="block truncate text-xs text-foreground">
                                {pick.playerName}
                              </span>
                              <span className="block font-mono text-[10px] text-ink-faint">
                                {pick.position}
                                {pick.nflTeam ? ` · ${pick.nflTeam}` : ""}
                                {pick.price !== null ? ` · $${pick.price}` : ""}
                                {pick.auto ? " · auto" : ""}
                              </span>
                              </span>
                            </span>
                          ) : onClock ? (
                            <span className="font-mono text-[10px] text-brand">on the clock</span>
                          ) : (
                            <span className="font-mono text-[10px] text-ink-faint">—</span>
                          )}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="mt-3 text-xs text-muted-foreground">
              Row = round, column = draft slot. The highlighted cell is on the clock.
            </p>
          </>
        )}
      </section>

      <section>
        <SectionRule title="Picks" meta="Newest first, with the agent's rationale" />
        <div className="mt-4">
          {madePicks.length === 0 ? (
            <p className="text-sm text-muted-foreground">No picks yet.</p>
          ) : (
            <>
              <ul className="divide-y divide-border">
                {recentPicks.map((pick) => (
                  <PickRow key={pick.id} leagueId={leagueId} pick={pick} />
                ))}
              </ul>
              {olderPicks.length > 0 ? (
                <details className="group mt-3 border-t border-border pt-3">
                  <summary className="eyebrow cursor-pointer list-none text-foreground hover:text-brand [&::-webkit-details-marker]:hidden">
                    <span className="group-open:hidden">Show all {madePicks.length} picks</span>
                    <span className="hidden group-open:inline">Show fewer</span>
                  </summary>
                  <ul className="mt-3 divide-y divide-border">
                    {olderPicks.map((pick) => (
                      <PickRow key={pick.id} leagueId={leagueId} pick={pick} />
                    ))}
                  </ul>
                </details>
              ) : null}
            </>
          )}
        </div>
      </section>
    </div>
  );
}

function PickRow({ leagueId, pick }: { leagueId: string; pick: DraftPick }) {
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm text-foreground">
          <span className="font-mono text-xs tabular-nums text-ink-faint">
            {pick.round}.{String(pick.pickNo).padStart(2, "0")}
          </span>{" "}
          <TeamLogo team={pick.nflTeam} size={16} className="mx-1 align-text-bottom" />
          <span className="font-medium">{pick.playerName}</span>{" "}
          <span className="font-mono text-[10px] text-ink-faint">
            {pick.position}
            {pick.nflTeam ? ` · ${pick.nflTeam}` : ""}
          </span>
        </span>
        <span className="flex flex-wrap items-center gap-1.5">
          <Badge
            variant="secondary"
            render={<Link href={`/leagues/${leagueId}/teams/${pick.teamId}`} />}
          >
            {pick.teamAbbreviation}
          </Badge>
          {pick.price !== null ? <Badge variant="outline">${pick.price}</Badge> : null}
          {pick.auto ? <Badge variant="warning">auto-pick</Badge> : null}
          {pick.costUsd !== null ? (
            <Badge variant="outline">${pick.costUsd.toFixed(4)}</Badge>
          ) : null}
          {pick.runId ? (
            <Link
              href={`/leagues/${leagueId}/traces/${pick.runId}`}
              className="font-mono text-[10px] text-muted-foreground hover:text-brand-strong"
            >
              trace →
            </Link>
          ) : null}
        </span>
      </div>
      {pick.rationale ? (
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {pick.rationale}
        </p>
      ) : null}
    </li>
  );
}

function SectionRule({ title, meta }: { title: string; meta?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border pb-2.5">
      <h2 className="eyebrow text-foreground">{title}</h2>
      {meta ? <span className="text-xs text-muted-foreground">{meta}</span> : null}
    </div>
  );
}
