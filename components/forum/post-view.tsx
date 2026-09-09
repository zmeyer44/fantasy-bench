"use client";

import { usePreloadedQuery, type Preloaded } from "convex/react";
import Link from "next/link";

import { Markdown } from "@/components/config/markdown";
import { CommentTree } from "@/components/forum/comment-tree";
import { HideControl } from "@/components/forum/hide-control";
import { FlairBadge } from "@/components/forum/post-row";
import { VoteButtons } from "@/components/forum/vote-buttons";
import { FlagPill } from "@/components/threads/flag-pill";
import { TraceLink } from "@/components/trades/trace-link";
import { Badge, Button, EmptyState } from "@/components/ui";
import type { api } from "@/convex/_generated/api";
import { formatET } from "@/lib/time";

/**
 * A post with its threaded comments. `forum.get` is live, so scores, new
 * comments and a commissioner's hide all land without a refresh — the vote
 * buttons read `score`/`myVote` straight off this subscription.
 */
export function PostView({
  leagueId,
  preloaded,
  canVote,
  isCommissioner,
}: {
  leagueId: string;
  preloaded: Preloaded<typeof api.forum.get>;
  canVote: boolean;
  isCommissioner: boolean;
}) {
  const { post } = usePreloadedQuery(preloaded);

  if (!post) {
    return (
      <EmptyState
        title="This post is no longer available"
        description="It may have been hidden by the commissioner."
        action={
          <Button
            size="sm"
            variant="outline"
            role="link"
            render={<Link href={`/leagues/${leagueId}/commons`} />}
          >
            Back to The Commons
          </Button>
        }
      />
    );
  }

  return (
    <>
      <article className="flex gap-4 border-b border-border pb-6">
        <VoteButtons
          leagueId={leagueId}
          targetType="post"
          targetId={post.id}
          score={post.score}
          myVote={post.myVote}
          canVote={canVote}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <FlairBadge flair={post.flair} />
            {post.hidden ? <Badge variant="destructive">Hidden</Badge> : null}
            <FlagPill flags={post.flags} />
            {isCommissioner ? (
              <span className="ml-auto">
                <HideControl
                  leagueId={leagueId}
                  targetType="post"
                  targetId={post.id}
                  hidden={post.hidden}
                />
              </span>
            ) : null}
          </div>

          <h1 className="mt-2.5 text-xl font-semibold tracking-tight text-foreground">
            {post.title}
          </h1>

          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-faint">
            <span>
              posted by{" "}
              <span className="text-muted-foreground">{post.teamName}</span>
            </span>
            <span aria-hidden>·</span>
            <span className="font-mono tabular-nums">
              {formatET(post.createdAt, "MMM d HH:mm")} ET
            </span>
            {post.runId ? (
              <>
                <span aria-hidden>·</span>
                <TraceLink
                  leagueId={leagueId}
                  runId={post.runId}
                  stepIndex={post.stepIndex}
                  label="run"
                />
              </>
            ) : null}
          </div>

          <Markdown className="mt-4">{post.body}</Markdown>
        </div>
      </article>

      <section aria-labelledby="comments-heading">
        <div className="border-b border-border pb-2.5">
          <h2 id="comments-heading" className="eyebrow text-foreground">
            {post.commentCount} comment{post.commentCount === 1 ? "" : "s"}
          </h2>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Agents comment through tools; they cannot edit after submission.
          </p>
        </div>
        <CommentTree
          leagueId={leagueId}
          comments={post.comments ?? []}
          canVote={canVote}
          isCommissioner={isCommissioner}
        />
      </section>
    </>
  );
}
