"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePreloadedQuery, type Preloaded } from "convex/react";

import {
  Badge,
  Button,
  EmptyState,
  Stat,
  StatStrip,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui";
import type { api } from "@/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import { formatET } from "@/lib/time";

type WaiverStatus = FunctionReturnType<typeof api.waivers.results>["results"][number]["status"];
type BadgeVariant = "success" | "secondary" | "destructive" | "outline";

const VARIANTS: Record<WaiverStatus, BadgeVariant> = {
  won: "success",
  lost: "secondary",
  invalid: "destructive",
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
    <div className="space-y-8">
      <StatStrip className="sm:grid-cols-3">
        <Stat label="Claims this week" value={String(view.results.length)} />
        <Stat label="Won" value={String(view.results.filter((row) => row.status === "won").length)} />
        <Stat label="Pending league-wide" value={String(view.pendingCount)} />
      </StatStrip>

      <section>
        <SectionRule
          title={`Week ${weekNo} waivers`}
          meta={
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
          <div className="mt-4">
            <EmptyState
              title="No claims"
              description="Agents submit FAAB bids during the Tuesday waiver window."
            />
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Team</TableHead>
                <TableHead>Add</TableHead>
                <TableHead>Drop</TableHead>
                <TableHead numeric>Bid</TableHead>
                <TableHead>Result</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Trace</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.results.map((row) => (
                <TableRow key={row.claimId}>
                  <TableCell>
                    <Link
                      href={`/leagues/${leagueId}/teams/${row.teamId}`}
                      className="text-sm hover:text-brand-strong"
                    >
                      {row.teamName}
                    </Link>
                  </TableCell>
                  <TableCell className="text-sm">
                    {row.addPlayerName}
                    <span className="ml-1.5 font-mono text-[10px] text-ink-faint">
                      {row.addPlayerPosition}
                    </span>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {row.dropPlayerName ?? "—"}
                  </TableCell>
                  <TableCell numeric className="font-mono text-xs">
                    ${row.bid}
                  </TableCell>
                  <TableCell>
                    <Badge variant={VARIANTS[row.status]}>{row.status}</Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {row.resultReason ?? "—"}
                  </TableCell>
                  <TableCell>
                    {row.runId ? (
                      <Link
                        href={`/leagues/${leagueId}/traces/${row.runId}`}
                        className="font-mono text-[10px] text-muted-foreground hover:text-brand-strong"
                      >
                        trace →
                      </Link>
                    ) : (
                      <span className="font-mono text-[10px] text-ink-faint">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      <section>
        <SectionRule title="FAAB" meta="Remaining budget and total won bids" />
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Team</TableHead>
              <TableHead numeric>Remaining</TableHead>
              <TableHead numeric>Spent on won claims</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.faab.map((row) => (
              <TableRow key={row.teamId}>
                <TableCell>
                  <Link
                    href={`/leagues/${leagueId}/teams/${row.teamId}`}
                    className="text-sm hover:text-brand-strong"
                  >
                    {row.teamName}
                  </Link>
                </TableCell>
                <TableCell numeric className="font-mono text-xs">
                  ${row.remaining}
                </TableCell>
                <TableCell numeric className="font-mono text-xs text-muted-foreground">
                  ${row.spent}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>
    </div>
  );
}

function SectionRule({
  title,
  meta,
  action,
}: {
  title: string;
  meta?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border pb-2.5">
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 className="eyebrow text-foreground">{title}</h2>
        {meta ? <span className="text-xs text-muted-foreground">{meta}</span> : null}
      </div>
      {action}
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
        <Button
          key={week}
          size="xs"
          variant={week === weekNo ? "secondary" : "ghost"}
          aria-current={week === weekNo ? "page" : undefined}
          className="font-mono tabular-nums"
          render={<Link href={`/leagues/${leagueId}/waivers?week=${week}`} />}
        >
          {week}
        </Button>
      ))}
    </div>
  );
}
