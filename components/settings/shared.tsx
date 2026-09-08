"use client";

import { useMutation } from "convex/react";
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";
import { useId, useState, type ReactNode } from "react";

import { mutationErrorMessage } from "@/components/league/convex-errors";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldSet,
  Switch,
  cn,
} from "@/components/ui";

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

/**
 * A settings section: a ruled heading, the form body, then the single primary
 * action. No card — the rule and the spacing carry the grouping, which lets the
 * tables inside a section span the full width of the console.
 */
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
  bodyClassName,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onSubmit?: () => void;
  saving?: boolean;
  error?: string | null;
  saved?: boolean;
  submitLabel?: string;
  disabled?: boolean;
  /** Extra classes for the `FieldSet` that wraps the body. */
  bodyClassName?: string;
}) {
  return (
    <section className="space-y-5">
      <header className="border-b border-border pb-3">
        <h2 className="font-heading text-base leading-snug font-medium text-foreground">{title}</h2>
        {description ? (
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{description}</p>
        ) : null}
      </header>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit?.();
        }}
      >
        <FieldSet disabled={disabled} className={cn("gap-5", bodyClassName)}>
          {children}
        </FieldSet>

        {onSubmit ? (
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <Button type="submit" size="sm" disabled={saving || disabled}>
              {saving ? "Saving…" : submitLabel}
            </Button>
            <SaveStatus saving={saving} saved={saved} error={error} />
          </div>
        ) : (
          <SaveStatus saving={saving} saved={saved} error={error} className="mt-4" />
        )}
      </form>

      {footer ? <p className="text-sm text-muted-foreground">{footer}</p> : null}
    </section>
  );
}

/** The shared "Saved." / error line every settings form ends with. */
export function SaveStatus({
  saving,
  saved,
  error,
  savedLabel = "Saved.",
  className,
}: {
  saving?: boolean;
  saved?: boolean;
  error?: string | null;
  /** Override for actions that are not plain saves ("Draft started."). */
  savedLabel?: string;
  className?: string;
}) {
  if (error) {
    return <FieldError className={className}>{error}</FieldError>;
  }
  if (saved) {
    return <p className={cn("text-sm text-muted-foreground", className)}>{savedLabel}</p>;
  }
  if (saving) {
    return <p className={cn("text-sm text-muted-foreground", className)}>Saving…</p>;
  }
  return null;
}

/** Banner shown on the tabs whose fields are frozen post-draft. */
export function LockNotice({ locked }: { locked: boolean }) {
  if (!locked) return null;
  return (
    <Alert className="border-warning/40 bg-warning/10">
      <AlertTitle className="text-warning">Rule set frozen</AlertTitle>
      <AlertDescription>
        The draft has begun, so the rule set is frozen (PRD 5.1). Budgets, conduct settings, the
        model allowlist and the schedule stay editable — every change is written to the change log.
      </AlertDescription>
    </Alert>
  );
}

/**
 * A boolean rule: label and description on the left, the switch on the right.
 * Every tab uses this so the toggles line up down the console.
 */
export function ToggleField({
  label,
  hint,
  checked,
  onChange,
  disabled = false,
  id,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  id?: string;
}) {
  const generatedId = useId();
  const switchId = id ?? generatedId;

  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel htmlFor={switchId}>{label}</FieldLabel>
        {hint ? <FieldDescription>{hint}</FieldDescription> : null}
      </FieldContent>
      <Switch
        id={switchId}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => onChange(next)}
      />
    </Field>
  );
}

/**
 * A compact labelled control for the dense grids (roster slots, window
 * overrides, team rows) where a full `Field` stack would be too tall. The label
 * is the mono tracked eyebrow used for table headers, so the grids read as
 * columns.
 */
export function CompactField({
  label,
  htmlFor,
  className,
  children,
}: {
  label: ReactNode;
  htmlFor?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Field className={cn("gap-1.5", className)}>
      <FieldLabel htmlFor={htmlFor} className="eyebrow">
        {label}
      </FieldLabel>
      {children}
    </Field>
  );
}
