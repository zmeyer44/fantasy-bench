"use client";

import { useMutation } from "convex/react";

import { cn } from "@/components/ui";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

type VoteDirection = 1 | -1 | 0;

/**
 * Up/down votes.
 *
 * The click is applied through a Convex optimistic update: every `forum.list`
 * page and every `forum.get` currently in the client store is rewritten with
 * the new score and `myVote` before the mutation leaves the browser, and Convex
 * rolls the guess back automatically if the mutation fails or replaces it with
 * the server's answer when the subscription catches up. There is no local
 * "guess" state to reconcile — `score`/`myVote` always come from the live read.
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
  myVote: VoteDirection;
  canVote: boolean;
  orientation?: "vertical" | "horizontal";
}) {
  const vote = useMutation(api.forum.vote).withOptimisticUpdate((localStore, args) => {
    // The board: one entry per `{ leagueId, sort, flair, paginationOpts }`
    // variant the reader has loaded (each `usePaginatedQuery` page is its own
    // query), so a vote on the "hot" tab also moves the row on "new".
    if (args.targetType === "post") {
      for (const { args: queryArgs, value } of localStore.getAllQueries(api.forum.list)) {
        if (value === undefined || queryArgs.leagueId !== args.leagueId) continue;
        let changed = false;
        const page = value.page.map((post) => {
          if (post.id !== args.targetId) return post;
          changed = true;
          return applyVote(post, args.direction);
        });
        if (changed) localStore.setQuery(api.forum.list, queryArgs, { ...value, page });
      }
    }

    // The post page: the post itself and every comment in its thread.
    for (const { args: queryArgs, value } of localStore.getAllQueries(api.forum.get)) {
      if (value === undefined || queryArgs.leagueId !== args.leagueId) continue;
      const post = value.post;
      if (args.targetType === "post") {
        if (post.id !== args.targetId) continue;
        localStore.setQuery(api.forum.get, queryArgs, {
          ...value,
          post: applyVote(post, args.direction),
        });
        continue;
      }

      const comments = post.comments;
      if (!comments?.some((comment) => comment.id === args.targetId)) continue;
      localStore.setQuery(api.forum.get, queryArgs, {
        ...value,
        post: {
          ...post,
          comments: comments.map((comment) =>
            comment.id === args.targetId ? applyVote(comment, args.direction) : comment,
          ),
        },
      });
    }
  });

  const click = (direction: 1 | -1) => {
    if (!canVote) return;
    const next: VoteDirection = myVote === direction ? 0 : direction;
    void vote({
      leagueId: leagueId as Id<"leagues">,
      targetType,
      targetId,
      direction: next,
    });
  };

  return (
    <div
      className={cn(
        "flex items-center gap-0.5",
        orientation === "vertical" ? "flex-col" : "flex-row",
      )}
    >
      <Arrow direction="up" active={myVote === 1} disabled={!canVote} onClick={() => click(1)} />
      <span
        className={cn(
          "min-w-6 text-center font-mono text-xs tabular-nums",
          myVote === 1 ? "text-accent-strong" : myVote === -1 ? "text-danger" : "text-ink-muted",
        )}
      >
        {score}
      </span>
      <Arrow direction="down" active={myVote === -1} disabled={!canVote} onClick={() => click(-1)} />
    </div>
  );
}

/**
 * Move a row's score by the delta between the vote it already carries and the
 * new one (+1 → -1 is a swing of two), and record the new vote. Always returns
 * a new object: query results in the store are immutable.
 */
function applyVote<T extends { score: number; myVote: VoteDirection }>(
  row: T,
  direction: VoteDirection,
): T {
  return { ...row, score: row.score - row.myVote + direction, myVote: direction };
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
