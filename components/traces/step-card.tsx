import { Badge, Card, CardBody, CardHeader } from "@/components/ui";
import type { TraceStep } from "@/lib/services/views";

import { Collapsible } from "./collapsible";
import { JsonBlock } from "./json-block";

type ToolCall = { toolName?: string; toolCallId?: string; input?: unknown; args?: unknown };
type ToolResult = {
  toolName?: string;
  toolCallId?: string;
  output?: unknown;
  result?: unknown;
};

function asToolCall(value: unknown): ToolCall {
  return (value ?? {}) as ToolCall;
}

function resultErrors(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const output = (record.output ?? record.result ?? record) as Record<string, unknown>;
  if (!output || typeof output !== "object") return [];
  if (Array.isArray(output.errors)) return output.errors.map(String);
  if (output.ok === false) return ["Tool rejected the call"];
  if (typeof output.error === "string") return [output.error];
  return [];
}

/**
 * One model call: text / reasoning, its tool calls, their results, and the
 * per-step usage line. Anchored at `#step-N` for deep links from posts,
 * messages, picks and actions.
 */
export function StepCard({ step }: { step: TraceStep }) {
  const tokens = step.usage as {
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    cachedInputTokens?: number;
  };

  return (
    <Card
      id={`step-${step.stepIndex}`}
      className="scroll-mt-24 target:border-accent target:shadow-[0_0_0_3px_var(--color-accent-soft)]"
    >
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <a
              href={`#step-${step.stepIndex}`}
              className="font-mono text-xs text-ink-faint hover:text-accent-strong"
            >
              #{step.stepIndex}
            </a>
            <span>Step {step.stepIndex}</span>
            {step.hasValidationError ? <Badge tone="danger">validation error</Badge> : null}
            {step.finishReason ? <Badge tone="outline">{step.finishReason}</Badge> : null}
          </span>
        }
        action={
          <span className="font-mono text-[10px] tabular-nums text-ink-faint">
            {tokens.inputTokens ?? 0} in · {tokens.outputTokens ?? 0} out
            {tokens.reasoningTokens ? ` · ${tokens.reasoningTokens} rsn` : ""}
            {tokens.cachedInputTokens ? ` · ${tokens.cachedInputTokens} cached` : ""} · $
            {step.costUsd.toFixed(5)}
            {step.latencyMs !== null ? ` · ${step.latencyMs}ms` : ""}
          </span>
        }
      />
      <CardBody className="space-y-2.5">
        {step.reasoning ? (
          <Collapsible summary="Reasoning" meta={`${step.reasoning.length} chars`}>
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-muted">
              {step.reasoning}
            </p>
          </Collapsible>
        ) : null}

        {step.text ? (
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink">{step.text}</p>
        ) : step.toolCalls.length === 0 ? (
          <p className="text-xs text-ink-faint">No model text on this step.</p>
        ) : null}

        {step.toolCalls.map((raw, index) => {
          const call = asToolCall(raw);
          const result = step.toolResults[index] as ToolResult | undefined;
          const matched =
            (step.toolResults.find(
              (candidate) =>
                (candidate as ToolResult)?.toolCallId !== undefined &&
                (candidate as ToolResult).toolCallId === call.toolCallId,
            ) as ToolResult | undefined) ?? result;
          const errors = resultErrors(matched);
          return (
            <div key={call.toolCallId ?? index} className="space-y-1.5">
              <Collapsible
                summary={
                  <span className="font-mono">
                    → {call.toolName ?? "tool"}
                    {errors.length > 0 ? " (rejected)" : ""}
                  </span>
                }
                meta={call.toolCallId}
                tone={errors.length > 0 ? "error" : "default"}
              >
                <JsonBlock value={call.input ?? call.args ?? {}} />
              </Collapsible>
              {matched ? (
                <Collapsible
                  summary={<span className="font-mono">← result</span>}
                  meta={errors.length > 0 ? `${errors.length} error(s)` : undefined}
                  tone={errors.length > 0 ? "error" : "default"}
                >
                  {errors.length > 0 ? (
                    <ul className="mb-2 list-inside list-disc rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
                      {errors.map((error) => (
                        <li key={error}>{error}</li>
                      ))}
                    </ul>
                  ) : null}
                  <JsonBlock
                    value={(matched as ToolResult).output ?? (matched as ToolResult).result ?? matched}
                    tone={errors.length > 0 ? "error" : "default"}
                  />
                </Collapsible>
              ) : null}
            </div>
          );
        })}
      </CardBody>
    </Card>
  );
}
