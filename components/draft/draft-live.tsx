"use client";

import { usePreloadedQuery, type Preloaded } from "convex/react";

import { DraftBoardView } from "@/components/draft/draft-board";
import { StartDraftButton } from "@/components/draft/start-draft-button";
import { Alert, AlertDescription, Badge, PageHeader } from "@/components/ui";
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
    <div className="space-y-8">
      <PageHeader
        eyebrow={`${board.draftType} draft`}
        title="Draft board"
        description={
          <>
            {board.scheduledAt
              ? `Scheduled ${formatET(board.scheduledAt, "EEE MMM d, HH:mm")} ET.`
              : "No draft time set."}{" "}
            {board.draftType === "auction"
              ? "Every resolved lot links to the run behind the winning bid."
              : "Every pick links to the run that made it."}
          </>
        }
        actions={
          <div className="flex flex-col items-end gap-2">
            {live ? (
              <span className="flex items-center gap-1.5 font-mono text-[11px] text-brand">
                <span className="inline-block size-1.5 animate-pulse rounded-full bg-brand" />
                live · updates as picks land
              </span>
            ) : (
              <Badge variant="outline">{board.status.replace("_", " ")}</Badge>
            )}
            {isCommissioner && board.status === "setup" ? (
              <StartDraftButton
                leagueId={leagueId}
                draftType={board.draftType}
                review={board.startReview}
              />
            ) : null}
          </div>
        }
      />

      {board.status === "setup" ? (
        <Alert>
          <AlertDescription>
            The draft has not started.{" "}
            {isCommissioner
              ? "Starting it locks the rule set (budgets, conduct settings and the model allowlist stay editable)."
              : "The commissioner starts it from the settings console."}
          </AlertDescription>
        </Alert>
      ) : null}

      <DraftBoardView leagueId={leagueId} board={board} />
    </div>
  );
}
