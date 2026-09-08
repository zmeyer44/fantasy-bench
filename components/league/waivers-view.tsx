"use client";

import Link from "next/link";
import { usePreloadedQuery, type Preloaded } from "convex/react";

import {
  Badge,
  Card,
  CardBody,
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

type WaiverStatus = FunctionReturnType<typeof api.waivers.results>["results"][number]["status"];

const TONES: Record<WaiverStatus, "accent" | "neutral" | "danger" | "outline"> = {
  won: "accent",
  lost: "neutral",
  invalid: "danger",
  pending: "outline",
};

/** Waiver outcomes for one league week, live off `waivers.results`. */
export function WaiversView({
  leagueId,
  weekNo,
  preloaded,
}: {
  leagueId: string;
  weekNo: number;
  preloaded: Preloaded<typeof api.waivers.results>;
}) {
  const view = usePreloadedQuery(preloaded);
  const weeks = view.weeksWithClaims.length > 0 ? view.weeksWithClaims : [weekNo];

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Claims this week" value={String(view.results.length)} />
        <Stat
          label="Won"
          value={String(view.results.filter((row) => row.status === "won").length)}
        />
        <Stat label="Pending league-wide" value={String(view.pendingCount)} />
      </div>

      <Card>
        <CardHeader
          title={`Week ${weekNo} waivers`}
          description={
            view.window
              ? `Window ${formatET(view.window.opensAt, "EEE HH:mm")} → ${formatET(
                  view.window.closesAt,
                  "EEE HH:mm",
                )} ET · ${view.window.status}`
              : "No waiver window recorded for this week."
          }
          action={<WeekLinks leagueId={leagueId} weekNo={weekNo} weeks={weeks} />}
        />
        {view.results.length === 0 ? (
          <CardBody>
            <EmptyState
              title="No claims"
              description="Agents submit FAAB bids during the Tuesday waiver window."
            />
          </CardBody>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Team</TH>
                <TH>Add</TH>
                <TH>Drop</TH>
                <TH numeric>Bid</TH>
                <TH>Result</TH>
                <TH>Reason</TH>
                <TH>Trace</TH>
              </TR>
            </THead>
            <TBody>
              {view.results.map((row) => (
                <TR key={row.claimId}>
                  <TD>
                    <Link
                      href={`/leagues/${leagueId}/teams/${row.teamId}`}
                      className="text-sm hover:text-accent-strong"
                    >
                      {row.teamName}
                    </Link>
                  </TD>
                  <TD className="text-sm">
                    {row.addPlayerName}
                    <span className="ml-1.5 font-mono text-[10px] text-ink-faint">
                      {row.addPlayerPosition}
                    </span>
                  </TD>
                  <TD className="text-sm text-ink-muted">{row.dropPlayerName ?? "—"}</TD>
                  <TD numeric className="font-mono text-xs">
                    ${row.bid}
                  </TD>
                  <TD>
                    <Badge tone={TONES[row.status]}>{row.status}</Badge>
                  </TD>
                  <TD className="text-xs text-ink-muted">{row.resultReason ?? "—"}</TD>
                  <TD>
                    {row.runId ? (
                      <Link
                        href={`/leagues/${leagueId}/traces/${row.runId}`}
                        className="font-mono text-[10px] text-ink-muted hover:text-accent-strong"
                      >
                        trace →
                      </Link>
                    ) : (
                      <span className="font-mono text-[10px] text-ink-faint">—</span>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <Card>
        <CardHeader title="FAAB" description="Remaining budget and total won bids" />
        <Table>
          <THead>
            <TR>
              <TH>Team</TH>
              <TH numeric>Remaining</TH>
              <TH numeric>Spent on won claims</TH>
            </TR>
          </THead>
          <TBody>
            {view.faab.map((row) => (
              <TR key={row.teamId}>
                <TD>
                  <Link
                    href={`/leagues/${leagueId}/teams/${row.teamId}`}
                    className="text-sm hover:text-accent-strong"
                  >
                    {row.teamName}
                  </Link>
                </TD>
                <TD numeric className="font-mono text-xs">
                  ${row.remaining}
                </TD>
                <TD numeric className="font-mono text-xs text-ink-muted">
                  ${row.spent}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3">
      <div className="eyebrow">{label}</div>
      <div className="mt-1 font-mono text-lg tabular-nums text-ink">{value}</div>
    </div>
  );
}

/** The waivers page keys off `?week=`, not a path segment, so it links rather than routes. */
function WeekLinks({
  leagueId,
  weekNo,
  weeks,
}: {
  leagueId: string;
  weekNo: number;
  weeks: number[];
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {weeks.slice(0, 10).map((week) => (
        <Link
          key={week}
          href={`/leagues/${leagueId}/waivers?week=${week}`}
          className={
            week === weekNo
              ? "rounded border border-accent bg-accent-soft px-1.5 py-0.5 font-mono text-[10px] text-accent-strong"
              : "rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-ink-muted hover:border-line-strong hover:text-ink"
          }
        >
          {week}
        </Link>
      ))}
    </div>
  );
}
