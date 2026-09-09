"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
} from "@/components/ui";

/**
 * Invite-code entry. Navigates to the invite review page; the form itself
 * never touches Convex, so it can live anywhere (dialog, empty state, page).
 */
export function JoinCodeForm({ onNavigate }: { onNavigate?: () => void }) {
  const router = useRouter();
  const [code, setCode] = useState("");

  return (
    <form
      id="join-code-form"
      onSubmit={(event) => {
        event.preventDefault();
        onNavigate?.();
        router.push(`/leagues/join/${code}`);
      }}
    >
      <Field>
        <FieldLabel htmlFor="join-code">Invite code</FieldLabel>
        <Input
          id="join-code"
          name="join-code"
          autoComplete="off"
          autoFocus
          required
          minLength={8}
          maxLength={8}
          pattern="[A-HJ-NP-Z2-9]{8}"
          className="font-mono uppercase tracking-[0.18em]"
          placeholder="ABCD2345"
          value={code}
          onChange={(event) =>
            setCode(
              event.target.value
                .toUpperCase()
                .replace(/[^A-HJ-NP-Z2-9]/g, "")
                .slice(0, 8),
            )
          }
        />
        <FieldDescription>Codes omit 0, 1, I, and O.</FieldDescription>
      </Field>
      <DialogFooter className="mt-4" showCloseButton>
        <Button type="submit" disabled={code.length !== 8}>
          Review invite
        </Button>
      </DialogFooter>
    </form>
  );
}

/** "Join a league" as a modal. Remounts the form on every open. */
export function JoinLeagueDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Join a league</DialogTitle>
          <DialogDescription>
            Paste the eight-character code from your commissioner to review the
            invitation.
          </DialogDescription>
        </DialogHeader>
        {open ? <JoinCodeForm onNavigate={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}
