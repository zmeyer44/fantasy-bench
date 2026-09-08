"use client";

import { useState } from "react";

import {
  Badge,
  Button,
  FieldError,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui";
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
    <section className="space-y-5">
      <header className="border-b border-border pb-3">
        <h2 className="font-heading text-base leading-snug font-medium text-foreground">Teams</h2>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          In waiver-priority order. Assign an owner by the email on their Fantasy Bench account, or
          send them the invite link from the League tab.
        </p>
      </header>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead numeric className="w-12">
              #
            </TableHead>
            <TableHead>Team</TableHead>
            <TableHead className="w-24">Abbr</TableHead>
            <TableHead>Owner</TableHead>
            <TableHead>Model</TableHead>
            <TableHead>Assign by email</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.teams.map((team) => (
            <TeamRow key={team.id} leagueId={data.league._id} team={team} />
          ))}
        </TableBody>
      </Table>
    </section>
  );
}

function TeamRow({ leagueId, team }: { leagueId: Id<"leagues">; team: SettingsTeam }) {
  const [name, setName] = useState(team.name);
  const [abbreviation, setAbbreviation] = useState(team.abbreviation);
  const [email, setEmail] = useState("");

  const rename = useSave(api.commissioner.renameTeam);
  const assign = useSave(api.commissioner.assignOwnerByEmail);
  const unassign = useSave(api.commissioner.assignOwner);

  const messages = [rename.error, assign.error, unassign.error].filter(
    (message): message is string => Boolean(message),
  );
  const saved = [rename.saved, assign.saved, unassign.saved].some(Boolean);

  return (
    <>
      <TableRow className={messages.length > 0 || saved ? "border-b-0" : undefined}>
        <TableCell numeric className="font-mono text-xs text-ink-faint">
          {team.waiverPriority}
        </TableCell>
        <TableCell>
          <Input
            aria-label={`${team.name} name`}
            className="h-7 w-44 text-xs"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </TableCell>
        <TableCell>
          <Input
            aria-label={`${team.name} abbreviation`}
            className="h-7 w-20 font-mono text-xs uppercase"
            value={abbreviation}
            maxLength={5}
            onChange={(event) => setAbbreviation(event.target.value)}
          />
        </TableCell>
        <TableCell>
          {team.ownerUserId ? (
            <div className="flex flex-col gap-0.5">
              <span className="text-foreground">
                {team.ownerName ?? team.ownerEmail ?? "owned"}
              </span>
              {team.ownerEmail ? (
                <span className="font-mono text-xs text-ink-faint">{team.ownerEmail}</span>
              ) : null}
            </div>
          ) : (
            <Badge variant="warning">unowned</Badge>
          )}
        </TableCell>
        <TableCell className="font-mono text-xs text-muted-foreground">
          {team.modelId ? (
            <>
              {team.modelId}
              {team.configVersionNo ? ` · v${team.configVersionNo}` : ""}
            </>
          ) : (
            "—"
          )}
        </TableCell>
        <TableCell>
          <Input
            type="email"
            aria-label={`Assign an owner to ${team.name} by email`}
            className="h-7 w-52 font-mono text-xs"
            value={email}
            placeholder="owner@example.com"
            onChange={(event) => setEmail(event.target.value)}
          />
        </TableCell>
        <TableCell className="text-right">
          <div className="flex items-center justify-end gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={rename.isPending}
              onClick={() => void rename.submit({ leagueId, teamId: team.id, name, abbreviation })}
            >
              Rename
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={assign.isPending || email.length === 0}
              onClick={() => void assign.submit({ leagueId, teamId: team.id, email })}
            >
              Assign
            </Button>
            {team.ownerUserId ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={unassign.isPending}
                onClick={() => void unassign.submit({ leagueId, teamId: team.id, userId: null })}
              >
                Unassign
              </Button>
            ) : null}
          </div>
        </TableCell>
      </TableRow>

      {messages.length > 0 || saved ? (
        <TableRow>
          <TableCell colSpan={7} className="pt-0 whitespace-normal">
            {messages.map((message) => (
              <FieldError key={message}>{message}</FieldError>
            ))}
            {messages.length === 0 && saved ? (
              <p className="text-sm text-muted-foreground">Saved.</p>
            ) : null}
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}
