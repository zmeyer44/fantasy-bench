"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button, Card, CardBody, CardHeader, Field, Input, Select } from "@/components/ui";
import { useTRPC } from "@/lib/trpc/client";

const TEAM_COUNTS = [8, 10, 12, 14];

export function CreateLeagueForm() {
  const router = useRouter();
  const trpc = useTRPC();

  const [name, setName] = useState("");
  const [teamCount, setTeamCount] = useState(12);
  const [scoringPreset, setScoringPreset] = useState<"ppr" | "half_ppr" | "standard">("ppr");
  const [draftType, setDraftType] = useState<"snake" | "auction">("snake");
  const [error, setError] = useState<string | null>(null);

  const createLeague = useMutation(
    trpc.league.create.mutationOptions({
      onSuccess: (league) => {
        router.push(`/leagues/${league.id}`);
        router.refresh();
      },
      onError: (err) => setError(err.message),
    }),
  );

  return (
    <Card>
      <CardHeader
        title="Create a league"
        description="You become the commissioner. Teams start unowned; invite owners with the league link."
      />
      <CardBody>
        <form
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            createLeague.mutate({
              name,
              teamCount,
              scoringPreset,
              draftType,
              isPublic: true,
              superflex: false,
              tePremium: false,
              faabBudget: 100,
            });
          }}
        >
          <div className="sm:col-span-2">
            <Field label="League name" htmlFor="league-name">
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
          </div>

          <Field label="Teams" htmlFor="team-count">
            <Select
              id="team-count"
              value={teamCount}
              onChange={(e) => setTeamCount(Number(e.target.value))}
            >
              {TEAM_COUNTS.map((n) => (
                <option key={n} value={n}>
                  {n} teams
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Scoring" htmlFor="scoring">
            <Select
              id="scoring"
              value={scoringPreset}
              onChange={(e) => setScoringPreset(e.target.value as typeof scoringPreset)}
            >
              <option value="ppr">PPR</option>
              <option value="half_ppr">Half PPR</option>
              <option value="standard">Standard</option>
            </Select>
          </Field>

          <Field label="Draft" htmlFor="draft-type">
            <Select
              id="draft-type"
              value={draftType}
              onChange={(e) => setDraftType(e.target.value as typeof draftType)}
            >
              <option value="snake">Snake</option>
              <option value="auction">Auction</option>
            </Select>
          </Field>

          <div className="flex items-end">
            <Button type="submit" disabled={createLeague.isPending} className="w-full">
              {createLeague.isPending ? "Creating…" : "Create league"}
            </Button>
          </div>

          {error ? (
            <p
              role="alert"
              className="sm:col-span-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger"
            >
              {error}
            </p>
          ) : null}
        </form>
      </CardBody>
    </Card>
  );
}
