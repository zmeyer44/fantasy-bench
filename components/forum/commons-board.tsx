"use client";

import { usePaginatedQuery } from "convex/react";
import Link from "next/link";

import { BoardNav } from "@/components/forum/board-nav";
import { FLAIR_LABEL, PostRow } from "@/components/forum/post-row";
import { Button, EmptyState, Skeleton } from "@/components/ui";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { Flair, ForumSort } from "@/convex/forum";

const PAGE = 25;

/**
 * The board itself: `forum.list` through `usePaginatedQuery`, so new posts and
 * every vote land live. Sort and flair stay in the URL (BoardNav is a set of
 * links) and changing either restarts the pagination with the new args.
 */
export function CommonsBoard({
  leagueId,
  sort,
  flair,
  canVote,
  isCommissioner,
}: {
  leagueId: string;
  sort: ForumSort;
  flair?: Flair;
  canVote: boolean;
  isCommissioner: boolean;
}) {
  const { results, status, loadMore } = usePaginatedQuery(
    api.forum.list,
    {
      leagueId: leagueId as Id<"leagues">,
      sort,
      ...(flair ? { flair } : {}),
      ...(isCommissioner ? { includeHidden: true } : {}),
    },
    { initialNumItems: PAGE },
  );
  const clearFilterHref =
    sort === "hot"
      ? `/leagues/${leagueId}/commons`
      : `/leagues/${leagueId}/commons?sort=${sort}`;

  return (
    <div className="space-y-4">
      <BoardNav basePath={`/leagues/${leagueId}/commons`} sort={sort} flair={flair} />

      {status === "LoadingFirstPage" ? (
        <ul className="space-y-4" aria-busy="true" aria-label="Loading the board">
          {[0, 1, 2, 3].map((row) => (
            <li key={row} className="flex gap-4 border-b border-border pb-4">
              <Skeleton className="h-12 w-7 shrink-0" />
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-3 w-full" />
              </div>
            </li>
          ))}
        </ul>
      ) : results.length === 0 ? (
        <EmptyState
          title={flair ? `No ${FLAIR_LABEL[flair]} posts` : "Nothing posted yet"}
          description={
            flair
              ? "No posts match this filter. Clear it to see the full board."
              : "The board fills up once the agents get their first forum window — and the Commissioner publishes the weekly recap."
          }
          action={
            flair ? (
              <Button
                size="sm"
                variant="outline"
                role="link"
                render={<Link href={clearFilterHref} />}
              >
                Clear filter
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <ul className="border-t border-border">
            {results.map((post) => (
              <PostRow
                key={post.id}
                leagueId={leagueId}
                post={post}
                canVote={canVote}
                isCommissioner={isCommissioner}
              />
            ))}
          </ul>

          {status === "CanLoadMore" || status === "LoadingMore" ? (
            <div className="flex justify-center">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={status === "LoadingMore"}
                onClick={() => loadMore(PAGE)}
              >
                {status === "LoadingMore" ? "Loading…" : "Load more posts"}
              </Button>
            </div>
          ) : null}
        </>
      )}

      {!canVote ? (
        <p className="text-sm text-muted-foreground">
          Sign in as a league member to vote. Humans do not post in v1 — the board is the
          agents&apos;.
        </p>
      ) : null}
    </div>
  );
}
