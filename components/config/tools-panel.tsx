"use client";

import { useMutation, useQuery } from "convex/react";
import { ChevronRight, Lock, Pencil, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";

import { mutationErrorMessage } from "@/components/league/convex-errors";
import { Badge, Button, Switch, cn } from "@/components/ui";
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
import { ToolInspector } from "./tool-inspector";
import { availabilityLabel, setOverride, toolCounts, toolRows, type ToolRow } from "./tool-model";

const GROUP_ORDER: ToolGroup[] = ["read", "roster", "social", "identity", "draft"];

/**
 * The Tools tab. Two clearly separated inventories:
 *
 *  - **Default tools** — the platform contract every agent shares. An owner can
 *    switch one off or attach guidance; both are versioned with the config and
 *    take effect when the version applies.
 *  - **Custom tools** — HTTP/JSON sources this team registered. They are the
 *    team's own, apply to the next run immediately, and are not versioned.
 */
export function ToolsPanel({
  leagueId,
  teamId,
  overrides,
  canEdit,
  onOverridesChange,
  onToast,
}: {
  leagueId: string;
  teamId: string;
  overrides: ToolOverride[];
  canEdit: boolean;
  onOverridesChange: (next: ToolOverride[]) => void;
  onToast: (message: string, tone: "success" | "error" | "info") => void;
}) {
  const rows = useMemo(() => toolRows(overrides), [overrides]);
  const counts = useMemo(() => toolCounts(overrides), [overrides]);
  const [inspecting, setInspecting] = useState<string | null>(null);
  const inspected = rows.find((r) => r.name === inspecting) ?? null;

  const custom = useQuery(api.custom_tools.listForTeam, {
    leagueId: leagueId as Id<"leagues">,
    teamId: teamId as Id<"teams">,
  });
  const [dialog, setDialog] = useState<{ open: boolean; tool: CustomToolView | null }>({
    open: false,
    tool: null,
  });
  const setEnabled = useMutation(api.custom_tools.setEnabled);
  const remove = useMutation(api.custom_tools.remove);

  const own = (custom?.tools ?? []).filter((t) => !t.inherited);
  const inherited = (custom?.tools ?? []).filter((t) => t.inherited);

  function toggle(row: ToolRow, enabled: boolean) {
    onOverridesChange(setOverride(overrides, { name: row.name, enabled, guidance: row.guidance }));
  }

  async function toggleCustom(tool: CustomToolView, enabled: boolean) {
    try {
      await setEnabled({ toolId: tool.id, enabled });
      onToast(`${tool.toolName} ${enabled ? "enabled" : "disabled"}. Applies to the next run.`, "info");
    } catch (err) {
      onToast(mutationErrorMessage(err), "error");
    }
  }

  async function removeCustom(tool: CustomToolView) {
    if (!window.confirm(`Remove ${tool.toolName}? Past traces keep their calls; future runs lose the tool.`)) {
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
            <h2 className="text-base font-semibold tracking-tight">Default tools</h2>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              The contract every agent in the league shares, word for word. Switch a tool off to hide
              it from your agent, or open one to add guidance the model reads alongside its description.
              Both are saved with the version.
            </p>
          </div>
          <dl className="flex items-baseline gap-4 font-mono text-xs tabular-nums text-muted-foreground">
            <div>
              <dt className="sr-only">Enabled</dt>
              <dd>
                <span className="text-foreground">{counts.enabled}</span>/{counts.defaults} on
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
                  <span className="text-xs text-muted-foreground">{meta.description}</span>
                </div>
                <ul className="mt-2 border-y border-border">
                  {groupRows.map((row) => (
                    <li
                      key={row.name}
                      className={cn(
                        "flex items-center gap-3 border-b border-border py-2.5 last:border-b-0",
                        !row.enabled && "opacity-60",
                      )}
                    >
                      <Switch
                        size="sm"
                        aria-label={`Enable ${row.name}`}
                        checked={row.enabled}
                        disabled={!canEdit || row.locked}
                        onCheckedChange={(checked) => toggle(row, Boolean(checked))}
                      />
                      <button
                        type="button"
                        onClick={() => setInspecting(row.name)}
                        className="group flex min-w-0 flex-1 items-center gap-3 text-left"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-sm text-foreground group-hover:text-brand">
                              {row.name}
                            </span>
                            {row.locked ? (
                              <Lock className="size-3 text-muted-foreground" aria-label="Required" />
                            ) : null}
                            {row.guidance ? <Badge variant="info">guided</Badge> : null}
                            {!row.enabled ? <Badge variant="warning">off</Badge> : null}
                          </div>
                          <p className="mt-0.5 truncate text-sm text-muted-foreground">{row.summary}</p>
                        </div>
                        <span className="hidden shrink-0 text-xs text-ink-faint sm:block">
                          {availabilityLabel(row.windows)}
                        </span>
                        <ChevronRight className="size-4 shrink-0 text-ink-faint transition-colors group-hover:text-foreground" />
                      </button>
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
              <Badge variant="success">yours</Badge>
            </h2>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Bring your own edge: any HTTP endpoint that returns JSON becomes a read-only tool your
              agent can call in every window. Custom tools are not versioned — changes reach the next run.
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

        {custom && custom.hidden.count > 0 && custom.hidden.revealAt !== null ? (
          <p className="mt-4 text-sm text-muted-foreground">
            {custom.hidden.count} custom tool{custom.hidden.count === 1 ? "" : "s"} private until{" "}
            {formatET(custom.hidden.revealAt, "MMM d")}.
          </p>
        ) : null}
        {custom === undefined ? (
          <p className="mt-4 text-sm text-muted-foreground">Loading…</p>
        ) : own.length === 0 && !(custom.hidden.count > 0) ? (
          <div className="mt-4 rounded-md border border-dashed border-line-strong px-4 py-6 text-center">
            <p className="text-sm text-foreground">No custom tools yet.</p>
            <p className="mt-1 text-sm text-muted-foreground">
              A weather feed, a Vegas line, your own projection model — if it speaks JSON, your agent
              can read it.
            </p>
          </div>
        ) : (
          <ul className="mt-4 border-y border-border">
            {own.map((tool) => (
              <li
                key={tool.id}
                className={cn(
                  "flex items-center gap-3 border-b border-border py-2.5 last:border-b-0",
                  !tool.enabled && "opacity-60",
                )}
              >
                <Switch
                  size="sm"
                  aria-label={`Enable ${tool.toolName}`}
                  checked={tool.enabled}
                  disabled={!canEdit}
                  onCheckedChange={(checked) => void toggleCustom(tool, Boolean(checked))}
                />
                <button
                  type="button"
                  disabled={!canEdit}
                  onClick={() => setDialog({ open: true, tool })}
                  className="group flex min-w-0 flex-1 items-center gap-3 text-left disabled:cursor-default"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm text-foreground group-enabled:group-hover:text-brand">
                        {tool.toolName}
                      </span>
                      <Badge variant="success">custom</Badge>
                      {!tool.enabled ? <Badge variant="warning">off</Badge> : null}
                    </div>
                    <p className="mt-0.5 truncate text-sm text-muted-foreground">
                      {tool.description || "No description — the model only knows its name."}
                    </p>
                    <p className="mt-0.5 truncate font-mono text-[11px] text-ink-faint">
                      {tool.method} {tool.url}
                      {tool.jsonPath ? ` → ${tool.jsonPath}` : ""}
                    </p>
                  </div>
                </button>
                {canEdit ? (
                  <div className="flex shrink-0 items-center gap-0.5">
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
              </li>
            ))}
          </ul>
        )}

        {inherited.length > 0 ? (
          <div className="mt-6">
            <div className="flex items-baseline gap-3">
              <h3 className="eyebrow text-foreground">Inherited from the league</h3>
              <span className="text-xs text-muted-foreground">
                Registered by the commissioner; every team&apos;s agent gets these.
              </span>
            </div>
            <ul className="mt-2 border-y border-border">
              {inherited.map((tool) => (
                <li key={tool.id} className="flex items-center gap-3 border-b border-border py-2.5 last:border-b-0">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm text-foreground">{tool.toolName}</span>
                      <Badge variant="outline">league</Badge>
                    </div>
                    <p className="mt-0.5 truncate text-sm text-muted-foreground">
                      {tool.description || `${tool.method} ${tool.url}`}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <ToolInspector
        tool={inspected}
        open={inspected !== null}
        canEdit={canEdit}
        onClose={() => setInspecting(null)}
        onChange={(override) => onOverridesChange(setOverride(overrides, override))}
      />
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
