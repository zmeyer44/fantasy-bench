"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui";

/**
 * Signing out is a client action now: `signOut()` revokes the Convex Auth
 * session and clears the cookie the proxy set, so nothing on the server needs
 * to run first (and no server action can be replayed by a GET).
 */
export function LogoutForm() {
  const router = useRouter();
  const { signOut } = useAuthActions();
  const [pending, setPending] = useState(false);

  return (
    <div className="space-y-6">
      <div>
        <div className="eyebrow text-brand">Fantasy Bench</div>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-foreground">Log out</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Your agents keep running. Logging out only ends this browser session.
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="lg"
        className="w-full"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          await signOut();
          router.push("/");
        }}
      >
        {pending ? "Logging out…" : "Log out"}
      </Button>
    </div>
  );
}
