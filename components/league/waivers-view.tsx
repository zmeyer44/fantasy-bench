"use client";

import { useState } from "react";
import Link from "next/link";
import { usePreloadedQuery, type Preloaded } from "convex/react";
import { Badge, EmptyState, InfoTip, Input } from "@/components/ui";
import { PlayerHeadshot, TeamAvatar } from "./identity";
import type { api } from "@/convex/_generated/api";
import { formatET } from "@/lib/time";
import { cn } from "@/lib/utils";

export function WaiversView({
  leagueId,
  weekNo,
  preloaded,
  available,
  showClaims = false,
}: {
  leagueId: string;
  weekNo: number;
  showClaims?: boolean;
  preloaded: Preloaded<typeof api.waivers.results>;
  available: Preloaded<typeof api.waivers.available>;
}) {
  const view = usePreloadedQuery(preloaded),
    pool = usePreloadedQuery(available);
  const [tab, setTab] = useState<"players" | "claims">(
    showClaims ? "claims" : "players",
  );
  const [search, setSearch] = useState("");
  const [position, setPosition] = useState("All");
  const [sort, setSort] = useState("projection");
  const [limit, setLimit] = useState(30);
  const filtered = pool.players
    .filter(
      (player) =>
        (position === "All" || player.position === position) &&
        `${player.fullName} ${player.nflTeam ?? ""}`
          .toLowerCase()
          .includes(search.trim().toLowerCase()),
    )
    .sort((a, b) =>
      sort === "name"
        ? a.fullName.localeCompare(b.fullName)
        : sort === "owned"
          ? (b.ownedPct ?? -1) - (a.ownedPct ?? -1)
          : (b.projection ?? -1) - (a.projection ?? -1),
    );
  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">
            Players & waivers
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Scout the wire. Your agent handles the claims.
          </p>
        </div>
        <span className="text-xs text-muted-foreground">
          {view.pendingCount} pending claims league-wide
        </span>
      </header>
      <div
        className="flex gap-6 border-b border-border"
        role="group"
        aria-label="Waiver views"
      >
        {(
          [
            ["players", "Available players"],
            ["claims", "Claim activity"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={tab === value}
            onClick={() => setTab(value)}
            className={cn(
              "min-h-11 border-b-2 pb-3 text-sm",
              tab === value
                ? "border-brand font-medium"
                : "border-transparent text-muted-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_260px]">
        <section className="min-w-0">
          {tab === "players" ? (
            <>
              <div className="flex flex-wrap items-end gap-3">
                <div className="min-w-0 flex-1">
                  <label
                    htmlFor="player-search"
                    className="mb-2 block text-xs text-muted-foreground"
                  >
                    Search players
                  </label>
                  <Input
                    id="player-search"
                    type="search"
                    placeholder="Player name or NFL team…"
                    value={search}
                    onChange={(event) => {
                      setSearch(event.target.value);
                      setLimit(30);
                    }}
                  />
                </div>
                <div>
                  <label
                    htmlFor="player-sort"
                    className="mb-2 block text-xs text-muted-foreground"
                  >
                    Sort by
                  </label>
                  <select
                    id="player-sort"
                    value={sort}
                    onChange={(event) => setSort(event.target.value)}
                    className="h-9 rounded border border-input bg-card px-2 text-xs"
                  >
                    <option value="projection">Projected points</option>
                    <option value="owned">Rostered %</option>
                    <option value="name">Player name</option>
                  </select>
                </div>
              </div>
              <div
                className="my-4 flex flex-wrap gap-1"
                role="group"
                aria-label="Filter by position"
              >
                {["All", "QB", "RB", "WR", "TE", "K", "DEF"].map((item) => (
                  <button
                    key={item}
                    type="button"
                    aria-pressed={position === item}
                    onClick={() => {
                      setPosition(item);
                      setLimit(30);
                    }}
                    className={cn(
                      "min-h-10 min-w-9 rounded px-3 text-xs font-medium",
                      position === item
                        ? "bg-brand text-primary-foreground"
                        : "bg-secondary text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {item === "DEF" ? "D/ST" : item}
                  </button>
                ))}
              </div>
              <p
                className="mb-3 text-xs leading-relaxed text-muted-foreground"
                role="status"
              >
                {filtered.length} players in the scouting pool
                {pool.weekNo ? ` · Week ${pool.weekNo} projections` : ""}
                {pool.takenAt
                  ? ` · As of ${formatET(pool.takenAt, "MMM d, h:mm a")} ET`
                  : ""}
              </p>
              <div role="table" aria-label="Available players">
                <div
                  role="row"
                  className="grid grid-cols-[minmax(0,1fr)_50px_52px] gap-2 border-y border-border py-2 text-[11px] text-muted-foreground sm:grid-cols-[minmax(0,1fr)_80px_70px]"
                >
                  <span role="columnheader">Player / game</span>
                  <span role="columnheader" className="text-right">
                    Rostered
                  </span>
                  <span role="columnheader" className="text-right">
                    Proj
                  </span>
                </div>
                {filtered.slice(0, limit).map((player) => (
                  <div
                    role="row"
                    key={player.id}
                    className="grid grid-cols-[minmax(0,1fr)_50px_52px] items-center gap-2 border-b border-border py-2 sm:grid-cols-[minmax(0,1fr)_80px_70px]"
                  >
                    <div
                      role="cell"
                      className="flex min-w-0 items-center gap-2 sm:gap-3"
                    >
                      <PlayerHeadshot
                        name={player.fullName}
                        sleeperId={player.sleeperId}
                        nflTeam={player.nflTeam}
                        position={player.position}
                        size={32}
                      />
                      <div className="min-w-0">
                        <div className="truncate text-xs font-medium leading-snug sm:text-sm">
                          {player.fullName}
                          {player.injuryStatus ? (
                            <span className="ml-1 text-[10px] font-semibold text-danger">
                              {player.injuryStatus}
                            </span>
                          ) : null}
                        </div>
                        <div className="mt-0.5 truncate text-[10px] leading-snug text-muted-foreground sm:text-xs">
                          {player.position} · {player.nflTeam ?? "FA"} ·{" "}
                          {player.opponent ?? "Opponent TBD"}
                          {player.kickoffAt
                            ? ` · ${formatET(player.kickoffAt, "EEE h:mm a")} ET`
                            : ""}
                        </div>
                      </div>
                    </div>
                    <span
                      role="cell"
                      className="text-right font-mono text-xs text-muted-foreground"
                    >
                      {player.ownedPct == null
                        ? "—"
                        : `${player.ownedPct.toFixed(0)}%`}
                    </span>
                    <span role="cell" className="text-right font-mono text-sm">
                      {player.projection?.toFixed(1) ?? "—"}
                    </span>
                  </div>
                ))}
              </div>
              {!filtered.length ? (
                <div className="py-6">
                  <EmptyState
                    title={
                      pool.players.length
                        ? "No matching players"
                        : "No scouting data yet"
                    }
                    description={
                      pool.players.length
                        ? "Try another name, NFL team, or position."
                        : "Available players appear after the league’s first snapshot."
                    }
                  />
                </div>
              ) : null}
              {filtered.length > limit ? (
                <button
                  type="button"
                  onClick={() => setLimit((value) => value + 30)}
                  className="mt-4 min-h-11 w-full rounded border border-border text-sm hover:bg-accent"
                >
                  Show more players ({filtered.length - limit} remaining)
                </button>
              ) : null}
            </>
          ) : (
            <>
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-base font-semibold">
                  Week {weekNo} claims
                </h3>
                <div className="flex flex-wrap gap-1">
                  {[...new Set([weekNo, ...view.weeksWithClaims])]
                    .sort((a, b) => b - a)
                    .map((week) => (
                      <Link
                        key={week}
                        aria-current={week === weekNo ? "page" : undefined}
                        href={`/leagues/${leagueId}/waivers?week=${week}`}
                        className={cn(
                          "inline-flex min-h-10 min-w-9 items-center justify-center rounded px-2 text-xs",
                          week === weekNo
                            ? "bg-secondary text-foreground"
                            : "text-muted-foreground",
                        )}
                      >
                        W{week}
                      </Link>
                    ))}
                </div>
              </div>
              {view.window ? (
                <p className="mb-4 text-xs leading-relaxed text-muted-foreground">
                  {formatET(view.window.opensAt, "EEE h:mm a")} –{" "}
                  {formatET(view.window.closesAt, "EEE h:mm a")} ET ·{" "}
                  {view.window.status}
                </p>
              ) : null}
              {!view.results.length ? (
                <EmptyState
                  title="No claims this week"
                  description="Agents submit FAAB bids during the waiver window."
                />
              ) : (
                <div className="divide-y divide-border border-y border-border">
                  {view.results.map((row) => (
                    <article key={row.claimId} className="py-4">
                      <div className="flex items-center justify-between gap-3">
                        <Link
                          className="flex min-w-0 items-center gap-2 text-xs hover:text-brand"
                          href={`/leagues/${leagueId}/teams/${row.teamId}`}
                        >
                          <TeamAvatar
                            name={row.teamName}
                            teamId={row.teamId}
                            avatarUrl={row.avatarUrl}
                            avatarTemplate={row.avatarTemplate}
                            size={24}
                          />
                          <span>{row.teamName}</span>
                        </Link>
                        <Badge
                          variant={
                            row.status === "won"
                              ? "success"
                              : row.status === "invalid"
                                ? "destructive"
                                : "secondary"
                          }
                        >
                          {row.status}
                        </Badge>
                      </div>
                      <div className="mt-3 flex items-center gap-3">
                        <PlayerHeadshot
                          name={row.addPlayerName}
                          sleeperId={row.addSleeperId}
                          nflTeam={row.addNflTeam}
                          position={row.addPlayerPosition}
                          size={36}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium">
                            <span className="mr-1 text-brand">+</span>
                            {row.addPlayerName}{" "}
                            <span className="text-xs text-muted-foreground">
                              {row.addPlayerPosition}
                            </span>
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {row.dropPlayerName
                              ? `Drop ${row.dropPlayerName}`
                              : "No player dropped"}
                          </p>
                        </div>
                        <span className="font-mono text-lg">${row.bid}</span>
                      </div>
                      <div className="mt-3 flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
                        <span>{row.resultReason}</span>
                        {row.runId ? (
                          <Link
                            className="hover:text-brand"
                            href={`/leagues/${leagueId}/traces/${row.runId}`}
                          >
                            Decision trace →
                          </Link>
                        ) : null}
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </>
          )}
        </section>
        <aside className="rounded-lg border border-border bg-card p-4">
          <h3 className="inline-flex items-center gap-1.5 text-sm font-semibold">
            FAAB budgets
            <InfoTip term="faab" />
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Remaining claim dollars
          </p>
          <div className="mt-4 space-y-4">
            {view.faab.map((row) => (
              <div key={row.teamId}>
                <div className="flex items-center justify-between gap-3">
                  <Link
                    className="min-w-0 truncate text-xs hover:text-brand"
                    href={`/leagues/${leagueId}/teams/${row.teamId}`}
                  >
                    {row.teamName}
                  </Link>
                  <span className="font-mono text-sm">${row.remaining}</span>
                </div>
                <div className="mt-2 h-1 rounded-full bg-secondary">
                  <div
                    className="h-full rounded-full bg-brand/70"
                    style={{
                      width: `${row.remaining + row.spent > 0 ? Math.min(100, (100 * row.remaining) / (row.remaining + row.spent)) : 0}%`,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
          <p className="mt-5 border-t border-border pt-4 text-xs leading-relaxed text-muted-foreground">
            Agents place bids automatically. Update your agent’s strategy to
            guide its next claim.
          </p>
        </aside>
      </div>
    </div>
  );
}
