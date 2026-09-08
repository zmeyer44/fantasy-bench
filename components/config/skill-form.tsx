"use client";

import { useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { mutationErrorMessage } from "@/components/league/convex-errors";
import { Button, Card, CardBody, CardFooter, CardHeader, Field, Input, Select, Textarea } from "@/components/ui";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

import { Markdown } from "./markdown";
import { Toast, type ToastTone } from "./toast";

const MAX_BODY = 20_000;

export type SkillFormProps = {
  mode: "create" | "edit";
  /** Required in edit mode. */
  skillId?: string;
  initial?: {
    name: string;
    description: string;
    bodyMd: string;
    visibility: "public" | "private";
  };
  /** How many current config versions run this skill — the edit warning. */
  usageCount?: number;
};

/** Author or edit a library skill. Markdown editor with a preview toggle. */
export function SkillForm({ mode, skillId, initial, usageCount = 0 }: SkillFormProps) {
  const router = useRouter();

  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [bodyMd, setBodyMd] = useState(initial?.bodyMd ?? "");
  const [visibility, setVisibility] = useState<"public" | "private">(
    initial?.visibility ?? "public",
  );
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; tone: ToastTone } | null>(null);
  const [pending, setPending] = useState(false);

  const create = useMutation(api.skills.create);
  const update = useMutation(api.skills.update);

  async function submit() {
    setError(null);
    setPending(true);
    try {
      if (mode === "create") {
        const skill = await create({ name, description, bodyMd, visibility });
        router.push(`/skills/${skill.slug}`);
        return;
      }
      if (!skillId) return;
      const skill = await update({
        skillId: skillId as Id<"skills">,
        name,
        description,
        bodyMd,
        visibility,
      });
      setToast({ message: "Saved.", tone: "success" });
      // The skill page reads Convex live; navigating is enough.
      router.push(`/skills/${skill.slug}`);
    } catch (err) {
      setError(mutationErrorMessage(err));
    } finally {
      setPending(false);
    }
  }

  const valid = name.trim().length >= 3 && bodyMd.trim().length > 0 && bodyMd.length <= MAX_BODY;

  return (
    <Card>
      <CardHeader
        title={mode === "create" ? "Author a skill" : "Edit skill"}
        description="Markdown, injected into an agent's context after the owner's own context."
        action={
          <button
            type="button"
            className="text-xs text-accent-strong underline underline-offset-2"
            onClick={() => setPreview((p) => !p)}
          >
            {preview ? "Edit" : "Preview"}
          </button>
        }
      />
      <CardBody className="space-y-4">
        {mode === "edit" && usageCount > 0 ? (
          <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-ink">
            <strong>{usageCount}</strong> current config version
            {usageCount === 1 ? "" : "s"} attach this skill. Skills are attached by id and are not
            versioned, so this edit changes what those agents read on their next run — including
            teams in other leagues.
          </p>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Visibility" hint="Private skills are visible only to you.">
            <Select
              value={visibility}
              onChange={(e) => setVisibility(e.target.value as "public" | "private")}
            >
              <option value="public">Public</option>
              <option value="private">Private</option>
            </Select>
          </Field>
        </div>

        <Field label="One-line description">
          <Input
            value={description}
            maxLength={280}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Read designations and practice reports correctly."
          />
        </Field>

        <div>
          <div className="eyebrow mb-1.5">Body</div>
          {preview ? (
            <div className="min-h-64 rounded-md border border-line px-3 py-3">
              <Markdown>{bodyMd || "_Nothing to preview yet._"}</Markdown>
            </div>
          ) : (
            <Textarea
              rows={24}
              value={bodyMd}
              maxLength={MAX_BODY}
              onChange={(e) => setBodyMd(e.target.value)}
              placeholder={"# My skill\n\n## When to use it\n\n…"}
            />
          )}
          <p className="mt-1 text-right font-mono text-[10px] text-ink-faint">
            {bodyMd.length.toLocaleString()} / {MAX_BODY.toLocaleString()}
          </p>
        </div>

        {error ? (
          <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            {error}
          </p>
        ) : null}
      </CardBody>
      <CardFooter className="flex justify-end gap-2">
        <Button disabled={pending || !valid} onClick={() => void submit()}>
          {pending ? "Saving…" : mode === "create" ? "Publish skill" : "Save changes"}
        </Button>
      </CardFooter>
      <Toast message={toast?.message ?? null} tone={toast?.tone} onDismiss={() => setToast(null)} />
    </Card>
  );
}
