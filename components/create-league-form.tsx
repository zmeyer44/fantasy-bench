"use client";

import { useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { mutationErrorMessage } from "@/components/league/convex-errors";
import { InviteLink } from "@/components/league/invite-link";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldLabel,
  Input,
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

const TEAM_COUNTS = [8, 10, 12, 14];

type Created = { leagueId: Id<"leagues">; name: string; joinCode: string };

/**
 * Commission a league in two steps: the form, then the invite link. The link
 * is the commissioner's one job after creating a league, so it is shown here
 * rather than buried in settings (where it also lives, with a rotate button).
 */
export function CreateLeagueForm() {
  const router = useRouter();

  const [name, setName] = useState("");
  const [teamCount, setTeamCount] = useState(12);
  const [scoringPreset, setScoringPreset] = useState<
    "ppr" | "half_ppr" | "standard"
  >("ppr");
  const [draftType, setDraftType] = useState<"snake" | "auction">("snake");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);

  const createLeague = useMutation(api.leagues.create);

  async function submit() {
    setError(null);
    setPending(true);
    try {
      const { leagueId, joinCode } = await createLeague({
        name,
        teamCount,
        scoringPreset,
        draftType,
        isPublic: true,
        superflex: false,
        tePremium: false,
        faabBudget: 100,
      });
      setCreated({ leagueId, name: name.trim(), joinCode });
    } catch (err) {
      setError(mutationErrorMessage(err));
    } finally {
      setPending(false);
    }
  }

  if (created) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>{created.name} is ready</DialogTitle>
          <DialogDescription>
            Send this link to everyone who should own a team. They will sign up
            or log in, then claim a team from the invitation page.
          </DialogDescription>
        </DialogHeader>
        <InviteLink code={created.joinCode} />
        <p className="text-xs text-muted-foreground">
          You can find this link again, or rotate it, under the league&apos;s
          settings.
        </p>
        <DialogFooter>
          <Button
            type="button"
            onClick={() => router.push(`/leagues/${created.leagueId}`)}
          >
            Open league
          </Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Create a league</DialogTitle>
        <DialogDescription>
          You become the commissioner. Teams start unowned; you get an invite
          link to share once the league exists.
        </DialogDescription>
      </DialogHeader>
      <form
        id="create-league-form"
        className="grid gap-4 sm:grid-cols-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field className="sm:col-span-3">
          <FieldLabel htmlFor="league-name">League name</FieldLabel>
          <Input
            id="league-name"
            autoFocus
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
            onChange={(e) =>
              setScoringPreset(e.target.value as typeof scoringPreset)
            }
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

        {error ? (
          <p
            role="alert"
            className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive sm:col-span-3"
          >
            {error}
          </p>
        ) : null}

        <DialogFooter className="sm:col-span-3" showCloseButton>
          <Button type="submit" disabled={pending}>
            {pending ? "Creating…" : "Create league"}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

/** "Create a league" as a modal. Remounts the form on every open. */
export function CreateLeagueDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {open ? <CreateLeagueForm /> : null}
      </DialogContent>
    </Dialog>
  );
}
