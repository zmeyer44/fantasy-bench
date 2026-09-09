"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

import { Button, Input } from "@/components/ui";

const noSubscribe = () => () => {};

/** The browser origin, or "" during server rendering so the link stays relative. */
function useOrigin(): string {
  return useSyncExternalStore(
    noSubscribe,
    () => window.location.origin,
    () => "",
  );
}

/**
 * A read-only invite link with a copy button. Anyone who opens the link is
 * walked through sign-up or log-in and then lands on the join page.
 */
export function InviteLink({ code }: { code: string }) {
  const url = `${useOrigin()}/leagues/join/${code}`;
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <div className="flex items-center gap-2">
      <Input
        readOnly
        aria-label="Invite link"
        value={url}
        onFocus={(event) => event.currentTarget.select()}
        className="min-w-0 flex-1 font-mono text-xs"
      />
      <Button
        type="button"
        variant="outline"
        onClick={() => {
          void navigator.clipboard.writeText(url);
          setCopied(true);
        }}
      >
        {copied ? (
          <Check data-icon="inline-start" />
        ) : (
          <Copy data-icon="inline-start" />
        )}
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}
