"use client";

import { useState } from "react";

import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Input,
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui";
import { api } from "@/convex/_generated/api";

import { CompactField, LockNotice, SettingsSection, ToggleField, useSave } from "./shared";
import type { SettingsData } from "./types";

const SLOTS = ["QB", "RB", "WR", "TE", "FLEX", "SUPERFLEX", "K", "DEF", "BENCH"];

/** Scoring preset, roster shape, superflex/TE-premium, FAAB, playoff format. */
export function RulesTab({ data }: { data: SettingsData }) {
  const { rules, locked } = data;

  const [scoringPreset, setScoringPreset] = useState(rules.scoringPreset);
  const [superflex, setSuperflex] = useState(rules.superflex);
  const [tePremium, setTePremium] = useState(rules.tePremium);
  const [faabBudget, setFaabBudget] = useState(String(rules.faabBudget));
  const [playoffTeams, setPlayoffTeams] = useState(String(rules.playoffTeams));
  const [playoffStartWeek, setPlayoffStartWeek] = useState(String(rules.playoffStartWeek));
  const [regularSeasonWeeks, setRegularSeasonWeeks] = useState(String(rules.regularSeasonWeeks));
  const [contextCharLimit, setContextCharLimit] = useState(String(rules.contextCharLimit));
  const [maxStepsCap, setMaxStepsCap] = useState(String(rules.maxStepsCap));
  const [slots, setSlots] = useState<Record<string, number>>({ ...rules.rosterSlots });

  const save = useSave(api.commissioner.updateRules);

  return (
    <div className="space-y-6">
      <LockNotice locked={locked} />

      <SettingsSection
        title="Scoring & roster"
        description={
          locked
            ? "Frozen: the draft has begun and these decide the shape of the season."
            : "These freeze when the draft starts."
        }
        disabled={locked}
        saving={save.isPending}
        error={save.error}
        saved={save.saved}
        bodyClassName="gap-8"
        onSubmit={() =>
          void save.submit({
            leagueId: data.league._id,
            patch: {
              scoringPreset,
              superflex,
              tePremium,
              rosterSlots: slots,
              faabBudget: Number(faabBudget),
              playoffTeams: Number(playoffTeams),
              playoffStartWeek: Number(playoffStartWeek),
              regularSeasonWeeks: Number(regularSeasonWeeks),
              contextCharLimit: Number(contextCharLimit),
              maxStepsCap: Number(maxStepsCap),
            },
          })
        }
      >
        <FieldGroup className="gap-4 sm:grid sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="scoring-preset">Scoring preset</FieldLabel>
            <NativeSelect
              id="scoring-preset"
              className="w-full"
              value={scoringPreset}
              onChange={(event) => setScoringPreset(event.target.value as typeof scoringPreset)}
            >
              <NativeSelectOption value="ppr">PPR</NativeSelectOption>
              <NativeSelectOption value="half_ppr">Half PPR</NativeSelectOption>
              <NativeSelectOption value="standard">Standard</NativeSelectOption>
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor="faab-budget">FAAB budget</FieldLabel>
            <Input
              id="faab-budget"
              type="number"
              min={0}
              max={1000}
              className="font-mono"
              value={faabBudget}
              onChange={(event) => setFaabBudget(event.target.value)}
            />
            <FieldDescription>Dollars per team per season.</FieldDescription>
          </Field>
        </FieldGroup>

        <FieldGroup className="gap-4">
          <ToggleField
            label="Superflex"
            hint="The FLEX slot may start a QB."
            checked={superflex}
            disabled={locked}
            onChange={setSuperflex}
          />
          <ToggleField
            label="TE premium"
            hint="Tight ends score extra per reception."
            checked={tePremium}
            disabled={locked}
            onChange={setTePremium}
          />
        </FieldGroup>

        <FieldSet>
          <FieldLegend variant="label" className="eyebrow">
            Roster shape
          </FieldLegend>
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-5">
            {SLOTS.map((slot) => (
              <CompactField key={slot} label={slot} htmlFor={`slot-${slot}`}>
                <Input
                  id={`slot-${slot}`}
                  type="number"
                  min={0}
                  max={20}
                  value={slots[slot] ?? 0}
                  onChange={(event) =>
                    setSlots((prev) => ({ ...prev, [slot]: Number(event.target.value) }))
                  }
                  className="font-mono"
                />
              </CompactField>
            ))}
          </div>
        </FieldSet>

        <FieldGroup className="gap-4 sm:grid sm:grid-cols-4">
          <Field>
            <FieldLabel htmlFor="regular-season-weeks">Regular season</FieldLabel>
            <Input
              id="regular-season-weeks"
              type="number"
              min={4}
              max={17}
              className="font-mono"
              value={regularSeasonWeeks}
              onChange={(event) => setRegularSeasonWeeks(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="playoff-teams">Playoff teams</FieldLabel>
            <Input
              id="playoff-teams"
              type="number"
              min={2}
              max={8}
              className="font-mono"
              value={playoffTeams}
              onChange={(event) => setPlayoffTeams(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="playoff-start-week">Playoffs start</FieldLabel>
            <Input
              id="playoff-start-week"
              type="number"
              min={10}
              max={18}
              className="font-mono"
              value={playoffStartWeek}
              onChange={(event) => setPlayoffStartWeek(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="max-steps-cap">Max steps cap</FieldLabel>
            <Input
              id="max-steps-cap"
              type="number"
              min={1}
              max={30}
              className="font-mono"
              value={maxStepsCap}
              onChange={(event) => setMaxStepsCap(event.target.value)}
            />
            <FieldDescription>Upper bound on any owner&rsquo;s harness.</FieldDescription>
          </Field>
        </FieldGroup>

        <Field className="sm:max-w-xs">
          <FieldLabel htmlFor="context-char-limit">Context character limit</FieldLabel>
          <Input
            id="context-char-limit"
            type="number"
            min={500}
            max={100000}
            className="font-mono"
            value={contextCharLimit}
            onChange={(event) => setContextCharLimit(event.target.value)}
          />
          <FieldDescription>How long an owner&rsquo;s system context may be.</FieldDescription>
        </Field>
      </SettingsSection>
    </div>
  );
}
