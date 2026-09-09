"use client";

import { useMutation, useQuery } from "convex/react";
import { ArrowUpRight, Lock, Pencil, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import { mutationErrorMessage } from "@/components/league/convex-errors";
import {
  Badge,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Switch,
  cn,
} from "@/components/ui";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { CustomToolView } from "@/convex/custom_tools";
import {
  TOOL_GROUP_LABELS,
  type ToolGroup,
  type ToolOverride,
} from "@/convex/runtime/tools/catalog";

import { formatET } from "@/lib/time";

import { CustomToolDialog } from "./custom-tool-dialog";
import { availabilityLabel, toolCounts, toolRows } from "./tool-model";

const GROUP_ORDER: ToolGroup[] = [
  "read",
  "roster",
  "social",
  "identity",
  "draft",
];

/**
 * The Tools tab. Two clearly separated inventories:
 *
 *  - **Default tools** — the platform contract every agent shares. Each card
 *    links to the tool's own page, where an owner can switch it off or attach
 *    guidance; both are saved as a config version from there.
 *  - **Custom tools** — HTTP/JSON sources this team registered. They are the
 *    team's own, apply to the next run immediately, and are not versioned.
 */
export function ToolsPanel({
  leagueId,
  teamId,
  overrides,
  canEdit,
  onToast,
}: {
  leagueId: string;
  teamId: string;
  overrides: ToolOverride[];
  canEdit: boolean;
  onToast: (message: string, tone: "success" | "error" | "info") => void;
}) {
  const rows = useMemo(() => toolRows(overrides), [overrides]);
  const counts = useMemo(() => toolCounts(overrides), [overrides]);
  const toolBase = `/leagues/${leagueId}/teams/${teamId}/config/tools`;

  const custom = useQuery(api.custom_tools.listForTeam, {
    leagueId: leagueId as Id<"leagues">,
    teamId: teamId as Id<"teams">,
  });
  const [dialog, setDialog] = useState<{
    open: boolean;
    tool: CustomToolView | null;
  }>({
    open: false,
    tool: null,
  });
  const setEnabled = useMutation(api.custom_tools.setEnabled);
  const remove = useMutation(api.custom_tools.remove);

  const own = (custom?.tools ?? []).filter((t) => !t.inherited);
  const inherited = (custom?.tools ?? []).filter((t) => t.inherited);

  async function toggleCustom(tool: CustomToolView, enabled: boolean) {
    try {
      await setEnabled({ toolId: tool.id, enabled });
      onToast(
        `${tool.toolName} ${enabled ? "enabled" : "disabled"}. Applies to the next run.`,
        "info",
      );
    } catch (err) {
      onToast(mutationErrorMessage(err), "error");
    }
  }

  async function removeCustom(tool: CustomToolView) {
    if (
      !window.confirm(
        `Remove ${tool.toolName}? Past traces keep their calls; future runs lose the tool.`,
      )
    ) {
      return;
    }
    try {
      await remove({ toolId: tool.id });
      onToast(`${tool.toolName} removed.`, "info");
    } catch (err) {
      onToast(mutationErrorMessage(err), "error");
    }
  }

  return (
    <div className="space-y-12">
      {/* ------------------------------------------------------ defaults */}
      <section>
        <header className="flex flex-wrap items-end justify-between gap-3 border-b border-border pb-3">
          <div>
            <h2 className="text-base font-semibold tracking-tight">
              Default tools
            </h2>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              The contract every agent in the league shares, word for word. Open
              a tool to switch it off or add guidance the model reads alongside
              its description. Changes take effect when you save.
            </p>
          </div>
          <dl className="flex items-baseline gap-4 font-mono text-xs tabular-nums text-muted-foreground">
            <div>
              <dt className="sr-only">Enabled</dt>
              <dd>
                <span className="text-foreground">{counts.enabled}</span>/
                {counts.defaults} on
              </dd>
            </div>
            <div>
              <dt className="sr-only">Guided</dt>
              <dd>
                <span className="text-foreground">{counts.guided}</span> guided
              </dd>
            </div>
          </dl>
        </header>

        <div className="mt-6 space-y-8">
          {GROUP_ORDER.map((group) => {
            const groupRows = rows.filter((r) => r.group === group);
            const meta = TOOL_GROUP_LABELS[group];
            return (
              <div key={group}>
                <div className="flex items-baseline gap-3">
                  <h3 className="eyebrow text-foreground">{meta.title}</h3>
                  <span className="text-xs text-muted-foreground">
                    {meta.description}
                  </span>
                </div>
                <ul className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {groupRows.map((row) => (
                    <li key={row.name} className="min-w-0">
                      <Card
                        size="sm"
                        className={cn(
                          "relative h-full transition-colors hover:border-line-strong",
                          !row.enabled && "opacity-60",
                        )}
                      >
                        <CardHeader>
                          <CardTitle className="flex min-w-0 items-center gap-2 font-mono text-sm">
                            <Link
                              href={`${toolBase}/${row.name}`}
                              className="truncate text-left after:absolute after:inset-0 after:rounded-lg hover:text-brand focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring"
                            >
                              {row.name}
                            </Link>
                            {row.locked ? (
                              <Lock
                                className="size-3 shrink-0 text-muted-foreground"
                                aria-label="Required"
                              />
                            ) : null}
                          </CardTitle>
                          <CardDescription className="line-clamp-2">
                            {row.summary}
                          </CardDescription>
                          <CardAction>
                            <ArrowUpRight
                              className="size-4 text-ink-faint"
                              aria-hidden
                            />
                          </CardAction>
                        </CardHeader>
                        <CardContent className="mt-auto flex items-center justify-between gap-2">
                          <span className="truncate text-xs text-ink-faint">
                            {availabilityLabel(row.windows)}
                          </span>
                          <div className="flex shrink-0 gap-1.5">
                            {row.enabled && row.guidance ? (
                              <Badge variant="info">Guided</Badge>
                            ) : null}
                            {!row.enabled ? (
                              <Badge variant="warning">Off</Badge>
                            ) : null}
                          </div>
                        </CardContent>
                      </Card>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </section>

      {/* -------------------------------------------------------- custom */}
      <section>
        <header className="flex flex-wrap items-end justify-between gap-3 border-b border-border pb-3">
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight">
              Custom tools
              <Badge variant="success">Yours</Badge>
            </h2>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Bring your own edge: any HTTP endpoint that returns JSON becomes a
              read-only tool your agent can call in every window. Custom tools
              are not versioned — changes reach the next run.
            </p>
          </div>
          {canEdit ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={own.length >= 8}
              onClick={() => setDialog({ open: true, tool: null })}
            >
              <Plus data-icon="inline-start" /> Add custom tool
            </Button>
          ) : null}
        </header>

        {custom &&
        custom.hidden.count > 0 &&
        custom.hidden.revealAt !== null ? (
          <p className="mt-4 text-sm text-muted-foreground">
            {custom.hidden.count} custom tool
            {custom.hidden.count === 1 ? "" : "s"} private until{" "}
            {formatET(custom.hidden.revealAt, "MMM d")}.
          </p>
        ) : null}
        {custom === undefined ? (
          <p className="mt-4 text-sm text-muted-foreground">Loading…</p>
        ) : own.length === 0 && !(custom.hidden.count > 0) ? (
          <div className="mt-4 rounded-md border border-dashed border-line-strong px-4 py-6 text-center">
            <p className="text-sm text-foreground">No custom tools yet.</p>
            <p className="mt-1 text-sm text-muted-foreground">
              A weather feed, a Vegas line, your own projection model — if it
              speaks JSON, your agent can read it.
            </p>
          </div>
        ) : (
          <ul className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {own.map((tool) => (
              <li key={tool.id} className="min-w-0">
                <Card
                  size="sm"
                  className={cn(
                    "relative h-full transition-colors",
                    canEdit && "hover:border-line-strong",
                    !tool.enabled && "opacity-60",
                  )}
                >
                  <CardHeader>
                    <CardTitle className="flex min-w-0 flex-wrap items-center gap-2 font-mono text-sm">
                      <button
                        type="button"
                        disabled={!canEdit}
                        onClick={() => setDialog({ open: true, tool })}
                        className="truncate text-left after:absolute after:inset-0 after:rounded-lg enabled:hover:text-brand focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring disabled:cursor-default"
                      >
                        {tool.toolName}
                      </button>
                      <Badge variant="success">Custom</Badge>
                      {!tool.enabled ? (
                        <Badge variant="warning">Off</Badge>
                      ) : null}
                    </CardTitle>
                    <CardDescription className="line-clamp-2">
                      {tool.description ||
                        "No description — the model only knows its name."}
                    </CardDescription>
                    <CardAction className="relative z-10">
                      <Switch
                        size="sm"
                        aria-label={`Enable ${tool.toolName}`}
                        checked={tool.enabled}
                        disabled={!canEdit}
                        onCheckedChange={(checked) =>
                          void toggleCustom(tool, Boolean(checked))
                        }
                      />
                    </CardAction>
                  </CardHeader>
                  <CardContent className="mt-auto flex items-center justify-between gap-2">
                    <p className="truncate font-mono text-[11px] text-ink-faint">
                      {tool.method} {tool.url}
                      {tool.jsonPath ? ` → ${tool.jsonPath}` : ""}
                    </p>
                    {canEdit ? (
                      <div className="relative z-10 flex shrink-0 items-center gap-0.5">
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`Edit ${tool.toolName}`}
                          onClick={() => setDialog({ open: true, tool })}
                        >
                          <Pencil />
                        </Button>
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`Remove ${tool.toolName}`}
                          onClick={() => void removeCustom(tool)}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    ) : null}
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        )}

        {inherited.length > 0 ? (
          <div className="mt-6">
            <div className="flex items-baseline gap-3">
              <h3 className="eyebrow text-foreground">
                Inherited from the league
              </h3>
              <span className="text-xs text-muted-foreground">
                Registered by the commissioner; every team&apos;s agent gets
                these.
              </span>
            </div>
            <ul className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {inherited.map((tool) => (
                <li key={tool.id} className="min-w-0">
                  <Card size="sm" className="h-full">
                    <CardHeader>
                      <CardTitle className="flex min-w-0 flex-wrap items-center gap-2 font-mono text-sm">
                        <span className="truncate">{tool.toolName}</span>
                        <Badge variant="outline">League</Badge>
                      </CardTitle>
                      <CardDescription className="line-clamp-2">
                        {tool.description || `${tool.method} ${tool.url}`}
                      </CardDescription>
                    </CardHeader>
                  </Card>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <CustomToolDialog
        open={dialog.open}
        leagueId={leagueId}
        teamId={teamId}
        tool={dialog.tool}
        onClose={() => setDialog((d) => ({ ...d, open: false }))}
        onSaved={(message) => onToast(message, "success")}
      />
    </div>
  );
}
