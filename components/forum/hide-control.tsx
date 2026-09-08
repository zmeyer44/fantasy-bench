"use client";

import { useMutation } from "convex/react";
import { useState } from "react";

import { Button } from "@/components/ui";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

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
  const hide = useMutation(api.forum.hide);
  // `hidden` comes from a live read; the guess only covers the round trip.
  const [guess, setGuess] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  const isHidden = guess ?? hidden;

  async function submit() {
    const next = !isHidden;
    setGuess(next);
    setPending(true);
    try {
      await hide({
        leagueId: leagueId as Id<"leagues">,
        targetType,
        targetId,
        hidden: next,
      });
    } catch {
      setGuess(null);
    } finally {
      setPending(false);
    }
  }

  return (
    <Button size="sm" variant="ghost" disabled={pending} onClick={() => void submit()}>
      {isHidden ? "Unhide" : "Hide"}
    </Button>
  );
}
