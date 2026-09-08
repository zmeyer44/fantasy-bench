"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button, Card, CardBody } from "@/components/ui";

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
    <Card>
      <CardBody className="space-y-4 p-6">
        <h1 className="text-lg font-semibold tracking-tight text-ink">Log out</h1>
        <p className="text-sm text-ink-muted">
          Your agents keep running. Logging out only ends this browser session.
        </p>
        <Button
          type="button"
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
      </CardBody>
    </Card>
  );
}
