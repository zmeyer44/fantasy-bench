"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import {
  Button,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
} from "@/components/ui";
import { authErrorCode, authErrorMessage } from "@/lib/auth-errors";
import { authHref, normalizeReturnPath } from "@/lib/auth-return";

type Mode = "login" | "signup";

const COPY: Record<
  Mode,
  {
    title: string;
    cta: string;
    altText: string;
    altHref: string;
    altLabel: string;
  }
> = {
  login: {
    title: "Log in",
    cta: "Log in",
    altText: "No account yet?",
    altHref: "/signup",
    altLabel: "Sign up",
  },
  signup: {
    title: "Create an account",
    cta: "Create account",
    altText: "Already have an account?",
    altHref: "/login",
    altLabel: "Log in",
  },
};

/**
 * The Convex Auth password form. `signIn("password", …)` takes the sign-up /
 * sign-in decision as a `flow` field, so one component covers both routes; on
 * success the session cookie is already set (the proxy writes it) and we push
 * to `next`.
 */
export function AuthForm({ mode }: { mode: Mode }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { signIn } = useAuthActions();
  const next = normalizeReturnPath(searchParams.get("next"));

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const copy = COPY[mode];

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    try {
      await signIn("password", {
        email: email.trim(),
        password,
        flow: mode === "signup" ? "signUp" : "signIn",
        ...(mode === "signup" ? { name: name.trim() } : {}),
      });
    } catch (caught) {
      setPending(false);
      setError(providerMessage(caught, mode));
      return;
    }

    // `useQuery(api.users.me)` in the nav picks the new identity up on its own.
    router.replace(next);
  }

  return (
    <div className="space-y-8">
      <div>
        <div className="eyebrow-caps text-brand">Fantasy Bench</div>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-foreground">
          {copy.title}
        </h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          {mode === "signup"
            ? "Your agents run the team. You guide them."
            : "Welcome back. Your agents kept working."}
        </p>
      </div>

      <form className="space-y-5" onSubmit={onSubmit}>
        {mode === "signup" ? (
          <Field>
            <FieldLabel htmlFor="name">Name</FieldLabel>
            <Input
              id="name"
              name="name"
              autoComplete="name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Zach Meyer"
            />
          </Field>
        ) : null}

        <Field>
          <FieldLabel htmlFor="email">Email</FieldLabel>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
        </Field>

        {mode === "login" ? (
          <div className="-mt-2 text-right">
            <Link
              href={authHref("/forgot-password", next)}
              className="text-xs text-muted-foreground underline underline-offset-4 hover:text-brand"
            >
              Forgot password?
            </Link>
          </div>
        ) : null}

        <Field>
          <FieldLabel htmlFor="password">Password</FieldLabel>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete={
              mode === "signup" ? "new-password" : "current-password"
            }
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {mode === "signup" ? (
            <FieldDescription>At least 8 characters.</FieldDescription>
          ) : null}
        </Field>

        {error ? (
          <p
            role="alert"
            className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            {error}
          </p>
        ) : null}

        <Button
          type="submit"
          variant="brand"
          size="lg"
          className="w-full"
          disabled={pending}
        >
          {pending ? "Working…" : copy.cta}
        </Button>
      </form>

      <p className="text-sm text-muted-foreground">
        {copy.altText}{" "}
        <Link
          href={authHref(copy.altHref as "/login" | "/signup", next)}
          className="text-foreground underline underline-offset-4 hover:text-brand"
        >
          {copy.altLabel}
        </Link>
      </p>
    </div>
  );
}

/**
 * Convex Auth surfaces provider failures as an opaque server error unless the
 * provider threw a `ConvexError` (ours does for password rules), so the generic
 * case gets a message that says what the visitor can actually do about it.
 */
function providerMessage(error: unknown, mode: Mode): string {
  if (authErrorCode(error) === "ACCOUNT_EXISTS") {
    return "An account with that email already exists. Log in or reset its password.";
  }
  const message = authErrorMessage(error);
  if (message) return message;
  return mode === "signup"
    ? "Could not create that account. Check the form, then try logging in or resetting your password."
    : "Could not sign in. Check the email and password and try again.";
}
