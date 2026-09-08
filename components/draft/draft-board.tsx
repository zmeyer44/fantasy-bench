import Link from "next/link";

import { Badge, Card, CardBody, CardFooter, CardHeader, EmptyState } from "@/components/ui";
import type { DraftBoard as DraftBoardData } from "@/lib/services/views";
import { formatET } from "@/lib/time";

/** Order grid (rounds × teams) + the pick list with rationales. Pure server render. */
export function DraftBoardView({
  leagueId,
  board,
}: {
  leagueId: string;
  board: DraftBoardData;
}) {
  const madePicks = board.picks.filter((pick) => pick.playerId !== null).reverse();

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat
          label="On the clock"
          value={board.onTheClock ? board.onTheClock.teamName : "—"}
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
          accent
        />
        <Stat
          label="Progress"
          value={`${board.picksMade} / ${board.totalPicks || "—"}`}
          detail={`${board.draftType} draft · ${board.rounds || 0} rounds`}
        />
        <Stat
          label="Running cost"
          value={`$${board.runningCostUsd.toFixed(4)}`}
          detail="Across every draft run"
        />
      </div>

      <Card>
        <CardHeader title="Order" description="Rounds × teams" />
        {board.rounds === 0 || board.teams.length === 0 ? (
          <CardBody>
            <EmptyState
              title="No draft order yet"
              description="The board is generated when the commissioner starts the draft."
            />
          </CardBody>
        ) : (
          <div className="w-full overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="border-b border-line">
                  <th className="sticky left-0 z-10 bg-surface px-2 py-2 text-left font-mono text-[10px] uppercase tracking-wider text-ink-faint">
                    R
                  </th>
                  {board.teams.map((team) => (
                    <th
                      key={team.id}
                      className="px-2 py-2 text-left font-mono text-[10px] uppercase tracking-wider text-ink-faint"
                      title={team.name}
                    >
                      {team.abbreviation}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {board.grid.map((row, roundIndex) => (
                  <tr key={roundIndex}>
                    <td className="sticky left-0 z-10 bg-surface px-2 py-1.5 font-mono text-[10px] text-ink-faint">
                      {roundIndex + 1}
                    </td>
                    {row.map((pick, slotIndex) => {
                      const onClock =
                        board.onTheClock && pick && pick.overallNo === board.onTheClock.overallNo;
                      return (
                        <td
                          key={slotIndex}
                          className={
                            onClock
                              ? "border-l border-line bg-accent-soft px-2 py-1.5 align-top"
                              : "border-l border-line px-2 py-1.5 align-top"
                          }
                        >
                          {pick?.playerName ? (
                            <span className="block">
                              <span className="block truncate text-[11px] text-ink">
                                {pick.playerName}
                              </span>
                              <span className="block font-mono text-[9px] text-ink-faint">
                                {pick.position}
                                {pick.nflTeam ? ` · ${pick.nflTeam}` : ""}
                                {pick.price !== null ? ` · $${pick.price}` : ""}
                                {pick.auto ? " · auto" : ""}
                              </span>
                            </span>
                          ) : onClock ? (
                            <span className="font-mono text-[10px] text-accent-strong">
                              on the clock
                            </span>
                          ) : (
                            <span className="font-mono text-[10px] text-ink-faint">—</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <CardFooter>
          Row = round, column = draft slot. The highlighted cell is on the clock.
        </CardFooter>
      </Card>

      <Card>
        <CardHeader title="Picks" description="Newest first, with the agent's rationale" />
        <CardBody className="space-y-3">
          {madePicks.length === 0 ? (
            <p className="text-sm text-ink-muted">No picks yet.</p>
          ) : (
            madePicks.map((pick) => (
              <div key={pick.id} className="border-b border-line pb-3 last:border-0 last:pb-0">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm text-ink">
                    <span className="font-mono text-xs text-ink-faint">
                      {pick.round}.{String(pick.pickNo).padStart(2, "0")}
                    </span>{" "}
                    <span className="font-medium">{pick.playerName}</span>{" "}
                    <span className="font-mono text-[10px] text-ink-faint">
                      {pick.position}
                      {pick.nflTeam ? ` · ${pick.nflTeam}` : ""}
                    </span>
                  </span>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Link href={`/leagues/${leagueId}/teams/${pick.teamId}`}>
                      <Badge tone="neutral">{pick.teamAbbreviation}</Badge>
                    </Link>
                    {pick.price !== null ? <Badge tone="outline">${pick.price}</Badge> : null}
                    {pick.auto ? <Badge tone="warning">auto-pick</Badge> : null}
                    {pick.costUsd !== null ? (
                      <Badge tone="outline">${pick.costUsd.toFixed(4)}</Badge>
                    ) : null}
                    {pick.runId ? (
                      <Link
                        href={`/leagues/${leagueId}/traces/${pick.runId}`}
                        className="font-mono text-[10px] text-ink-muted hover:text-accent-strong"
                      >
                        trace →
                      </Link>
                    ) : null}
                  </span>
                </div>
                {pick.rationale ? (
                  <p className="mt-1.5 text-xs leading-relaxed text-ink-muted">{pick.rationale}</p>
                ) : null}
              </div>
            ))
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function Stat({
  label,
  value,
  detail,
  accent = false,
}: {
  label: string;
  value: string;
  detail: string;
  accent?: boolean;
}) {
  return (
    <div
      className={
        accent
          ? "rounded-lg border border-accent/40 bg-accent-soft px-4 py-3"
          : "rounded-lg border border-line bg-surface px-4 py-3"
      }
    >
      <div className="eyebrow">{label}</div>
      <div className="mt-1 truncate text-sm font-medium text-ink">{value}</div>
      <div className="mt-0.5 font-mono text-[10px] text-ink-faint">{detail}</div>
    </div>
  );
}
