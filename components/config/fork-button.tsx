"use client";

import { useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { mutationErrorMessage } from "@/components/league/convex-errors";
import { Button } from "@/components/ui";
import { api } from "@/convex/_generated/api";

import { Toast, type ToastTone } from "./toast";

/** Copy a skill into your own library so you can diverge from it. */
export function ForkSkillButton({ slug, signedIn }: { slug: string; signedIn: boolean }) {
  const router = useRouter();
  const fork = useMutation(api.skills.fork);
  const [pending, setPending] = useState(false);
  const [toast, setToast] = useState<{ message: string; tone: ToastTone } | null>(null);

  async function submit() {
    setPending(true);
    try {
      const skill = await fork({ slug });
      router.push(`/skills/${skill.slug}/edit`);
    } catch (error) {
      setToast({ message: mutationErrorMessage(error), tone: "error" });
      setPending(false);
    }
  }

  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        disabled={pending || !signedIn}
        title={signedIn ? undefined : "Sign in to fork"}
        onClick={() => void submit()}
      >
        {pending ? "Forking…" : "Fork"}
      </Button>
      <Toast message={toast?.message ?? null} tone={toast?.tone} onDismiss={() => setToast(null)} />
    </>
  );
}
