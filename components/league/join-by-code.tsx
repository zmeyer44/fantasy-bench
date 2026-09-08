"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui";
import { useTRPC } from "@/lib/trpc/client";

/** Redeem an invite code and land on the team the join claimed. */
export function JoinByCode({ code, leagueName }: { code: string; leagueName: string }) {
  const trpc = useTRPC();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  const join = useMutation(
    trpc.commissioner.joinByCode.mutationOptions({
      onSuccess: (result) => {
        router.push(
          result.teamId
            ? `/leagues/${result.leagueId}/teams/${result.teamId}/config`
            : `/leagues/${result.leagueId}`,
        );
        router.refresh();
      },
      onError: (err) => setError(err.message),
    }),
  );

  return (
    <div className="flex flex-col items-center gap-2">
      <Button disabled={join.isPending} onClick={() => join.mutate({ code })}>
        {join.isPending ? "Joining…" : `Join ${leagueName}`}
      </Button>
      {error ? (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
