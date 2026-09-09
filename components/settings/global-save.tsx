"use client";

import { useMutation } from "convex/react";
import { useState } from "react";

import { mutationErrorMessage } from "@/components/league/convex-errors";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui";
import { api } from "@/convex/_generated/api";

import { SaveStatus } from "./shared";
import type { SettingsData, SettingsTeam } from "./types";

/**
 * The commissioner's manual global save: promote every owner's queued config
 * version now instead of waiting for the scheduled unlock. The queued rows come
 * from `commissioner.settings.teams` (`pendingVersionNo`), which is live, so the
 * list empties on its own once the mutation lands.
 */
export function GlobalSaveSection({ data }: { data: SettingsData }) {
  const apply = useMutation(api.commissioner.applyPendingConfigs);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<number | null>(null);

  const queued = data.teams.filter(
    (team): team is SettingsTeam & { pendingVersionNo: number } => team.pendingVersionNo !== null,
  );

  async function submit() {
    setPending(true);
    setError(null);
    try {
      const result = await apply({ leagueId: data.league._id });
      setApplied(result.teamsApplied.length);
      setOpen(false);
      setTimeout(() => setApplied(null), 4000);
    } catch (err) {
      setError(mutationErrorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="space-y-5">
      <header className="border-b border-border pb-3">
        <h2 className="font-heading text-base leading-snug font-medium text-foreground">
          Global save
        </h2>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Apply every owner&apos;s queued agent changes right now instead of at the next unlock.
          Each queued version becomes that team&apos;s live agent for its next run, exactly as
          the scheduled unlock would apply it. Owners are not asked first.
        </p>
      </header>

      {queued.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No team has changes waiting behind the edit lock.
        </p>
      ) : (
        <ul className="divide-y divide-border border-y border-border" aria-label="Teams with queued changes">
          {queued.map((team) => (
            <li key={team.id} className="flex items-center justify-between gap-4 py-2.5 text-sm">
              <span className="min-w-0 truncate text-foreground">{team.name}</span>
              <span className="flex shrink-0 items-center gap-2 font-mono text-xs text-muted-foreground">
                {team.configVersionNo ? `v${team.configVersionNo} live` : "no live version"}
                <Badge variant="warning">v{team.pendingVersionNo} queued</Badge>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="brand"
          size="sm"
          disabled={queued.length === 0 || pending}
          onClick={() => setOpen(true)}
        >
          Apply queued changes now
        </Button>
        <SaveStatus
          saving={pending}
          saved={applied !== null}
          error={open ? null : error}
          savedLabel={
            applied === null
              ? undefined
              : `Applied queued changes for ${applied} team${applied === 1 ? "" : "s"}.`
          }
        />
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Apply queued changes now?</DialogTitle>
            <DialogDescription>
              {queued.length === 1
                ? "One team's queued agent version becomes live immediately."
                : `${queued.length} teams' queued agent versions become live immediately.`}{" "}
              The change is logged league-wide and cannot be undone: owners can only save a new
              version on top.
            </DialogDescription>
          </DialogHeader>

          <ul className="divide-y divide-border border-y border-border text-sm">
            {queued.map((team) => (
              <li key={team.id} className="flex items-center justify-between gap-4 py-2">
                <span className="min-w-0 truncate text-foreground">{team.name}</span>
                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                  {team.configVersionNo ? `v${team.configVersionNo} → ` : ""}v{team.pendingVersionNo}
                </span>
              </li>
            ))}
          </ul>

          {error ? (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="button" variant="brand" disabled={pending} onClick={() => void submit()}>
              {pending ? "Applying…" : "Apply now"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
