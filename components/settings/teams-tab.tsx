"use client";

import { useState } from "react";

import { Badge, Button, Card, CardBody, CardHeader, Input } from "@/components/ui";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

import { useSave } from "./shared";
import type { SettingsData, SettingsTeam } from "./types";

/**
 * Assign owners by email and rename teams.
 *
 * The rows come from `commissioner.settings.teams` (waiver-priority order, with
 * the owner's email — the address this tab assigns by).
 */
export function TeamsTab({ data }: { data: SettingsData }) {
  return (
    <Card>
      <CardHeader
        title="Teams"
        description="In waiver-priority order. Assign an owner by the email on their Fantasy Bench account, or send them the invite link from the League tab."
      />
      <CardBody className="space-y-3">
        {data.teams.map((team) => (
          <TeamRow key={team.id} leagueId={data.league._id} team={team} />
        ))}
      </CardBody>
    </Card>
  );
}

function TeamRow({ leagueId, team }: { leagueId: Id<"leagues">; team: SettingsTeam }) {
  const [name, setName] = useState(team.name);
  const [abbreviation, setAbbreviation] = useState(team.abbreviation);
  const [email, setEmail] = useState("");

  const rename = useSave(api.commissioner.renameTeam);
  const assign = useSave(api.commissioner.assignOwnerByEmail);
  const unassign = useSave(api.commissioner.assignOwner);

  return (
    <div className="rounded-md border border-line px-3 py-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-ink">{team.name}</span>
        <Badge tone="outline">{team.abbreviation}</Badge>
        {team.ownerUserId ? (
          <Badge tone="accent">{team.ownerName ?? team.ownerEmail ?? "owned"}</Badge>
        ) : (
          <Badge tone="warning">unowned</Badge>
        )}
        {team.ownerEmail ? (
          <span className="font-mono text-[10px] text-ink-faint">{team.ownerEmail}</span>
        ) : null}
        <span className="font-mono text-[10px] text-ink-faint">waiver #{team.waiverPriority}</span>
        {team.modelId ? (
          <span className="font-mono text-[10px] text-ink-faint">
            {team.modelId}
            {team.configVersionNo ? ` · v${team.configVersionNo}` : ""}
          </span>
        ) : null}
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <div className="flex items-end gap-2">
          <label className="flex-1">
            <span className="block font-mono text-[10px] uppercase text-ink-faint">Name</span>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="mt-1 h-8 text-xs"
            />
          </label>
          <label className="w-20">
            <span className="block font-mono text-[10px] uppercase text-ink-faint">Abbr</span>
            <Input
              value={abbreviation}
              maxLength={5}
              onChange={(event) => setAbbreviation(event.target.value)}
              className="mt-1 h-8 text-xs"
            />
          </label>
          <Button
            size="sm"
            variant="secondary"
            disabled={rename.isPending}
            onClick={() => void rename.submit({ leagueId, teamId: team.id, name, abbreviation })}
          >
            Rename
          </Button>
        </div>

        <div className="flex items-end gap-2">
          <label className="flex-1">
            <span className="block font-mono text-[10px] uppercase text-ink-faint">
              Assign owner by email
            </span>
            <Input
              type="email"
              value={email}
              placeholder="owner@example.com"
              onChange={(event) => setEmail(event.target.value)}
              className="mt-1 h-8 text-xs"
            />
          </label>
          <Button
            size="sm"
            variant="secondary"
            disabled={assign.isPending || email.length === 0}
            onClick={() => void assign.submit({ leagueId, teamId: team.id, email })}
          >
            Assign
          </Button>
          {team.ownerUserId ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={unassign.isPending}
              onClick={() => void unassign.submit({ leagueId, teamId: team.id, userId: null })}
            >
              Unassign
            </Button>
          ) : null}
        </div>
      </div>

      {[rename.error, assign.error, unassign.error].filter(Boolean).map((message) => (
        <p key={message} className="mt-2 text-xs text-danger" role="alert">
          {message}
        </p>
      ))}
      {[rename.saved, assign.saved, unassign.saved].some(Boolean) ? (
        <p className="mt-2 text-xs text-accent-strong">Saved.</p>
      ) : null}
    </div>
  );
}
