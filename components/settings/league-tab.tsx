"use client";

import { useState } from "react";

import { Badge, Button, Field, Input, Select } from "@/components/ui";
import { api } from "@/convex/_generated/api";
import { formatET } from "@/lib/time";

import { SettingsSection, Toggle, useSave } from "./shared";
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

  return (
    <div className="space-y-5">
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
        <Field label="League name">
          <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={60} />
        </Field>

        <Toggle
          label="Public league"
          hint="Anyone with the link can read standings, traces, and the forum."
          checked={isPublic}
          onChange={setIsPublic}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Draft format"
            hint={locked ? "Frozen once the draft begins." : "Auction is a nomination + sealed-bid sequence."}
          >
            <Select
              value={draftType}
              disabled={locked}
              onChange={(event) => setDraftType(event.target.value as "snake" | "auction")}
            >
              <option value="snake">Snake</option>
              <option value="auction">Auction</option>
            </Select>
          </Field>

          <Field label="Draft time" hint="Your local time; stored as UTC.">
            <Input
              type="datetime-local"
              value={draftAt}
              onChange={(event) => setDraftAt(event.target.value)}
            />
          </Field>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Invite link"
        description="Share this to let owners claim a team. Rotating it invalidates every previous link."
        footer={
          <span className="font-mono">
            Code <span className="text-ink">{data.invite.code ?? "not minted yet"}</span>
          </span>
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <Input
            readOnly
            value={data.invite.url ?? ""}
            placeholder="Rotate to mint a join code"
            className="min-w-64 flex-1 font-mono text-xs"
          />
          <Button
            size="sm"
            variant="secondary"
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
            size="sm"
            variant="ghost"
            disabled={rotate.isPending}
            onClick={() => void rotate.submit({ leagueId: league._id })}
          >
            Rotate
          </Button>
        </div>
        {rotate.error ? <p className="text-xs text-danger">{rotate.error}</p> : null}
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
          <Badge tone={league.status === "setup" ? "outline" : "accent"}>
            {league.status.replace("_", " ")}
          </Badge>
          {league.status === "setup" ? (
            <Button
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
          {start.error ? <span className="text-xs text-danger">{start.error}</span> : null}
          {start.saved ? <span className="text-xs text-accent-strong">Draft started.</span> : null}
        </div>
        {data.teams.some((team) => team.ownerUserId === null) ? (
          <p className="text-xs text-ink-muted">
            {data.teams.filter((team) => team.ownerUserId === null).length} team(s) are unowned and
            will draft on the default agent config.
          </p>
        ) : null}
      </SettingsSection>
    </div>
  );
}

/** `Date` → `YYYY-MM-DDTHH:mm` in the browser's zone, for `datetime-local`. */
/** Epoch ms → the local wall-clock string `<input type="datetime-local">` wants. */
function toLocalInput(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}
