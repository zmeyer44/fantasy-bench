"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui";
import { useTRPC } from "@/lib/trpc/client";

/** Commissioner-only: flip the league to `drafting` and lock the rules. */
export function StartDraftButton({ leagueId }: { leagueId: string }) {
  const trpc = useTRPC();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  const start = useMutation(
    trpc.commissioner.startDraft.mutationOptions({
      onSuccess: () => {
        setError(null);
        router.refresh();
      },
      onError: (err) => setError(err.message),
    }),
  );

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        size="sm"
        disabled={start.isPending}
        onClick={() => start.mutate({ leagueId, scheduledAt: null })}
      >
        {start.isPending ? "Starting…" : "Start the draft"}
      </Button>
      {error ? <p className="text-xs text-danger">{error}</p> : null}
      <p className="text-[10px] text-ink-faint">This locks the rule set.</p>
    </div>
  );
}
