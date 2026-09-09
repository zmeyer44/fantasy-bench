"use client";

import { useAction, useMutation, useQuery } from "convex/react";
import { KeyRound, Trash2 } from "lucide-react";
import { useState } from "react";

import { CapMeter } from "@/components/cost/charts";
import { formatUsd } from "@/components/cost/format";
import { mutationErrorMessage } from "@/components/league/convex-errors";
import { Badge, Button, Field, FieldDescription, FieldLabel, Input } from "@/components/ui";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { formatET } from "@/lib/time";

/**
 * Spend against the commissioner's caps, and the owner's own gateway key.
 *
 * A team on its own key is billed to that key and bypasses every cap; the
 * ledger still meters it, so the figures here keep moving either way.
 */
export function SpendPanel({
  leagueId,
  teamId,
  weekNo,
  canEdit,
  onToast,
}: {
  leagueId: string;
  teamId: string;
  weekNo: number;
  canEdit: boolean;
  onToast: (message: string, tone: "success" | "error" | "info") => void;
}) {
  const dashboard = useQuery(api.ledger.teamDashboard, {
    leagueId: leagueId as Id<"leagues">,
    teamId: teamId as Id<"teams">,
    weekNo,
  });
  const key = useQuery(api.gateway_keys.status, {
    leagueId: leagueId as Id<"leagues">,
    teamId: teamId as Id<"teams">,
  });
  const setKey = useAction(api.gateway_keys.set);
  const removeKey = useMutation(api.gateway_keys.remove);

  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const budget = dashboard?.budget;
  const ownKey = key?.hasKey === true;

  async function submit() {
    setPending(true);
    setError(null);
    try {
      const result = await setKey({ teamId: teamId as Id<"teams">, apiKey: draft });
      setDraft("");
      onToast(`Key ending in ${result.last4} verified and saved. Your next run bills to it.`, "success");
    } catch (err) {
      setError(mutationErrorMessage(err));
    } finally {
      setPending(false);
    }
  }

  async function remove() {
    if (!window.confirm("Remove your gateway key? Future runs use the league key and its spend caps again.")) return;
    try {
      await removeKey({ teamId: teamId as Id<"teams"> });
      onToast("Key removed. The league's caps apply from the next run.", "info");
    } catch (err) {
      onToast(mutationErrorMessage(err), "error");
    }
  }

  return (
    <section>
      <div className="mb-4 border-b border-border pb-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          Spend
          {ownKey ? (
            <Badge variant="info">
              <KeyRound data-icon="inline-start" /> own key
            </Badge>
          ) : null}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Week {weekNo} against the commissioner&apos;s caps. Every run is metered whichever key pays.
        </p>
      </div>

      {budget ? (
        <div className="space-y-5">
          <CapMeter
            label="Weekly spend cap"
            used={budget.teamWeekUsd}
            cap={ownKey ? null : budget.teamUsdCap}
            format={formatUsd}
          />
          {ownKey && budget.teamUsdCap !== null ? (
            <p className="-mt-3 text-xs text-muted-foreground">
              League cap {formatUsd(budget.teamUsdCap)} / week — bypassed on your key.
            </p>
          ) : null}
          <CapMeter
            label="Weekly tokens"
            used={budget.tokensUsed}
            cap={ownKey ? null : budget.tokenCap}
            format={(v) => v.toLocaleString()}
          />
          <CapMeter
            label="League USD hard cap"
            used={budget.leagueUsdUsed}
            cap={budget.leagueUsdCap}
            format={formatUsd}
          />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Loading…</p>
      )}

      {/* ------------------------------------------------------------ key */}
      <div className="mt-8 border-t border-border pt-5">
        <h3 className="text-sm font-medium">Your gateway key</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Want to spend past the caps? Add your own Vercel AI Gateway key. Runs bill to it, every
          cap is bypassed, and the league still sees exactly what your agent spends.
        </p>

        {key === undefined ? null : ownKey ? (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-border px-3 py-2.5">
            <div className="min-w-0">
              <div className="font-mono text-sm">
                {key.canManage && key.last4 ? `•••• ${key.last4}` : "Key on file"}
              </div>
              {key.canManage ? (
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {key.addedAt ? `added ${formatET(key.addedAt, "MMM d, HH:mm")} ET` : ""}
                  {key.verifiedAt ? " · verified" : ""}
                  {key.lastUsedAt ? ` · last used ${formatET(key.lastUsedAt, "MMM d")}` : " · not used yet"}
                </div>
              ) : null}
              {key.lastError ? (
                <div className="mt-1 text-xs text-destructive">{key.lastError}</div>
              ) : null}
            </div>
            {canEdit ? (
              <Button type="button" size="sm" variant="ghost" onClick={() => void remove()}>
                <Trash2 data-icon="inline-start" /> Remove
              </Button>
            ) : null}
          </div>
        ) : canEdit ? (
          key.configured ? (
            <div className="mt-4 space-y-3">
              <Field>
                <FieldLabel htmlFor="gateway-key">Vercel AI Gateway key</FieldLabel>
                <Input
                  id="gateway-key"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono text-xs"
                  placeholder="vck_…"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                />
                <FieldDescription>
                  Verified against the gateway before it is stored, encrypted at rest, never shown
                  again. You can remove it at any time.
                </FieldDescription>
              </Field>
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={pending || draft.trim().length < 16}
                onClick={() => void submit()}
              >
                {pending ? "Verifying…" : "Verify & save key"}
              </Button>
            </div>
          ) : (
            <p className="mt-3 text-sm text-ink-faint">
              This deployment is not configured to store keys yet.
            </p>
          )
        ) : (
          <p className="mt-3 text-sm text-ink-faint">Runs on the league&apos;s key.</p>
        )}
      </div>
    </section>
  );
}
