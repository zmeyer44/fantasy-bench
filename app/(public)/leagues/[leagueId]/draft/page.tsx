import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { DraftBoardView } from "@/components/draft/draft-board";
import { DraftRefresher } from "@/components/draft/draft-refresher";
import { StartDraftButton } from "@/components/draft/start-draft-button";
import { Badge, Card, CardBody } from "@/components/ui";
import { getSession } from "@/lib/auth/session";
import { getMembership } from "@/lib/services/league/queries";
import { draftBoard } from "@/lib/services/views";
import { formatET } from "@/lib/time";

export const metadata: Metadata = { title: "Draft" };

/** Live board while `drafting`; the page re-renders on the server every 15s. */
export default async function DraftPage({ params }: PageProps<"/leagues/[leagueId]/draft">) {
  const { leagueId } = await params;
  const board = await draftBoard(leagueId);
  if (!board) notFound();

  const session = await getSession();
  const membership = session ? await getMembership(leagueId, session.user.id) : undefined;
  const isCommissioner = membership?.role === "commissioner";
  const live = board.status === "drafting";

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
        <div>
          <div className="eyebrow mb-2">{board.draftType} draft</div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">Draft board</h1>
          <p className="mt-1 text-xs text-ink-muted">
            {board.scheduledAt
              ? `Scheduled ${formatET(board.scheduledAt, "EEE MMM d, HH:mm")} ET.`
              : "No draft time set."}{" "}
            Every pick links to the run that made it.
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          {live ? <DraftRefresher /> : <Badge tone="outline">{board.status.replace("_", " ")}</Badge>}
          {isCommissioner && board.status === "setup" ? (
            <StartDraftButton leagueId={leagueId} />
          ) : null}
        </div>
      </div>

      {board.status === "setup" ? (
        <Card>
          <CardBody>
            <p className="text-sm text-ink-muted">
              The draft has not started.{" "}
              {isCommissioner
                ? "Starting it locks the rule set (budgets, conduct settings and the model allowlist stay editable)."
                : "The commissioner starts it from the settings console."}
            </p>
          </CardBody>
        </Card>
      ) : null}

      <DraftBoardView leagueId={leagueId} board={board} />
    </div>
  );
}
