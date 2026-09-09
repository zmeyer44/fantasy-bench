"use client";

import { useState } from "react";

import {
  Field,
  FieldLabel,
  FieldGroup,
  Input,
  NativeSelect,
  NativeSelectOption,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui";
import { api } from "@/convex/_generated/api";

import { GlobalSaveSection } from "./global-save";
import { SettingsSection, useSave } from "./shared";
import {
  WEEKDAY_OPTIONS,
  FIXED_LINEUP_POLICY,
  WINDOW_TEMPLATES,
  type SettingsData,
  type Weekday,
  type WindowOverrideInput,
  type WindowOverridesInput,
} from "./types";

/** The config edit lock plus per-window-label schedule overrides (PRD 5.3, 5.5). */
export function WindowsTab({ data }: { data: SettingsData }) {
  const [editLock, setEditLock] = useState(data.rules.editLock);
  const [overrides, setOverrides] = useState<WindowOverridesInput>(() => {
    const stored = (data.rules.windowOverrides ?? {}) as WindowOverridesInput;
    const editable = new Set<string>(WINDOW_TEMPLATES.map((template) => template.label));
    return Object.fromEntries(Object.entries(stored).filter(([label]) => editable.has(label)));
  });

  const saveLock = useSave(api.commissioner.setEditLock);
  const saveOverrides = useSave(api.commissioner.setWindowOverrides);

  const patch = (label: string, next: Partial<WindowOverrideInput>) =>
    setOverrides((prev) => ({ ...prev, [label]: { ...prev[label], ...next } }));

  return (
    <div className="space-y-10">
      <SettingsSection
        title="Config edit lock"
        description="Owners may edit their agent between these two Eastern moments each week. Edits saved during the lock are queued and apply at the next unlock, or sooner with a global save."
        saving={saveLock.isPending}
        error={saveLock.error}
        saved={saveLock.saved}
        onSubmit={() =>
          void saveLock.submit({
            leagueId: data.league._id,
            editLock: {
              unlockDay: editLock.unlockDay,
              unlockTime: editLock.unlockTime,
              lockDay: editLock.lockDay,
              lockTime: editLock.lockTime,
            },
          })
        }
        footer={`Currently unlocks ${editLock.unlockDay} ${editLock.unlockTime} and locks ${editLock.lockDay} ${editLock.lockTime} ET.`}
      >
        <FieldGroup className="gap-4 sm:grid sm:grid-cols-4">
          <Field>
            <FieldLabel htmlFor="unlock-day">Unlock day</FieldLabel>
            <NativeSelect
              id="unlock-day"
              className="w-full"
              value={editLock.unlockDay}
              onChange={(event) =>
                setEditLock({ ...editLock, unlockDay: event.target.value })
              }
            >
              {WEEKDAY_OPTIONS.map((day) => (
                <NativeSelectOption key={day} value={day}>
                  {day}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor="unlock-time">Unlock time</FieldLabel>
            <Input
              id="unlock-time"
              className="font-mono"
              value={editLock.unlockTime}
              placeholder="06:00"
              onChange={(event) =>
                setEditLock({ ...editLock, unlockTime: event.target.value })
              }
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="lock-day">Lock day</FieldLabel>
            <NativeSelect
              id="lock-day"
              className="w-full"
              value={editLock.lockDay}
              onChange={(event) =>
                setEditLock({ ...editLock, lockDay: event.target.value })
              }
            >
              {WEEKDAY_OPTIONS.map((day) => (
                <NativeSelectOption key={day} value={day}>
                  {day}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor="lock-time">Lock time</FieldLabel>
            <Input
              id="lock-time"
              className="font-mono"
              value={editLock.lockTime}
              placeholder="03:00"
              onChange={(event) =>
                setEditLock({ ...editLock, lockTime: event.target.value })
              }
            />
          </Field>
        </FieldGroup>
      </SettingsSection>

      <GlobalSaveSection data={data} />

      <SettingsSection
        title="Weekly lineup deadline"
        description="Every team gets one weekly lineup window. This league-wide competitive deadline cannot be overridden."
      >
        <div className="grid gap-2 border-y border-border py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
          <div>
            <p className="font-medium text-foreground">{FIXED_LINEUP_POLICY.name}</p>
            <p className="mt-1 font-mono text-xs text-muted-foreground">
              {FIXED_LINEUP_POLICY.label} · {FIXED_LINEUP_POLICY.schedule}
            </p>
          </div>
          <p className="text-sm font-medium text-warning">
            Hard lock · {FIXED_LINEUP_POLICY.deadline}
          </p>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Window overrides"
        description="Adjust waivers, trades, and forum windows. The weekly lineup deadline is fixed above."
        saving={saveOverrides.isPending}
        error={saveOverrides.error}
        saved={saveOverrides.saved}
        onSubmit={() =>
          void saveOverrides.submit({
            leagueId: data.league._id,
            windowOverrides:
              Object.keys(overrides).length > 0 ? overrides : null,
          })
        }
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Window</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Opens</TableHead>
              <TableHead>At</TableHead>
              <TableHead>Closes</TableHead>
              <TableHead>At</TableHead>
              <TableHead numeric>Lead (min)</TableHead>
              <TableHead numeric>Rounds</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {WINDOW_TEMPLATES.map((template) => {
              const current = overrides[template.label] ?? {};
              const enabled = current.enabled ?? true;
              return (
                <TableRow key={template.label}>
                  <TableCell className="align-top">
                    <span className="block text-foreground">
                      {template.name}
                    </span>
                    <span className="block font-mono text-xs text-ink-faint">
                      {template.label} · {template.defaults}
                    </span>
                  </TableCell>
                  <TableCell className="align-top">
                    <div className="flex items-center gap-2 pt-1">
                      <Switch
                        checked={enabled}
                        aria-label={`${template.name} enabled`}
                        onCheckedChange={(next) =>
                          patch(template.label, { enabled: next })
                        }
                      />
                      <span
                        className={
                          enabled
                            ? "font-mono text-xs text-brand"
                            : "font-mono text-xs text-muted-foreground"
                        }
                      >
                        {enabled ? "Open" : "Off"}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="align-top">
                    <DaySelect
                      label={`${template.name} opens on`}
                      value={current.opensDay ?? ""}
                      onChange={(value) =>
                        patch(template.label, { opensDay: value })
                      }
                    />
                  </TableCell>
                  <TableCell className="align-top">
                    <TimeInput
                      label={`${template.name} opens at`}
                      value={current.opensTime ?? ""}
                      onChange={(value) =>
                        patch(template.label, { opensTime: value || undefined })
                      }
                    />
                  </TableCell>
                  <TableCell className="align-top">
                    <DaySelect
                      label={`${template.name} closes on`}
                      value={current.closesDay ?? ""}
                      onChange={(value) =>
                        patch(template.label, { closesDay: value })
                      }
                    />
                  </TableCell>
                  <TableCell className="align-top">
                    <TimeInput
                      label={`${template.name} closes at`}
                      value={current.closesTime ?? ""}
                      onChange={(value) =>
                        patch(template.label, {
                          closesTime: value || undefined,
                        })
                      }
                    />
                  </TableCell>
                  <TableCell numeric className="align-top">
                    <NumberInput
                      label={`${template.name} submission lead minutes`}
                      value={current.submissionLeadMinutes}
                      onChange={(value) =>
                        patch(template.label, { submissionLeadMinutes: value })
                      }
                    />
                  </TableCell>
                  <TableCell numeric className="align-top">
                    <NumberInput
                      label={`${template.name} rounds`}
                      value={current.rounds}
                      onChange={(value) =>
                        patch(template.label, { rounds: value })
                      }
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </SettingsSection>
    </div>
  );
}

function DaySelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: Weekday | undefined) => void;
}) {
  return (
    <NativeSelect
      size="sm"
      aria-label={label}
      className="w-24"
      value={value}
      onChange={(event) =>
        onChange((event.target.value || undefined) as Weekday | undefined)
      }
    >
      <NativeSelectOption value="">—</NativeSelectOption>
      {WEEKDAY_OPTIONS.map((day) => (
        <NativeSelectOption key={day} value={day}>
          {day}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );
}

function TimeInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Input
      aria-label={label}
      className="h-7 w-24 font-mono text-xs"
      value={value}
      placeholder="HH:mm"
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function NumberInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | undefined;
  onChange: (value: number | undefined) => void;
}) {
  return (
    <Input
      aria-label={label}
      type="number"
      min={0}
      className="h-7 w-20 text-right font-mono text-xs"
      value={value ?? ""}
      onChange={(event) =>
        onChange(
          event.target.value === "" ? undefined : Number(event.target.value),
        )
      }
    />
  );
}
