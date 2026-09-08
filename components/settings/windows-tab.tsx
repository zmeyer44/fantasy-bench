"use client";

import { useState } from "react";

import { Field, Input, Select } from "@/components/ui";
import { api } from "@/convex/_generated/api";

import { SettingsSection, Toggle, useSave } from "./shared";
import {
  WEEKDAY_OPTIONS,
  WINDOW_TEMPLATES,
  type SettingsData,
  type Weekday,
  type WindowOverrideInput,
  type WindowOverridesInput,
} from "./types";

/** The config edit lock plus per-window-label schedule overrides (PRD 5.3, 5.5). */
export function WindowsTab({ data }: { data: SettingsData }) {
  const [editLock, setEditLock] = useState(data.rules.editLock);
  const [overrides, setOverrides] = useState<WindowOverridesInput>(
    (data.rules.windowOverrides ?? {}) as WindowOverridesInput,
  );

  const saveLock = useSave(api.commissioner.setEditLock);
  const saveOverrides = useSave(api.commissioner.setWindowOverrides);

  const patch = (label: string, next: Partial<WindowOverrideInput>) =>
    setOverrides((prev) => ({ ...prev, [label]: { ...prev[label], ...next } }));

  return (
    <div className="space-y-5">
      <SettingsSection
        title="Config edit lock"
        description="Owners may edit their agent between these two Eastern moments each week. Edits saved during the lock are queued and apply at the next unlock."
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
        <div className="grid gap-4 sm:grid-cols-4">
          <Field label="Unlock day">
            <Select
              value={editLock.unlockDay}
              onChange={(event) =>
                setEditLock({ ...editLock, unlockDay: event.target.value })
              }
            >
              {WEEKDAY_OPTIONS.map((day) => (
                <option key={day} value={day}>
                  {day}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Unlock time">
            <Input
              value={editLock.unlockTime}
              placeholder="06:00"
              onChange={(event) => setEditLock({ ...editLock, unlockTime: event.target.value })}
            />
          </Field>
          <Field label="Lock day">
            <Select
              value={editLock.lockDay}
              onChange={(event) => setEditLock({ ...editLock, lockDay: event.target.value })}
            >
              {WEEKDAY_OPTIONS.map((day) => (
                <option key={day} value={day}>
                  {day}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Lock time">
            <Input
              value={editLock.lockTime}
              placeholder="03:00"
              onChange={(event) => setEditLock({ ...editLock, lockTime: event.target.value })}
            />
          </Field>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Window overrides"
        description="Leave a field blank to keep the template default. Only labels you touch are stored."
        saving={saveOverrides.isPending}
        error={saveOverrides.error}
        saved={saveOverrides.saved}
        onSubmit={() =>
          void saveOverrides.submit({
            leagueId: data.league._id,
            windowOverrides: Object.keys(overrides).length > 0 ? overrides : null,
          })
        }
      >
        <div className="space-y-3">
          {WINDOW_TEMPLATES.map((template) => {
            const current = overrides[template.label] ?? {};
            return (
              <div key={template.label} className="rounded-md border border-line px-3 py-2.5">
                <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm font-medium text-ink">{template.name}</span>
                  <span className="font-mono text-[10px] text-ink-faint">
                    {template.label} · default {template.defaults}
                  </span>
                </div>
                <Toggle
                  label="Enabled"
                  checked={current.enabled ?? true}
                  onChange={(next) => patch(template.label, { enabled: next })}
                />
                <div className="mt-2 grid gap-2 sm:grid-cols-6">
                  <DaySelect
                    label="Opens"
                    value={current.opensDay ?? ""}
                    onChange={(value) => patch(template.label, { opensDay: value })}
                  />
                  <TimeInput
                    label="at"
                    value={current.opensTime ?? ""}
                    onChange={(value) => patch(template.label, { opensTime: value || undefined })}
                  />
                  <DaySelect
                    label="Closes"
                    value={current.closesDay ?? ""}
                    onChange={(value) => patch(template.label, { closesDay: value })}
                  />
                  <TimeInput
                    label="at"
                    value={current.closesTime ?? ""}
                    onChange={(value) => patch(template.label, { closesTime: value || undefined })}
                  />
                  <NumberInput
                    label="Lead (min)"
                    value={current.submissionLeadMinutes}
                    onChange={(value) =>
                      patch(template.label, { submissionLeadMinutes: value })
                    }
                  />
                  <NumberInput
                    label="Rounds"
                    value={current.rounds}
                    onChange={(value) => patch(template.label, { rounds: value })}
                  />
                </div>
              </div>
            );
          })}
        </div>
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
    <label className="block">
      <span className="block font-mono text-[10px] uppercase text-ink-faint">{label}</span>
      <Select
        value={value}
        onChange={(event) => onChange((event.target.value || undefined) as Weekday | undefined)}
        className="mt-1 h-8 text-xs"
      >
        <option value="">—</option>
        {WEEKDAY_OPTIONS.map((day) => (
          <option key={day} value={day}>
            {day}
          </option>
        ))}
      </Select>
    </label>
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
    <label className="block">
      <span className="block font-mono text-[10px] uppercase text-ink-faint">{label}</span>
      <Input
        value={value}
        placeholder="HH:mm"
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 h-8 text-xs"
      />
    </label>
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
    <label className="block">
      <span className="block font-mono text-[10px] uppercase text-ink-faint">{label}</span>
      <Input
        type="number"
        min={0}
        value={value ?? ""}
        onChange={(event) =>
          onChange(event.target.value === "" ? undefined : Number(event.target.value))
        }
        className="mt-1 h-8 text-xs"
      />
    </label>
  );
}
