"use client";

import { useMutation, useQuery } from "convex/react";
import { useEffect, useMemo, useState } from "react";

import { formatUsd } from "@/components/cost/format";
import { clearDraft } from "@/components/editor/markdown-editor";
import {
  mutationErrorIssues,
  mutationErrorMessage,
  type ConvexIssue,
} from "@/components/league/convex-errors";
import {
  Badge,
  Button,
  Field,
  FieldLabel,
  Input,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  cn,
} from "@/components/ui";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { HarnessSettings } from "@/convex/lib/config_pure";
import type { ToolOverride } from "@/convex/runtime/tools/catalog";
import { findModel } from "@/lib/models";
import { formatET } from "@/lib/time";

import { ModelPanel } from "./model-panel";
import { PromptPanel } from "./prompt-panel";
import {
  AttachSkillDialog,
  AuthorSkillDialog,
  type AttachedSkill,
} from "./skill-picker";
import { Toast, type ToastTone } from "./toast";
import { toolCounts } from "./tool-model";
import { ToolsPanel } from "./tools-panel";

export type EditorTab = "prompt" | "tools" | "model";

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
    toolOverrides: ToolOverride[];
    noteToAgent: string;
    hasPendingChanges: boolean;
  };
  initialTab?: EditorTab;
  /** The league's current week, for the spend meters. */
  weekNo: number;
};

const DEBOUNCE_MS = 500;

/**
 * The agent editor: one draft (context, skills, tool overrides, model, harness)
 * across three tabs and a single save that appends an immutable version.
 */
export function ConfigEditor(props: ConfigEditorProps) {
  const { rules, initial, canEdit } = props;
  const leagueId = props.leagueId as Id<"leagues">;
  const teamId = props.teamId as Id<"teams">;

  const lockStatus = useQuery(api.configs.lockStatus, { leagueId });
  const lock = lockStatus ?? props.initialLock;
  const nextChangeLabel = `${formatET(lock.nextChange, "EEE h:mm a")} ET`;

  const [tab, setTab] = useState<EditorTab>(props.initialTab ?? "prompt");
  const [contextMd, setContextMd] = useState(initial.contextMd);
  const [note, setNote] = useState(initial.noteToAgent);
  const [skills, setSkills] = useState<AttachedSkill[]>(initial.skills);
  const [modelId, setModelId] = useState(initial.modelId);
  const [harness, setHarness] = useState<HarnessSettings>(initial.harness);
  // Tool customisation is saved from each tool's own page; the editor only
  // carries the newest overrides forward so a prompt or model save keeps them.
  const toolOverrides: ToolOverride[] = initial.toolOverrides;
  const [changeSummary, setChangeSummary] = useState("");

  const [attachOpen, setAttachOpen] = useState(false);
  const [authorOpen, setAuthorOpen] = useState(false);
  const [toast, setToast] = useState<{
    message: string;
    tone: ToastTone;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<ConvexIssue[]>([]);
  const [savingNote, setSavingNote] = useState(false);
  const [saving, setSaving] = useState(false);

  const model = findModel(modelId);
  const effectiveHarness: HarnessSettings = model?.supportsReasoning
    ? harness
    : { ...harness, reasoningEffort: null };

  // ---- live preview: debounce the whole estimate input -----------------------
  const skillIds = useMemo(() => skills.map((s) => s.id), [skills]);
  const [estimateInput, setEstimateInput] = useState({
    contextMd,
    skillIds,
    modelId,
  });
  useEffect(() => {
    const timer = setTimeout(
      () => setEstimateInput({ contextMd, skillIds, modelId }),
      DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [contextMd, skillIds, modelId]);

  const estimateArgs =
    estimateInput.contextMd.trim().length === 0 &&
    estimateInput.skillIds.length === 0
      ? ("skip" as const)
      : {
          leagueId,
          contextMd: estimateInput.contextMd,
          skillIds: estimateInput.skillIds as Id<"skills">[],
          modelId: estimateInput.modelId,
        };
  const estimate = useQuery(api.configs.estimate, estimateArgs);
  const estimateStale =
    estimate === undefined ||
    estimateInput.contextMd !== contextMd ||
    estimateInput.modelId !== modelId ||
    estimateInput.skillIds.join() !== skillIds.join();

  // Custom tools are live (not versioned); the shell only needs the count.
  const customTools = useQuery(api.custom_tools.listForTeam, {
    leagueId,
    teamId,
  });
  const customCount = (customTools?.tools ?? []).filter(
    (t) => !t.inherited && t.enabled,
  ).length;
  const counts = useMemo(() => toolCounts(toolOverrides), [toolOverrides]);

  const overLimit = contextMd.length > rules.contextCharLimit;
  const draftKey = `context:${leagueId}:${teamId}`;

  // What the last save (or first paint) looked like, so the bar goes quiet again after saving.
  const [baseline, setBaseline] = useState(() => ({
    contextMd: initial.contextMd,
    modelId: initial.modelId,
    harness: initial.harness,
    skillIds: initial.skills.map((s) => s.id),
  }));
  const dirty =
    contextMd !== baseline.contextMd ||
    modelId !== baseline.modelId ||
    JSON.stringify(effectiveHarness) !== JSON.stringify(baseline.harness) ||
    skillIds.join("|") !== baseline.skillIds.join("|");

  const saveNote = useMutation(api.configs.setNote);
  const save = useMutation(api.configs.save);

  function notify(message: string, tone: ToastTone) {
    setToast({ message, tone });
  }

  async function submitNote() {
    setSavingNote(true);
    try {
      await saveNote({ leagueId, teamId, text: note.trim() ? note : null });
      notify("Note saved for the next config save.", "info");
    } catch (err) {
      notify(mutationErrorMessage(err), "error");
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
        toolOverrides,
        ...(changeSummary.trim()
          ? { changeSummary: changeSummary.trim() }
          : {}),
      });
      setChangeSummary("");
      setNote("");
      setBaseline({
        contextMd,
        modelId,
        harness: effectiveHarness,
        skillIds,
      });
      clearDraft(draftKey);
      notify(
        result.applied
          ? "Changes saved."
          : "Changes saved — they take effect at the next unlock.",
        "success",
      );
    } catch (err) {
      setError(mutationErrorMessage(err));
      setIssues(mutationErrorIssues(err));
      notify("Save rejected — see the errors below.", "error");
    } finally {
      setSaving(false);
    }
  }

  function attach(skill: AttachedSkill) {
    setSkills((current) =>
      current.some((s) => s.id === skill.id) ? current : [...current, skill],
    );
  }

  return (
    <div className="space-y-8">
      {/* ------------------------------------------------------- overview */}
      <div className="grid gap-4 rounded-lg border border-border bg-card p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
          <Glance
            label="Model"
            value={model?.displayName ?? modelId}
            detail={model?.provider ?? "unknown"}
          />
          <Glance
            label="Tools"
            value={`${counts.enabled + customCount}`}
            detail={`${counts.enabled}/${counts.defaults} default${customCount ? ` · ${customCount} custom` : ""}${counts.guided ? ` · ${counts.guided} guided` : ""}`}
          />
          <Glance
            label="Skills"
            value={String(skills.length)}
            detail={
              skills.length === 0
                ? "context only"
                : skills.map((s) => s.name).join(", ")
            }
          />
          <Glance
            label="Est. cost / run"
            value={estimate ? formatUsd(estimate.estimatedCostPerRunUsd) : "—"}
            detail={
              estimate
                ? `${estimate.tokens.toLocaleString()} prompt tokens`
                : "estimating"
            }
            dim={estimateStale}
          />
        </dl>
        <div className="flex flex-wrap items-center gap-2 sm:flex-col sm:items-end">
          <Badge variant={lock.open ? "success" : "warning"}>
            {lock.open ? "editable" : "locked"}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {lock.open
              ? `Saves apply now · locks ${nextChangeLabel}`
              : canEdit
                ? `Saves take effect ${nextChangeLabel}`
                : `Unlocks ${nextChangeLabel}`}
          </span>
          {initial.hasPendingChanges ? (
            <span className="text-xs text-muted-foreground">
              saved changes pending
            </span>
          ) : null}
        </div>
      </div>

      {/* ----------------------------------------------------------- tabs */}
      <Tabs value={tab} onValueChange={(value) => setTab(value as EditorTab)}>
        <TabsList
          variant="line"
          className="w-full justify-start border-b border-border"
        >
          <TabsTrigger value="prompt" className="flex-none px-3 py-2">
            System prompt
          </TabsTrigger>
          <TabsTrigger value="tools" className="flex-none px-3 py-2">
            Tools
            <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
              {counts.enabled + customCount}
            </span>
          </TabsTrigger>
          <TabsTrigger value="model" className="flex-none px-3 py-2">
            Model &amp; harness
          </TabsTrigger>
        </TabsList>

        <TabsContent value="prompt" className="pt-6">
          <PromptPanel
            contextMd={contextMd}
            contextCharLimit={rules.contextCharLimit}
            draftKey={draftKey}
            note={note}
            skills={skills}
            canEdit={canEdit}
            saving={saving}
            onContextChange={setContextMd}
            onNoteChange={setNote}
            onSaveNote={() => void submitNote()}
            savingNote={savingNote}
            onSkillsChange={setSkills}
            onAttachSkill={() => setAttachOpen(true)}
            onAuthorSkill={() => setAuthorOpen(true)}
            onSubmit={() => void submitVersion()}
          />
        </TabsContent>

        <TabsContent value="tools" className="pt-6">
          <ToolsPanel
            leagueId={props.leagueId}
            teamId={props.teamId}
            overrides={toolOverrides}
            canEdit={canEdit}
            onToast={notify}
          />
        </TabsContent>

        <TabsContent value="model" className="pt-6">
          <ModelPanel
            leagueId={props.leagueId}
            teamId={props.teamId}
            weekNo={props.weekNo}
            modelId={modelId}
            harness={harness}
            rules={rules}
            canEdit={canEdit}
            estimate={estimate}
            estimateStale={estimateStale}
            onModelChange={setModelId}
            onHarnessChange={(update) => setHarness(update)}
            onToast={notify}
          />
        </TabsContent>
      </Tabs>

      {/* ------------------------------------------------------- save bar */}
      {!canEdit ? (
        <p className="border-t border-border pt-5 text-sm text-muted-foreground">
          You are reading {props.teamName}&apos;s agent. Every config in the
          league is public; only its owner (or the commissioner) can change it.
        </p>
      ) : dirty || error ? (
        <div className="sticky bottom-4 z-20">
          <div className="rounded-lg border border-line-strong bg-card/95 shadow-lg backdrop-blur supports-backdrop-filter:bg-card/80">
            <div className="flex flex-wrap items-end justify-end gap-4 p-4">
              <Field className="min-w-56 flex-1">
                <FieldLabel
                  htmlFor="change-summary"
                  className="eyebrow text-foreground"
                >
                  Change summary
                </FieldLabel>
                <Input
                  id="change-summary"
                  value={changeSummary}
                  maxLength={200}
                  placeholder="Weight floor over ceiling when favored"
                  onChange={(e) => setChangeSummary(e.target.value)}
                />
              </Field>
              <div className="flex items-center gap-3">
                <span className="text-xs text-warning">Unsaved changes</span>
                <Button
                  type="button"
                  size="lg"
                  disabled={saving || overLimit || !dirty}
                  onClick={() => void submitVersion()}
                >
                  {saving ? "Saving…" : "Save changes"}
                </Button>
              </div>
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
                        <span className="font-mono text-xs">{issue.field}</span>{" "}
                        — {issue.message}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

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

function Glance({
  label,
  value,
  detail,
  dim,
}: {
  label: string;
  value: string;
  detail: string;
  dim?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "mt-1 truncate font-mono text-lg tabular-nums",
          dim && "opacity-50",
        )}
      >
        {value}
      </dd>
      <dd className="mt-0.5 truncate text-[11px] text-muted-foreground">
        {detail}
      </dd>
    </div>
  );
}
