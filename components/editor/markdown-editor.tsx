"use client";

import { Toolbar } from "@base-ui/react/toolbar";
import {
  Bold,
  Code,
  Columns2,
  Eye,
  Heading,
  Italic,
  Keyboard,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  Maximize2,
  Minimize2,
  Minus,
  PencilLine,
  Plus,
  Quote,
  SquareCode,
  Strikethrough,
  Table2,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { Markdown } from "@/components/config/markdown";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
  Kbd,
  KbdGroup,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ToggleGroup,
  ToggleGroupItem,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn,
} from "@/components/ui";
import { estimateTokens } from "@/convex/lib/config_pure";

import {
  caretPosition,
  continueList,
  countWords,
  diffRange,
  indentLines,
  insertBlock,
  insertCodeBlock,
  insertLink,
  insertRule,
  insertTable,
  setHeading,
  toggleInline,
  toggleLinePrefix,
  type EditorState,
} from "./markdown-commands";
import { snippetsFor, type SnippetKind } from "./snippets";

export type MarkdownEditorMode = "write" | "split" | "preview";

export type MarkdownEditorProps = {
  value: string;
  onChange: (next: string) => void;
  /** Which snippet set to offer. */
  kind?: SnippetKind;
  /** Hard limit reported in the status bar; the value itself is never truncated. */
  maxChars?: number;
  disabled?: boolean;
  placeholder?: string;
  id?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  /** Invoked on ⌘S / Ctrl+S. */
  onSave?: () => void;
  /** Persist unsaved edits to localStorage under this key and offer to restore them. */
  draftKey?: string;
  /** Initial mode. */
  defaultMode?: MarkdownEditorMode;
  /** Editor height when not fullscreen. */
  minHeight?: number;
  className?: string;
};

const DRAFT_PREFIX = "fb:draft:";
const DRAFT_DEBOUNCE_MS = 600;

type Draft = { text: string; savedAt: number };

function readDraft(key: string): Draft | null {
  try {
    const raw = window.localStorage.getItem(DRAFT_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Draft;
    return typeof parsed.text === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function writeDraft(key: string, text: string) {
  try {
    window.localStorage.setItem(
      DRAFT_PREFIX + key,
      JSON.stringify({ text, savedAt: Date.now() }),
    );
  } catch {
    /* quota or private mode: drafts are a convenience, never required */
  }
}

/** Remove a persisted draft. Call after the parent has saved successfully. */
export function clearDraft(key: string) {
  try {
    window.localStorage.removeItem(DRAFT_PREFIX + key);
  } catch {
    /* ignore */
  }
}

const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = IS_MAC ? "⌘" : "Ctrl";

/**
 * The markdown editor owners use for agent context and skills.
 *
 * A native textarea (undo, IME, spellcheck, and accessibility for free) with a
 * formatting toolbar, keyboard shortcuts, list continuation, a GFM preview in
 * split or full view, insertable scaffolds, a status bar with the limit the
 * commissioner set, fullscreen, and localStorage draft recovery.
 */
export function MarkdownEditor({
  value,
  onChange,
  kind = "context",
  maxChars,
  disabled = false,
  placeholder,
  id,
  onSave,
  draftKey,
  defaultMode = "write",
  minHeight = 480,
  className,
  ...aria
}: MarkdownEditorProps) {
  const generatedId = useId();
  const textareaId = id ?? `${generatedId}-editor`;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  const [mode, setMode] = useState<MarkdownEditorMode>(defaultMode);
  const [fullscreen, setFullscreen] = useState(false);
  const [caret, setCaret] = useState({ line: 1, column: 1 });
  const [draft, setDraft] = useState<Draft | null>(null);

  const snippets = useMemo(() => snippetsFor(kind), [kind]);
  const chars = value.length;
  const words = useMemo(() => countWords(value), [value]);
  const tokens = estimateTokens(value);
  const overLimit = maxChars !== undefined && chars > maxChars;

  // ---------------------------------------------------------------- drafts
  const initialValueRef = useRef(value);
  useEffect(() => {
    if (!draftKey) return;
    // Deferred so the first paint matches the server (localStorage is client-only);
    // the prompt compares against the value the editor mounted with.
    const timer = window.setTimeout(() => {
      const stored = readDraft(draftKey);
      if (
        stored &&
        stored.text !== initialValueRef.current &&
        stored.text.trim().length > 0
      ) {
        setDraft(stored);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [draftKey]);

  useEffect(() => {
    if (!draftKey) return;
    const timer = setTimeout(
      () => writeDraft(draftKey, value),
      DRAFT_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [draftKey, value]);

  // ---------------------------------------------------------------- edits

  /**
   * Apply a command result as one native edit so ⌘Z still works. Falls back to
   * a plain value set where `execCommand` is unavailable.
   */
  const apply = useCallback(
    (next: EditorState) => {
      const el = textareaRef.current;
      if (!el) return;
      const { from, to, insert } = diffRange(el.value, next.text);
      el.focus();
      if (from !== to || insert.length > 0) {
        el.setSelectionRange(from, to);
        let ok = false;
        try {
          ok = document.execCommand("insertText", false, insert);
        } catch {
          ok = false;
        }
        if (!ok || el.value !== next.text) {
          el.setRangeText(insert, from, to, "end");
          onChange(el.value);
        }
      }
      el.setSelectionRange(next.start, next.end);
      setCaret(caretPosition(next.text, next.end));
    },
    [onChange],
  );

  const run = useCallback(
    (command: (state: EditorState) => EditorState | null) => {
      const el = textareaRef.current;
      if (!el || disabled) return;
      const next = command({
        text: el.value,
        start: el.selectionStart,
        end: el.selectionEnd,
      });
      if (next) apply(next);
    },
    [apply, disabled],
  );

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    const mod = IS_MAC ? event.metaKey : event.ctrlKey;

    if (event.key === "Escape" && fullscreen) {
      event.preventDefault();
      setFullscreen(false);
      return;
    }
    if (event.key === "Tab" && !event.altKey && !mod) {
      event.preventDefault();
      run((s) => indentLines(s, event.shiftKey));
      return;
    }
    if (
      event.key === "Enter" &&
      !mod &&
      !event.shiftKey &&
      !event.altKey &&
      !event.nativeEvent.isComposing
    ) {
      const el = event.currentTarget;
      const next = continueList({
        text: el.value,
        start: el.selectionStart,
        end: el.selectionEnd,
      });
      if (next) {
        event.preventDefault();
        apply(next);
      }
      return;
    }
    if (!mod) return;

    const key = event.key.toLowerCase();
    if (key === "s") {
      event.preventDefault();
      onSave?.();
    } else if (key === "b") {
      event.preventDefault();
      run((s) => toggleInline(s, "**"));
    } else if (key === "i") {
      event.preventDefault();
      run((s) => toggleInline(s, "_"));
    } else if (key === "e") {
      event.preventDefault();
      run((s) => toggleInline(s, "`"));
    } else if (key === "k") {
      event.preventDefault();
      run((s) => insertLink(s));
    } else if (event.shiftKey && key === "x") {
      event.preventDefault();
      run((s) => toggleInline(s, "~~"));
    } else if (event.shiftKey && event.code === "Digit8") {
      event.preventDefault();
      run((s) => toggleLinePrefix(s, "- "));
    } else if (event.shiftKey && event.code === "Digit7") {
      event.preventDefault();
      run((s) => toggleLinePrefix(s, "", { ordered: true }));
    } else if (event.shiftKey && key === "p") {
      event.preventDefault();
      setMode((m) => (m === "preview" ? "write" : "preview"));
    } else if (event.shiftKey && key === "f") {
      event.preventDefault();
      setFullscreen((f) => !f);
    }
  }

  function updateCaret() {
    const el = textareaRef.current;
    if (el) setCaret(caretPosition(el.value, el.selectionEnd));
  }

  // Keep the preview roughly aligned with the editor in split view.
  function syncScroll() {
    const el = textareaRef.current;
    const preview = previewRef.current;
    if (!el || !preview || mode !== "split") return;
    const ratio = el.scrollTop / Math.max(1, el.scrollHeight - el.clientHeight);
    preview.scrollTop = ratio * (preview.scrollHeight - preview.clientHeight);
  }

  // Fullscreen locks page scroll and closes on Escape from anywhere inside.
  useEffect(() => {
    if (!fullscreen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [fullscreen]);

  const showEditor = mode !== "preview";
  const showPreview = mode !== "write";

  return (
    <div
      data-slot="markdown-editor"
      data-fullscreen={fullscreen || undefined}
      className={cn(
        "@container flex flex-col overflow-hidden rounded-lg border border-input bg-card",
        "focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/40",
        overLimit && "border-destructive/60",
        fullscreen &&
          "fixed inset-0 z-50 rounded-none border-0 ring-0 focus-within:ring-0",
        className,
      )}
      onKeyDown={(event) => {
        if (event.key === "Escape" && fullscreen) setFullscreen(false);
      }}
    >
      {/* ------------------------------------------------------------ toolbar */}
      <Toolbar.Root
        aria-label="Formatting"
        disabled={disabled}
        className="flex flex-wrap items-center gap-0.5 border-b border-border bg-muted/40 px-1.5 py-1"
      >
        <Toolbar.Group
          aria-label="Text style"
          className="flex items-center gap-0.5"
        >
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <ToolButton
                  label="Heading"
                  disabled={disabled || !showEditor}
                />
              }
            >
              <Heading />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-48">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Heading</DropdownMenuLabel>
                {([1, 2, 3] as const).map((level) => (
                  <DropdownMenuItem
                    key={level}
                    onClick={() => run((s) => setHeading(s, level))}
                  >
                    <span
                      className={cn(
                        "font-semibold",
                        level === 1
                          ? "text-base"
                          : level === 2
                            ? "text-sm"
                            : "text-xs",
                      )}
                    >
                      Heading {level}
                    </span>
                    <DropdownMenuShortcut>
                      {"#".repeat(level)}
                    </DropdownMenuShortcut>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <ToolButton
            label="Bold"
            shortcut={`${MOD}B`}
            disabled={disabled || !showEditor}
            onClick={() => run((s) => toggleInline(s, "**"))}
          >
            <Bold />
          </ToolButton>
          <ToolButton
            label="Italic"
            shortcut={`${MOD}I`}
            disabled={disabled || !showEditor}
            onClick={() => run((s) => toggleInline(s, "_"))}
          >
            <Italic />
          </ToolButton>
          <ToolButton
            label="Strikethrough"
            shortcut={`${MOD}⇧X`}
            disabled={disabled || !showEditor}
            onClick={() => run((s) => toggleInline(s, "~~"))}
          >
            <Strikethrough />
          </ToolButton>
          <ToolButton
            label="Inline code"
            shortcut={`${MOD}E`}
            disabled={disabled || !showEditor}
            onClick={() => run((s) => toggleInline(s, "`"))}
          >
            <Code />
          </ToolButton>
        </Toolbar.Group>

        <Toolbar.Separator className="mx-1 h-5 w-px bg-border" />

        <Toolbar.Group
          aria-label="Blocks"
          className="flex items-center gap-0.5"
        >
          <ToolButton
            label="Bulleted list"
            shortcut={`${MOD}⇧8`}
            disabled={disabled || !showEditor}
            onClick={() => run((s) => toggleLinePrefix(s, "- "))}
          >
            <List />
          </ToolButton>
          <ToolButton
            label="Numbered list"
            shortcut={`${MOD}⇧7`}
            disabled={disabled || !showEditor}
            onClick={() =>
              run((s) => toggleLinePrefix(s, "", { ordered: true }))
            }
          >
            <ListOrdered />
          </ToolButton>
          <ToolButton
            label="Task list"
            disabled={disabled || !showEditor}
            onClick={() => run((s) => toggleLinePrefix(s, "", { task: true }))}
          >
            <ListChecks />
          </ToolButton>
          <ToolButton
            label="Quote"
            disabled={disabled || !showEditor}
            onClick={() => run((s) => toggleLinePrefix(s, "> "))}
          >
            <Quote />
          </ToolButton>
          <ToolButton
            label="Code block"
            disabled={disabled || !showEditor}
            onClick={() => run((s) => insertCodeBlock(s))}
          >
            <SquareCode />
          </ToolButton>
          <ToolButton
            label="Link"
            shortcut={`${MOD}K`}
            disabled={disabled || !showEditor}
            onClick={() => run((s) => insertLink(s))}
          >
            <Link2 />
          </ToolButton>
          <ToolButton
            label="Table"
            disabled={disabled || !showEditor}
            onClick={() => run((s) => insertTable(s))}
          >
            <Table2 />
          </ToolButton>
          <ToolButton
            label="Horizontal rule"
            disabled={disabled || !showEditor}
            onClick={() => run((s) => insertRule(s))}
          >
            <Minus />
          </ToolButton>
        </Toolbar.Group>

        <Toolbar.Separator className="mx-1 h-5 w-px bg-border" />

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Toolbar.Button
                disabled={disabled || !showEditor}
                className={cn(
                  "inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors",
                  "hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                  "aria-expanded:bg-accent aria-expanded:text-foreground disabled:pointer-events-none disabled:opacity-50",
                )}
              />
            }
          >
            <Plus className="size-3.5" />
            Insert
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-72">
            <DropdownMenuGroup>
              <DropdownMenuLabel>
                {kind === "context" ? "Context sections" : "Skill scaffolds"}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {snippets.map((snippet) => (
                <DropdownMenuItem
                  key={snippet.id}
                  onClick={() => run((s) => insertBlock(s, snippet.body))}
                  className="flex-col items-start gap-0.5"
                >
                  <span className="text-sm text-foreground">
                    {snippet.label}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {snippet.hint}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="ml-auto flex items-center gap-1">
          <ToggleGroup
            value={[mode]}
            onValueChange={(next) => {
              const chosen = next[0];
              if (
                chosen === "write" ||
                chosen === "split" ||
                chosen === "preview"
              )
                setMode(chosen);
            }}
            size="sm"
            spacing={0}
            variant="outline"
            aria-label="View"
            className="h-7"
          >
            <ToggleGroupItem
              value="write"
              aria-label="Write"
              className="h-7 px-2"
            >
              <PencilLine className="size-3.5" />
              <span className="hidden @[780px]:inline">Write</span>
            </ToggleGroupItem>
            <ToggleGroupItem
              value="split"
              aria-label="Split"
              className="hidden h-7 px-2 lg:inline-flex"
            >
              <Columns2 className="size-3.5" />
              <span className="hidden @[780px]:inline">Split</span>
            </ToggleGroupItem>
            <ToggleGroupItem
              value="preview"
              aria-label="Preview"
              className="h-7 px-2"
            >
              <Eye className="size-3.5" />
              <span className="hidden @[780px]:inline">Preview</span>
            </ToggleGroupItem>
          </ToggleGroup>

          <Popover>
            <PopoverTrigger render={<ToolButton label="Keyboard shortcuts" />}>
              <Keyboard />
            </PopoverTrigger>
            <PopoverContent align="end" className="w-64 p-3">
              <p className="eyebrow mb-3">Shortcuts</p>
              <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-xs">
                {[
                  ["Save", `${MOD}S`],
                  ["Bold", `${MOD}B`],
                  ["Italic", `${MOD}I`],
                  ["Inline code", `${MOD}E`],
                  ["Link", `${MOD}K`],
                  ["Strikethrough", `${MOD}⇧X`],
                  ["Bulleted list", `${MOD}⇧8`],
                  ["Numbered list", `${MOD}⇧7`],
                  ["Toggle preview", `${MOD}⇧P`],
                  ["Fullscreen", `${MOD}⇧F`],
                  ["Indent / outdent", "Tab / ⇧Tab"],
                  ["Continue list", "Enter"],
                ].map(([label, keys]) => (
                  <div key={label} className="contents">
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd>
                      <Kbd>{keys}</Kbd>
                    </dd>
                  </div>
                ))}
              </dl>
            </PopoverContent>
          </Popover>

          <ToolButton
            label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
            shortcut={`${MOD}⇧F`}
            onClick={() => setFullscreen((f) => !f)}
            aria-pressed={fullscreen}
          >
            {fullscreen ? <Minimize2 /> : <Maximize2 />}
          </ToolButton>
        </div>
      </Toolbar.Root>

      {/* ------------------------------------------------------- draft banner */}
      {draft ? (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-brand-soft px-3 py-2 text-sm"
        >
          <span className="text-foreground">
            You have an unsaved draft from{" "}
            <span className="font-mono text-xs">
              {new Date(draft.savedAt).toLocaleString()}
            </span>
            .
          </span>
          <span className="flex items-center gap-1.5">
            <Button
              type="button"
              size="xs"
              onClick={() => {
                onChange(draft.text);
                setDraft(null);
              }}
            >
              Restore
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => {
                if (draftKey) clearDraft(draftKey);
                setDraft(null);
              }}
            >
              Discard
            </Button>
          </span>
        </div>
      ) : null}

      {/* -------------------------------------------------------------- panes */}
      <div
        className={cn(
          "grid min-h-0",
          fullscreen ? "flex-1" : "",
          showEditor && showPreview
            ? "lg:grid-cols-2 lg:divide-x lg:divide-border"
            : "grid-cols-1",
        )}
        style={fullscreen ? undefined : { height: minHeight }}
      >
        {showEditor ? (
          <textarea
            ref={textareaRef}
            id={textareaId}
            value={value}
            disabled={disabled}
            placeholder={placeholder}
            spellCheck
            aria-invalid={overLimit || undefined}
            aria-label={aria["aria-label"]}
            aria-describedby={aria["aria-describedby"]}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={onKeyDown}
            onKeyUp={updateCaret}
            onClick={updateCaret}
            onSelect={updateCaret}
            onScroll={syncScroll}
            className={cn(
              "h-full w-full resize-none bg-transparent px-4 py-3 font-mono text-[13px] leading-6 text-foreground outline-none",
              "placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60",
              "selection:bg-brand selection:text-background",
            )}
          />
        ) : null}
        {showPreview ? (
          <div
            ref={previewRef}
            aria-label="Preview"
            className="h-full min-w-0 overflow-y-auto px-4 py-3"
          >
            {value.trim() ? (
              <Markdown>{value}</Markdown>
            ) : (
              <p className="text-sm text-muted-foreground">
                Nothing to preview yet.
              </p>
            )}
          </div>
        ) : null}
      </div>

      {/* ---------------------------------------------------------- status bar */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-border bg-muted/40 px-3 py-1.5 font-mono text-[11px] tabular-nums text-muted-foreground">
        <div className="flex items-center gap-3">
          <span>
            Ln {caret.line}, Col {caret.column}
          </span>
          <span>{words.toLocaleString()} words</span>
          <span>≈{tokens.toLocaleString()} tokens</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden @[780px]:inline">Markdown · GFM</span>
          <span className={cn(overLimit && "font-semibold text-destructive")}>
            {chars.toLocaleString()}
            {maxChars !== undefined ? ` / ${maxChars.toLocaleString()}` : null}
            {overLimit ? " · over limit" : null}
          </span>
        </div>
      </div>
    </div>
  );
}

/** Icon button for the toolbar: Base UI toolbar item, tooltip with the shortcut. */
function ToolButton({
  label,
  shortcut,
  children,
  className,
  ...props
}: Toolbar.Button.Props & {
  label: string;
  shortcut?: string;
  children?: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toolbar.Button
            aria-label={label}
            className={cn(
              "inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors",
              "hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
              "aria-expanded:bg-accent aria-expanded:text-foreground aria-pressed:text-brand",
              "disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-4",
              className,
            )}
            {...props}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {shortcut ? (
          <KbdGroup>
            <Kbd>{shortcut}</Kbd>
          </KbdGroup>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}
