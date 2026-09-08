"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import {
  Badge,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  Field,
  Input,
  Select,
  Textarea,
  cn,
} from "@/components/ui";
import type { HarnessSettings } from "@/lib/services/config";
import { formatUsd } from "@/components/cost/format";
import { MODEL_CATALOG, findModel } from "@/lib/models";
import { useTRPC } from "@/lib/trpc/client";

import { Markdown } from "./markdown";
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
  lock: {
    open: boolean;
    /** Preformatted in Eastern by the server, e.g. "Wed 3:00 AM ET". */
    nextChangeLabel: string;
  };
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
  const { rules, lock, initial, canEdit } = props;
  const router = useRouter();
  const trpc = useTRPC();

  const [contextMd, setContextMd] = useState(initial.contextMd);
  const [note, setNote] = useState(initial.noteToAgent);
  const [skills, setSkills] = useState<AttachedSkill[]>(initial.skills);
  const [modelId, setModelId] = useState(initial.modelId);
  const [harness, setHarness] = useState<HarnessSettings>(initial.harness);
  const [changeSummary, setChangeSummary] = useState("");

  const [previewContext, setPreviewContext] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [authorOpen, setAuthorOpen] = useState(false);
  const [toast, setToast] = useState<{ message: string; tone: ToastTone } | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const estimate = useQuery(
    trpc.config.estimate.queryOptions({
      leagueId: props.leagueId,
      contextMd: estimateInput.contextMd,
      skillIds: estimateInput.skillIds,
      modelId: estimateInput.modelId,
    }),
  );

  const charCount = contextMd.length;
  const overLimit = charCount > rules.contextCharLimit;

  const saveNote = useMutation(
    trpc.config.setNote.mutationOptions({
      onSuccess: () => setToast({ message: "Note saved for the next config save.", tone: "info" }),
      onError: (err) => setToast({ message: err.message, tone: "error" }),
    }),
  );

  const save = useMutation(
    trpc.config.save.mutationOptions({
      onSuccess: (result) => {
        setError(null);
        setChangeSummary("");
        setNote("");
        setToast({
          message: result.applied
            ? `Version ${result.version.versionNo} saved and applied.`
            : `Version ${result.version.versionNo} queued — it applies at the next unlock.`,
          tone: "success",
        });
        router.refresh();
      },
      onError: (err) => {
        setError(err.message);
        setToast({ message: "Save rejected — see the errors above.", tone: "error" });
      },
    }),
  );

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
    <div className="space-y-6">
      <LockBanner
        open={lock.open}
        nextChangeLabel={lock.nextChangeLabel}
        nextVersionNo={props.nextVersionNo}
        pendingVersionNo={initial.pendingVersionNo}
        canEdit={canEdit}
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        {/* ------------------------------------------------------ pane 1 */}
        <div className="space-y-6">
          <Card>
            <CardHeader
              title="Context"
              description="The system prompt your agent runs with. Markdown."
              action={
                <button
                  type="button"
                  className="text-xs text-accent-strong underline underline-offset-2"
                  onClick={() => setPreviewContext((p) => !p)}
                >
                  {previewContext ? "Edit" : "Preview"}
                </button>
              }
            />
            <CardBody className="space-y-2">
              {previewContext ? (
                <div className="min-h-64 rounded-md border border-line px-3 py-2">
                  <Markdown>{contextMd || "_Nothing written yet._"}</Markdown>
                </div>
              ) : (
                <Textarea
                  rows={22}
                  value={contextMd}
                  disabled={disabled}
                  onChange={(e) => setContextMd(e.target.value)}
                  aria-invalid={overLimit}
                  className={cn(overLimit && "border-danger")}
                />
              )}
              <div className="flex items-center justify-between">
                <p className="text-xs text-ink-faint">
                  Public to the league. Everyone can read what you wrote.
                </p>
                <p
                  className={cn(
                    "font-mono text-[11px] tabular-nums",
                    overLimit ? "font-semibold text-danger" : "text-ink-faint",
                  )}
                >
                  {charCount.toLocaleString()} / {rules.contextCharLimit.toLocaleString()}
                </p>
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Note to agent"
              description="A scratchpad. It is appended to the context — and cleared — on your next save."
            />
            <CardBody className="space-y-2">
              <Textarea
                rows={4}
                value={note}
                disabled={disabled}
                maxLength={4_000}
                placeholder="You benched your best receiver on a hunch. Weight the projection more heavily next time."
                onChange={(e) => setNote(e.target.value)}
              />
              <div className="flex justify-end">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={disabled || saveNote.isPending}
                  onClick={() =>
                    saveNote.mutate({
                      leagueId: props.leagueId,
                      teamId: props.teamId,
                      text: note.trim() ? note : null,
                    })
                  }
                >
                  {saveNote.isPending ? "Saving…" : "Save note"}
                </Button>
              </div>
            </CardBody>
          </Card>

          {/* ---------------------------------------------------- pane 2 */}
          <Card>
            <CardHeader
              title="Skills"
              description="Injected in this order, after your context."
              action={
                <div className="flex gap-2">
                  <Button size="sm" variant="secondary" disabled={disabled} onClick={() => setAttachOpen(true)}>
                    Attach from library
                  </Button>
                  <Button size="sm" variant="secondary" disabled={disabled} onClick={() => setAuthorOpen(true)}>
                    Author new
                  </Button>
                </div>
              }
            />
            <CardBody>
              {skills.length === 0 ? (
                <p className="text-sm text-ink-muted">
                  No skills attached. Your agent runs on its context alone.
                </p>
              ) : (
                <ol className="space-y-2">
                  {skills.map((skill, i) => (
                    <li
                      key={skill.id}
                      className="flex items-start gap-3 rounded-md border border-line px-3 py-2"
                    >
                      <span className="mt-0.5 font-mono text-[10px] text-ink-faint">{i + 1}</span>
                      <div className="min-w-0 flex-1">
                        <Link
                          href={`/skills/${skill.slug}`}
                          className="text-sm font-medium text-ink hover:text-accent-strong"
                        >
                          {skill.name}
                        </Link>
                        <p className="mt-0.5 line-clamp-2 text-xs text-ink-muted">
                          {skill.description || `${skill.bodyMd.length.toLocaleString()} chars`}
                        </p>
                      </div>
                      {!disabled ? (
                        <div className="flex shrink-0 items-center gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`Move ${skill.name} up`}
                            disabled={i === 0}
                            onClick={() => move(i, -1)}
                          >
                            ↑
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`Move ${skill.name} down`}
                            disabled={i === skills.length - 1}
                            onClick={() => move(i, 1)}
                          >
                            ↓
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`Detach ${skill.name}`}
                            onClick={() => setSkills((c) => c.filter((s) => s.id !== skill.id))}
                          >
                            ✕
                          </Button>
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ol>
              )}
            </CardBody>
            <CardFooter>
              Skills are attached by id: if the author edits one, your future runs get the new text.
            </CardFooter>
          </Card>
        </div>

        {/* ------------------------------------------------------ pane 3 */}
        <div className="space-y-6">
          <Card>
            <CardHeader title="Model" description="Version-pinned. Prices per million tokens." />
            <CardBody className="space-y-3">
              <Select
                value={modelId}
                disabled={disabled}
                aria-label="Model"
                onChange={(e) => setModelId(e.target.value)}
              >
                {allowed.map((m) => (
                  <option key={m.modelId} value={m.modelId}>
                    {m.displayName} — {m.provider}
                  </option>
                ))}
                {!allowed.some((m) => m.modelId === modelId) ? (
                  <option value={modelId}>{modelId} (not allowlisted)</option>
                ) : null}
              </Select>

              {model ? (
                <dl className="space-y-1.5">
                  <SpecRow label="Gateway id" value={model.modelId} mono />
                  <SpecRow label="Provider" value={model.provider} />
                  <SpecRow label="$ / M in" value={`$${model.inputPerM}`} />
                  <SpecRow label="$ / M out" value={`$${model.outputPerM}`} />
                  <SpecRow
                    label="Reasoning"
                    value={model.supportsReasoning ? "supported" : "not supported"}
                  />
                </dl>
              ) : (
                <p className="text-xs text-danger">
                  {modelId} is not in the model catalog.
                </p>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Harness" description="Runtime knobs, bounded by league rules." />
            <CardBody className="space-y-4">
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

              <Field
                label="Token budget per run"
                hint={
                  rules.weeklyTokenCapPerTeam
                    ? `Weekly team cap: ${rules.weeklyTokenCapPerTeam.toLocaleString()}`
                    : "No weekly cap set by the commissioner."
                }
              >
                <Input
                  type="number"
                  min={1_000}
                  max={rules.weeklyTokenCapPerTeam ?? 2_000_000}
                  step={1_000}
                  disabled={disabled}
                  value={harness.tokenBudget}
                  onChange={(e) =>
                    setHarness((h) => ({ ...h, tokenBudget: Number(e.target.value) || 0 }))
                  }
                />
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
                <Field label="Reasoning effort">
                  <Select
                    disabled={disabled}
                    value={harness.reasoningEffort ?? ""}
                    onChange={(e) =>
                      setHarness((h) => ({
                        ...h,
                        reasoningEffort: (e.target.value || null) as HarnessSettings["reasoningEffort"],
                      }))
                    }
                  >
                    <option value="">Off</option>
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                  </Select>
                </Field>
              ) : (
                <p className="text-xs text-ink-faint">
                  {model?.displayName ?? "This model"} does not expose a reasoning-effort control.
                </p>
              )}

              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--color-accent)]"
                  disabled={disabled}
                  checked={harness.deliberateMode}
                  onChange={(e) => setHarness((h) => ({ ...h, deliberateMode: e.target.checked }))}
                />
                <span>
                  Deliberate mode
                  <span className="ml-2 text-xs text-ink-faint">
                    plan before any tool call
                  </span>
                </span>
              </label>
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Live preview"
              description="Updates as you type. Assumes 4 steps and 1,500 output tokens per step."
            />
            <CardBody className="space-y-3">
              <div className="flex items-baseline justify-between">
                <span className="eyebrow">Prompt tokens</span>
                <span
                  className={cn(
                    "font-mono text-lg tabular-nums",
                    estimate.isFetching && "opacity-50",
                  )}
                >
                  {estimate.data ? estimate.data.tokens.toLocaleString() : "—"}
                </span>
              </div>
              <div className="flex items-baseline justify-between">
                <span className="eyebrow">Est. cost / run</span>
                <span
                  className={cn(
                    "font-mono text-lg tabular-nums",
                    estimate.isFetching && "opacity-50",
                  )}
                >
                  {estimate.data ? formatUsd(estimate.data.estimatedCostPerRunUsd) : "—"}
                </span>
              </div>
              {estimate.data ? (
                <dl className="space-y-1 border-t border-line pt-3">
                  <SpecRow label="Base prompt" value={estimate.data.breakdown.baseTokens.toLocaleString()} />
                  <SpecRow label="Your context" value={estimate.data.breakdown.contextTokens.toLocaleString()} />
                  <SpecRow label="Skills" value={estimate.data.breakdown.skillTokens.toLocaleString()} />
                </dl>
              ) : null}
            </CardBody>
            <CardFooter>
              Excludes the per-window snapshot, which varies. Input is priced uncached, so the real
              figure is usually lower.
            </CardFooter>
          </Card>
        </div>
      </div>

      {/* --------------------------------------------------------- save bar */}
      {canEdit ? (
        <div className="sticky bottom-4 z-20">
          <Card className="shadow-lg">
            <CardBody className="flex flex-wrap items-end gap-3">
              <div className="min-w-56 flex-1">
                <Field label="Change summary" hint="Shown in the changelog. Optional.">
                  <Input
                    value={changeSummary}
                    maxLength={200}
                    placeholder="Weight floor over ceiling when favoured"
                    onChange={(e) => setChangeSummary(e.target.value)}
                  />
                </Field>
              </div>
              <Button
                disabled={save.isPending || overLimit}
                onClick={() => {
                  setError(null);
                  save.mutate({
                    leagueId: props.leagueId,
                    teamId: props.teamId,
                    contextMd,
                    modelId,
                    harness: effectiveHarness,
                    skillIds,
                    changeSummary: changeSummary.trim() || undefined,
                  });
                }}
              >
                {save.isPending
                  ? "Saving…"
                  : lock.open
                    ? `Save version ${props.nextVersionNo}`
                    : `Queue version ${props.nextVersionNo}`}
              </Button>
            </CardBody>
            {error ? (
              <CardFooter>
                <p role="alert" className="text-danger">
                  {error}
                </p>
              </CardFooter>
            ) : null}
          </Card>
        </div>
      ) : (
        <Card>
          <CardBody className="text-sm text-ink-muted">
            You are reading {props.teamName}&apos;s configuration. Every config in the league is
            public; only its owner (or the commissioner) can change it.
          </CardBody>
        </Card>
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
        "flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3 text-sm",
        open
          ? "border-accent/40 bg-accent-soft text-accent-strong"
          : "border-warning/40 bg-warning/10 text-ink",
      )}
    >
      <Badge tone={open ? "accent" : "warning"}>{open ? "editable" : "locked"}</Badge>
      <span>
        {open
          ? `Editable until ${nextChangeLabel}.`
          : canEdit
            ? `Locked — saving queues version ${nextVersionNo} for ${nextChangeLabel}.`
            : `Locked until ${nextChangeLabel}.`}
      </span>
      {pendingVersionNo !== null ? (
        <span className="text-ink-muted">
          Version {pendingVersionNo} is already queued and will replace it.
        </span>
      ) : null}
    </div>
  );
}

function SpecRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-xs uppercase tracking-wide text-ink-faint">{label}</dt>
      <dd className={cn("truncate text-xs text-ink", mono !== false && "font-mono tabular-nums")}>
        {value}
      </dd>
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
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <span className="eyebrow">{label}</span>
        <span className="font-mono text-xs tabular-nums text-ink">
          {format ? format(value) : value}
        </span>
      </div>
      <input
        type="range"
        className="w-full accent-[var(--color-accent)]"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {hint ? <p className="text-xs text-ink-faint">{hint}</p> : null}
    </div>
  );
}
