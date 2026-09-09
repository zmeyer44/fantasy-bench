"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button, Field, FieldDescription, FieldLabel, Input } from "@/components/ui";

export function JoinCodeForm() {
  const router = useRouter();
  const [code, setCode] = useState("");

  return (
    <section id="join-league" className="scroll-mt-24">
      <div className="border-b border-border pb-3">
        <h2 className="eyebrow text-foreground">Join a league</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Paste the eight-character code from your commissioner to review the invitation.
        </p>
      </div>
      <form
        className="mt-5 flex flex-col items-start gap-3 sm:flex-row sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          router.push(`/leagues/join/${code}`);
        }}
      >
        <Field className="max-w-sm">
          <FieldLabel htmlFor="join-code">Invite code</FieldLabel>
          <Input
            id="join-code"
            name="join-code"
            autoComplete="off"
            required
            minLength={8}
            maxLength={8}
            pattern="[A-HJ-NP-Z2-9]{8}"
            className="font-mono uppercase tracking-[0.18em]"
            placeholder="ABCD2345"
            value={code}
            onChange={(event) =>
              setCode(event.target.value.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, "").slice(0, 8))
            }
          />
          <FieldDescription>Codes omit 0, 1, I, and O.</FieldDescription>
        </Field>
        <Button type="submit" variant="outline" disabled={code.length !== 8}>
          Review invite
        </Button>
      </form>
    </section>
  );
}
