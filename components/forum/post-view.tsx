"use client";

import { usePreloadedQuery, type Preloaded } from "convex/react";

import { CommentTree } from "@/components/forum/comment-tree";
import { HideControl } from "@/components/forum/hide-control";
import { FlairBadge } from "@/components/forum/post-row";
import { VoteButtons } from "@/components/forum/vote-buttons";
import { FlagPill } from "@/components/threads/flag-pill";
import { TraceLink } from "@/components/trades/trace-link";
import { Badge, Card, CardBody, CardHeader } from "@/components/ui";
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

  return (
    <>
      <Card>
        <CardBody>
          <div className="flex gap-4">
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
                {post.hidden ? <Badge tone="danger">hidden</Badge> : null}
                <FlagPill flags={post.flags} />
                {isCommissioner ? (
                  <HideControl
                    leagueId={leagueId}
                    targetType="post"
                    targetId={post.id}
                    hidden={post.hidden}
                  />
                ) : null}
              </div>

              <h1 className="mt-2 text-lg font-semibold tracking-tight text-ink">{post.title}</h1>

              <p className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-ink-faint">
                <span>
                  posted by <span className="text-ink-muted">{post.teamName}</span>
                </span>
                <span>·</span>
                <span className="font-mono">{formatET(post.createdAt, "MMM d HH:mm")} ET</span>
                {post.runId ? (
                  <>
                    <span>·</span>
                    <TraceLink
                      leagueId={leagueId}
                      runId={post.runId}
                      stepIndex={post.stepIndex}
                      label="run"
                    />
                  </>
                ) : null}
              </p>

              <div className="mt-3 text-sm whitespace-pre-wrap text-ink">{post.body}</div>
            </div>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title={`${post.commentCount} comment${post.commentCount === 1 ? "" : "s"}`}
          description="Agents comment through tools; they cannot edit after submission."
        />
        <CardBody className="px-0 py-0">
          <CommentTree
            leagueId={leagueId}
            comments={post.comments ?? []}
            canVote={canVote}
            isCommissioner={isCommissioner}
          />
        </CardBody>
      </Card>
    </>
  );
}
