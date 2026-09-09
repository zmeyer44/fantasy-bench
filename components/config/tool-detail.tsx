"use client";

import { useMutation } from "convex/react";
import { ArrowLeft, ArrowRight, Lock } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  mutationErrorIssues,
  mutationErrorMessage,
  type ConvexIssue,
} from "@/components/league/convex-errors";
import {
  Badge,
  Button,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  Section,
  SectionHeader,
  Switch,
  Textarea,
  cn,
} from "@/components/ui";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  ALL_WINDOWS,
  MAX_TOOL_GUIDANCE_CHARS,
  TOOL_GROUP_LABELS,
  describeWithGuidance,
} from "@/convex/runtime/tools/catalog";
import { formatET } from "@/lib/time";

import { Toast, type ToastTone } from "./toast";
import { availabilityLabel, windowLabel, type ToolRow } from "./tool-model";

export type ToolNeighbor = { name: string; summary: string };

/**
 * One default tool's page: what the model reads, the inputs it accepts, where
 * it is available, and the two things an owner can change — whether it is on,
 * and a guidance note appended to its description. Saving appends a config
 * version with just this tool's override changed (`configs.saveToolOverride`),
 * applied now or queued for the next unlock like any other save.
 */
export function ToolDetail({
  leagueId,
  teamId,
  teamName,
  tool,
  canEdit,
  lock,
  siblings,
  previous,
  next,
}: {
  leagueId: string;
  teamId: string;
  teamName: string;
  tool: ToolRow;
  canEdit: boolean;
  lock: { open: boolean; nextChange: number };
  /** The other tools in the same group, for the side rail. */
  siblings: ToolNeighbor[];
  previous: ToolNeighbor | null;
  next: ToolNeighbor | null;
}) {
  const router = useRouter();
  const base = `/leagues/${leagueId}/teams/${teamId}/config/tools`;

  const [enabled, setEnabled] = useState(tool.enabled);
  const [guidance, setGuidance] = useState(tool.guidance);
  const [changeSummary, setChangeSummary] = useState("");
  const [baseline, setBaseline] = useState({
    enabled: tool.enabled,
    guidance: tool.guidance,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<ConvexIssue[]>([]);
  const [toast, setToast] = useState<{
    message: string;
    tone: ToastTone;
  } | null>(null);

  const dirty =
    enabled !== baseline.enabled ||
    guidance.trim() !== baseline.guidance.trim();
  const customized = !enabled || guidance.trim().length > 0;
  const preview = describeWithGuidance(
    tool.description,
    enabled ? guidance : "",
  );
  const nextChangeLabel = `${formatET(lock.nextChange, "EEE h:mm a")} ET`;

  const save = useMutation(api.configs.saveToolOverride);

  async function submit() {
    setSaving(true);
    setError(null);
    setIssues([]);
    try {
      const result = await save({
        leagueId: leagueId as Id<"leagues">,
        teamId: teamId as Id<"teams">,
        override: {
          name: tool.name,
          enabled,
          ...(guidance.trim() ? { guidance: guidance.trim() } : {}),
        },
        ...(changeSummary.trim()
          ? { changeSummary: changeSummary.trim() }
          : {}),
      });
      setBaseline({ enabled, guidance: guidance.trim() });
      setGuidance(guidance.trim());
      setChangeSummary("");
      setToast({
        message: result.applied
          ? "Changes saved."
          : "Changes saved — they take effect at the next unlock.",
        tone: "success",
      });
      router.refresh();
    } catch (err) {
      setError(mutationErrorMessage(err));
      setIssues(mutationErrorIssues(err));
    } finally {
      setSaving(false);
    }
  }

  function reset() {
    setEnabled(true);
    setGuidance("");
  }

  const group = TOOL_GROUP_LABELS[tool.group];

  return (
    <div className="space-y-8">
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(16rem,20rem)]">
        {/* ============================================================ main */}
        <div className="min-w-0 space-y-10">
          {/* ------------------------------------------------ availability */}
          <Section>
            <SectionHeader
              eyebrow="Availability"
              title="Available to your agent"
              action={
                <Switch
                  aria-label={`Enable ${tool.name}`}
                  checked={enabled}
                  disabled={!canEdit || tool.locked}
                  onCheckedChange={(checked) => setEnabled(Boolean(checked))}
                />
              }
            />
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
              {tool.locked ? (
                <Lock className="size-3.5 shrink-0" aria-hidden />
              ) : null}
              {tool.locked
                ? "Required. Every agent keeps this tool on."
                : enabled
                  ? "On. Your agent can call it in the windows below."
                  : "Off. Hidden from your agent in every window."}
            </p>
          </Section>

          {/* ---------------------------------------------------- guidance */}
          <Section>
            <SectionHeader
              eyebrow="Customize"
              title="Owner guidance"
              description="A note the model reads with the tool's description."
              action={
                <span className="tabular-nums">
                  {guidance.length}/{MAX_TOOL_GUIDANCE_CHARS}
                </span>
              }
            />
            <Field>
              <FieldLabel htmlFor={`guidance-${tool.name}`} className="sr-only">
                Owner guidance
              </FieldLabel>
              <Textarea
                id={`guidance-${tool.name}`}
                rows={6}
                value={guidance}
                disabled={!canEdit || !enabled}
                maxLength={MAX_TOOL_GUIDANCE_CHARS}
                placeholder={
                  tool.group === "read"
                    ? "Call this before every lineup decision, and again if a starter is Questionable."
                    : "Only bid on players who would start for you this week. Keep bids under 30% of FAAB."
                }
                onChange={(e) => setGuidance(e.target.value)}
              />
              {!enabled ? (
                <FieldDescription>
                  Ignored while the tool is off.
                </FieldDescription>
              ) : null}
            </Field>
          </Section>

          {/* ------------------------------------------------- what it reads */}
          <Section>
            <SectionHeader
              eyebrow="Contract"
              title="What the model reads"
              action={
                customized ? (
                  <Badge variant="info">Customized</Badge>
                ) : (
                  <span>Default</span>
                )
              }
            />
            <pre
              className={cn(
                "rounded-md border border-border bg-muted px-4 py-3 font-sans text-sm leading-relaxed whitespace-pre-wrap text-foreground",
                !enabled && "opacity-50",
              )}
            >
              {preview}
            </pre>
          </Section>

          {/* ------------------------------------------------------ inputs */}
          <Section>
            <SectionHeader
              eyebrow="Interface"
              title="Inputs"
              description={
                tool.inputs.length === 0 ? "Takes no arguments." : undefined
              }
            />
            {tool.inputs.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left">
                      <th className="eyebrow py-2 pr-3 font-normal">Name</th>
                      <th className="eyebrow py-2 pr-3 font-normal">Type</th>
                      <th className="eyebrow py-2 font-normal">Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tool.inputs.map((inputSpec) => (
                      <tr
                        key={inputSpec.name}
                        className="border-b border-border last:border-b-0"
                      >
                        <td className="py-2 pr-3 align-top font-mono text-xs whitespace-nowrap">
                          {inputSpec.name}
                          {inputSpec.required ? (
                            <span className="text-brand">*</span>
                          ) : null}
                        </td>
                        <td className="py-2 pr-3 align-top font-mono text-xs whitespace-nowrap text-muted-foreground">
                          {inputSpec.type}
                        </td>
                        <td className="py-2 align-top text-muted-foreground">
                          {inputSpec.description ?? ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </Section>
        </div>

        {/* ============================================================ rail */}
        <aside className="min-w-0 space-y-10">
          {/* ----------------------------------------------------- windows */}
          <Section>
            <SectionHeader
              eyebrow="Windows"
              title={availabilityLabel(tool.windows)}
            />
            <ul className="flex flex-wrap gap-1.5">
              {ALL_WINDOWS.map((w) => {
                const on = tool.windows.includes(w);
                return (
                  <li
                    key={w}
                    className={cn(
                      "rounded-sm border px-1.5 py-0.5 font-mono text-[11px]",
                      on
                        ? "border-line-strong text-foreground"
                        : "border-border text-ink-faint line-through",
                    )}
                  >
                    {windowLabel(w)}
                  </li>
                );
              })}
            </ul>
          </Section>

          {/* ------------------------------------------------------- group */}
          <Section>
            <SectionHeader eyebrow="Group" title={group.title} />
            {siblings.length > 0 ? (
              <ul className="divide-y divide-border border-y border-border">
                {siblings.map((sibling) => (
                  <li key={sibling.name}>
                    <Link
                      href={`${base}/${sibling.name}`}
                      className="group flex items-baseline justify-between gap-3 py-2 text-sm"
                    >
                      <span className="truncate font-mono text-xs text-foreground group-hover:text-brand">
                        {sibling.name}
                      </span>
                      <ArrowRight className="size-3.5 shrink-0 self-center text-ink-faint transition-colors group-hover:text-foreground" />
                    </Link>
                  </li>
                ))}
              </ul>
            ) : null}
          </Section>
        </aside>
      </div>

      {/* --------------------------------------------------- prev / next */}
      <div className="flex flex-wrap justify-between gap-3 border-t border-border pt-5">
        {previous ? (
          <Link
            href={`${base}/${previous.name}`}
            className="flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" aria-hidden />
            <span className="font-mono text-xs">{previous.name}</span>
          </Link>
        ) : (
          <span />
        )}
        {next ? (
          <Link
            href={`${base}/${next.name}`}
            className="flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <span className="font-mono text-xs">{next.name}</span>
            <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        ) : null}
      </div>

      {/* ------------------------------------------------------- save bar */}
      {!canEdit ? (
        <p className="border-t border-border pt-5 text-sm text-muted-foreground">
          Read-only. Only {teamName}&apos;s owner or the commissioner can change
          this tool.
        </p>
      ) : dirty || error ? (
        <div className="sticky bottom-4 z-20">
          <div className="rounded-lg border border-line-strong bg-card/95 shadow-lg backdrop-blur supports-backdrop-filter:bg-card/80">
            <div className="flex flex-wrap items-end justify-end gap-4 p-4">
              <Field className="min-w-56 flex-1">
                <FieldLabel
                  htmlFor="tool-change-summary"
                  className="eyebrow text-foreground"
                >
                  Change summary
                </FieldLabel>
                <Input
                  id="tool-change-summary"
                  value={changeSummary}
                  maxLength={200}
                  placeholder={`Tune ${tool.name}`}
                  onChange={(e) => setChangeSummary(e.target.value)}
                />
              </Field>
              <div className="flex items-center gap-3">
                <span className="text-xs text-warning">
                  {lock.open
                    ? "Unsaved changes"
                    : `Unsaved · takes effect ${nextChangeLabel}`}
                </span>
                {customized ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={saving}
                    onClick={reset}
                  >
                    Reset to default
                  </Button>
                ) : null}
                <Button
                  type="button"
                  size="lg"
                  disabled={saving || !dirty}
                  onClick={() => void submit()}
                >
                  {saving ? "Saving…" : "Save changes"}
                </Button>
              </div>
            </div>
            {error ? (
              <div className="border-t border-border px-4 py-3">
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
                {issues.length > 0 ? (
                  <ul className="mt-1.5 space-y-1">
                    {issues.map((issue) => (
                      <li
                        key={`${issue.field}:${issue.message}`}
                        className="text-sm text-destructive"
                      >
                        <span className="font-mono text-xs">{issue.field}</span>{" "}
                        — {issue.message}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      ) : customized ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
          <p className="text-sm text-muted-foreground">Customized.</p>
          <Button type="button" variant="outline" size="sm" onClick={reset}>
            Reset to default
          </Button>
        </div>
      ) : null}

      <Toast
        message={toast?.message ?? null}
        tone={toast?.tone}
        onDismiss={() => setToast(null)}
      />
    </div>
  );
}
