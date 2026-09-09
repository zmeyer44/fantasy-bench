"use client";

import { ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "convex/react";

import { Badge, cn } from "@/components/ui";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { FunctionReturnType } from "convex/server";

import { Collapsible } from "./collapsible";
import { JsonBlock } from "./json-block";

export type TraceStep = FunctionReturnType<
  typeof api.runs.steps
>["page"][number];

type ToolCall = {
  toolName?: string;
  toolCallId?: string;
  input?: unknown;
  args?: unknown;
};
type ToolResult = {
  toolName?: string;
  toolCallId?: string;
  output?: unknown;
  result?: unknown;
  payloadRef?: string;
};

function asToolCall(value: unknown): ToolCall {
  return (value ?? {}) as ToolCall;
}

function resultErrors(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const output = (record.output ?? record.result ?? record) as Record<
    string,
    unknown
  >;
  if (!output || typeof output !== "object") return [];
  if (Array.isArray(output.errors)) return output.errors.map(String);
  if (output.ok === false) return ["Tool rejected the call"];
  if (typeof output.error === "string") return [output.error];
  return [];
}

/**
 * One model call: text / reasoning, its tool calls, their results, and the
 * per-step usage line.
 *
 * A step is a ruled section of the trace document, not a card: a 30-step run
 * paints as a stack of hairline-separated headers and only the step you open
 * costs anything. `#step-N` still deep-links from posts, messages, picks and
 * actions: a matching hash opens the step and marks it in lime.
 */
export function StepCard({ step }: { step: TraceStep }) {
  const details = useRef<HTMLDetailsElement>(null);

  // Deep links: `#step-3` opens step 3. The `open` attribute is the DOM's own
  // state, so this syncs an external system rather than re-rendering.
  useEffect(() => {
    const anchor = `#step-${step.stepIndex}`;
    const reveal = () => {
      if (window.location.hash === anchor && details.current)
        details.current.open = true;
    };
    reveal();
    window.addEventListener("hashchange", reveal);
    return () => window.removeEventListener("hashchange", reveal);
  }, [step.stepIndex]);

  const tokens = step.usage;

  return (
    <section
      id={`step-${step.stepIndex}`}
      className="scroll-mt-24 border-b border-border target:bg-brand-soft"
    >
      <details ref={details} className="group">
        <summary
          className={cn(
            "flex cursor-pointer list-none flex-wrap items-center gap-2 py-2.5",
            "transition-colors hover:bg-accent",
          )}
        >
          <ChevronRight
            aria-hidden
            className="size-3.5 shrink-0 text-ink-faint transition-transform group-open:rotate-90"
          />
          <a
            href={`#step-${step.stepIndex}`}
            className="font-mono text-xs text-ink-faint hover:text-brand-strong"
            onClick={(event) => event.stopPropagation()}
          >
            #{step.stepIndex}
          </a>
          <span className="text-sm font-medium text-foreground">
            Step {step.stepIndex}
          </span>
          {step.hasValidationError ? (
            <Badge variant="destructive">Validation error</Badge>
          ) : null}
          {step.finishReason ? (
            <Badge variant="outline">{step.finishReason}</Badge>
          ) : null}
          <span className="ml-auto font-mono text-[10px] tabular-nums text-ink-faint">
            {tokens.inputTokens} in · {tokens.outputTokens} out
            {tokens.reasoningTokens ? ` · ${tokens.reasoningTokens} rsn` : ""}
            {tokens.cachedInputTokens
              ? ` · ${tokens.cachedInputTokens} cached`
              : ""}{" "}
            · ${step.costUsd.toFixed(5)}
            {step.latencyMs !== null ? ` · ${step.latencyMs}ms` : ""}
          </span>
        </summary>

        <div className="space-y-2.5 pb-4 pl-5">
          {step.reasoning ? (
            <Collapsible
              summary="Reasoning"
              meta={`${step.reasoning.length} chars`}
            >
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
                {step.reasoning}
              </p>
            </Collapsible>
          ) : null}

          {step.text ? (
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
              {step.text}
            </p>
          ) : step.toolCalls.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No model text on this step.
            </p>
          ) : null}

          {step.toolCalls.map((raw, index) => {
            const call = asToolCall(raw);
            const positional = step.toolResults[index] as
              ToolResult | undefined;
            const matched =
              (step.toolResults.find(
                (candidate) =>
                  (candidate as ToolResult)?.toolCallId !== undefined &&
                  (candidate as ToolResult).toolCallId === call.toolCallId,
              ) as ToolResult | undefined) ?? positional;
            return (
              <ToolCallBlock
                key={call.toolCallId ?? index}
                call={call}
                result={matched ?? null}
              />
            );
          })}
        </div>
      </details>
    </section>
  );
}

/**
 * One tool call and its result.
 *
 * Results larger than the inline limit are stored as
 * `{ toolCallId, payloadRef }`; the payload is fetched only once the reader
 * actually opens the result.
 */
function ToolCallBlock({
  call,
  result,
}: {
  call: ToolCall;
  result: ToolResult | null;
}) {
  const [resultOpen, setResultOpen] = useState(false);
  const errors = resultErrors(result);
  const payloadRef =
    typeof result?.payloadRef === "string" ? result.payloadRef : null;

  const payload = useQuery(
    api.runs.stepPayload,
    resultOpen && payloadRef
      ? { payloadId: payloadRef as Id<"run_step_payloads"> }
      : "skip",
  );

  const inline = result ? (result.output ?? result.result ?? result) : null;
  const body = payloadRef ? (payload ? payload.payload : undefined) : inline;

  return (
    <div className="border-l border-border pl-3">
      <Collapsible
        summary={
          <>
            → {call.toolName ?? "tool"}
            {errors.length > 0 ? " (rejected)" : ""}
          </>
        }
        meta={call.toolCallId}
        tone={errors.length > 0 ? "error" : "default"}
      >
        <JsonBlock value={call.input ?? call.args ?? {}} />
      </Collapsible>
      {result ? (
        <Collapsible
          summary="← result"
          meta={
            errors.length > 0
              ? `${errors.length} error(s)`
              : payloadRef
                ? "large result"
                : undefined
          }
          tone={errors.length > 0 ? "error" : "default"}
          onOpenChange={setResultOpen}
        >
          {errors.length > 0 ? (
            <ul className="mb-2 list-inside list-disc rounded-sm border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          ) : null}
          {body === undefined ? (
            <p className="text-sm text-muted-foreground">
              Loading the stored result…
            </p>
          ) : (
            <JsonBlock
              value={body}
              tone={errors.length > 0 ? "error" : "default"}
            />
          )}
        </Collapsible>
      ) : null}
    </div>
  );
}
