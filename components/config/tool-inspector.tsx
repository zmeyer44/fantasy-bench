"use client";

import { Lock } from "lucide-react";
import { useState } from "react";

import {
  Badge,
  Button,
  Field,
  FieldDescription,
  FieldLabel,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  Switch,
  Textarea,
  cn,
} from "@/components/ui";
import {
  MAX_TOOL_GUIDANCE_CHARS,
  TOOL_GROUP_LABELS,
  describeWithGuidance,
  type ToolOverride,
} from "@/convex/runtime/tools/catalog";

import { availabilityLabel, windowLabel, type ToolRow } from "./tool-model";

/**
 * The per-tool inspector: what the model reads, the inputs it accepts, where it
 * is available, and the two things an owner can change — whether it is on, and
 * a guidance note appended to its description. Edits are local until the owner
 * saves a version; the panel just reports them upward.
 */
export function ToolInspector({
  tool,
  open,
  canEdit,
  onClose,
  onChange,
}: {
  tool: ToolRow | null;
  open: boolean;
  canEdit: boolean;
  onClose: () => void;
  onChange: (override: ToolOverride) => void;
}) {
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent
        side="right"
        className="w-full gap-0 overflow-y-auto p-0 sm:max-w-xl"
      >
        {tool ? (
          // Keyed by tool so the local draft resets whenever a different tool opens.
          <InspectorBody
            key={tool.name}
            tool={tool}
            canEdit={canEdit}
            onClose={onClose}
            onChange={onChange}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function InspectorBody({
  tool,
  canEdit,
  onClose,
  onChange,
}: {
  tool: ToolRow;
  canEdit: boolean;
  onClose: () => void;
  onChange: (override: ToolOverride) => void;
}) {
  const [guidance, setGuidance] = useState(tool.guidance);
  const [enabled, setEnabled] = useState(tool.enabled);

  const dirty = guidance.trim() !== tool.guidance || enabled !== tool.enabled;
  const preview = describeWithGuidance(
    tool.description,
    enabled ? guidance : "",
  );

  function apply() {
    onChange({ name: tool.name, enabled, guidance: guidance.trim() });
    onClose();
  }

  function reset() {
    setEnabled(true);
    setGuidance("");
  }

  return (
    <>
      <SheetHeader className="border-b border-border px-6 py-5">
        <div className="flex flex-wrap items-center gap-2">
          <SheetTitle className="font-mono text-base tracking-tight">
            {tool.name}
          </SheetTitle>
          <Badge variant="outline">{TOOL_GROUP_LABELS[tool.group].title}</Badge>
          {tool.locked ? (
            <Badge variant="secondary">
              <Lock data-icon="inline-start" /> required
            </Badge>
          ) : null}
          {!enabled ? <Badge variant="warning">Off</Badge> : null}
        </div>
        <SheetDescription>{tool.summary}</SheetDescription>
      </SheetHeader>

      <div className="space-y-8 px-6 py-6">
        {/* ------------------------------------------------------ switch */}
        <section className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-medium">Available to your agent</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {tool.locked
                ? tool.lockedReason
                : enabled
                  ? "Advertised and callable whenever the window allows it."
                  : "Hidden from your agent in every window. It cannot call what it cannot see."}
            </p>
          </div>
          <Switch
            aria-label={`Enable ${tool.name}`}
            checked={enabled}
            disabled={!canEdit || tool.locked}
            onCheckedChange={(checked) => setEnabled(Boolean(checked))}
          />
        </section>

        {/* --------------------------------------------------- guidance */}
        <section>
          <Field>
            <FieldLabel htmlFor={`guidance-${tool.name}`}>
              Owner guidance
            </FieldLabel>
            <Textarea
              id={`guidance-${tool.name}`}
              rows={4}
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
            <FieldDescription className="flex items-baseline justify-between gap-3">
              <span>
                Appended to the tool&apos;s description. Every agent reads it as
                part of the contract.
              </span>
              <span className="shrink-0 font-mono tabular-nums">
                {guidance.length}/{MAX_TOOL_GUIDANCE_CHARS}
              </span>
            </FieldDescription>
          </Field>
        </section>

        {/* --------------------------------------------- what it reads */}
        <section>
          <h3 className="eyebrow text-foreground">What the model reads</h3>
          <pre
            className={cn(
              "mt-3 max-h-72 overflow-y-auto rounded-md border border-border bg-muted px-3 py-2.5 font-sans text-sm leading-relaxed whitespace-pre-wrap text-foreground",
              !enabled && "opacity-50",
            )}
          >
            {preview}
          </pre>
        </section>

        {/* ------------------------------------------------------ inputs */}
        <section>
          <h3 className="eyebrow text-foreground">Inputs</h3>
          {tool.inputs.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">
              Takes no arguments.
            </p>
          ) : (
            <div className="mt-3 overflow-x-auto">
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
                      <td className="py-2 pr-3 align-top font-mono text-xs">
                        {inputSpec.name}
                        {inputSpec.required ? (
                          <span className="text-brand">*</span>
                        ) : null}
                      </td>
                      <td className="py-2 pr-3 align-top font-mono text-xs text-muted-foreground">
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
          )}
        </section>

        {/* ------------------------------------------------ availability */}
        <section>
          <h3 className="eyebrow text-foreground">Windows</h3>
          <p className="mt-3 text-sm text-muted-foreground">
            {availabilityLabel(tool.windows)}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {(
              [
                "lineup",
                "waiver",
                "trade",
                "draft",
                "forum",
                "commissioner",
              ] as const
            ).map((w) => {
              const on = tool.windows.includes(w);
              return (
                <span
                  key={w}
                  className={cn(
                    "rounded-sm border px-1.5 py-0.5 font-mono text-[11px]",
                    on
                      ? "border-line-strong text-foreground"
                      : "border-border text-ink-faint line-through",
                  )}
                >
                  {windowLabel(w)}
                </span>
              );
            })}
          </div>
        </section>
      </div>

      <SheetFooter className="sticky bottom-0 mt-auto flex-row items-center justify-between gap-2 border-t border-border bg-popover px-6 py-4">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!canEdit || (!guidance && enabled)}
          onClick={reset}
        >
          Reset to default
        </Button>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            {canEdit ? "Cancel" : "Close"}
          </Button>
          {canEdit ? (
            <Button type="button" disabled={!dirty} onClick={apply}>
              Apply to draft
            </Button>
          ) : null}
        </div>
      </SheetFooter>
    </>
  );
}
