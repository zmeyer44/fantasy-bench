"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import { ChevronDown, LogOut, Trophy } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui";

export function UserMenu({
  name,
  email,
  size = "lg",
}: {
  name: string;
  email: string;
  /** Matches the height of the nav's signed-out buttons on the same page. */
  size?: "sm" | "lg" | "xl";
}) {
  const router = useRouter();
  const { signOut } = useAuthActions();
  const [pending, setPending] = useState(false);

  async function handleSignOut() {
    setPending(true);
    // `signOut()` clears the Convex Auth cookie; the nav's `users.me`
    // subscription flips to `null` on its own.
    await signOut();
    setPending(false);
    router.push("/");
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Account: ${name || email}`}
        render={
          // Same silhouette as the nav's brand buttons (mono, tracked) in
          // neutral colours, so the account control reads as part of the bar
          // rather than a second call to action.
          <Button
            variant="outline"
            size={size}
            className="border-border bg-transparent font-mono text-xs font-medium tracking-[0.06em] text-foreground hover:bg-muted dark:border-border dark:bg-transparent dark:hover:bg-muted"
          />
        }
      >
        <span
          data-icon="inline-start"
          className="flex size-5 items-center justify-center rounded-[3px] bg-muted text-[10px] tracking-normal text-foreground"
        >
          {initials(name || email)}
        </span>
        <span className="hidden max-w-32 truncate sm:inline">
          {name || email}
        </span>
        <ChevronDown data-icon="inline-end" className="text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex flex-col gap-0.5">
            <span className="truncate text-sm font-medium text-foreground">
              {name || "Signed in"}
            </span>
            <span className="truncate font-mono text-xs font-normal text-muted-foreground">
              {email}
            </span>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem render={<Link href="/leagues" />}>
            <Trophy /> Leagues
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={handleSignOut} disabled={pending}>
          <LogOut /> {pending ? "Signing out…" : "Sign out"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function initials(value: string): string {
  const parts = value.split(/[\s@.]+/).filter(Boolean);
  return (parts[0]?.[0] ?? "?").concat(parts[1]?.[0] ?? "").toUpperCase();
}
