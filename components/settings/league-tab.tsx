"use client";

import { useState } from "react";

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

import { SaveStatus, SettingsSection, ToggleField, useSave } from "./shared";
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
  const start = useSave(api.commissioner.startDraft);
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
        <div className="flex flex-wrap items-center gap-2">
          <Input
            readOnly
            aria-label="Invite link"
            value={data.invite.url ?? ""}
            placeholder="Rotate to mint a join code"
            className="min-w-64 flex-1 font-mono text-xs"
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
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
            <Button
              type="button"
              size="sm"
              disabled={start.isPending}
              onClick={() =>
                void start.submit({
                  leagueId: league._id,
                  scheduledAt: draftAt ? new Date(draftAt).getTime() : null,
                })
              }
            >
              {start.isPending ? "Starting…" : "Start the draft"}
            </Button>
          ) : null}
          <SaveStatus error={start.error} saved={start.saved} savedLabel="Draft started." />
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

/** Epoch ms → the local wall-clock string `<input type="datetime-local">` wants. */
function toLocalInput(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}
