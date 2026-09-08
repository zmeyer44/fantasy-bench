"use client";

import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { cn } from "@/components/ui";
import { useTRPC } from "@/lib/trpc/client";

/**
 * Up/down votes. The score moves the moment you click and rolls back if the
 * mutation fails — humans vote a lot and a round trip per click reads as lag.
 * `score` and `myVote` come from a live Convex read, so once the mutation
 * lands the local guess and the server agree and the adjustment cancels out.
 *
 * Signed-out spectators see the score but the arrows are inert.
 */
export function VoteButtons({
  leagueId,
  targetType,
  targetId,
  score,
  myVote,
  canVote,
  orientation = "vertical",
}: {
  leagueId: string;
  targetType: "post" | "comment";
  targetId: string;
  score: number;
  myVote: 1 | -1 | 0;
  canVote: boolean;
  orientation?: "vertical" | "horizontal";
}) {
  const trpc = useTRPC();
  // The click's guess, kept until the subscription reports the same thing.
  const [guess, setGuess] = useState<1 | -1 | 0 | null>(null);
  const current = guess ?? myVote;
  const displayScore = guess === null ? score : score - myVote + guess;

  const vote = useMutation(
    trpc.forum.vote.mutationOptions({
      onError: () => setGuess(null),
    }),
  );

  const click = (direction: 1 | -1) => {
    if (!canVote) return;
    const next: 1 | -1 | 0 = current === direction ? 0 : direction;
    setGuess(next);
    vote.mutate({ leagueId, targetType, targetId, direction: next });
  };

  return (
    <div
      className={cn(
        "flex items-center gap-0.5",
        orientation === "vertical" ? "flex-col" : "flex-row",
      )}
    >
      <Arrow
        direction="up"
        active={current === 1}
        disabled={!canVote || vote.isPending}
        onClick={() => click(1)}
      />
      <span
        className={cn(
          "min-w-6 text-center font-mono text-xs tabular-nums",
          current === 1
            ? "text-accent-strong"
            : current === -1
              ? "text-danger"
              : "text-ink-muted",
        )}
      >
        {displayScore}
      </span>
      <Arrow
        direction="down"
        active={current === -1}
        disabled={!canVote || vote.isPending}
        onClick={() => click(-1)}
      />
    </div>
  );
}

function Arrow({
  direction,
  active,
  disabled,
  onClick,
}: {
  direction: "up" | "down";
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={direction === "up" ? "Upvote" : "Downvote"}
      aria-pressed={active}
      className={cn(
        "flex h-5 w-5 items-center justify-center rounded text-xs transition-colors",
        disabled
          ? "cursor-default text-ink-faint/60"
          : "hover:bg-surface-muted hover:text-ink",
        active
          ? direction === "up"
            ? "text-accent-strong"
            : "text-danger"
          : "text-ink-faint",
      )}
    >
      {direction === "up" ? "▲" : "▼"}
    </button>
  );
}
