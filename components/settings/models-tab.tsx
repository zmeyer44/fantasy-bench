"use client";

import { useState } from "react";

import { Badge, Field, Select } from "@/components/ui";
import { api } from "@/convex/_generated/api";

import { SettingsSection, Toggle, useSave } from "./shared";
import type { SettingsData } from "./types";

/**
 * Allowlist checklist with prices, the fallback model, and the
 * deprecated-model replacement tool (PRD 5.1 / 7).
 */
export function ModelsTab({ data }: { data: SettingsData }) {
  const [allowlist, setAllowlist] = useState<string[]>(data.rules.modelAllowlist ?? []);
  const [fallback, setFallback] = useState(data.rules.fallbackModelId ?? "");
  const [autopilot, setAutopilot] = useState(data.rules.safetyAutopilot);
  const [fromModel, setFromModel] = useState(data.modelsInUse[0]?.modelId ?? "");
  const [toModel, setToModel] = useState("");

  const saveAllowlist = useSave(api.commissioner.setModelAllowlist);
  const saveFallbacks = useSave(api.commissioner.setFallbacks);
  const replace = useSave(api.commissioner.replaceDeprecatedModel);

  const usedBy = new Map(data.modelsInUse.map((row) => [row.modelId, row.teamCount]));

  const toggle = (modelId: string) =>
    setAllowlist((prev) =>
      prev.includes(modelId) ? prev.filter((id) => id !== modelId) : [...prev, modelId],
    );

  return (
    <div className="space-y-5">
      <SettingsSection
        title="Model allowlist"
        description="Owners may only pick from this list. Versions are pinned — “latest” aliases are rejected."
        saving={saveAllowlist.isPending}
        error={saveAllowlist.error}
        saved={saveAllowlist.saved}
        onSubmit={() =>
          void saveAllowlist.submit({ leagueId: data.league._id, modelIds: allowlist })
        }
      >
        <div className="space-y-1.5">
          {data.catalog.map((model) => {
            const teams = usedBy.get(model.modelId) ?? 0;
            const checked = allowlist.includes(model.modelId);
            return (
              <label
                key={model.modelId}
                className="flex items-center gap-3 rounded-md border border-line px-3 py-2 hover:bg-surface-muted"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(model.modelId)}
                  className="size-4 accent-[var(--color-accent)]"
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-ink">{model.displayName}</span>
                  <span className="block font-mono text-[10px] text-ink-faint">
                    {model.modelId}
                  </span>
                </span>
                <span className="shrink-0 text-right font-mono text-[10px] tabular-nums text-ink-muted">
                  ${model.inputPerM}/M in · ${model.outputPerM}/M out
                  {model.cachedInputPerM !== null ? ` · $${model.cachedInputPerM}/M cached` : ""}
                </span>
                {teams > 0 ? (
                  <Badge tone="accent">
                    {teams} team{teams === 1 ? "" : "s"}
                  </Badge>
                ) : null}
              </label>
            );
          })}
        </div>
        {allowlist.length === 0 ? (
          <p className="text-xs text-danger">Pick at least one model.</p>
        ) : null}
      </SettingsSection>

      <SettingsSection
        title="Fallbacks"
        description="What happens when the primary path fails at lock time (PRD 5.4)."
        saving={saveFallbacks.isPending}
        error={saveFallbacks.error}
        saved={saveFallbacks.saved}
        onSubmit={() =>
          void saveFallbacks.submit({
            leagueId: data.league._id,
            fallbackModelId: fallback === "" ? null : fallback,
            safetyAutopilot: autopilot,
          })
        }
      >
        <Field
          label="Fallback model"
          hint="Used after retries are exhausted. Disclosed in the trace."
        >
          <Select value={fallback} onChange={(event) => setFallback(event.target.value)}>
            <option value="">None — fail without a model fallback</option>
            {data.catalog.map((model) => (
              <option key={model.modelId} value={model.modelId}>
                {model.displayName} ({model.modelId})
              </option>
            ))}
          </Select>
        </Field>
        <Toggle
          label="Safety autopilot"
          hint="If a lineup run fails, keep the last valid lineup and fill empty or locked-out starting slots with the highest-projected eligible bench player."
          checked={autopilot}
          onChange={setAutopilot}
        />
      </SettingsSection>

      <SettingsSection
        title="Replace a deprecated model"
        description="A provider retired a pinned id mid-season. This rewrites every affected team's config to a new version summarised “commissioner replacement” and logs the swap league-wide."
        saving={replace.isPending}
        error={replace.error}
        saved={replace.saved}
        submitLabel="Replace across the league"
        onSubmit={() =>
          void replace.submit({
            leagueId: data.league._id,
            fromModelId: fromModel,
            toModelId: toModel,
          })
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="From (deprecated)">
            <Select value={fromModel} onChange={(event) => setFromModel(event.target.value)}>
              <option value="">Select a model in use</option>
              {data.modelsInUse.map((row) => (
                <option key={row.modelId} value={row.modelId}>
                  {row.modelId} ({row.teamCount} team{row.teamCount === 1 ? "" : "s"})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="To (replacement)">
            <Select value={toModel} onChange={(event) => setToModel(event.target.value)}>
              <option value="">Select a replacement</option>
              {data.catalog
                .filter((model) => model.modelId !== fromModel)
                .map((model) => (
                  <option key={model.modelId} value={model.modelId}>
                    {model.displayName} ({model.modelId})
                  </option>
                ))}
            </Select>
          </Field>
        </div>
        {replace.data ? (
          <p className="text-xs text-accent-strong">
            Updated {replace.data.teamsUpdated.length} team(s).
          </p>
        ) : null}
      </SettingsSection>
    </div>
  );
}
