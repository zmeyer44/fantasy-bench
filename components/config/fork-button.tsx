"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui";
import { useTRPC } from "@/lib/trpc/client";

import { Toast, type ToastTone } from "./toast";

/** Copy a skill into your own library so you can diverge from it. */
export function ForkSkillButton({ slug, signedIn }: { slug: string; signedIn: boolean }) {
  const router = useRouter();
  const trpc = useTRPC();
  const [toast, setToast] = useState<{ message: string; tone: ToastTone } | null>(null);

  const fork = useMutation(
    trpc.skills.fork.mutationOptions({
      onSuccess: (skill) => router.push(`/skills/${skill.slug}/edit`),
      onError: (err) => setToast({ message: err.message, tone: "error" }),
    }),
  );

  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        disabled={fork.isPending || !signedIn}
        title={signedIn ? undefined : "Sign in to fork"}
        onClick={() => fork.mutate({ slug })}
      >
        {fork.isPending ? "Forking…" : "Fork"}
      </Button>
      <Toast message={toast?.message ?? null} tone={toast?.tone} onDismiss={() => setToast(null)} />
    </>
  );
}
