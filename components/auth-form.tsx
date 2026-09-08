"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { authClient } from "@/lib/auth/client";
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

export function AuthForm({ mode }: { mode: Mode }) {
  const router = useRouter();
  const searchParams = useSearchParams();
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

    // better-auth returns `{ data, error }` unless `fetchOptions.throw` is set.
    const result =
      mode === "signup"
        ? await authClient.signUp.email({ email, password, name })
        : await authClient.signIn.email({ email, password });

    setPending(false);
    if (result.error) {
      setError(result.error.message ?? "Something went wrong. Try again.");
      return;
    }
    router.push(next);
    router.refresh();
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
