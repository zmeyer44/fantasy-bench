"use client";

import { ArrowDown, ArrowUp, ChevronDown, X } from "lucide-react";
import { useState } from "react";

import { MarkdownEditor } from "@/components/editor/markdown-editor";
import { Badge, Button, Textarea, cn } from "@/components/ui";

import type { AttachedSkill } from "./skill-picker";

/**
 * The Prompt tab: the system prompt in the order the model receives it.
 *
 *   1. Platform base prompt — fixed, identical for every agent (read-only here).
 *   2. Owner context — the one channel a human has; the editor.
 *   3. Attached skills — injected after the context, in this order.
 *
 * The note to agent rides the *user* message, so it sits apart at the bottom.
 */
export function PromptPanel({
  contextMd,
  contextCharLimit,
  draftKey,
  note,
  skills,
  canEdit,
  saving,
  onContextChange,
  onNoteChange,
  onSaveNote,
  savingNote,
  onSkillsChange,
  onAttachSkill,
  onAuthorSkill,
  onSubmit,
}: {
  contextMd: string;
  contextCharLimit: number;
  draftKey: string;
  note: string;
  skills: AttachedSkill[];
  canEdit: boolean;
  saving: boolean;
  onContextChange: (value: string) => void;
  onNoteChange: (value: string) => void;
  onSaveNote: () => void;
  savingNote: boolean;
  onSkillsChange: (skills: AttachedSkill[]) => void;
  onAttachSkill: () => void;
  onAuthorSkill: () => void;
  onSubmit: () => void;
}) {
  const [platformOpen, setPlatformOpen] = useState(false);
  const disabled = !canEdit;

  function move(index: number, delta: number) {
    const next = [...skills];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    onSkillsChange(next);
  }

  return (
    <div className="space-y-10">
      {/* --------------------------------------------------- 1. platform */}
      <PromptSection
        index={1}
        title="Platform base prompt"
        meta="Fixed · identical for every agent"
        badge={<Badge variant="outline">read-only</Badge>}
      >
        <button
          type="button"
          onClick={() => setPlatformOpen((o) => !o)}
          className="flex w-full items-center justify-between gap-3 rounded-md border border-border bg-muted/40 px-3 py-2.5 text-left text-sm transition-colors hover:bg-muted"
          aria-expanded={platformOpen}
        >
          <span className="text-muted-foreground">
            Rules of engagement, this window&apos;s scope and deadlines, budgets, the tool list, the
            untrusted-data policy and the league shape.
          </span>
          <ChevronDown
            className={cn("size-4 shrink-0 text-ink-faint transition-transform", platformOpen && "rotate-180")}
          />
        </button>
        {platformOpen ? (
          <div className="mt-2 rounded-md border border-border px-3 py-3 text-sm leading-relaxed text-muted-foreground">
            <p className="text-foreground">
              &ldquo;You are the autonomous general manager of a fantasy football team in Fantasy Bench,
              a league in which AI agents make every roster decision. No human touches this roster.
              Your owner tunes your context, your skills and your model; everything else is yours.&rdquo;
            </p>
            <ul className="mt-3 list-disc space-y-1 pl-5">
              <li>Act only through tools; every call and result is public in the trace.</li>
              <li>Illegal actions return structured errors; committed actions are final.</li>
              <li>Window type, submission deadline, snapshot time and player-lock rules.</li>
              <li>Step and token budgets for this run and the league&apos;s caps.</li>
              <li>
                The tools available this window — the list on the{" "}
                <span className="text-foreground">Tools</span> tab, with any guidance you added.
              </li>
              <li>Untrusted-data handling and the commissioner&apos;s injection policy.</li>
              <li>Scoring, starting slots, FAAB and rate limits.</li>
            </ul>
            <p className="mt-3 text-xs text-ink-faint">
              The exact text is assembled per run from the league rules and the window. Open any
              trace to read it verbatim.
            </p>
          </div>
        ) : null}
      </PromptSection>

      {/* ------------------------------------------------------ 2. owner */}
      <PromptSection
        index={2}
        title="Your context"
        meta="Markdown · public to the league"
        badge={<Badge variant="success">editable</Badge>}
      >
        <MarkdownEditor
          kind="context"
          aria-label="Agent context"
          value={contextMd}
          onChange={onContextChange}
          disabled={disabled}
          maxChars={contextCharLimit}
          draftKey={draftKey}
          onSave={() => {
            if (!disabled && !saving) onSubmit();
          }}
          placeholder={"# How to run this team\n\nStrategy, preferences, heuristics. Use Insert for a starting structure."}
        />
        <p className="mt-2.5 text-sm text-muted-foreground">
          Injected as{" "}
          <span className="font-mono text-xs text-foreground">&lt;owner_context&gt;</span>, subordinate
          only to the league rules. The limit of{" "}
          <span className="font-mono tabular-nums">{contextCharLimit.toLocaleString()}</span> characters
          is set by the commissioner.
        </p>
      </PromptSection>

      {/* ----------------------------------------------------- 3. skills */}
      <PromptSection
        index={3}
        title="Attached skills"
        meta={skills.length === 0 ? "None" : `${skills.length} · injected in this order`}
        action={
          canEdit ? (
            <>
              <Button type="button" size="sm" variant="outline" onClick={onAttachSkill}>
                Attach from library
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={onAuthorSkill}>
                Author new
              </Button>
            </>
          ) : null
        }
      >
        {skills.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No skills attached. Your agent runs on its context alone.
          </p>
        ) : (
          <ol className="divide-y divide-border border-y border-border">
            {skills.map((skill, i) => (
              <li key={skill.id} className="flex items-start gap-3 py-2.5">
                <span className="mt-1 font-mono text-[10px] text-ink-faint tabular-nums">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div className="min-w-0 flex-1">
                  <span className="text-sm font-medium text-foreground">{skill.name}</span>
                  <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">
                    {skill.description || `${skill.bodyMd.length.toLocaleString()} chars`}
                  </p>
                </div>
                {canEdit ? (
                  <div className="flex shrink-0 items-center gap-0.5">
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Move ${skill.name} up`}
                      disabled={i === 0}
                      onClick={() => move(i, -1)}
                    >
                      <ArrowUp />
                    </Button>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Move ${skill.name} down`}
                      disabled={i === skills.length - 1}
                      onClick={() => move(i, 1)}
                    >
                      <ArrowDown />
                    </Button>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Detach ${skill.name}`}
                      onClick={() => onSkillsChange(skills.filter((s) => s.id !== skill.id))}
                    >
                      <X />
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
        )}
        <p className="mt-3 text-sm text-ink-faint">
          Skills are attached by id: if the author edits one, your future runs get the new text.
        </p>
      </PromptSection>

      {/* -------------------------------------------------------- note */}
      <section className="border-t border-dashed border-line-strong pt-8">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Note to agent</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Rides the user message of the next run, then folds into your context — and clears — on
              your next save.
            </p>
          </div>
        </div>
        <Textarea
          rows={3}
          aria-label="Note to agent"
          value={note}
          disabled={disabled}
          maxLength={4_000}
          placeholder="You benched your best receiver on a hunch. Weight the projection more heavily next time."
          onChange={(e) => onNoteChange(e.target.value)}
        />
        <div className="mt-2.5 flex justify-end">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled || savingNote}
            onClick={onSaveNote}
          >
            {savingNote ? "Saving…" : "Save note"}
          </Button>
        </div>
      </section>
    </div>
  );
}

function PromptSection({
  index,
  title,
  meta,
  badge,
  action,
  children,
}: {
  index: number;
  title: string;
  meta?: string;
  badge?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="grid gap-4 sm:grid-cols-[36px_minmax(0,1fr)]">
      <div className="hidden sm:block">
        <span className="inline-flex size-7 items-center justify-center rounded-full border border-line-strong font-mono text-xs text-muted-foreground">
          {index}
        </span>
      </div>
      <div className="min-w-0">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3 border-b border-border pb-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">{title}</h2>
            {badge}
            {meta ? <span className="text-xs text-muted-foreground">{meta}</span> : null}
          </div>
          {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
        </div>
        {children}
      </div>
    </section>
  );
}
