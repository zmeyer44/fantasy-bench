"use client";

import { useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { mutationErrorMessage } from "@/components/league/convex-errors";
import {
  Button,
  Field,
  FieldLabel,
  Input,
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui";
import { api } from "@/convex/_generated/api";

const TEAM_COUNTS = [8, 10, 12, 14];

export function CreateLeagueForm() {
  const router = useRouter();

  const [name, setName] = useState("");
  const [teamCount, setTeamCount] = useState(12);
  const [scoringPreset, setScoringPreset] = useState<"ppr" | "half_ppr" | "standard">("ppr");
  const [draftType, setDraftType] = useState<"snake" | "auction">("snake");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const createLeague = useMutation(api.leagues.create);

  async function submit() {
    setError(null);
    setPending(true);
    try {
      const { leagueId } = await createLeague({
        name,
        teamCount,
        scoringPreset,
        draftType,
        isPublic: true,
        superflex: false,
        tePremium: false,
        faabBudget: 100,
      });
      // The league pages read Convex live; navigating is enough.
      router.push(`/leagues/${leagueId}`);
    } catch (err) {
      setError(mutationErrorMessage(err));
      setPending(false);
    }
  }

  return (
    <section>
      <div className="border-b border-border pb-3">
        <h2 className="eyebrow text-foreground">Create a league</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          You become the commissioner. Teams start unowned; invite owners with the league link.
        </p>
      </div>

      <form
        className="mt-5 grid items-end gap-5 sm:grid-cols-2 lg:grid-cols-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field className="sm:col-span-2 lg:col-span-4">
          <FieldLabel htmlFor="league-name">League name</FieldLabel>
          <Input
            id="league-name"
            required
            minLength={3}
            maxLength={60}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="The Bench League"
          />
        </Field>

        <Field>
          <FieldLabel htmlFor="team-count">Teams</FieldLabel>
          <NativeSelect
            id="team-count"
            className="w-full"
            value={teamCount}
            onChange={(e) => setTeamCount(Number(e.target.value))}
          >
            {TEAM_COUNTS.map((n) => (
              <NativeSelectOption key={n} value={n}>
                {n} teams
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>

        <Field>
          <FieldLabel htmlFor="scoring">Scoring</FieldLabel>
          <NativeSelect
            id="scoring"
            className="w-full"
            value={scoringPreset}
            onChange={(e) => setScoringPreset(e.target.value as typeof scoringPreset)}
          >
            <NativeSelectOption value="ppr">PPR</NativeSelectOption>
            <NativeSelectOption value="half_ppr">Half PPR</NativeSelectOption>
            <NativeSelectOption value="standard">Standard</NativeSelectOption>
          </NativeSelect>
        </Field>

        <Field>
          <FieldLabel htmlFor="draft-type">Draft</FieldLabel>
          <NativeSelect
            id="draft-type"
            className="w-full"
            value={draftType}
            onChange={(e) => setDraftType(e.target.value as typeof draftType)}
          >
            <NativeSelectOption value="snake">Snake</NativeSelectOption>
            <NativeSelectOption value="auction">Auction</NativeSelectOption>
          </NativeSelect>
        </Field>

        <Button type="submit" disabled={pending} className="w-full">
          {pending ? "Creating…" : "Create league"}
        </Button>

        {error ? (
          <p
            role="alert"
            className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive sm:col-span-2 lg:col-span-4"
          >
            {error}
          </p>
        ) : null}
      </form>
    </section>
  );
}
