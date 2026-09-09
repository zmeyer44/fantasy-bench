"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePreloadedQuery, type Preloaded } from "convex/react";

import {
  PlayerHeadshot,
  PositionTag,
  TeamAvatar,
  TEAM_AVATARS,
} from "./identity";
import { RunTags } from "@/components/traces/run-tags";
import { KeyRound, Lock } from "lucide-react";

import { Badge, Button, EmptyState, InfoTip, cn } from "@/components/ui";
import { COOLDOWN_DAYS } from "@/convex/lib/visibility";
import { TOOL_CATALOG } from "@/convex/runtime/tools/catalog";
import type { api } from "@/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import { formatET } from "@/lib/time";

type TeamPage = NonNullable<FunctionReturnType<typeof api.views.team>>;
type LineupRow = TeamPage["lineup"][number];

/** A team's roster, lineup, agent config and recent runs — live off `views.team`. */
export function TeamView({
  leagueId,
  teamId,
  preloaded,
  canEditAgent = false,
}: {
  leagueId: string;
  teamId: string;
  preloaded: Preloaded<typeof api.views.team>;
  canEditAgent?: boolean;
}) {
  const page = usePreloadedQuery(preloaded);
  if (!page) return <EmptyState title="Team not found" />;

  const base = `/leagues/${leagueId}`;
  const teamBase = `${base}/teams/${teamId}`;
  const starters = page.lineup.filter((row) => row.starting);
  const bench = page.lineup.filter((row) => !row.starting);
  const record = `${page.record.wins}-${page.record.losses}${
    page.record.ties ? `-${page.record.ties}` : ""
  }`;

  return (
    <div className="space-y-5 sm:space-y-8">
      {/* Header: identity on the left, the season's four numbers on the right. */}
      <header className="flex flex-wrap items-center justify-between gap-x-8 gap-y-4 border-b border-border pb-5">
        <div className="flex min-w-0 items-center gap-3">
          <TeamAvatar
            name={page.team.name}
            teamId={teamId}
            avatarUrl={page.team.avatarUrl}
            avatarTemplate={page.team.avatarTemplate}
            size={56}
          />
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold tracking-tight text-foreground">
              {page.team.name}
            </h1>
            <p className="mt-0.5 font-mono text-[10px] tracking-wider text-muted-foreground uppercase">
              {[page.team.abbreviation, `#${page.record.rank}`, page.record.streak]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
        </div>

        <dl className="grid w-full grid-cols-4 gap-x-6 sm:w-auto">
          {[
            { label: "Record", value: record },
            { label: "Points for", value: page.record.pointsFor.toFixed(1) },
            { label: "Karma", tip: "karma" as const, value: String(page.team.karma) },
            {
              label: "FAAB",
              tip: "faab" as const,
              value: `$${page.team.faabRemaining}`,
              detail: `of $${page.team.faabBudget}`,
            },
          ].map((stat) => (
            <div key={stat.label} className="min-w-0">
              <dt className="inline-flex items-center gap-1 font-mono text-[10px] tracking-wider text-muted-foreground uppercase">
                {stat.label}
                {"tip" in stat && stat.tip ? <InfoTip term={stat.tip} /> : null}
              </dt>
              <dd className="mt-0.5 font-mono text-lg font-medium tabular-nums text-foreground">
                {stat.value}
                {"detail" in stat && stat.detail ? (
                  <span className="block text-xs font-normal text-muted-foreground sm:ml-1 sm:inline">
                    {stat.detail}
                  </span>
                ) : null}
              </dd>
            </div>
          ))}
        </dl>
      </header>

      <nav
        aria-label="Team navigation"
        className="flex gap-5 border-b border-border text-sm"
      >
        <span
          aria-current="page"
          className="border-b-2 border-brand pb-3 font-medium"
        >
          Roster
        </span>
        <Link
          className="pb-3 text-muted-foreground hover:text-foreground"
          href={`${base}/matchups/${page.weekNo}`}
        >
          Matchups
        </Link>
        <Link
          className="pb-3 text-muted-foreground hover:text-foreground"
          href={`${base}/waivers`}
        >
          Players & waivers
        </Link>
      </nav>
      <AgentPanel
        config={page.config}
        teamBase={teamBase}
        base={base}
        canEditAgent={canEditAgent}
      />

      <div className="grid gap-10 lg:grid-cols-3">
        <div className="space-y-10 lg:col-span-2">
          <section>
            <SectionRule
              title={`Week ${page.weekNo} lineup`}
              meta={
                page.lineupSource
                  ? `Set by ${page.lineupSource.replace("_", " ")}${
                      page.snapshotTakenAt
                        ? ` · projections as of ${formatET(page.snapshotTakenAt, "MMM d HH:mm")} ET`
                        : ""
                    }`
                  : "No lineup set for this week yet."
              }
              action={
                page.lineupSetByRunId ? (
                  <Link
                    href={`${base}/traces/${page.lineupSetByRunId}`}
                    className="eyebrow transition-colors hover:text-foreground"
                  >
                    Trace →
                  </Link>
                ) : null
              }
            />
            {starters.length === 0 ? (
              <div className="mt-4">
                <EmptyState title="No lineup yet" />
              </div>
            ) : (
              <SlotTable
                rows={starters}
                totals={{
                  projected: page.projectedTotal,
                  live: page.liveTotal,
                }}
              />
            )}
          </section>

          <section>
            <SectionRule title="Bench" meta={`${bench.length} players`} />
            {bench.length === 0 ? (
              <p className="mt-4 text-sm text-muted-foreground">
                Nobody on the bench.
              </p>
            ) : (
              <SlotTable rows={bench} />
            )}
          </section>

          <section>
            <SectionRule
              title="Recent runs"
              action={
                <Link
                  href={`${base}/traces?team=${teamId}`}
                  className="eyebrow transition-colors hover:text-foreground"
                >
                  All traces →
                </Link>
              }
            />
            <div className="mt-4">
              {page.recentRuns.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  This agent has not run yet.
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {page.recentRuns.map((run) => (
                    <li key={run.id} className="py-3 first:pt-0 last:pb-0">
                      <Link
                        href={`${base}/traces/${run.id}`}
                        className="font-mono text-sm text-foreground hover:text-brand-strong"
                      >
                        {run.windowLabelText}
                        {run.weekNo ? ` · wk ${run.weekNo}` : ""}
                      </Link>
                      <div className="mt-2">
                        <RunTags
                          run={run}
                          leagueId={leagueId}
                          showTeam={false}
                        />
                      </div>
                      {run.rationale ? (
                        <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-muted-foreground">
                          {run.rationale}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>

        <div className="space-y-10">
          <section className="rounded-lg border border-border bg-card p-4">
            <h2 className="text-sm font-semibold">Team identity</h2>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              The agent chooses the team name and crest. Owners can guide its style
              by editing the agent.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {TEAM_AVATARS.map((template) => (
                <span key={template} title={template}>
                  <TeamAvatar
                    name={template}
                    avatarTemplate={template}
                    size={36}
                  />
                </span>
              ))}
            </div>
            {page.team.avatarStatus === "generating" ? (
              <p role="status" className="mt-3 text-xs text-brand">
                Your agent is creating a custom avatar…
              </p>
            ) : null}
            {page.team.avatarStatus === "failed" ? (
              <p role="status" className="mt-3 text-xs text-muted-foreground">
                {page.team.avatarError}
              </p>
            ) : null}
            {page.team.identityRunId ? (
              <Link
                className="mt-3 block text-xs text-brand hover:underline"
                href={`${base}/traces/${page.team.identityRunId}`}
              >
                Identity decision →
              </Link>
            ) : null}
          </section>
          <section>
            <SectionRule
              title="Cost"
              action={
                <Link
                  href={`${base}/cost`}
                  className="eyebrow transition-colors hover:text-foreground"
                >
                  Dashboard →
                </Link>
              }
            />
            <dl className="mt-4 divide-y divide-border">
              <Row
                label="Season"
                value={`$${page.cost.seasonUsd.toFixed(4)}`}
              />
              <Row
                label={`Week ${page.weekNo}`}
                value={`$${page.cost.weekUsd.toFixed(4)}`}
              />
              <Row
                label="Tokens"
                value={page.cost.seasonTokens.toLocaleString()}
              />
              <Row label="Runs" value={String(page.cost.runCount)} />
            </dl>
          </section>
        </div>
      </div>
    </div>
  );
}

/**
 * The agent, front and centre: what runs this team, what it reads and what it
 * can do — with the one lime action on the page leading into the editor.
 */
function AgentPanel({
  config,
  teamBase,
  base,
  canEditAgent,
}: {
  config: TeamPage["config"];
  teamBase: string;
  base: string;
  canEditAgent: boolean;
}) {
  const defaultTools = TOOL_CATALOG.length - config.toolsDisabled;
  const totalTools = defaultTools + config.customTools.length;
  const hasVersion = config.versionNo !== null;
  const privateUntil = config.privateUntil;
  const revealLabel = privateUntil ? `${formatET(privateUntil, "MMM d")}` : null;
  const excerpt = config.contextExcerpt
    .replace(/^#+\s*/gm, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  const href = `${teamBase}/config`;

  return (
    <section
      aria-labelledby="agent-panel-title"
      className="rounded-lg border border-line-strong bg-card"
    >
      <div className="grid gap-6 p-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:gap-10">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="eyebrow text-brand">Agent</span>
            {hasVersion ? (
              <Badge variant="outline">v{config.versionNo} live</Badge>
            ) : (
              <Badge variant="outline">no version</Badge>
            )}
            {config.hasPendingVersion ? <Badge variant="warning">edit queued</Badge> : null}
            {privateUntil ? (
              <Badge variant="secondary">
                <Lock data-icon="inline-start" /> private until {revealLabel}
              </Badge>
            ) : null}
            {config.ownKey ? (
              <Badge variant="info">
                <KeyRound data-icon="inline-start" /> own key
              </Badge>
            ) : null}
          </div>
          <h2 id="agent-panel-title" className="mt-2 text-xl font-semibold tracking-tight">
            {config.modelLabel}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {config.changeSummary
              ? `Last change: ${config.changeSummary}`
              : hasVersion
                ? "Runs every window on this configuration."
                : "This team has not configured its agent yet. It runs on platform defaults."}
            {config.createdAt ? ` · saved ${formatET(config.createdAt, "MMM d HH:mm")} ET` : ""}
          </p>

          <div className="mt-4 border-l-2 border-border pl-3">
            <div className="eyebrow">System prompt</div>
            {privateUntil ? (
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                The owner&apos;s context, skills and tool customizations are private until{" "}
                {revealLabel}. Every customization becomes public {COOLDOWN_DAYS} days after it is
                saved, so the league can learn from what worked.
              </p>
            ) : (
              <p
                className={cn(
                  "mt-1.5 line-clamp-3 text-sm leading-relaxed",
                  excerpt ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {excerpt || "No owner context written yet. The agent plays a conventional game."}
              </p>
            )}
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-2">
            <Button
              size="lg"
              variant={canEditAgent ? "default" : "outline"}
              render={<Link href={href} />}
            >
              {canEditAgent ? "Edit agent" : "View agent"}
            </Button>
            <Button size="lg" variant="ghost" render={<Link href={`${href}?tab=tools`} />}>
              Tools
            </Button>
            <Button size="lg" variant="ghost" render={<Link href={`${teamBase}/config/versions`} />}>
              Versions
            </Button>
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-x-6 gap-y-5 border-t border-border pt-5 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-10">
          <div className="min-w-0">
            <dt className="text-[11px] text-muted-foreground">Tools</dt>
            <dd className="mt-1 font-mono text-2xl tabular-nums">{privateUntil ? "—" : totalTools}</dd>
            <dd className="mt-1 text-[11px] text-muted-foreground">
              {privateUntil
                ? `revealed ${revealLabel}`
                : `${defaultTools}/${TOOL_CATALOG.length} default${
                    config.customTools.length ? ` · ${config.customTools.length} custom` : ""
                  }${config.toolsGuided ? ` · ${config.toolsGuided} guided` : ""}`}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-[11px] text-muted-foreground">Skills</dt>
            <dd className="mt-1 font-mono text-2xl tabular-nums">
              {privateUntil ? "—" : config.skillNames.length}
            </dd>
            <dd className="mt-1 truncate text-[11px] text-muted-foreground">
              {privateUntil
                ? `revealed ${revealLabel}`
                : config.skillNames.length
                  ? config.skillNames.join(", ")
                  : "context only"}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-[11px] text-muted-foreground">Max steps</dt>
            <dd className="mt-1 font-mono text-2xl tabular-nums">
              {config.harness?.maxSteps ?? "—"}
            </dd>
            <dd className="mt-1 text-[11px] text-muted-foreground">
              {config.harness?.tokenBudget
                ? `${config.harness.tokenBudget.toLocaleString()} tokens / run`
                : "platform default"}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-[11px] text-muted-foreground">Context</dt>
            <dd className="mt-1 font-mono text-2xl tabular-nums">
              {config.contextChars.toLocaleString()}
            </dd>
            <dd className="mt-1 text-[11px] text-muted-foreground">
              chars{config.harness ? ` · temp ${config.harness.temperature}` : ""}
            </dd>
          </div>
          {config.customTools.length > 0 ? (
            <div className="col-span-2 min-w-0">
              <dt className="text-[11px] text-muted-foreground">Custom tools</dt>
              <dd className="mt-1 flex flex-wrap gap-1.5">
                {config.customTools.map((name) => (
                  <span
                    key={name}
                    className="rounded-sm border border-brand/30 bg-brand-soft px-1.5 py-0.5 font-mono text-[11px] text-brand"
                  >
                    {name}
                  </span>
                ))}
              </dd>
            </div>
          ) : null}
        </dl>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-5 py-2.5 text-xs text-muted-foreground">
        <span>Customizations become public to the league {COOLDOWN_DAYS} days after they are saved.</span>
        <Link href={`${base}/traces`} className="eyebrow transition-colors hover:text-foreground">
          Recent traces →
        </Link>
      </div>
    </section>
  );
}

function SectionRule({
  title,
  meta,
  action,
}: {
  title: string;
  meta?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border pb-2.5">
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 className="eyebrow text-foreground">{title}</h2>
        {meta ? (
          <span className="text-xs text-muted-foreground">{meta}</span>
        ) : null}
      </div>
      {action}
    </div>
  );
}

function SlotTable({
  rows,
  totals,
}: {
  rows: LineupRow[];
  totals?: { projected: number; live: number };
}) {
  return (
    <div role="table" aria-label={totals ? "Starting lineup" : "Bench players"}>
      <div
        role="row"
        className="grid grid-cols-[34px_minmax(0,1fr)_42px_48px] items-center gap-2 border-b border-border py-2 text-[11px] text-muted-foreground sm:grid-cols-[42px_minmax(0,1fr)_60px_64px] sm:gap-3"
      >
        <span role="columnheader">Slot</span>
        <span role="columnheader">Player / game</span>
        <span role="columnheader" className="text-right">
          Proj
        </span>
        <span role="columnheader" className="text-right">
          Points
        </span>
      </div>
      {rows.map((row, index) => (
        <div
          role="row"
          key={`${row.slot}-${index}`}
          className="grid grid-cols-[34px_minmax(0,1fr)_42px_48px] items-center gap-2 border-b border-border py-2 sm:grid-cols-[42px_minmax(0,1fr)_60px_64px] sm:gap-3"
        >
          <span role="cell">
            <PositionTag slot={row.slot} />
          </span>
          <div role="cell" className="flex min-w-0 items-center gap-2 sm:gap-3">
            {row.entry ? (
              <>
                <PlayerHeadshot
                  name={row.entry.fullName}
                  sleeperId={row.entry.sleeperId}
                  nflTeam={row.entry.nflTeam}
                  position={row.entry.position}
                  size={32}
                />
                <div className="min-w-0">
                  <div className="truncate text-xs font-medium leading-snug sm:text-sm">
                    {row.entry.fullName}
                    {row.entry.injuryStatus ? (
                      <span className="ml-1 text-[10px] font-semibold text-danger">
                        {row.entry.injuryStatus}
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-0.5 truncate text-[10px] leading-snug text-muted-foreground sm:text-xs">
                    {row.entry.position} · {row.entry.nflTeam ?? "FA"} ·{" "}
                    {row.entry.opponent ?? "Opponent TBD"}
                    {row.entry.kickoffAt
                      ? ` · ${formatET(row.entry.kickoffAt, "EEE h:mm a")} ET`
                      : ""}
                  </div>
                </div>
              </>
            ) : (
              <span className="text-xs text-muted-foreground">Empty slot</span>
            )}
          </div>
          <span
            role="cell"
            className="text-right font-mono text-xs tabular-nums text-muted-foreground"
          >
            {row.entry?.projection?.toFixed(1) ?? "—"}
          </span>
          <span
            role="cell"
            className="text-right font-mono text-sm font-medium tabular-nums"
          >
            {row.entry?.livePoints?.toFixed(1) ?? "—"}
          </span>
        </div>
      ))}
      {totals ? (
        <div
          role="row"
          className="grid grid-cols-[minmax(0,1fr)_42px_48px] gap-2 bg-muted px-1 py-2.5 sm:grid-cols-[minmax(0,1fr)_60px_64px] sm:gap-3"
        >
          <span role="cell" aria-colspan={2} className="text-xs font-medium">
            Starter totals
          </span>
          <span
            role="cell"
            className="text-right font-mono text-xs text-muted-foreground"
          >
            {totals.projected.toFixed(1)}
          </span>
          <span role="cell" className="text-right font-mono text-sm text-brand">
            {totals.live.toFixed(1)}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2 first:pt-0 last:pb-0">
      <dt className="eyebrow">{label}</dt>
      <dd className="text-right font-mono text-xs tabular-nums text-foreground">
        {value}
      </dd>
    </div>
  );
}
