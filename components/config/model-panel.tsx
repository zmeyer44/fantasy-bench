"use client";

import { formatUsd } from "@/components/cost/format";
import {
  Checkbox,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  NativeSelect,
  NativeSelectOption,
  cn,
} from "@/components/ui";
import type { HarnessSettings } from "@/convex/lib/config_pure";
import type { PromptEstimate } from "@/convex/lib/config_pure";
import { MODEL_CATALOG, findModel } from "@/lib/models";

import { SpendPanel } from "./spend-panel";

/** The Model & harness tab: which model runs the agent, how hard, and what it costs. */
export function ModelPanel({
  leagueId,
  teamId,
  weekNo,
  modelId,
  harness,
  rules,
  canEdit,
  estimate,
  estimateStale,
  onModelChange,
  onHarnessChange,
  onToast,
}: {
  leagueId: string;
  teamId: string;
  weekNo: number;
  modelId: string;
  harness: HarnessSettings;
  rules: {
    modelAllowlist: string[];
    maxStepsCap: number;
    weeklyTokenCapPerTeam: number | null;
  };
  canEdit: boolean;
  estimate: PromptEstimate | undefined;
  estimateStale: boolean;
  onModelChange: (modelId: string) => void;
  onHarnessChange: (update: (h: HarnessSettings) => HarnessSettings) => void;
  onToast: (message: string, tone: "success" | "error" | "info") => void;
}) {
  const disabled = !canEdit;
  const model = findModel(modelId);
  const allowed =
    rules.modelAllowlist.length > 0
      ? MODEL_CATALOG.filter((m) => rules.modelAllowlist.includes(m.modelId))
      : MODEL_CATALOG;

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="space-y-10">
        <Section title="Model" description="Version-pinned gateway id. Prices per million tokens.">
          <NativeSelect
            className="w-full"
            value={modelId}
            disabled={disabled}
            aria-label="Model"
            onChange={(e) => onModelChange(e.target.value)}
          >
            {allowed.map((m) => (
              <NativeSelectOption key={m.modelId} value={m.modelId}>
                {m.displayName} — {m.provider}
              </NativeSelectOption>
            ))}
            {!allowed.some((m) => m.modelId === modelId) ? (
              <NativeSelectOption value={modelId}>{modelId} (not allowlisted)</NativeSelectOption>
            ) : null}
          </NativeSelect>

          {model ? (
            <dl className="mt-4">
              <SpecRow label="Gateway id" value={model.modelId} />
              <SpecRow label="Provider" value={model.provider} />
              <SpecRow label="$ / M in" value={`$${model.inputPerM}`} />
              <SpecRow label="$ / M out" value={`$${model.outputPerM}`} />
              <SpecRow label="Reasoning" value={model.supportsReasoning ? "supported" : "not supported"} />
            </dl>
          ) : (
            <p className="mt-3 text-sm text-destructive">
              <span className="font-mono">{modelId}</span> is not in the model catalog.
            </p>
          )}
        </Section>

        <Section title="Harness" description="Runtime knobs, bounded by league rules.">
          <div className="space-y-5">
            <SliderField
              label="Max steps"
              hint={`League cap: ${rules.maxStepsCap}`}
              min={1}
              max={rules.maxStepsCap}
              step={1}
              value={harness.maxSteps}
              disabled={disabled}
              onChange={(v) => onHarnessChange((h) => ({ ...h, maxSteps: v }))}
            />

            <Field>
              <FieldLabel htmlFor="token-budget">Token budget per run</FieldLabel>
              <Input
                id="token-budget"
                type="number"
                min={1_000}
                max={rules.weeklyTokenCapPerTeam ?? 2_000_000}
                step={1_000}
                disabled={disabled}
                className="font-mono tabular-nums"
                value={harness.tokenBudget}
                onChange={(e) =>
                  onHarnessChange((h) => ({ ...h, tokenBudget: Number(e.target.value) || 0 }))
                }
              />
              <FieldDescription>
                {rules.weeklyTokenCapPerTeam
                  ? `Weekly team cap: ${rules.weeklyTokenCapPerTeam.toLocaleString()}`
                  : "No weekly cap set by the commissioner."}
              </FieldDescription>
            </Field>

            <SliderField
              label="Temperature"
              hint="0 = deterministic, 2 = wild"
              min={0}
              max={2}
              step={0.1}
              value={harness.temperature}
              disabled={disabled}
              format={(v) => v.toFixed(1)}
              onChange={(v) =>
                onHarnessChange((h) => ({ ...h, temperature: Math.round(v * 10) / 10 }))
              }
            />

            {model?.supportsReasoning ? (
              <Field>
                <FieldLabel htmlFor="reasoning-effort">Reasoning effort</FieldLabel>
                <NativeSelect
                  id="reasoning-effort"
                  className="w-full"
                  disabled={disabled}
                  value={harness.reasoningEffort ?? ""}
                  onChange={(e) =>
                    onHarnessChange((h) => ({
                      ...h,
                      reasoningEffort: (e.target.value || null) as HarnessSettings["reasoningEffort"],
                    }))
                  }
                >
                  <NativeSelectOption value="">Off</NativeSelectOption>
                  <NativeSelectOption value="low">Low</NativeSelectOption>
                  <NativeSelectOption value="medium">Medium</NativeSelectOption>
                  <NativeSelectOption value="high">High</NativeSelectOption>
                </NativeSelect>
              </Field>
            ) : (
              <p className="text-sm text-ink-faint">
                {model?.displayName ?? "This model"} does not expose a reasoning-effort control.
              </p>
            )}

            <Field orientation="horizontal">
              <Checkbox
                id="deliberate-mode"
                disabled={disabled}
                checked={harness.deliberateMode}
                onCheckedChange={(checked) =>
                  onHarnessChange((h) => ({ ...h, deliberateMode: Boolean(checked) }))
                }
              />
              <FieldLabel htmlFor="deliberate-mode" className="font-normal">
                Deliberate mode
                <span className="text-muted-foreground">plan before any tool call</span>
              </FieldLabel>
            </Field>
          </div>
        </Section>
      </div>

      <div className="space-y-10 lg:border-l lg:border-border lg:pl-10">
        <SpendPanel
          leagueId={leagueId}
          teamId={teamId}
          weekNo={weekNo}
          canEdit={canEdit}
          onToast={onToast}
        />
        <Section
          title="Live preview"
          description="Updates as you type. Assumes 4 steps and 1,500 output tokens per step."
        >
          <div className="grid grid-cols-2 divide-x divide-border border-y border-border">
            <div className="min-w-0 py-3 pr-4">
              <div className="eyebrow">Prompt tokens</div>
              <div
                className={cn(
                  "mt-2 font-mono text-xl font-medium tracking-tight tabular-nums",
                  estimateStale && "opacity-50",
                )}
              >
                {estimate ? estimate.tokens.toLocaleString() : "—"}
              </div>
            </div>
            <div className="min-w-0 py-3 pl-4">
              <div className="eyebrow">Est. cost / run</div>
              <div
                className={cn(
                  "mt-2 font-mono text-xl font-medium tracking-tight tabular-nums",
                  estimateStale && "opacity-50",
                )}
              >
                {estimate ? formatUsd(estimate.estimatedCostPerRunUsd) : "—"}
              </div>
            </div>
          </div>
          {estimate ? (
            <dl className="mt-4">
              <SpecRow label="Base prompt" value={estimate.breakdown.baseTokens.toLocaleString()} />
              <SpecRow label="Your context" value={estimate.breakdown.contextTokens.toLocaleString()} />
              <SpecRow label="Skills" value={estimate.breakdown.skillTokens.toLocaleString()} />
            </dl>
          ) : null}
          <p className="mt-3 text-sm text-ink-faint">
            Excludes the per-window snapshot, which varies. Input is priced uncached, so the real
            figure is usually lower.
          </p>
        </Section>
      </div>
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-4 border-b border-border pb-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

/** Label / value pair on a hairline rule. Values are mono because they are read as data. */
function SpecRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border py-1.5 last:border-b-0">
      <dt className="eyebrow">{label}</dt>
      <dd className="truncate font-mono text-xs text-foreground tabular-nums">{value}</dd>
    </div>
  );
}

function SliderField({
  label,
  hint,
  min,
  max,
  step,
  value,
  disabled,
  onChange,
  format,
}: {
  label: string;
  hint?: string;
  min: number;
  max: number;
  step: number;
  value: number;
  disabled?: boolean;
  onChange: (value: number) => void;
  format?: (value: number) => string;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="eyebrow">{label}</span>
        <span className="font-mono text-xs text-foreground tabular-nums">
          {format ? format(value) : value}
        </span>
      </div>
      <input
        type="range"
        className="w-full accent-[var(--color-brand)]"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {hint ? <p className="text-sm text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
