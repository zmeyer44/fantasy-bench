import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ThreadMessage } from "@/components/threads/thread-message";
import { TradeCard } from "@/components/trades/trade-card";
import { Badge, Card, CardBody, CardHeader, PageHeader } from "@/components/ui";
import { getLeagueById } from "@/lib/services/league";
import { getThread, type ThreadMessageView } from "@/lib/services/messaging";
import { getSocialViewer } from "@/lib/services/messaging/viewer";
import type { TradeSummary } from "@/lib/services/trades";
import { formatET } from "@/lib/time";

export async function generateMetadata({
  params,
}: PageProps<"/leagues/[leagueId]/threads/[threadId]">): Promise<Metadata> {
  const { threadId } = await params;
  const thread = await getThread(threadId);
  return { title: thread ? `${thread.teamA.name} ↔ ${thread.teamB.name}` : "Thread" };
}

type Entry =
  | { kind: "message"; at: string; message: ThreadMessageView }
  | { kind: "trade"; at: string; trade: TradeSummary };

/**
 * The chat view: messages left/right by team with proposal cards inline, in one
 * chronological stream. Team A (the canonical `team_a_id`) is rendered on the
 * right so a conversation always reads the same way.
 */
export default async function ThreadPage({
  params,
}: PageProps<"/leagues/[leagueId]/threads/[threadId]">) {
  const { leagueId, threadId } = await params;
  const viewer = await getSocialViewer(leagueId);
  const [league, thread] = await Promise.all([
    getLeagueById(leagueId),
    getThread(threadId, {
      viewer: { teamIds: viewer.teamIds, isCommissioner: viewer.isCommissioner },
    }),
  ]);
  if (!league || !thread || thread.leagueId !== leagueId) notFound();

  const entries: Entry[] = [
    ...thread.messages.map((message) => ({
      kind: "message" as const,
      at: message.createdAt,
      message,
    })),
    ...thread.trades.map((trade) => ({
      kind: "trade" as const,
      at: trade.createdAt,
      trade,
    })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={thread.windowLabel ? `${thread.windowLabel} · week ${thread.weekNo}` : "Direct messages"}
        title={`${thread.teamA.name} ↔ ${thread.teamB.name}`}
        description={`${thread.messageCount} messages · ${thread.trades.length} proposal${
          thread.trades.length === 1 ? "" : "s"
        }`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={thread.status === "open" ? "accent" : "neutral"}>{thread.status}</Badge>
            {thread.flaggedCount > 0 ? (
              <Badge tone="danger">{thread.flaggedCount} flagged</Badge>
            ) : null}
            <Link
              href={`/leagues/${leagueId}/threads`}
              className="text-xs text-ink-muted hover:text-accent-strong"
            >
              All threads →
            </Link>
          </div>
        }
      />

      {thread.delayed ? (
        <div className="rounded-md border border-warning/40 bg-warning/10 px-4 py-3">
          <p className="text-sm font-medium text-ink">Delayed reveal</p>
          <p className="mt-0.5 text-xs text-ink-muted">
            This league hides negotiation bodies from non-parties until the negotiation
            resolves or its window closes
            {thread.revealAt ? `, at ${formatET(thread.revealAt, "MMM d HH:mm")} ET` : ""}. The
            proposals themselves stay public.
          </p>
        </div>
      ) : null}

      <Card>
        <CardHeader
          title="Conversation"
          description={`${thread.teamB.name} on the left, ${thread.teamA.name} on the right`}
        />
        <CardBody>
          {entries.length === 0 ? (
            <p className="py-6 text-center text-sm text-ink-faint">Nothing said yet.</p>
          ) : (
            <ul className="space-y-4">
              {entries.map((entry) =>
                entry.kind === "message" ? (
                  <ThreadMessage
                    key={entry.message.id}
                    leagueId={leagueId}
                    message={entry.message}
                    alignRight={entry.message.senderTeamId === thread.teamA.id}
                  />
                ) : (
                  <li key={entry.trade.id}>
                    <TradeCard
                      leagueId={leagueId}
                      trade={entry.trade}
                      fairnessFloor={league.rules?.fairnessFloor ?? undefined}
                    />
                  </li>
                ),
              )}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
