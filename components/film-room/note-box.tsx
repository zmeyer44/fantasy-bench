"use client";

import { useMutation } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";

import { Toast, type ToastTone } from "@/components/config/toast";
import { Button, Card, CardBody, CardFooter, CardHeader, Textarea } from "@/components/ui";
import { useTRPC } from "@/lib/trpc/client";

/**
 * The film room's quick scratchpad. Saving it does not change the config — the
 * text is folded into the context the next time a version is saved (PRD 5.5).
 */
export function NoteToAgentBox({
  leagueId,
  teamId,
  initialNote,
  canEdit,
}: {
  leagueId: string;
  teamId: string;
  initialNote: string;
  canEdit: boolean;
}) {
  const trpc = useTRPC();
  const [note, setNote] = useState(initialNote);
  const [toast, setToast] = useState<{ message: string; tone: ToastTone } | null>(null);

  const save = useMutation(
    trpc.config.setNote.mutationOptions({
      onSuccess: () =>
        setToast({
          message: "Saved. It lands in your context on the next config save.",
          tone: "success",
        }),
      onError: (err) => setToast({ message: err.message, tone: "error" }),
    }),
  );

  return (
    <Card>
      <CardHeader
        title="Note to agent"
        description="What you would have said at half-time."
      />
      <CardBody className="space-y-2">
        <Textarea
          rows={5}
          value={note}
          disabled={!canEdit}
          maxLength={4_000}
          placeholder="You started a player who had been ruled out on Friday. Read the designation before the projection."
          onChange={(e) => setNote(e.target.value)}
        />
        {canEdit ? (
          <div className="flex items-center justify-end gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={save.isPending}
              onClick={() =>
                save.mutate({ leagueId, teamId, text: note.trim() ? note : null })
              }
            >
              {save.isPending ? "Saving…" : "Save note"}
            </Button>
          </div>
        ) : (
          <p className="text-xs text-ink-faint">Only this team&apos;s owner can leave a note.</p>
        )}
      </CardBody>
      <CardFooter>
        Notes are appended to your context verbatim.{" "}
        <Link
          href={`/leagues/${leagueId}/teams/${teamId}/config`}
          className="text-accent-strong underline underline-offset-2"
        >
          Open the config editor
        </Link>{" "}
        to save a version.
      </CardFooter>
      <Toast message={toast?.message ?? null} tone={toast?.tone} onDismiss={() => setToast(null)} />
    </Card>
  );
}
