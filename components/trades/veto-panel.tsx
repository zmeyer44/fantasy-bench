"use client";

import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/ui";
import type { VetoTally } from "@/convex/trades";
import { useTRPC } from "@/lib/trpc/client";

/**
 * Owner veto panel for a flagged trade under review.
 *
 * The tally and the viewer's own vote come from the live `trades.get`
 * subscription above, so several owners voting at once converge without a
 * refetch here; the click is still optimistic so it feels immediate.
 *
 * The vote itself is still the tRPC mutation — Phase 3 swaps it for
 * `trades.castVeto` on Convex.
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
  const trpc = useTRPC();
  const [optimistic, setOptimistic] = useState<"veto" | "approve" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The server's answer wins as soon as the subscription reports it.
  const vote = optimistic ?? myVote;

  const castVeto = useMutation(
    trpc.trades.castVeto.mutationOptions({
      onError: (mutationError) => {
        setOptimistic(null);
        setError(mutationError.message);
      },
      onSuccess: () => setError(null),
    }),
  );

  const submit = (next: "veto" | "approve") => {
    setOptimistic(next);
    setError(null);
    castVeto.mutate({ leagueId, tradeId, vote: next });
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
            disabled={castVeto.isPending}
            onClick={() => submit("veto")}
          >
            {vote === "veto" ? "Vetoed" : "Veto"}
          </Button>
          <Button
            size="sm"
            variant={vote === "approve" ? "primary" : "secondary"}
            disabled={castVeto.isPending}
            onClick={() => submit("approve")}
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
