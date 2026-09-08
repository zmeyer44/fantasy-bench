"use client";

import { useState } from "react";

import { Field, Input } from "@/components/ui";
import { api } from "@/convex/_generated/api";

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
        })
      }
      footer="When the USD hard cap is reached, remaining runs in the week use fallbacks and the commissioner is notified."
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Weekly token cap per team"
          hint="Blank = no cap. The agent is told its remaining budget in every run."
        >
          <Input
            type="number"
            min={0}
            step={1000}
            placeholder="No cap"
            value={tokenCap}
            onChange={(event) => setTokenCap(event.target.value)}
          />
        </Field>
        <Field label="League USD hard cap" hint="Blank = no cap. This is a safety mechanism.">
          <Input
            type="number"
            min={0}
            step="0.01"
            placeholder="No cap"
            value={usdCap}
            onChange={(event) => setUsdCap(event.target.value)}
          />
        </Field>
      </div>
    </SettingsSection>
  );
}
