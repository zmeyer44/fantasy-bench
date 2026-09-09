"use client";

import { useState } from "react";

import { StartDraftButton } from "@/components/draft/start-draft-button";
import {
  Badge,
  Button,
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  Input,
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui";
import { api } from "@/convex/_generated/api";
import { formatET } from "@/lib/time";

import { SettingsSection, ToggleField, useSave } from "./shared";
import type { SettingsData } from "./types";

/** Name, visibility, draft format/time, invite link, and starting the draft. */
export function LeagueTab({ data }: { data: SettingsData }) {
  const { league, locked } = data;

  const [name, setName] = useState(league.name);
  const [isPublic, setIsPublic] = useState(league.isPublic);
  const [draftType, setDraftType] = useState(league.draftType);
  const [draftAt, setDraftAt] = useState(
    league.draftScheduledAt ? toLocalInput(league.draftScheduledAt) : "",
  );
  const [copied, setCopied] = useState(false);

  const save = useSave(api.commissioner.updateLeague);
  const rotate = useSave(api.commissioner.rotateJoinCode);

  const unowned = data.teams.filter((team) => team.ownerUserId === null).length;

  return (
    <div className="space-y-10">
      <SettingsSection
        title="League"
        description="Public leagues render every spectator page without a login."
        saving={save.isPending}
        error={save.error}
        saved={save.saved}
        onSubmit={() =>
          void save.submit({
            leagueId: league._id,
            name,
            isPublic,
            draftType,
            // Convex stores dates as epoch ms; the input is local wall-clock.
            draftScheduledAt: draftAt ? new Date(draftAt).getTime() : null,
          })
        }
      >
        <Field>
          <FieldLabel htmlFor="league-name">League name</FieldLabel>
          <Input
            id="league-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={60}
          />
        </Field>

        <ToggleField
          label="Public league"
          hint="Anyone with the link can read standings, traces, and the forum."
          checked={isPublic}
          onChange={setIsPublic}
        />

        <FieldGroup className="gap-4 sm:grid sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="draft-type">Draft format</FieldLabel>
            <NativeSelect
              id="draft-type"
              className="w-full"
              value={draftType}
              disabled={locked}
              onChange={(event) => setDraftType(event.target.value as "snake" | "auction")}
            >
              <NativeSelectOption value="snake">Snake</NativeSelectOption>
              <NativeSelectOption value="auction">Auction</NativeSelectOption>
            </NativeSelect>
            <FieldDescription>
              {locked
                ? "Frozen once the draft begins."
                : "Auction is a nomination + sealed-bid sequence."}
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="draft-at">Draft time</FieldLabel>
            <Input
              id="draft-at"
              type="datetime-local"
              value={draftAt}
              onChange={(event) => setDraftAt(event.target.value)}
            />
            <FieldDescription>Your local time; stored as UTC.</FieldDescription>
          </Field>
        </FieldGroup>
      </SettingsSection>

      <SettingsSection
        title="Invite link"
        description="Share this to let owners claim a team. Rotating it invalidates every previous link."
        error={rotate.error}
        footer={
          <>
            Code{" "}
            <span className="font-mono text-foreground">
              {data.invite.code ?? "not minted yet"}
            </span>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center">
          <Input
            readOnly
            aria-label="Invite link"
            value={data.invite.url ?? ""}
            placeholder="Rotate to mint a join code"
            className="col-span-2 min-w-0 font-mono text-xs sm:flex-1"
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="w-full sm:w-auto"
            disabled={!data.invite.url}
            onClick={() => {
              void navigator.clipboard.writeText(data.invite.url ?? "");
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}
          >
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="w-full sm:w-auto"
            disabled={rotate.isPending}
            onClick={() => void rotate.submit({ leagueId: league._id })}
          >
            Rotate
          </Button>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Draft"
        description={
          league.status === "setup"
            ? "Starting the draft locks the rule set and generates the board."
            : `The draft is ${league.status.replace("_", " ")}.`
        }
        footer={
          data.rules.rulesLockedAt ? (
            <>Rules locked {formatET(data.rules.rulesLockedAt, "MMM d, HH:mm")} ET.</>
          ) : (
            <>Rules are not locked yet.</>
          )
        }
      >
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant={league.status === "setup" ? "outline" : "success"}>
            {league.status.replace("_", " ")}
          </Badge>
          {league.status === "setup" ? (
            <StartDraftButton
              leagueId={league._id}
              draftType={league.draftType}
              review={startReview(data)}
              scheduledAt={draftAt ? new Date(draftAt).getTime() : null}
            />
          ) : null}
        </div>
        {unowned > 0 ? (
          <p className="text-sm text-muted-foreground">
            {unowned} team{unowned === 1 ? "" : "s"} unowned — they will draft on the default agent
            config.
          </p>
        ) : null}
      </SettingsSection>
    </div>
  );
}

/** Build the same review contract used by the draft board from live commissioner settings. */
export function startReview(data: SettingsData) {
  const rosterSize = Object.values(data.rules.rosterSlots).reduce((sum, count) => sum + count, 0);
  const prices = new Map(
    data.catalog.map((model) => [model.modelId, model.inputPerM > 0 || model.outputPerM > 0]),
  );
  return {
    teamCount: data.teams.length,
    rosterSize,
    totalRosterSpots: rosterSize * data.teams.length,
    scoringPreset: data.rules.scoringPreset,
    superflex: data.rules.superflex,
    tePremium: data.rules.tePremium,
    draftPickSeconds: data.rules.draftPickSeconds,
    draftBudget: data.rules.draftBudget,
    unownedTeams: data.teams.filter((team) => team.ownerUserId === null).length,
    modelAssignments: data.modelsInUse.map((assignment) => ({
      ...assignment,
      paid: prices.get(assignment.modelId) ?? true,
    })),
  };
}

/** Epoch ms → the local wall-clock string `<input type="datetime-local">` wants. */
function toLocalInput(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}
