"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import { useConvexAuth } from "convex/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { Button, Field, FieldDescription, FieldLabel, Input } from "@/components/ui";
import { authErrorCode } from "@/lib/auth-errors";
import { authHref, normalizeReturnPath } from "@/lib/auth-return";

/** Eight digits; mirrors `RESET_CODE_LENGTH` in `convex/auth.ts`. */
const CODE_LENGTH = 8;

export function PasswordResetForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { signIn } = useAuthActions();
  const { isLoading, isAuthenticated } = useConvexAuth();
  const next = normalizeReturnPath(searchParams.get("next"));

  // Requesting a reset code answers with `tokens: null`, which the auth client
  // treats as a sign-out. Account recovery is for people who are locked out, so
  // a signed-in visitor goes back to where they were instead.
  useEffect(() => {
    if (!isLoading && isAuthenticated) router.replace(next);
  }, [isLoading, isAuthenticated, next, router]);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [requested, setRequested] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function sendResetCode() {
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      await signIn("password", { flow: "reset", email: email.trim() });
      setRequested(true);
      setCode("");
      setNotice("If an account exists for that email, a reset code is on its way.");
    } catch (cause) {
      const throttled = authErrorCode(cause) === "RESET_THROTTLED";
      setError(
        throttled
          ? "Please wait a minute before requesting another code."
          : "We could not send a reset email. Delivery may be unavailable; please try again later.",
      );
    } finally {
      setPending(false);
    }
  }

  async function requestReset(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await sendResetCode();
  }

  async function verifyReset(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await signIn("password", {
        flow: "reset-verification",
        email: email.trim(),
        code: code.trim(),
        newPassword,
      });
      router.replace(next);
    } catch {
      setError("That code is invalid or expired. Request a new code and try again.");
      setPending(false);
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <div className="eyebrow-caps text-brand">Account recovery</div>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-foreground">
          Reset your password
        </h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          {requested
            ? "Enter the eight-digit code from your email and choose a new password."
            : "We will email a short-lived verification code to the address on your account."}
        </p>
      </div>

      <form className="space-y-5" onSubmit={requested ? verifyReset : requestReset}>
        <Field>
          <FieldLabel htmlFor="reset-email">Email</FieldLabel>
          <Input
            id="reset-email"
            name="email"
            type="email"
            autoComplete="email"
            required
            readOnly={requested}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>

        {requested ? (
          <>
            <Field>
              <FieldLabel htmlFor="reset-code">Verification code</FieldLabel>
              <Input
                id="reset-code"
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                minLength={CODE_LENGTH}
                maxLength={CODE_LENGTH}
                pattern={`[0-9]{${CODE_LENGTH}}`}
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, CODE_LENGTH))}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="new-password">New password</FieldLabel>
              <Input
                id="new-password"
                name="new-password"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
              />
              <FieldDescription>At least 8 characters.</FieldDescription>
            </Field>
          </>
        ) : null}

        {error ? (
          <p role="alert" className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        ) : null}

        {notice ? (
          <p role="status" className="border border-brand/30 bg-brand/10 px-3 py-2 text-xs text-foreground">
            {notice}
          </p>
        ) : null}

        <Button type="submit" variant="brand" size="lg" className="w-full" disabled={pending}>
          {pending ? "Working…" : requested ? "Reset password" : "Email reset code"}
        </Button>
      </form>

      <div className="flex items-center justify-between gap-4 text-sm">
        {requested ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <button
              type="button"
              className="text-muted-foreground underline underline-offset-4 hover:text-brand disabled:opacity-50"
              disabled={pending}
              onClick={() => void sendResetCode()}
            >
              Request new code
            </button>
            <button
              type="button"
              className="text-muted-foreground underline underline-offset-4 hover:text-brand"
              onClick={() => {
                setRequested(false);
                setCode("");
                setNewPassword("");
                setError(null);
                setNotice(null);
              }}
            >
              Use another email
            </button>
          </div>
        ) : <span />}
        <Link href={authHref("/login", next)} className="text-foreground underline underline-offset-4 hover:text-brand">
          Back to log in
        </Link>
      </div>
    </div>
  );
}
