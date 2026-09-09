"use client";

import { usePreloadedQuery, type Preloaded } from "convex/react";
import { ArrowUpRight, Plus, Ticket } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

import { CreateLeagueDialog } from "@/components/create-league-form";
import { JoinLeagueDialog } from "@/components/league/join-code-form";
import { StatusPill } from "@/components/league/status-pill";
import { Badge, Button, EmptyState, PageHeader } from "@/components/ui";
import type { api } from "@/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";

type LeagueSummary = FunctionReturnType<typeof api.leagues.listMine>[number];
type Modal = "join" | "create" | null;

/**
 * The console's league index: header actions, the card grid, and the two
 * modals ("Join a league", "Create a league") they open. Preloaded on the
 * server for the first paint, then live: a league created in another tab, or
 * a role change made by its commissioner, lands here without a refresh.
 */
export function LeaguesConsole({
  preloaded,
}: {
  preloaded: Preloaded<typeof api.leagues.listMine>;
}) {
  const leagues = usePreloadedQuery(preloaded);
  const searchParams = useSearchParams();
  const modal: Modal = searchParams.get("join") === "1"
    ? "join"
    : searchParams.get("create") === "1" ? "create" : null;

  function setModal(next: Modal) {
    const url = new URL(window.location.href);
    url.searchParams.delete("join");
    url.searchParams.delete("create");
    if (next) url.searchParams.set(next, "1");
    // Next.js synchronizes native history updates with useSearchParams.
    history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }

  function close() {
    setModal(null);
  }

  const actions = (
    <>
      <Button variant="outline" onClick={() => setModal("join")}>
        <Ticket data-icon="inline-start" />
        Join a league
      </Button>
      <Button onClick={() => setModal("create")}>
        <Plus data-icon="inline-start" />
        Create a league
      </Button>
    </>
  );

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Console"
        title="Your leagues"
        description="Every league you commission or own a team in."
        actions={actions}
      />

      {leagues.length === 0 ? (
        <EmptyState
          title="No leagues yet"
          description="Enter an invite to join a league, or create one and become its commissioner."
          action={
            <div className="flex flex-wrap justify-center gap-2">{actions}</div>
          }
        />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {leagues.map((league) => (
            <li key={league._id}>
              <LeagueCard league={league} />
            </li>
          ))}
        </ul>
      )}

      <JoinLeagueDialog
        open={modal === "join"}
        onOpenChange={(o) => (o ? setModal("join") : close())}
      />
      <CreateLeagueDialog
        open={modal === "create"}
        onOpenChange={(o) => (o ? setModal("create") : close())}
      />
    </div>
  );
}

function LeagueCard({ league }: { league: LeagueSummary }) {
  return (
    <Link
      href={`/leagues/${league._id}`}
      className="group flex h-full flex-col rounded-lg border border-border bg-card p-4 text-card-foreground transition-colors hover:border-line-strong hover:bg-muted/40 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate font-heading text-base font-medium leading-snug text-foreground group-hover:text-brand">
            {league.name}
          </h2>
          <p className="mt-0.5 truncate font-mono text-xs text-ink-faint">
            /{league.slug}
          </p>
        </div>
        <ArrowUpRight
          className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
          aria-hidden
        />
      </div>

      <dl className="mt-4 grid grid-cols-3 gap-3 font-mono text-xs">
        <div>
          <dt className="eyebrow">Season</dt>
          <dd className="mt-1 text-foreground">{league.season}</dd>
        </div>
        <div>
          <dt className="eyebrow">Teams</dt>
          <dd className="mt-1 text-foreground">{league.teamCountActual}</dd>
        </div>
        <div>
          <dt className="eyebrow">Draft</dt>
          <dd className="mt-1 text-foreground">{league.draftType}</dd>
        </div>
      </dl>

      <div className="mt-4 flex items-center gap-2 border-t border-border pt-3">
        <StatusPill status={league.status} />
        <Badge variant="outline">{league.role}</Badge>
      </div>
    </Link>
  );
}
