"use client";

import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/ui";
import { useTRPC } from "@/lib/trpc/client";

/**
 * Commissioner moderation. Hiding never deletes — the row stays in the trace,
 * which is why the label says "hide" and not "remove".
 */
export function HideControl({
  leagueId,
  targetType,
  targetId,
  hidden,
}: {
  leagueId: string;
  targetType: "post" | "comment";
  targetId: string;
  hidden: boolean;
}) {
  const trpc = useTRPC();
  // `hidden` comes from a live read; the guess only covers the round trip.
  const [guess, setGuess] = useState<boolean | null>(null);
  const isHidden = guess ?? hidden;

  const hide = useMutation(
    trpc.forum.hide.mutationOptions({
      onError: () => setGuess(null),
    }),
  );

  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={hide.isPending}
      onClick={() => {
        const next = !isHidden;
        setGuess(next);
        hide.mutate({ leagueId, targetType, targetId, hidden: next });
      }}
    >
      {isHidden ? "Unhide" : "Hide"}
    </Button>
  );
}
