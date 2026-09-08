"use client";

import { useMutation, useQuery } from "convex/react";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { formatUsd } from "@/components/cost/format";
import { MarkdownEditor, clearDraft } from "@/components/editor/markdown-editor";
import {
  mutationErrorIssues,
  mutationErrorMessage,
  type ConvexIssue,
} from "@/components/league/convex-errors";
import {
  Badge,
  Button,
  Checkbox,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  NativeSelect,
  NativeSelectOption,
  Textarea,
  cn,
} from "@/components/ui";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { HarnessSettings } from "@/convex/lib/config_pure";
import { MODEL_CATALOG, findModel } from "@/lib/models";
import { formatET } from "@/lib/time";

import { AttachSkillDialog, AuthorSkillDialog, type AttachedSkill } from "./skill-picker";
import { Toast, type ToastTone } from "./toast";

export type ConfigEditorProps = {
  leagueId: string;
  teamId: string;
  teamName: string;
  /** False for spectators and other owners — configs are public but read-only. */
  canEdit: boolean;
  rules: {
    contextCharLimit: number;
    modelAllowlist: string[];
    maxStepsCap: number;
    weeklyTokenCapPerTeam: number | null;
  };
  /** First paint from `configs.get`; the editor then subscribes to `configs.lockStatus`. */
  initialLock: { open: boolean; nextChange: number };
  initial: {
    contextMd: string;
    modelId: string;
    harness: HarnessSettings;
    skills: AttachedSkill[];
    noteToAgent: string;
    currentVersionNo: number | null;
    pendingVersionNo: number | null;
  };
  nextVersionNo: number;
};

const DEBOUNCE_MS = 500;

export function ConfigEditor(props: ConfigEditorProps) {
  const { rules, initial, canEdit } = props;
  const leagueId = props.leagueId as Id<"leagues">;
  const teamId = props.teamId as Id<"teams">;

  // Live edit lock: when the window opens or closes the banner and the save
  // button change wording without a reload.
  const lockStatus = useQuery(api.configs.lockStatus, { leagueId });
  const lock = lockStatus ?? props.initialLock;
  const nextChangeLabel = `${formatET(lock.nextChange, "EEE h:mm a")} ET`;

  const [contextMd, setContextMd] = useState(initial.contextMd);
  const [note, setNote] = useState(initial.noteToAgent);
  const [skills, setSkills] = useState<AttachedSkill[]>(initial.skills);
  const [modelId, setModelId] = useState(initial.modelId);
  const [harness, setHarness] = useState<HarnessSettings>(initial.harness);
  const [changeSummary, setChangeSummary] = useState("");

  const [attachOpen, setAttachOpen] = useState(false);
  const [authorOpen, setAuthorOpen] = useState(false);
  const [toast, setToast] = useState<{ message: string; tone: ToastTone } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Field-level complaints from `configs.save`, rendered next to the save bar.
  const [issues, setIssues] = useState<ConvexIssue[]>([]);
  const [savingNote, setSavingNote] = useState(false);
  const [saving, setSaving] = useState(false);

  const model = findModel(modelId);
  const allowed = useMemo(
    () =>
      rules.modelAllowlist.length > 0
        ? MODEL_CATALOG.filter((m) => rules.modelAllowlist.includes(m.modelId))
        : MODEL_CATALOG,
    [rules.modelAllowlist],
  );

  // Reasoning effort is meaningless on a model that does not support it. Derive
  // the effective value rather than syncing state in an effect, so switching to
  // an unsupported model and back does not silently forget the setting.
  const effectiveHarness: HarnessSettings = model?.supportsReasoning
    ? harness
    : { ...harness, reasoningEffort: null };

  // ---- live preview: debounce the whole estimate input -----------------------
  const skillIds = useMemo(() => skills.map((s) => s.id), [skills]);
  const [estimateInput, setEstimateInput] = useState({ contextMd, skillIds, modelId });

  useEffect(() => {
    const timer = setTimeout(
      () => setEstimateInput({ contextMd, skillIds, modelId }),
      DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [contextMd, skillIds, modelId]);

  // Nothing to price while the context is empty and no skill is attached — the
  // subscription is skipped rather than asking for an estimate of nothing.
  const estimateArgs =
    estimateInput.contextMd.trim().length === 0 && estimateInput.skillIds.length === 0
      ? ("skip" as const)
      : {
          leagueId,
          contextMd: estimateInput.contextMd,
          skillIds: estimateInput.skillIds as Id<"skills">[],
          modelId: estimateInput.modelId,
        };
  const estimate = useQuery(api.configs.estimate, estimateArgs);
  // True while the debounce timer still holds an older input than the editor's.
  const estimateStale =
    estimate === undefined ||
    estimateInput.contextMd !== contextMd ||
    estimateInput.modelId !== modelId ||
    estimateInput.skillIds.join() !== skillIds.join();

  const overLimit = contextMd.length > rules.contextCharLimit;
  const draftKey = `context:${leagueId}:${teamId}`;

  // Convex mutations: the versions list, the lock banner and the changelog are
  // all live subscriptions, so a save needs no refetch — only local feedback.
  const saveNote = useMutation(api.configs.setNote);
  const save = useMutation(api.configs.save);

  async function submitNote() {
    setSavingNote(true);
    try {
      await saveNote({ leagueId, teamId, text: note.trim() ? note : null });
      setToast({ message: "Note saved for the next config save.", tone: "info" });
    } catch (err) {
      setToast({ message: mutationErrorMessage(err), tone: "error" });
    } finally {
      setSavingNote(false);
    }
  }

  async function submitVersion() {
    setSaving(true);
    setError(null);
    setIssues([]);
    try {
      const result = await save({
        leagueId,
        teamId,
        contextMd,
        modelId,
        harness: effectiveHarness,
        skillIds: skillIds as Id<"skills">[],
        ...(changeSummary.trim() ? { changeSummary: changeSummary.trim() } : {}),
      });
      setChangeSummary("");
      setNote("");
      clearDraft(draftKey);
      setToast({
        message: result.applied
          ? `Version ${result.versionNo} saved and applied.`
          : `Version ${result.versionNo} queued — it applies at the next unlock.`,
        tone: "success",
      });
    } catch (err) {
      setError(mutationErrorMessage(err));
      setIssues(mutationErrorIssues(err));
      setToast({ message: "Save rejected — see the errors above.", tone: "error" });
    } finally {
      setSaving(false);
    }
  }

  function attach(skill: AttachedSkill) {
    setSkills((current) =>
      current.some((s) => s.id === skill.id) ? current : [...current, skill],
    );
  }

  function move(index: number, delta: number) {
    setSkills((current) => {
      const next = [...current];
      const target = index + delta;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  const disabled = !canEdit;

  return (
    <div className="space-y-8">
      <LockBanner
        open={lock.open}
        nextChangeLabel={nextChangeLabel}
        nextVersionNo={props.nextVersionNo}
        pendingVersionNo={initial.pendingVersionNo}
        canEdit={canEdit}
      />

      <div className="grid gap-10 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        {/* ------------------------------------------------------ pane 1 */}
        <div className="space-y-10">
          <Section
            title="Context"
            description="The system prompt your agent runs with. Markdown, public to the league."
          >
            <MarkdownEditor
              kind="context"
              aria-label="Agent context"
              value={contextMd}
              onChange={setContextMd}
              disabled={disabled}
              maxChars={rules.contextCharLimit}
              draftKey={draftKey}
              onSave={() => {
                if (!disabled && !saving) void submitVersion();
              }}
              placeholder={"# How to run this team\n\nStrategy, preferences, heuristics. Use Insert for a starting structure."}
            />
            <p className="mt-2.5 text-sm text-muted-foreground">
              Everyone in the league can read what you wrote. The limit of{" "}
              <span className="font-mono tabular-nums">{rules.contextCharLimit.toLocaleString()}</span>{" "}
              characters is set by the commissioner.
            </p>
          </Section>

          <Section
            title="Note to agent"
            description="A scratchpad. It is appended to the context — and cleared — on your next save."
          >
            <Textarea
              rows={4}
              aria-label="Note to agent"
              value={note}
              disabled={disabled}
              maxLength={4_000}
              placeholder="You benched your best receiver on a hunch. Weight the projection more heavily next time."
              onChange={(e) => setNote(e.target.value)}
            />
            <div className="mt-2.5 flex justify-end">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled || savingNote}
                onClick={() => void submitNote()}
              >
                {savingNote ? "Saving…" : "Save note"}
              </Button>
            </div>
          </Section>

          {/* ---------------------------------------------------- pane 2 */}
          <Section
            title="Skills"
            description="Injected in this order, after your context."
            action={
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => setAttachOpen(true)}
                >
                  Attach from library
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => setAuthorOpen(true)}
                >
                  Author new
                </Button>
              </>
            }
          >
            {skills.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No skills attached. Your agent runs on its context alone.
              </p>
            ) : (
              <ol className="divide-y divide-border border-b border-border">
                {skills.map((skill, i) => (
                  <li key={skill.id} className="flex items-start gap-3 py-2.5">
                    <span className="mt-1 font-mono text-[10px] text-ink-faint tabular-nums">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/skills/${skill.slug}`}
                        className="text-sm font-medium text-foreground transition-colors hover:text-brand"
                      >
                        {skill.name}
                      </Link>
                      <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">
                        {skill.description || `${skill.bodyMd.length.toLocaleString()} chars`}
                      </p>
                    </div>
                    {!disabled ? (
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
                          onClick={() => setSkills((c) => c.filter((s) => s.id !== skill.id))}
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
          </Section>
        </div>

        {/* ------------------------------------------------------ pane 3 */}
        <div className="space-y-10 lg:border-l lg:border-border lg:pl-10">
          <Section title="Model" description="Version-pinned. Prices per million tokens.">
            <NativeSelect
              className="w-full"
              value={modelId}
              disabled={disabled}
              aria-label="Model"
              onChange={(e) => setModelId(e.target.value)}
            >
              {allowed.map((m) => (
                <NativeSelectOption key={m.modelId} value={m.modelId}>
                  {m.displayName} — {m.provider}
                </NativeSelectOption>
              ))}
              {!allowed.some((m) => m.modelId === modelId) ? (
                <NativeSelectOption value={modelId}>{modelId} (not allowlisted)</NativeSelectOption>
              ) : null}
            </NativeSelect>

            {model ? (
              <dl className="mt-4">
                <SpecRow label="Gateway id" value={model.modelId} />
                <SpecRow label="Provider" value={model.provider} />
                <SpecRow label="$ / M in" value={`$${model.inputPerM}`} />
                <SpecRow label="$ / M out" value={`$${model.outputPerM}`} />
                <SpecRow
                  label="Reasoning"
                  value={model.supportsReasoning ? "supported" : "not supported"}
                />
              </dl>
            ) : (
              <p className="mt-3 text-sm text-destructive">
                <span className="font-mono">{modelId}</span> is not in the model catalog.
              </p>
            )}
          </Section>

          <Section title="Harness" description="Runtime knobs, bounded by league rules.">
            <div className="space-y-5">
              <SliderField
                label="Max steps"
                hint={`League cap: ${rules.maxStepsCap}`}
                min={1}
                max={rules.maxStepsCap}
                step={1}
                value={harness.maxSteps}
                disabled={disabled}
                onChange={(v) => setHarness((h) => ({ ...h, maxSteps: v }))}
              />

              <Field>
                <FieldLabel htmlFor="token-budget">Token budget per run</FieldLabel>
                <Input
                  id="token-budget"
                  type="number"
                  min={1_000}
                  max={rules.weeklyTokenCapPerTeam ?? 2_000_000}
                  step={1_000}
                  disabled={disabled}
                  className="font-mono tabular-nums"
                  value={harness.tokenBudget}
                  onChange={(e) =>
                    setHarness((h) => ({ ...h, tokenBudget: Number(e.target.value) || 0 }))
                  }
                />
                <FieldDescription>
                  {rules.weeklyTokenCapPerTeam
                    ? `Weekly team cap: ${rules.weeklyTokenCapPerTeam.toLocaleString()}`
                    : "No weekly cap set by the commissioner."}
                </FieldDescription>
              </Field>

              <SliderField
                label="Temperature"
                hint="0 = deterministic, 2 = wild"
                min={0}
                max={2}
                step={0.1}
                value={harness.temperature}
                disabled={disabled}
                format={(v) => v.toFixed(1)}
                onChange={(v) => setHarness((h) => ({ ...h, temperature: Math.round(v * 10) / 10 }))}
              />

              {model?.supportsReasoning ? (
                <Field>
                  <FieldLabel htmlFor="reasoning-effort">Reasoning effort</FieldLabel>
                  <NativeSelect
                    id="reasoning-effort"
                    className="w-full"
                    disabled={disabled}
                    value={harness.reasoningEffort ?? ""}
                    onChange={(e) =>
                      setHarness((h) => ({
                        ...h,
                        reasoningEffort: (e.target.value ||
                          null) as HarnessSettings["reasoningEffort"],
                      }))
                    }
                  >
                    <NativeSelectOption value="">Off</NativeSelectOption>
                    <NativeSelectOption value="low">Low</NativeSelectOption>
                    <NativeSelectOption value="medium">Medium</NativeSelectOption>
                    <NativeSelectOption value="high">High</NativeSelectOption>
                  </NativeSelect>
                </Field>
              ) : (
                <p className="text-sm text-ink-faint">
                  {model?.displayName ?? "This model"} does not expose a reasoning-effort control.
                </p>
              )}

              <Field orientation="horizontal">
                <Checkbox
                  id="deliberate-mode"
                  disabled={disabled}
                  checked={harness.deliberateMode}
                  onCheckedChange={(checked) =>
                    setHarness((h) => ({ ...h, deliberateMode: checked }))
                  }
                />
                <FieldLabel htmlFor="deliberate-mode" className="font-normal">
                  Deliberate mode
                  <span className="text-muted-foreground">plan before any tool call</span>
                </FieldLabel>
              </Field>
            </div>
          </Section>

          <Section
            title="Live preview"
            description="Updates as you type. Assumes 4 steps and 1,500 output tokens per step."
          >
            <div className="grid grid-cols-2 divide-x divide-border border-y border-border">
              <div className="min-w-0 py-3 pr-4">
                <div className="eyebrow">Prompt tokens</div>
                <div
                  className={cn(
                    "mt-2 font-mono text-xl font-medium tracking-tight tabular-nums",
                    estimateStale && "opacity-50",
                  )}
                >
                  {estimate ? estimate.tokens.toLocaleString() : "—"}
                </div>
              </div>
              <div className="min-w-0 py-3 pl-4">
                <div className="eyebrow">Est. cost / run</div>
                <div
                  className={cn(
                    "mt-2 font-mono text-xl font-medium tracking-tight tabular-nums",
                    estimateStale && "opacity-50",
                  )}
                >
                  {estimate ? formatUsd(estimate.estimatedCostPerRunUsd) : "—"}
                </div>
              </div>
            </div>
            {estimate ? (
              <dl className="mt-4">
                <SpecRow label="Base prompt" value={estimate.breakdown.baseTokens.toLocaleString()} />
                <SpecRow
                  label="Your context"
                  value={estimate.breakdown.contextTokens.toLocaleString()}
                />
                <SpecRow label="Skills" value={estimate.breakdown.skillTokens.toLocaleString()} />
              </dl>
            ) : null}
            <p className="mt-3 text-sm text-ink-faint">
              Excludes the per-window snapshot, which varies. Input is priced uncached, so the real
              figure is usually lower.
            </p>
          </Section>
        </div>
      </div>

      {/* --------------------------------------------------------- save bar */}
      {canEdit ? (
        <div className="sticky bottom-4 z-20">
          <div className="rounded-lg border border-line-strong bg-card/95 shadow-lg backdrop-blur supports-backdrop-filter:bg-card/80">
            <div className="flex flex-wrap items-end gap-4 p-4">
              <Field className="min-w-56 flex-1">
                <FieldLabel htmlFor="change-summary" className="eyebrow text-foreground">
                  Change summary
                </FieldLabel>
                <Input
                  id="change-summary"
                  value={changeSummary}
                  maxLength={200}
                  placeholder="Weight floor over ceiling when favoured"
                  onChange={(e) => setChangeSummary(e.target.value)}
                />
              </Field>
              <Button
                type="button"
                size="lg"
                disabled={saving || overLimit}
                onClick={() => void submitVersion()}
              >
                {saving
                  ? "Saving…"
                  : lock.open
                    ? `Save version ${props.nextVersionNo}`
                    : `Queue version ${props.nextVersionNo}`}
              </Button>
            </div>
            {error ? (
              <div className="border-t border-border px-4 py-3">
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
                {issues.length > 0 ? (
                  <ul className="mt-1.5 space-y-1">
                    {issues.map((issue) => (
                      <li
                        key={`${issue.field}:${issue.message}`}
                        className="text-sm text-destructive"
                      >
                        <span className="font-mono text-xs">{issue.field}</span> — {issue.message}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        <p className="border-t border-border pt-5 text-sm text-muted-foreground">
          You are reading {props.teamName}&apos;s configuration. Every config in the league is
          public; only its owner (or the commissioner) can change it.
        </p>
      )}

      <AttachSkillDialog
        open={attachOpen}
        onClose={() => setAttachOpen(false)}
        attachedIds={skillIds}
        onAttach={attach}
      />
      <AuthorSkillDialog
        open={authorOpen}
        onClose={() => setAuthorOpen(false)}
        onCreated={attach}
      />
      <Toast
        message={toast?.message ?? null}
        tone={toast?.tone}
        onDismiss={() => setToast(null)}
      />
    </div>
  );
}

/**
 * A titled block of the editor. Sections are separated by a rule rather than
 * nested cards: the page is one dense surface, not a stack of boxes.
 */
function Section({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3 border-b border-border pb-3">
        <div className="min-w-0">
          <h2 className="eyebrow text-foreground">{title}</h2>
          {description ? (
            <p className="mt-2 text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

function LockBanner({
  open,
  nextChangeLabel,
  nextVersionNo,
  pendingVersionNo,
  canEdit,
}: {
  open: boolean;
  nextChangeLabel: string;
  nextVersionNo: number;
  pendingVersionNo: number | null;
  canEdit: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2.5 text-sm",
        open ? "border-brand/30 bg-brand-soft text-foreground" : "border-warning/40 bg-warning/10 text-foreground",
      )}
    >
      <Badge variant={open ? "success" : "warning"}>{open ? "editable" : "locked"}</Badge>
      <span>
        {open
          ? `Editable until ${nextChangeLabel}.`
          : canEdit
            ? `Locked — saving queues version ${nextVersionNo} for ${nextChangeLabel}.`
            : `Locked until ${nextChangeLabel}.`}
      </span>
      {pendingVersionNo !== null ? (
        <span className="text-muted-foreground">
          Version {pendingVersionNo} is already queued and will replace it.
        </span>
      ) : null}
    </div>
  );
}

/** Label / value pair on a hairline rule. Values are mono because they are read as data. */
function SpecRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border py-1.5 last:border-b-0">
      <dt className="eyebrow">{label}</dt>
      <dd className="truncate font-mono text-xs text-foreground tabular-nums">{value}</dd>
    </div>
  );
}

function SliderField({
  label,
  hint,
  min,
  max,
  step,
  value,
  disabled,
  onChange,
  format,
}: {
  label: string;
  hint?: string;
  min: number;
  max: number;
  step: number;
  value: number;
  disabled?: boolean;
  onChange: (value: number) => void;
  format?: (value: number) => string;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="eyebrow">{label}</span>
        <span className="font-mono text-xs text-foreground tabular-nums">
          {format ? format(value) : value}
        </span>
      </div>
      <input
        type="range"
        className="w-full accent-[var(--color-brand)]"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {hint ? <p className="text-sm text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
