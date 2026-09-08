"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";

import { mutationErrorMessage } from "@/components/league/convex-errors";
import { Badge, Button, Dialog, Field, Input, Textarea } from "@/components/ui";
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
      onClose={onClose}
      title="Attach a skill"
      description="The library is public across every league. Attaching by id means the author's future edits reach your agent."
      footer={
        <Button variant="secondary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="space-y-3">
        <Input
          autoFocus
          placeholder="Search skills…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        <div className="max-h-80 space-y-2 overflow-y-auto">
          {list === undefined ? (
            <p className="text-sm text-ink-muted">Loading…</p>
          ) : list.length === 0 ? (
            <p className="text-sm text-ink-muted">No skills match that search.</p>
          ) : (
            list.map((skill) => (
              <div
                key={skill._id}
                className="flex items-start justify-between gap-3 rounded-md border border-line px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-ink">{skill.name}</span>
                    <Badge tone="outline">{skill.usageCount} in use</Badge>
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-xs text-ink-muted">
                    {skill.description || `${skill.bodyMd.length.toLocaleString()} chars`}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant={attached.has(skill._id) ? "ghost" : "secondary"}
                  disabled={attached.has(skill._id)}
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
                  {attached.has(skill._id) ? "Attached" : "Attach"}
                </Button>
              </div>
            ))
          )}
        </div>
      </div>
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
      onClose={onClose}
      title="Author a skill"
      description="Skills are public: every league can read and fork what you write."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={pending || name.trim().length < 3 || bodyMd.trim().length === 0}
            onClick={() => void submit()}
          >
            {pending ? "Publishing…" : "Publish & attach"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
        </Field>
        <Field label="One-line description">
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={280}
          />
        </Field>
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="eyebrow">Markdown</span>
            <button
              type="button"
              className="text-xs text-accent-strong underline underline-offset-2"
              onClick={() => setPreview((p) => !p)}
            >
              {preview ? "Edit" : "Preview"}
            </button>
          </div>
          {preview ? (
            <div className="max-h-64 overflow-y-auto rounded-md border border-line px-3 py-2">
              <Markdown>{bodyMd || "_Nothing to preview yet._"}</Markdown>
            </div>
          ) : (
            <Textarea
              rows={12}
              value={bodyMd}
              maxLength={20_000}
              onChange={(e) => setBodyMd(e.target.value)}
              placeholder={"# My skill\n\nWhen deciding a lineup…"}
            />
          )}
          <p className="mt-1 text-right font-mono text-[10px] text-ink-faint">
            {bodyMd.length.toLocaleString()} / 20,000
          </p>
        </div>
        {error ? (
          <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
