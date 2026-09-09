"use client";

import { useAction, useMutation } from "convex/react";
import { Plus, X } from "lucide-react";
import { useState } from "react";

import { mutationErrorMessage } from "@/components/league/convex-errors";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  NativeSelect,
  NativeSelectOption,
  Textarea,
  cn,
} from "@/components/ui";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { CustomToolView } from "@/convex/custom_tools";
import { providerSlug } from "@/convex/runtime/tools/catalog";
import { customToolUrlError } from "@/convex/lib/custom_tool_url";

type Header = { name: string; value: string };

export type CustomToolDraft = {
  name: string;
  description: string;
  url: string;
  method: "GET" | "POST";
  headers: Header[];
  jsonPath: string;
};

const EMPTY: CustomToolDraft = {
  name: "",
  description: "",
  url: "",
  method: "GET",
  headers: [],
  jsonPath: "",
};

function draftOf(tool: CustomToolView | null): CustomToolDraft {
  if (!tool) return EMPTY;
  return {
    name: tool.name,
    description: tool.description,
    url: tool.url,
    method: tool.method,
    headers: tool.headers.map((h) => ({ name: h.name, value: h.value ?? "" })),
    jsonPath: tool.jsonPath,
  };
}

type TestResult = {
  ok: boolean;
  errors: string[];
  preview: string | null;
  bytes: number;
  fetchedAt: string | null;
};

/**
 * Create or edit a team-scoped custom tool: an HTTPS/JSON source the runtime
 * exposes as `custom_<slug>`. Saves apply immediately (custom tools are not
 * versioned), and "Test" performs the exact request the agent would.
 */
export function CustomToolDialog({
  open,
  leagueId,
  teamId,
  tool,
  onClose,
  onSaved,
}: {
  open: boolean;
  leagueId: string;
  teamId: string;
  /** Null creates; a view edits. */
  tool: CustomToolView | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        {/* Keyed so every open starts from the tool being edited (or a blank draft). */}
        <CustomToolForm
          key={`${open ? "open" : "closed"}:${tool?.id ?? "new"}`}
          leagueId={leagueId}
          teamId={teamId}
          tool={tool}
          onClose={onClose}
          onSaved={onSaved}
        />
      </DialogContent>
    </Dialog>
  );
}

function CustomToolForm({
  leagueId,
  teamId,
  tool,
  onClose,
  onSaved,
}: {
  leagueId: string;
  teamId: string;
  tool: CustomToolView | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [draft, setDraft] = useState<CustomToolDraft>(draftOf(tool));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testQuery, setTestQuery] = useState("");
  const [result, setResult] = useState<TestResult | null>(null);

  const create = useMutation(api.custom_tools.create);
  const update = useMutation(api.custom_tools.update);
  const runTest = useAction(api.custom_tools.test);

  const slug = providerSlug(draft.name.trim() || "provider");
  const urlError = customToolUrlError(draft.url);
  const valid =
    draft.name.trim().length >= 2 && urlError === null;

  function patch(partial: Partial<CustomToolDraft>) {
    setDraft((d) => ({ ...d, ...partial }));
  }

  function setHeader(index: number, partial: Partial<Header>) {
    setDraft((d) => ({
      ...d,
      headers: d.headers.map((h, i) =>
        i === index ? { ...h, ...partial } : h,
      ),
    }));
  }

  async function submit() {
    setPending(true);
    setError(null);
    try {
      const payload = {
        name: draft.name.trim(),
        description: draft.description,
        url: draft.url.trim(),
        method: draft.method,
        headers: draft.headers.filter((h) => h.name.trim()),
        jsonPath: draft.jsonPath,
      };
      if (tool) {
        await update({ toolId: tool.id, ...payload });
        onSaved(`custom_${slug} updated. Applies to the next run.`);
      } else {
        await create({
          leagueId: leagueId as Id<"leagues">,
          teamId: teamId as Id<"teams">,
          ...payload,
        });
        onSaved(`custom_${slug} added. Your agent gets it on its next run.`);
      }
      onClose();
    } catch (err) {
      setError(mutationErrorMessage(err));
    } finally {
      setPending(false);
    }
  }

  async function test() {
    setTesting(true);
    setResult(null);
    setError(null);
    try {
      const out = await runTest({
        teamId: teamId as Id<"teams">,
        name: draft.name.trim() || "Draft tool",
        description: draft.description,
        url: draft.url.trim(),
        method: draft.method,
        headers: draft.headers.filter((h) => h.name.trim()),
        jsonPath: draft.jsonPath,
        ...(testQuery.trim() ? { query: testQuery.trim() } : {}),
      });
      setResult(out);
    } catch (err) {
      setError(mutationErrorMessage(err));
    } finally {
      setTesting(false);
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {tool ? "Edit custom tool" : "Add a custom tool"}
        </DialogTitle>
        <DialogDescription>
          A secure HTTPS endpoint that returns JSON. Your agent sees it as a read-only
          tool named{" "}
          <span className="font-mono text-foreground">custom_{slug}</span> in
          every window, and its response arrives wrapped as untrusted data.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_120px]">
          <Field>
            <FieldLabel htmlFor="ct-name">Name</FieldLabel>
            <Input
              id="ct-name"
              value={draft.name}
              maxLength={60}
              placeholder="Weather feed"
              onChange={(e) => patch({ name: e.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="ct-method">Method</FieldLabel>
            <NativeSelect
              id="ct-method"
              className="w-full"
              value={draft.method}
              onChange={(e) =>
                patch({ method: e.target.value as "GET" | "POST" })
              }
            >
              <NativeSelectOption value="GET">GET</NativeSelectOption>
              <NativeSelectOption value="POST">POST</NativeSelectOption>
            </NativeSelect>
          </Field>
        </div>

        <Field>
          <FieldLabel htmlFor="ct-url">URL</FieldLabel>
          <Input
            id="ct-url"
            value={draft.url}
            className="font-mono text-xs"
            placeholder="https://api.example.com/weather"
            aria-invalid={draft.url.trim().length > 0 && urlError !== null}
            onChange={(e) => patch({ url: e.target.value })}
          />
          {draft.url.trim().length > 0 && urlError ? (
            <FieldError>{urlError}</FieldError>
          ) : null}
          <FieldDescription>
            {draft.method === "GET"
              ? "The agent's free-text query is appended as ?query=."
              : 'The agent\'s free-text query is POSTed as {"query": …}.'}{" "}
            HTTPS is required. 10 s timeout, 64 KB cap, JSON only.
          </FieldDescription>
        </Field>

        <Field>
          <FieldLabel htmlFor="ct-description">
            What the model reads about it
          </FieldLabel>
          <Textarea
            id="ct-description"
            rows={3}
            value={draft.description}
            maxLength={600}
            placeholder="Hourly forecast and wind speed for every NFL stadium this week. Pass a team abbreviation as the query."
            onChange={(e) => patch({ description: e.target.value })}
          />
          <FieldDescription>
            Write it like a tool description: what it returns and when to call
            it.
          </FieldDescription>
        </Field>

        <Field>
          <FieldLabel htmlFor="ct-path">JSON path</FieldLabel>
          <Input
            id="ct-path"
            value={draft.jsonPath}
            className="font-mono text-xs"
            placeholder="data.games"
            onChange={(e) => patch({ jsonPath: e.target.value })}
          />
          <FieldDescription>
            Optional. Dot path into the response, e.g. `results.0.items`.
          </FieldDescription>
        </Field>

        <div>
          <div className="flex items-center justify-between border-b border-border pb-2">
            <span className="eyebrow text-foreground">Headers</span>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={draft.headers.length >= 8}
              onClick={() =>
                patch({ headers: [...draft.headers, { name: "", value: "" }] })
              }
            >
              <Plus data-icon="inline-start" /> Add header
            </Button>
          </div>
          {draft.headers.length === 0 ? (
            <p className="mt-2.5 text-sm text-muted-foreground">
              None. Add an API key header here; values are sent only to this
              HTTPS endpoint and are visible only to you and the commissioner.
            </p>
          ) : (
            <ul className="mt-2.5 space-y-2">
              {draft.headers.map((header, i) => (
                <li
                  key={i}
                  className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_28px] items-center gap-2"
                >
                  <Input
                    aria-label={`Header ${i + 1} name`}
                    value={header.name}
                    className="font-mono text-xs"
                    placeholder="X-Api-Key"
                    onChange={(e) => setHeader(i, { name: e.target.value })}
                  />
                  <Input
                    aria-label={`Header ${i + 1} value`}
                    value={header.value}
                    className="font-mono text-xs"
                    placeholder="value"
                    onChange={(e) => setHeader(i, { value: e.target.value })}
                  />
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Remove header ${i + 1}`}
                    onClick={() =>
                      patch({
                        headers: draft.headers.filter((_, j) => j !== i),
                      })
                    }
                  >
                    <X />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* ------------------------------------------------------- test */}
        <div className="rounded-md border border-border bg-muted/40 p-3">
          <div className="flex flex-wrap items-end gap-2">
            <Field className="min-w-40 flex-1">
              <FieldLabel htmlFor="ct-test-query" className="eyebrow">
                Test query
              </FieldLabel>
              <Input
                id="ct-test-query"
                value={testQuery}
                placeholder="optional"
                onChange={(e) => setTestQuery(e.target.value)}
              />
            </Field>
            <Button
              type="button"
              variant="outline"
              disabled={!valid || testing}
              onClick={() => void test()}
            >
              {testing ? "Calling…" : "Test tool"}
            </Button>
          </div>
          {result ? (
            <div className="mt-3">
              <p
                className={cn(
                  "text-sm",
                  result.ok ? "text-success" : "text-destructive",
                )}
                role="status"
              >
                {result.ok
                  ? `OK — ${result.bytes.toLocaleString()} bytes returned to the agent.`
                  : result.errors.join(" ")}
              </p>
              {result.preview ? (
                <pre className="mt-2 max-h-48 overflow-auto rounded-sm border border-border bg-background p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                  {result.preview}
                </pre>
              ) : null}
            </div>
          ) : null}
        </div>

        {error ? (
          <p
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
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
          disabled={!valid || pending}
          onClick={() => void submit()}
        >
          {pending ? "Saving…" : tool ? "Save tool" : "Add tool"}
        </Button>
      </DialogFooter>
    </>
  );
}
