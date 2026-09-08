"use client";

import { useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { mutationErrorMessage } from "@/components/league/convex-errors";
import { Button } from "@/components/ui";
import { api } from "@/convex/_generated/api";

/** Redeem an invite code and land on the team the join claimed. */
export function JoinByCode({ code, leagueName }: { code: string; leagueName: string }) {
  const router = useRouter();
  const joinByCode = useMutation(api.leagues.joinByCode);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setPending(true);
    setError(null);
    try {
      const result = await joinByCode({ code });
      // The league pages subscribe to Convex, so the new membership shows up on
      // arrival; only the navigation is needed.
      router.push(
        result.teamId
          ? `/leagues/${result.leagueId}/teams/${result.teamId}/config`
          : `/leagues/${result.leagueId}`,
      );
    } catch (err) {
      setError(mutationErrorMessage(err));
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <Button type="button" variant="brand" size="lg" disabled={pending} onClick={() => void submit()}>
        {pending ? "Joining…" : `Join ${leagueName}`}
      </Button>
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
