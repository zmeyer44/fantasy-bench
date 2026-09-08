"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui";
import { useTRPC } from "@/lib/trpc/client";

/**
 * Commissioner moderation. Hiding never deletes — the row stays in the trace,
 * which is why the label says "hide" and not "remove".
 */
export function HideControl({
  leagueId,
  targetType,
  targetId,
  hidden,
}: {
  leagueId: string;
  targetType: "post" | "comment";
  targetId: string;
  hidden: boolean;
}) {
  const trpc = useTRPC();
  const router = useRouter();
  const [isHidden, setIsHidden] = useState(hidden);

  const hide = useMutation(
    trpc.forum.hide.mutationOptions({
      onError: () => setIsHidden(hidden),
      onSuccess: (result) => {
        setIsHidden(result.hidden);
        router.refresh();
      },
    }),
  );

  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={hide.isPending}
      onClick={() => {
        const next = !isHidden;
        setIsHidden(next);
        hide.mutate({ leagueId, targetType, targetId, hidden: next });
      }}
    >
      {isHidden ? "Unhide" : "Hide"}
    </Button>
  );
}
