"use client";

import { Lock } from "lucide-react";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, cn } from "@/components/ui";

import { ProviderLogo, providerLabel } from "./provider-logo";

/** One row of the picker. Prices are USD per million tokens and optional (models in use may be uncatalogued). */
export type ModelOption = {
  modelId: string;
  displayName: string;
  provider: string;
  inputPerM?: number;
  outputPerM?: number;
  /** Only runs on a team's own gateway key; shows the lock. */
  requiresOwnKey?: boolean;
  /** Greys the row out and blocks selection (e.g. gated model with no key on file). */
  disabled?: boolean;
  /** Trailing note on the detail line, e.g. "3 teams" or "not allowlisted". */
  note?: string;
};

/**
 * The model picker: a shadcn Select whose rows carry the provider mark,
 * display name, provider, pricing and an own-key lock. Used by the agent
 * editor and the commissioner's fallback / replacement tools so every model
 * list in the product reads the same way.
 */
export function ModelSelect({
  id,
  value,
  onValueChange,
  options,
  noneLabel,
  placeholder = "Select a model",
  disabled,
  className,
  "aria-label": ariaLabel,
}: {
  id?: string;
  /** The selected gateway id, or `null` for the "none" row. */
  value: string | null;
  onValueChange: (modelId: string | null) => void;
  options: readonly ModelOption[];
  /** When set, a leading row with this label selects `null`. */
  noneLabel?: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  const byId = new Map(options.map((option) => [option.modelId, option]));

  return (
    <Select
      value={value}
      onValueChange={(next) => onValueChange((next as string | null) ?? null)}
      disabled={disabled}
    >
      <SelectTrigger id={id} aria-label={ariaLabel} className={cn("w-full", className)}>
        <SelectValue placeholder={placeholder}>
          {(selected: string | null) => {
            if (selected === null || selected === undefined) {
              return <span className="text-muted-foreground">{noneLabel ?? placeholder}</span>;
            }
            const option = byId.get(selected);
            if (!option) {
              return <span className="truncate font-mono text-xs">{selected}</span>;
            }
            return (
              <>
                <ProviderLogo provider={option.provider} className="text-foreground" />
                <span className="truncate">{option.displayName}</span>
                {option.requiresOwnKey ? (
                  <Lock
                    aria-label="Requires your own gateway key"
                    className="size-3.5 text-warning"
                  />
                ) : null}
              </>
            );
          }}
        </SelectValue>
      </SelectTrigger>
      <SelectContent align="start" alignItemWithTrigger={false} className="max-h-96">
        {noneLabel ? (
          <SelectItem value={null} label={noneLabel} className="py-2 text-muted-foreground">
            <span className="flex items-center gap-2.5">
              <span aria-hidden className="size-4 shrink-0" />
              {noneLabel}
            </span>
          </SelectItem>
        ) : null}
        {options.map((option) => (
          <SelectItem
            key={option.modelId}
            value={option.modelId}
            label={option.displayName}
            disabled={option.disabled}
            className="py-2"
          >
            <ModelRow option={option} />
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ModelRow({ option }: { option: ModelOption }) {
  const details: string[] = [providerLabel(option.provider)];
  if (option.inputPerM !== undefined && option.outputPerM !== undefined) {
    details.push(`$${option.inputPerM} in · $${option.outputPerM} out / M`);
  }
  if (option.note) details.push(option.note);

  return (
    <span className="flex min-w-0 flex-1 items-center gap-2.5">
      <ProviderLogo provider={option.provider} className="text-foreground" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-1.5 leading-none">
          <span className="truncate">{option.displayName}</span>
          {option.requiresOwnKey ? (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-warning">
              <Lock aria-hidden className="size-3" />
              Own key
            </span>
          ) : null}
        </span>
        <span className="truncate font-mono text-[11px] leading-none text-muted-foreground">
          {details.join(" · ")}
        </span>
      </span>
    </span>
  );
}
