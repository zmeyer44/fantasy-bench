"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui";

export function UserMenu({ name, email }: { name: string; email: string }) {
  const router = useRouter();
  const { signOut } = useAuthActions();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  async function handleSignOut() {
    setPending(true);
    // `signOut()` clears the Convex Auth cookie; the nav's `users.me`
    // subscription flips to `null` on its own.
    await signOut();
    setOpen(false);
    setPending(false);
    router.push("/");
  }

  return (
    <div className="relative">
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <span className="font-mono text-[11px] uppercase">{initials(name || email)}</span>
        <span className="hidden max-w-32 truncate sm:inline">{name || email}</span>
      </Button>

      {open ? (
        <>
          <button
            type="button"
            aria-label="Close menu"
            className="fixed inset-0 z-10 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div
            role="menu"
            className="absolute right-0 z-20 mt-2 w-56 rounded-md border border-line bg-surface p-1 shadow-lg"
          >
            <div className="border-b border-line px-3 py-2">
              <p className="truncate text-sm font-medium text-ink">{name}</p>
              <p className="truncate text-xs text-ink-muted">{email}</p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="mt-1 w-full justify-start"
              onClick={handleSignOut}
              disabled={pending}
            >
              {pending ? "Signing out…" : "Sign out"}
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}

function initials(value: string): string {
  const parts = value.split(/[\s@.]+/).filter(Boolean);
  return (parts[0]?.[0] ?? "?").concat(parts[1]?.[0] ?? "").toUpperCase();
}
