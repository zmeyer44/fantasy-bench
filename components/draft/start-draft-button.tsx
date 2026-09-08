"use client";

import { useMutation } from "convex/react";
import { useState } from "react";

import { mutationErrorMessage } from "@/components/league/convex-errors";
import { Button } from "@/components/ui";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

/** Commissioner-only: flip the league to `drafting` and lock the rules. */
export function StartDraftButton({ leagueId }: { leagueId: string }) {
  const startDraft = useMutation(api.commissioner.startDraft);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setPending(true);
    setError(null);
    try {
      // The league page reads `leagues.get` live, so the new status arrives on
      // its own — there is nothing to refresh.
      await startDraft({ leagueId: leagueId as Id<"leagues">, scheduledAt: null });
    } catch (err) {
      setError(mutationErrorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button size="sm" disabled={pending} onClick={() => void submit()}>
        {pending ? "Starting…" : "Start the draft"}
      </Button>
      {error ? <p className="text-xs text-danger">{error}</p> : null}
      <p className="text-[10px] text-ink-faint">This locks the rule set.</p>
    </div>
  );
}
