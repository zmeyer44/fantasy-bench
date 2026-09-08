"use client";

import { useMutation, useQuery } from "convex/react";
import { Check, Plus, Search } from "lucide-react";
import { useState } from "react";

import { mutationErrorMessage } from "@/components/league/convex-errors";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  Textarea,
} from "@/components/ui";
import { api } from "@/convex/_generated/api";

import { Markdown } from "./markdown";

export type AttachedSkill = {
  id: string;
  name: string;
  slug: string;
  description: string;
  bodyMd: string;
};

/** "Attach from library": searchable list of public skills with usage counts. */
export function AttachSkillDialog({
  open,
  onClose,
  attachedIds,
  onAttach,
}: {
  open: boolean;
  onClose: () => void;
  attachedIds: string[];
  onAttach: (skill: AttachedSkill) => void;
}) {
  const [query, setQuery] = useState("");

  // Live library search, skipped entirely while the dialog is closed.
  const term = query.trim();
  const list = useQuery(api.skills.list, open ? (term ? { query: term } : {}) : "skip");

  const attached = new Set(attachedIds);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Attach a skill</DialogTitle>
          <DialogDescription>
            The library is public across every league. Attaching by id means the author&apos;s
            future edits reach your agent.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            autoFocus
            placeholder="Search skills…"
            aria-label="Search skills"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-8"
          />
        </div>

        <div className="-mx-4 max-h-80 overflow-y-auto border-y border-border">
          {list === undefined ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">Loading…</p>
          ) : list.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">No skills match that search.</p>
          ) : (
            <ul className="divide-y divide-border">
              {list.map((skill) => {
                const isAttached = attached.has(skill._id);
                return (
                  <li
                    key={skill._id}
                    className="flex items-start justify-between gap-3 px-4 py-2.5 transition-colors hover:bg-accent"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-foreground">
                          {skill.name}
                        </span>
                        <Badge variant="outline">{skill.usageCount} in use</Badge>
                      </div>
                      <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">
                        {skill.description || `${skill.bodyMd.length.toLocaleString()} chars`}
                      </p>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant={isAttached ? "ghost" : "outline"}
                      disabled={isAttached}
                      onClick={() =>
                        onAttach({
                          id: skill._id,
                          name: skill.name,
                          slug: skill.slug,
                          description: skill.description ?? "",
                          bodyMd: skill.bodyMd,
                        })
                      }
                    >
                      {isAttached ? <Check data-icon="inline-start" /> : <Plus data-icon="inline-start" />}
                      {isAttached ? "Attached" : "Attach"}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "Author new skill": writes to the shared library, then attaches it. */
export function AuthorSkillDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (skill: AttachedSkill) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [bodyMd, setBodyMd] = useState("");
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const create = useMutation(api.skills.create);

  async function submit() {
    setPending(true);
    try {
      const skill = await create({ name, description, bodyMd, visibility: "public" });
      onCreated({
        id: skill._id,
        name: skill.name,
        slug: skill.slug,
        description: skill.description ?? "",
        bodyMd: skill.bodyMd,
      });
      setName("");
      setDescription("");
      setBodyMd("");
      setError(null);
      onClose();
    } catch (err) {
      setError(mutationErrorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Author a skill</DialogTitle>
          <DialogDescription>
            Skills are public: every league can read and fork what you write.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="author-skill-name">Name</FieldLabel>
              <Input
                id="author-skill-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="author-skill-description">One-line description</FieldLabel>
              <Input
                id="author-skill-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={280}
              />
            </Field>
          </div>

          <Field>
            <div className="flex items-center justify-between gap-2 border-b border-border pb-2">
              <FieldLabel htmlFor="author-skill-body" className="eyebrow text-foreground">
                Markdown
              </FieldLabel>
              <Button type="button" size="xs" variant="ghost" onClick={() => setPreview((p) => !p)}>
                {preview ? "Edit" : "Preview"}
              </Button>
            </div>
            {preview ? (
              <div className="max-h-64 overflow-y-auto rounded-lg border border-border px-3 py-2">
                <Markdown>{bodyMd || "_Nothing to preview yet._"}</Markdown>
              </div>
            ) : (
              <Textarea
                id="author-skill-body"
                rows={12}
                value={bodyMd}
                maxLength={20_000}
                onChange={(e) => setBodyMd(e.target.value)}
                placeholder={"# My skill\n\nWhen deciding a lineup…"}
                className="font-mono text-xs"
              />
            )}
            <FieldDescription className="text-right font-mono text-xs tabular-nums">
              {bodyMd.length.toLocaleString()} / 20,000
            </FieldDescription>
          </Field>

          {error ? (
            <p
              role="alert"
              className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={pending || name.trim().length < 3 || bodyMd.trim().length === 0}
            onClick={() => void submit()}
          >
            {pending ? "Publishing…" : "Publish & attach"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
