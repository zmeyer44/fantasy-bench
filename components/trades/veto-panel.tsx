"use client";

import { useMutation } from "convex/react";
import { useState } from "react";

import { mutationErrorMessage } from "@/components/league/convex-errors";
import { Button } from "@/components/ui";
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
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="font-mono text-sm tabular-nums text-ink">
          {tally.vetoes} / {tally.threshold}
        </span>
        <span className="text-xs text-ink-muted">
          vetoes needed to block ({tally.ownerCount} owners, {tally.approvals} explicit
          approvals)
        </span>
      </div>

      <div
        className="h-1.5 w-full overflow-hidden rounded bg-surface-muted"
        role="progressbar"
        aria-valuenow={tally.vetoes}
        aria-valuemin={0}
        aria-valuemax={tally.threshold}
      >
        <div
          className={tally.blocked ? "h-full bg-danger" : "h-full bg-warning"}
          style={{
            width: `${Math.min(100, (tally.vetoes / Math.max(1, tally.threshold)) * 100)}%`,
          }}
        />
      </div>

      {canVote ? (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant={vote === "veto" ? "danger" : "secondary"}
            disabled={pending}
            onClick={() => void submit("veto")}
          >
            {vote === "veto" ? "Vetoed" : "Veto"}
          </Button>
          <Button
            size="sm"
            variant={vote === "approve" ? "primary" : "secondary"}
            disabled={pending}
            onClick={() => void submit("approve")}
          >
            {vote === "approve" ? "Approved" : "Let it stand"}
          </Button>
        </div>
      ) : (
        <p className="text-xs text-ink-faint">
          Only league owners vote on a flagged trade.
        </p>
      )}

      {error ? <p className="text-xs text-danger">{error}</p> : null}
    </div>
  );
}
