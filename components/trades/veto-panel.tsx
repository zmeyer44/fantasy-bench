"use client";

import { useMutation } from "convex/react";
import { useState } from "react";

import { mutationErrorMessage } from "@/components/league/convex-errors";
import {
  Button,
  Field,
  FieldDescription,
  FieldError,
  FieldTitle,
  Progress,
  cn,
} from "@/components/ui";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { VetoTally } from "@/convex/trades";

/**
 * Owner veto panel for a flagged trade under review.
 *
 * The tally and the viewer's own vote come from the live `trades.get`
 * subscription above, so several owners voting at once converge without a
 * refetch here; the click is still optimistic so it feels immediate.
 */
export function VetoPanel({
  leagueId,
  tradeId,
  tally,
  myVote,
  canVote,
}: {
  leagueId: string;
  tradeId: string;
  tally: VetoTally;
  myVote: "veto" | "approve" | null;
  canVote: boolean;
}) {
  const castVeto = useMutation(api.trades.castVeto);
  const [optimistic, setOptimistic] = useState<"veto" | "approve" | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The server's answer wins as soon as the subscription reports it.
  const vote = optimistic ?? myVote;

  const submit = async (next: "veto" | "approve") => {
    setOptimistic(next);
    setError(null);
    setPending(true);
    try {
      await castVeto({
        leagueId: leagueId as Id<"leagues">,
        tradeId: tradeId as Id<"trades">,
        vote: next,
      });
    } catch (mutationError) {
      setOptimistic(null);
      setError(mutationErrorMessage(mutationError));
    } finally {
      setPending(false);
    }
  };

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        // Both buttons act on their own; nothing to submit.
        event.preventDefault();
      }}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span
          className={cn(
            "font-mono text-sm tabular-nums",
            tally.blocked ? "text-destructive" : "text-foreground",
          )}
        >
          {tally.vetoes} / {tally.threshold}
        </span>
        <span className="text-sm text-muted-foreground">vetoes needed to block</span>
      </div>

      <Progress
        value={tally.vetoes}
        max={Math.max(1, tally.threshold)}
        aria-label="Vetoes cast against the threshold"
        className={cn(
          tally.blocked
            ? "[&_[data-slot=progress-indicator]]:bg-destructive"
            : "[&_[data-slot=progress-indicator]]:bg-warning",
        )}
      />

      <p className="font-mono text-[10px] tabular-nums text-ink-faint">
        {tally.ownerCount} owner{tally.ownerCount === 1 ? "" : "s"} · {tally.approvals} explicit
        approval{tally.approvals === 1 ? "" : "s"}
      </p>

      {canVote ? (
        <Field>
          <FieldTitle>Your vote</FieldTitle>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant={vote === "veto" ? "destructive" : "outline"}
              disabled={pending}
              aria-pressed={vote === "veto"}
              onClick={() => void submit("veto")}
            >
              {vote === "veto" ? "Vetoed" : "Veto"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={vote === "approve" ? "default" : "outline"}
              disabled={pending}
              aria-pressed={vote === "approve"}
              onClick={() => void submit("approve")}
            >
              {vote === "approve" ? "Approved" : "Let it stand"}
            </Button>
          </div>
          <FieldDescription>
            A vote can be changed until the review window closes.
          </FieldDescription>
          {error ? <FieldError>{error}</FieldError> : null}
        </Field>
      ) : (
        <p className="text-sm text-muted-foreground">
          Only league owners vote on a flagged trade.
        </p>
      )}
    </form>
  );
}
