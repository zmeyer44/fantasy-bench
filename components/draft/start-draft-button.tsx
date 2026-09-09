"use client";

import { useMutation } from "convex/react";
import { useState } from "react";

import { mutationErrorMessage } from "@/components/league/convex-errors";
import {
  Alert,
  AlertDescription,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { DraftBoardData } from "@/components/draft/draft-board";

/** Commissioner-only: flip the league to `drafting` and lock the rules. */
export function StartDraftButton({
  leagueId,
  draftType,
  review,
  scheduledAt = null,
}: {
  leagueId: string;
  draftType: "snake" | "auction";
  review: DraftBoardData["startReview"];
  scheduledAt?: number | null;
}) {
  const startDraft = useMutation(api.commissioner.startDraft);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setPending(true);
    setError(null);
    try {
      // The league page reads `leagues.get` live, so the new status arrives on
      // its own — there is nothing to refresh.
      await startDraft({ leagueId: leagueId as Id<"leagues">, scheduledAt });
      setOpen(false);
    } catch (err) {
      setError(mutationErrorMessage(err));
    } finally {
      setPending(false);
    }
  }

  const paidTeams = review.modelAssignments
    .filter((assignment) => assignment.paid)
    .reduce((sum, assignment) => sum + assignment.teamCount, 0);
  const clockLabel = `${Math.floor(review.draftPickSeconds / 60)}m ${review.draftPickSeconds % 60}s`;
  const scoringLabel = review.scoringPreset === "half_ppr"
    ? "Half PPR"
    : review.scoringPreset === "ppr"
      ? "PPR"
      : "Standard";

  return (
    <>
      <div className="flex flex-col items-end gap-1.5">
        <Button type="button" variant="brand" size="sm" onClick={() => setOpen(true)}>
          Review and start
        </Button>
        <p className="text-xs text-muted-foreground">This locks the rule set.</p>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Review and start {draftType} draft</DialogTitle>
            <DialogDescription>
              Check the season setup before the agents go on the clock. Starting freezes scoring
              and roster rules for the season.
            </DialogDescription>
          </DialogHeader>

          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 border-y border-border py-4 text-sm">
            <ReviewRow label="Format" value={draftType === "auction" ? "Auction · sealed bids" : "Snake"} />
            <ReviewRow label="Teams" value={String(review.teamCount)} />
            <ReviewRow
              label="Scoring"
              value={`${scoringLabel}${review.tePremium ? " · TE premium" : ""}`}
            />
            <ReviewRow
              label="Roster"
              value={`${review.rosterSize} per team · ${review.totalRosterSpots} total${review.superflex ? " · Superflex" : ""}`}
            />
            <ReviewRow
              label="Clock"
              value={`${clockLabel} per ${draftType === "auction" ? "phase" : "pick"}`}
            />
            {draftType === "auction" ? (
              <ReviewRow label="Draft budget" value={`$${review.draftBudget} per team`} />
            ) : null}
            <ReviewRow
              label="Models"
              value={review.modelAssignments
                .map((assignment) => `${assignment.modelId} × ${assignment.teamCount}`)
                .join(", ")}
            />
          </dl>

          {review.unownedTeams > 0 || paidTeams > 0 ? (
            <Alert variant="warning">
              <AlertDescription className="space-y-1">
                {review.unownedTeams > 0 ? (
                  <p>
                    {review.unownedTeams} unowned team{review.unownedTeams === 1 ? "" : "s"} will
                    draft with the configured default agents.
                  </p>
                ) : null}
                {paidTeams > 0 ? (
                  <p>
                    {paidTeams} team{paidTeams === 1 ? "" : "s"} use paid models. Draft runs count
                    toward league or owner spend limits.
                  </p>
                ) : null}
              </AlertDescription>
            </Alert>
          ) : null}

          {error ? (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="button" variant="brand" disabled={pending} onClick={() => void submit()}>
              {pending ? "Starting…" : `Start ${draftType} draft`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">{label}</dt>
      <dd className="mt-1 break-words text-foreground">{value}</dd>
    </div>
  );
}
