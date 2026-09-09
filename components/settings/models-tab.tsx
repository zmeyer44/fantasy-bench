"use client";

import { useState } from "react";

import {
  Badge,
  Checkbox,
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  NativeSelect,
  NativeSelectOption,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui";
import { OwnKeyBadge } from "@/components/models/own-key-badge";
import { api } from "@/convex/_generated/api";

import { SettingsSection, ToggleField, useSave } from "./shared";
import type { SettingsData } from "./types";

/**
 * Allowlist table with prices, the fallback model, and the
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
    <div className="space-y-10">
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
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8">
                <span className="sr-only">Allowed</span>
              </TableHead>
              <TableHead>Model</TableHead>
              <TableHead>Provider</TableHead>
              <TableHead numeric>$/M in</TableHead>
              <TableHead numeric>$/M out</TableHead>
              <TableHead numeric>$/M cached</TableHead>
              <TableHead numeric>Teams</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.catalog.map((model) => {
              const teams = usedBy.get(model.modelId) ?? 0;
              const checked = allowlist.includes(model.modelId);
              return (
                <TableRow key={model.modelId} data-state={checked ? "selected" : undefined}>
                  <TableCell>
                    <Checkbox
                      checked={checked}
                      aria-label={`Allow ${model.displayName}`}
                      onCheckedChange={() => toggle(model.modelId)}
                    />
                  </TableCell>
                  <TableCell className="max-w-72">
                    <span className="flex items-center gap-2 text-foreground">
                      <span className="truncate">{model.displayName}</span>
                      {model.requiresOwnKey ? <OwnKeyBadge compact /> : null}
                    </span>
                    <span className="block truncate font-mono text-xs text-ink-faint">
                      {model.modelId}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{model.provider}</TableCell>
                  <TableCell numeric className="font-mono text-xs">
                    {model.inputPerM}
                  </TableCell>
                  <TableCell numeric className="font-mono text-xs">
                    {model.outputPerM}
                  </TableCell>
                  <TableCell numeric className="font-mono text-xs text-muted-foreground">
                    {model.cachedInputPerM ?? "—"}
                  </TableCell>
                  <TableCell numeric>
                    {teams > 0 ? (
                      <Badge variant="secondary">{teams}</Badge>
                    ) : (
                      <span className="font-mono text-xs text-ink-faint">0</span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {allowlist.length === 0 ? <FieldError>Pick at least one model.</FieldError> : null}
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
        <Field className="sm:max-w-lg">
          <FieldLabel htmlFor="fallback-model">Fallback model</FieldLabel>
          <NativeSelect
            id="fallback-model"
            className="w-full"
            value={fallback}
            onChange={(event) => setFallback(event.target.value)}
          >
            <NativeSelectOption value="">None — fail without a model fallback</NativeSelectOption>
            {data.catalog.map((model) => (
              <NativeSelectOption
                key={model.modelId}
                value={model.modelId}
                disabled={model.requiresOwnKey}
              >
                {model.displayName} ({model.modelId})
                {model.requiresOwnKey ? " · 🔒 own key only" : ""}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <FieldDescription>
            Used after retries are exhausted. Disclosed in the trace. Models that only run on a
            team&apos;s own key cannot be the fallback.
          </FieldDescription>
        </Field>

        <ToggleField
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
        <FieldGroup className="gap-4 sm:grid sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="replace-from">From (deprecated)</FieldLabel>
            <NativeSelect
              id="replace-from"
              className="w-full"
              value={fromModel}
              onChange={(event) => setFromModel(event.target.value)}
            >
              <NativeSelectOption value="">Select a model in use</NativeSelectOption>
              {data.modelsInUse.map((row) => (
                <NativeSelectOption key={row.modelId} value={row.modelId}>
                  {row.modelId} ({row.teamCount} team{row.teamCount === 1 ? "" : "s"})
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor="replace-to">To (replacement)</FieldLabel>
            <NativeSelect
              id="replace-to"
              className="w-full"
              value={toModel}
              onChange={(event) => setToModel(event.target.value)}
            >
              <NativeSelectOption value="">Select a replacement</NativeSelectOption>
              {data.catalog
                .filter((model) => model.modelId !== fromModel)
                .map((model) => (
                  <NativeSelectOption
                    key={model.modelId}
                    value={model.modelId}
                    disabled={model.requiresOwnKey}
                  >
                    {model.displayName} ({model.modelId})
                    {model.requiresOwnKey ? " · 🔒 own key only" : ""}
                  </NativeSelectOption>
                ))}
            </NativeSelect>
          </Field>
        </FieldGroup>

        {replace.data ? (
          <p className="text-sm text-muted-foreground">
            Updated {replace.data.teamsUpdated.length} team(s).
          </p>
        ) : null}
      </SettingsSection>
    </div>
  );
}
