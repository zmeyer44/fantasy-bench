"use client";

import { useMutation } from "convex/react";
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";
import { useState, type ReactNode } from "react";

import { mutationErrorMessage } from "@/components/league/convex-errors";
import { Button, Card, CardBody, CardFooter, CardHeader } from "@/components/ui";

/**
 * One Convex mutation plus its inline error/success state. Every settings form
 * is the same shape: edit locally, submit, show the server's validation message
 * next to the form rather than in a toast.
 *
 * The console reads `commissioner.settings` live, so the saved values arrive on
 * their own — there is nothing to refetch and no `router.refresh()`.
 */
export function useSave<Mutation extends FunctionReference<"mutation">>(mutationRef: Mutation) {
  const run = useMutation(mutationRef);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const [data, setData] = useState<FunctionReturnType<Mutation> | null>(null);

  async function submit(args: FunctionArgs<Mutation>): Promise<void> {
    setIsPending(true);
    try {
      const result = (await run(args)) as FunctionReturnType<Mutation>;
      setData(result);
      setError(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setSaved(false);
      setError(mutationErrorMessage(err));
    } finally {
      setIsPending(false);
    }
  }

  return { submit, isPending, error, saved, data, setError };
}

export function SettingsSection({
  title,
  description,
  children,
  footer,
  onSubmit,
  saving,
  error,
  saved,
  submitLabel = "Save",
  disabled = false,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onSubmit?: () => void;
  saving?: boolean;
  error?: string | null;
  saved?: boolean;
  submitLabel?: string;
  disabled?: boolean;
}) {
  return (
    <Card>
      <CardHeader title={title} description={description} />
      <CardBody>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit?.();
          }}
          className="space-y-4"
        >
          <fieldset disabled={disabled} className="space-y-4">
            {children}
          </fieldset>
          {onSubmit ? (
            <div className="flex flex-wrap items-center gap-3 border-t border-line pt-3">
              <Button type="submit" size="sm" disabled={saving || disabled}>
                {saving ? "Saving…" : submitLabel}
              </Button>
              {saved ? <span className="text-xs text-accent-strong">Saved.</span> : null}
              {error ? (
                <span className="text-xs text-danger" role="alert">
                  {error}
                </span>
              ) : null}
            </div>
          ) : null}
        </form>
      </CardBody>
      {footer ? <CardFooter>{footer}</CardFooter> : null}
    </Card>
  );
}

/** Banner shown on the tabs whose fields are frozen post-draft. */
export function LockNotice({ locked }: { locked: boolean }) {
  if (!locked) return null;
  return (
    <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-ink">
      The draft has begun, so the rule set is frozen (PRD 5.1). Budgets, conduct settings, the model
      allowlist and the schedule stay editable — every change is written to the change log.
    </div>
  );
}

export function Toggle({
  label,
  hint,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-start gap-3">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 size-4 accent-[var(--color-accent)]"
      />
      <span className="min-w-0">
        <span className="block text-sm text-ink">{label}</span>
        {hint ? <span className="block text-xs text-ink-muted">{hint}</span> : null}
      </span>
    </label>
  );
}
