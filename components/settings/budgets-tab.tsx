"use client";

import { useState } from "react";

import { Field, FieldDescription, FieldGroup, FieldLabel, Input } from "@/components/ui";
import { api } from "@/convex/_generated/api";
import { DEFAULT_WEEKLY_USD_CAP_PER_TEAM, effectiveWeeklyUsdCap } from "@/convex/lib/defaults";

import { SettingsSection, useSave } from "./shared";
import type { SettingsData } from "./types";

/** Weekly token cap per team (game mechanic) and league USD hard cap (safety). */
export function BudgetsTab({ data }: { data: SettingsData }) {
  const [tokenCap, setTokenCap] = useState(
    data.rules.weeklyTokenCapPerTeam === undefined ? "" : String(data.rules.weeklyTokenCapPerTeam),
  );
  const [usdCap, setUsdCap] = useState(
    data.rules.leagueUsdHardCap === undefined ? "" : String(data.rules.leagueUsdHardCap),
  );
  const effectiveTeamCap = effectiveWeeklyUsdCap(data.rules.weeklyUsdCapPerTeam);
  const [teamUsdCap, setTeamUsdCap] = useState(
    effectiveTeamCap === null ? "" : String(effectiveTeamCap),
  );

  const save = useSave(api.commissioner.setBudgets);

  return (
    <SettingsSection
      title="Budgets"
      description="Budgets stay editable after the draft (PRD 5.1). Every change is logged."
      saving={save.isPending}
      error={save.error}
      saved={save.saved}
      onSubmit={() =>
        void save.submit({
          leagueId: data.league._id,
          weeklyTokenCapPerTeam: tokenCap === "" ? null : Number(tokenCap),
          leagueUsdHardCap: usdCap === "" ? null : Number(usdCap),
          weeklyUsdCapPerTeam: teamUsdCap === "" ? null : Number(teamUsdCap),
        })
      }
      footer="When a cap is reached, remaining runs in the week use fallbacks. Owners who add their own gateway key bypass every cap; their spend is still metered and public."
    >
      <FieldGroup className="gap-4 sm:grid sm:grid-cols-3">
        <Field>
          <FieldLabel htmlFor="weekly-usd-cap">Weekly spend cap per team (USD)</FieldLabel>
          <Input
            id="weekly-usd-cap"
            type="number"
            min={0}
            step="0.25"
            placeholder="No cap"
            className="font-mono"
            value={teamUsdCap}
            onChange={(event) => setTeamUsdCap(event.target.value)}
          />
          <FieldDescription>
            Default ${DEFAULT_WEEKLY_USD_CAP_PER_TEAM.toFixed(2)} per team per week. Blank = no cap.
          </FieldDescription>
        </Field>

        <Field>
          <FieldLabel htmlFor="weekly-token-cap">Weekly token cap per team</FieldLabel>
          <Input
            id="weekly-token-cap"
            type="number"
            min={0}
            step={1000}
            placeholder="No cap"
            className="font-mono"
            value={tokenCap}
            onChange={(event) => setTokenCap(event.target.value)}
          />
          <FieldDescription>
            Blank = no cap. The agent is told its remaining budget in every run.
          </FieldDescription>
        </Field>

        <Field>
          <FieldLabel htmlFor="league-usd-cap">League USD hard cap</FieldLabel>
          <Input
            id="league-usd-cap"
            type="number"
            min={0}
            step="0.01"
            placeholder="No cap"
            className="font-mono"
            value={usdCap}
            onChange={(event) => setUsdCap(event.target.value)}
          />
          <FieldDescription>Blank = no cap. This is a safety mechanism.</FieldDescription>
        </Field>
      </FieldGroup>
    </SettingsSection>
  );
}
