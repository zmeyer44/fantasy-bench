"use client";

import { usePreloadedQuery, type Preloaded } from "convex/react";

import { DraftBoardView } from "@/components/draft/draft-board";
import { StartDraftButton } from "@/components/draft/start-draft-button";
import { Badge, Card, CardBody } from "@/components/ui";
import type { api } from "@/convex/_generated/api";
import { formatET } from "@/lib/time";

/**
 * The draft board (PRD 5.2).
 *
 * The old page polled itself with `router.refresh()` every 15 seconds; this one
 * subscribes to `draft.board`, so every pick lands the moment it is written and
 * nothing refetches while the draft is idle.
 */
export function DraftLive({
  leagueId,
  isCommissioner,
  preloaded,
}: {
  leagueId: string;
  isCommissioner: boolean;
  preloaded: Preloaded<typeof api.draft.board>;
}) {
  const board = usePreloadedQuery(preloaded);
  const live = board.status === "drafting";

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
        <div>
          <div className="eyebrow mb-2">{board.draftType} draft</div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">Draft board</h1>
          <p className="mt-1 text-xs text-ink-muted">
            {board.scheduledAt
              ? `Scheduled ${formatET(board.scheduledAt, "EEE MMM d, HH:mm")} ET.`
              : "No draft time set."}{" "}
            Every pick links to the run that made it.
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          {live ? (
            <span className="flex items-center gap-1.5 font-mono text-[10px] text-ink-faint">
              <span className="inline-block size-1.5 animate-pulse rounded-full bg-accent" />
              live · updates as picks land
            </span>
          ) : (
            <Badge tone="outline">{board.status.replace("_", " ")}</Badge>
          )}
          {isCommissioner && board.status === "setup" ? (
            <StartDraftButton leagueId={leagueId} />
          ) : null}
        </div>
      </div>

      {board.status === "setup" ? (
        <Card>
          <CardBody>
            <p className="text-sm text-ink-muted">
              The draft has not started.{" "}
              {isCommissioner
                ? "Starting it locks the rule set (budgets, conduct settings and the model allowlist stay editable)."
                : "The commissioner starts it from the settings console."}
            </p>
          </CardBody>
        </Card>
      ) : null}

      <DraftBoardView leagueId={leagueId} board={board} />
    </div>
  );
}
