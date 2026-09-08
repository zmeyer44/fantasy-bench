"use client";

import { useMutation } from "convex/react";
import { TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { MarkdownEditor, clearDraft } from "@/components/editor/markdown-editor";
import { mutationErrorMessage } from "@/components/league/convex-errors";
import {
  Button,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

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

/** Author or edit a library skill: identity fields plus the markdown editor. */
export function SkillForm({ mode, skillId, initial, usageCount = 0 }: SkillFormProps) {
  const router = useRouter();

  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [bodyMd, setBodyMd] = useState(initial?.bodyMd ?? "");
  const [visibility, setVisibility] = useState<"public" | "private">(
    initial?.visibility ?? "public",
  );
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; tone: ToastTone } | null>(null);
  const [pending, setPending] = useState(false);

  const create = useMutation(api.skills.create);
  const update = useMutation(api.skills.update);
  const draftKey = `skill:${mode === "edit" && skillId ? skillId : "new"}`;

  async function submit() {
    setError(null);
    setPending(true);
    try {
      if (mode === "create") {
        const skill = await create({ name, description, bodyMd, visibility });
        clearDraft(draftKey);
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
      clearDraft(draftKey);
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
    <form
      className="space-y-8"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {mode === "edit" && usageCount > 0 ? (
        <p className="flex items-start gap-2.5 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5 text-sm text-foreground">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          <span>
            <span className="font-mono tabular-nums">{usageCount}</span> current config version
            {usageCount === 1 ? "" : "s"} attach this skill. Skills are attached by id and are not
            versioned, so this edit changes what those agents read on their next run — including
            teams in other leagues.
          </span>
        </p>
      ) : null}

      <section className="space-y-5">
        <div className="border-b border-border pb-3">
          <h2 className="eyebrow text-foreground">Identity</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            The name and one-line description shown in the library index.
          </p>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="skill-name">Name</FieldLabel>
            <Input
              id="skill-name"
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="skill-visibility">Visibility</FieldLabel>
            <NativeSelect
              id="skill-visibility"
              className="w-full"
              value={visibility}
              onChange={(e) => setVisibility(e.target.value as "public" | "private")}
            >
              <NativeSelectOption value="public">Public</NativeSelectOption>
              <NativeSelectOption value="private">Private</NativeSelectOption>
            </NativeSelect>
            <FieldDescription>Private skills are visible only to you.</FieldDescription>
          </Field>
        </div>

        <Field>
          <FieldLabel htmlFor="skill-description">One-line description</FieldLabel>
          <Input
            id="skill-description"
            value={description}
            maxLength={280}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Read designations and practice reports correctly."
          />
        </Field>
      </section>

      <section className="space-y-4">
        <div className="border-b border-border pb-3">
          <h2 className="eyebrow text-foreground">Body</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Markdown, injected into an agent&apos;s context after the owner&apos;s own context.
            Start from a scaffold with Insert if you like.
          </p>
        </div>

        <MarkdownEditor
          kind="skill"
          id="skill-body"
          aria-label="Skill body"
          value={bodyMd}
          onChange={setBodyMd}
          maxChars={MAX_BODY}
          draftKey={draftKey}
          onSave={() => {
            if (valid && !pending) void submit();
          }}
          placeholder={"# My skill\n\n## When to use it\n\n…"}
        />
      </section>

      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}

      <div className="flex justify-end gap-2 border-t border-border pt-5">
        <Button type="submit" disabled={pending || !valid}>
          {pending ? "Saving…" : mode === "create" ? "Publish skill" : "Save changes"}
        </Button>
      </div>

      <Toast message={toast?.message ?? null} tone={toast?.tone} onDismiss={() => setToast(null)} />
    </form>
  );
}
