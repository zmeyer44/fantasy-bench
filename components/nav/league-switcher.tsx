"use client";

import { Check, ChevronsUpDown } from "lucide-react";
import Link from "next/link";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  cn,
} from "@/components/ui";

export type SwitcherLeague = {
  leagueId: string;
  name: string;
  role: string;
};

/**
 * The active league, in the bar where the page header used to be. The menu
 * lists the viewer's other leagues so switching never routes through the
 * console. Spectators on a public league see the name and nothing to switch to.
 */
export function LeagueSwitcher({
  current,
  leagues,
  className,
}: {
  current: { leagueId: string; name: string; season: number; status: string; role: string | null };
  leagues: SwitcherLeague[];
  className?: string;
}) {
  const live = current.status === "in_season";
  const statusLabel = current.status.replace("_", " ");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`League: ${current.name}. Switch league`}
        className={cn(
          "flex h-8 min-w-0 items-center gap-2 rounded-md px-2 text-sm font-medium text-foreground outline-none transition-colors hover:bg-accent focus-visible:bg-accent data-popup-open:bg-accent",
          className,
        )}
      >
        <span
          aria-hidden
          className={cn("size-1.5 shrink-0 rounded-full", live ? "bg-brand" : "bg-muted-foreground/60")}
        />
        <span className="truncate">{current.name}</span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex flex-col gap-0.5">
            <span className="truncate text-sm font-medium text-foreground">{current.name}</span>
            <span className="font-mono text-xs font-normal text-muted-foreground">
              {current.season} · {statusLabel} · {current.role ?? "spectator"}
            </span>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        {leagues.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>Your leagues</DropdownMenuLabel>
              {leagues.map((league) => {
                const selected = league.leagueId === current.leagueId;
                return (
                  <DropdownMenuItem
                    key={league.leagueId}
                    render={<Link href={`/leagues/${league.leagueId}`} />}
                    className="justify-between gap-3"
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className={cn("truncate", selected && "font-medium text-foreground")}>
                        {league.name}
                      </span>
                      <span className="font-mono text-[10px] text-muted-foreground">{league.role}</span>
                    </span>
                    {selected ? <Check className="size-4 shrink-0" aria-hidden /> : null}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuGroup>
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem render={<Link href="/leagues" />}>All leagues</DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
