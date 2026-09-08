"use client";

import { useState } from "react";

import { Field, Input, Select } from "@/components/ui";
import { api } from "@/convex/_generated/api";

import { LockNotice, SettingsSection, Toggle, useSave } from "./shared";
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
    <div className="space-y-5">
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
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Scoring preset">
            <Select
              value={scoringPreset}
              onChange={(event) =>
                setScoringPreset(event.target.value as typeof scoringPreset)
              }
            >
              <option value="ppr">PPR</option>
              <option value="half_ppr">Half PPR</option>
              <option value="standard">Standard</option>
            </Select>
          </Field>
          <Field label="FAAB budget" hint="Dollars per team per season.">
            <Input
              type="number"
              min={0}
              max={1000}
              value={faabBudget}
              onChange={(event) => setFaabBudget(event.target.value)}
            />
          </Field>
        </div>

        <div className="space-y-2">
          <Toggle
            label="Superflex"
            hint="The FLEX slot may start a QB."
            checked={superflex}
            onChange={setSuperflex}
          />
          <Toggle
            label="TE premium"
            hint="Tight ends score extra per reception."
            checked={tePremium}
            onChange={setTePremium}
          />
        </div>

        <div>
          <span className="eyebrow mb-2 block">Roster shape</span>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
            {SLOTS.map((slot) => (
              <label key={slot} className="block">
                <span className="block font-mono text-[10px] uppercase text-ink-faint">{slot}</span>
                <Input
                  type="number"
                  min={0}
                  max={20}
                  value={slots[slot] ?? 0}
                  onChange={(event) =>
                    setSlots((prev) => ({ ...prev, [slot]: Number(event.target.value) }))
                  }
                  className="mt-1 h-8 text-xs"
                />
              </label>
            ))}
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-4">
          <Field label="Regular season">
            <Input
              type="number"
              min={4}
              max={17}
              value={regularSeasonWeeks}
              onChange={(event) => setRegularSeasonWeeks(event.target.value)}
            />
          </Field>
          <Field label="Playoff teams">
            <Input
              type="number"
              min={2}
              max={8}
              value={playoffTeams}
              onChange={(event) => setPlayoffTeams(event.target.value)}
            />
          </Field>
          <Field label="Playoffs start">
            <Input
              type="number"
              min={10}
              max={18}
              value={playoffStartWeek}
              onChange={(event) => setPlayoffStartWeek(event.target.value)}
            />
          </Field>
          <Field label="Max steps cap" hint="Upper bound on any owner's harness.">
            <Input
              type="number"
              min={1}
              max={30}
              value={maxStepsCap}
              onChange={(event) => setMaxStepsCap(event.target.value)}
            />
          </Field>
        </div>

        <Field label="Context character limit" hint="How long an owner's system context may be.">
          <Input
            type="number"
            min={500}
            max={100000}
            value={contextCharLimit}
            onChange={(event) => setContextCharLimit(event.target.value)}
          />
        </Field>
      </SettingsSection>
    </div>
  );
}
