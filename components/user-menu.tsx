"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import { ChevronDown, LogOut, Trophy, Library, Gauge } from "lucide-react";
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

export function UserMenu({ name, email }: { name: string; email: string }) {
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
      <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
        <span className="flex size-5 items-center justify-center rounded-sm bg-brand font-mono text-[10px] font-semibold text-primary-foreground">
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
          <DropdownMenuItem render={<Link href="/skills" />}>
            <Library /> Skills
          </DropdownMenuItem>
          <DropdownMenuItem render={<Link href="/bench" />}>
            <Gauge /> Bench
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
