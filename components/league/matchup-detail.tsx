"use client";

import Link from "next/link";
import { usePreloadedQuery, type Preloaded } from "convex/react";

import {
  Badge,
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
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-line bg-surface px-4 py-4">
        <Score side={page.away} isFinal={page.isFinal} align="left" />
        <div className="text-center">
          <div className="eyebrow">Week {weekNo}</div>
          <div className="mt-1">
            {page.isFinal ? <Badge tone="neutral">final</Badge> : <Badge tone="accent">live</Badge>}
          </div>
        </div>
        <Score side={page.home} isFinal={page.isFinal} align="right" />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <SideCard leagueId={leagueId} side={page.away} />
        <SideCard leagueId={leagueId} side={page.home} />
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
      <div className="text-sm font-medium text-ink">{side.teamName}</div>
      <div className="font-mono text-[10px] text-ink-faint">
        {side.record} · proj {side.projectedTotal.toFixed(1)}
      </div>
      <div className="mt-1 font-mono text-2xl tabular-nums text-ink">{points.toFixed(1)}</div>
    </div>
  );
}

function SideCard({ leagueId, side }: { leagueId: string; side: MatchupTeamView }) {
  const starters = side.slots.filter((slot) => slot.starting);
  const bench = side.slots.filter((slot) => !slot.starting);

  return (
    <Card>
      <CardHeader
        title={
          <Link
            href={`/leagues/${leagueId}/teams/${side.teamId}`}
            className="hover:text-accent-strong"
          >
            {side.teamName}
          </Link>
        }
        description={
          side.lineupSource ? `Lineup set by ${side.lineupSource.replace("_", " ")}` : undefined
        }
        action={
          side.rationale ? (
            <Link
              href={`/leagues/${leagueId}/traces/${side.rationale.runId}`}
              className="text-xs text-ink-muted hover:text-accent-strong"
            >
              Trace →
            </Link>
          ) : null
        }
      />

      {side.rationale?.excerpt ? (
        <CardBody className="border-b border-line bg-surface-muted/50">
          <p className="text-xs leading-relaxed text-ink-muted">
            <span className="eyebrow mr-2">{side.rationale.windowLabel}</span>
            {side.rationale.excerpt}
          </p>
        </CardBody>
      ) : null}

      <SlotRows rows={starters} />

      {bench.length > 0 ? (
        <>
          <div className="border-t border-line px-4 py-2">
            <span className="eyebrow">Bench</span>
          </div>
          <SlotRows rows={bench} muted />
        </>
      ) : null}

      <CardFooter className="flex justify-between">
        <span>
          Projected <span className="font-mono text-ink">{side.projectedTotal.toFixed(1)}</span>
        </span>
        <span>
          Points <span className="font-mono text-ink">{side.liveTotal.toFixed(1)}</span>
        </span>
      </CardFooter>
    </Card>
  );
}

function SlotRows({ rows, muted = false }: { rows: MatchupTeamView["slots"]; muted?: boolean }) {
  if (rows.length === 0) {
    return (
      <CardBody>
        <p className="text-sm text-ink-muted">No lineup recorded.</p>
      </CardBody>
    );
  }
  return (
    <Table>
      <THead>
        <TR>
          <TH>Slot</TH>
          <TH>Player</TH>
          <TH>Kickoff</TH>
          <TH numeric>Proj</TH>
          <TH numeric>Pts</TH>
        </TR>
      </THead>
      <TBody>
        {rows.map((slot, index) => (
          <TR key={`${slot.slot}-${slot.playerId ?? index}`} className={muted ? "opacity-70" : ""}>
            <TD className="font-mono text-[10px] uppercase text-ink-faint">{slot.slot}</TD>
            <TD>
              {slot.playerName ? (
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm text-ink">{slot.playerName}</span>
                  <span className="font-mono text-[10px] text-ink-faint">
                    {slot.position}
                    {slot.nflTeam ? ` · ${slot.nflTeam}` : ""}
                    {slot.opponent ? ` vs ${slot.opponent}` : ""}
                  </span>
                  {slot.injuryStatus ? <Badge tone="danger">{slot.injuryStatus}</Badge> : null}
                </span>
              ) : (
                <span className="text-sm text-ink-faint">— empty —</span>
              )}
            </TD>
            <TD className="font-mono text-[10px] text-ink-muted">
              {slot.kickoffAt ? formatET(slot.kickoffAt, "EEE HH:mm") : "—"}
            </TD>
            <TD numeric className="font-mono text-xs text-ink-muted">
              {slot.projection?.toFixed(1) ?? "—"}
            </TD>
            <TD numeric className="font-mono text-xs text-ink">
              {slot.points?.toFixed(1) ?? "—"}
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}
