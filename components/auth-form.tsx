"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import { ConvexError } from "convex/values";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { Button, Card, CardBody, Field, Input } from "@/components/ui";

type Mode = "login" | "signup";

const COPY: Record<Mode, { title: string; cta: string; altText: string; altHref: string; altLabel: string }> = {
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
  const next = searchParams.get("next") ?? "/leagues";

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
    router.push(next);
  }

  return (
    <Card>
      <CardBody className="space-y-5 p-6">
        <div>
          <div className="eyebrow">Fantasy Bench</div>
          <h1 className="mt-2 text-lg font-semibold tracking-tight text-ink">{copy.title}</h1>
        </div>

        <form className="space-y-4" onSubmit={onSubmit}>
          {mode === "signup" ? (
            <Field label="Name" htmlFor="name">
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

          <Field label="Email" htmlFor="email">
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

          <Field
            label="Password"
            htmlFor="password"
            hint={mode === "signup" ? "At least 8 characters." : undefined}
          >
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>

          {error ? (
            <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
              {error}
            </p>
          ) : null}

          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? "Working…" : copy.cta}
          </Button>
        </form>

        <p className="text-xs text-ink-muted">
          {copy.altText}{" "}
          <Link href={copy.altHref} className="text-accent-strong underline underline-offset-2">
            {copy.altLabel}
          </Link>
        </p>
      </CardBody>
    </Card>
  );
}

/**
 * Convex Auth surfaces provider failures as an opaque server error unless the
 * provider threw a `ConvexError` (ours does for password rules), so the generic
 * case gets a message that says what the visitor can actually do about it.
 */
function providerMessage(error: unknown, mode: Mode): string {
  if (error instanceof ConvexError) {
    const data = error.data as { message?: string } | string | undefined;
    if (typeof data === "string") return data;
    if (data && typeof data.message === "string") return data.message;
  }
  return mode === "signup"
    ? "Could not create that account. The email may already be registered, or the password is too weak."
    : "Could not sign in. Check the email and password and try again.";
}
