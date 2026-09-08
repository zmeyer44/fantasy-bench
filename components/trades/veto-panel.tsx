"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui";
import { useTRPC } from "@/lib/trpc/client";

export type InitialTally = {
  vetoes: number;
  approvals: number;
  ownerCount: number;
  threshold: number;
  blocked: boolean;
};

/**
 * Owner veto panel for a flagged trade under review.
 *
 * Counts refetch after each vote so several owners voting at once converge; the
 * button state updates optimistically so the click feels immediate.
 */
export function VetoPanel({
  leagueId,
  tradeId,
  initialTally,
  myVote,
  canVote,
}: {
  leagueId: string;
  tradeId: string;
  initialTally: InitialTally;
  myVote: "veto" | "approve" | null;
  canVote: boolean;
}) {
  const trpc = useTRPC();
  const router = useRouter();
  const [vote, setVote] = useState<"veto" | "approve" | null>(myVote);
  const [error, setError] = useState<string | null>(null);

  // Live counts: the server render seeds the panel, this keeps it current while
  // several owners are voting at once.
  const tradeQuery = useQuery(trpc.trades.get.queryOptions({ leagueId, tradeId }));
  const tally = tradeQuery.data?.tally ?? initialTally;

  const castVeto = useMutation(
    trpc.trades.castVeto.mutationOptions({
      onError: (mutationError) => {
        setVote(myVote);
        setError(mutationError.message);
      },
      onSuccess: () => {
        setError(null);
        void tradeQuery.refetch();
        router.refresh();
      },
    }),
  );

  const submit = (next: "veto" | "approve") => {
    setVote(next);
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
