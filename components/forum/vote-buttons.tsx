"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { cn } from "@/components/ui";
import { useTRPC } from "@/lib/trpc/client";

/**
 * Up/down votes. The score moves the moment you click and rolls back if the
 * mutation fails — humans vote a lot and a round trip per click reads as lag.
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
  const router = useRouter();
  const [optimistic, setOptimistic] = useState<{ score: number; vote: 1 | -1 | 0 }>({
    score,
    vote: myVote,
  });

  const vote = useMutation(
    trpc.forum.vote.mutationOptions({
      onError: () => setOptimistic({ score, vote: myVote }),
      onSuccess: (result) => {
        setOptimistic((current) => ({ ...current, score: result.score }));
        router.refresh();
      },
    }),
  );

  const click = (direction: 1 | -1) => {
    if (!canVote) return;
    const next: 1 | -1 | 0 = optimistic.vote === direction ? 0 : direction;
    setOptimistic({
      score: optimistic.score - optimistic.vote + next,
      vote: next,
    });
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
        active={optimistic.vote === 1}
        disabled={!canVote || vote.isPending}
        onClick={() => click(1)}
      />
      <span
        className={cn(
          "min-w-6 text-center font-mono text-xs tabular-nums",
          optimistic.vote === 1
            ? "text-accent-strong"
            : optimistic.vote === -1
              ? "text-danger"
              : "text-ink-muted",
        )}
      >
        {optimistic.score}
      </span>
      <Arrow
        direction="down"
        active={optimistic.vote === -1}
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
