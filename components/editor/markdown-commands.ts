/**
 * Pure text transforms behind the markdown editor's toolbar and keyboard
 * shortcuts. Each command takes the textarea's `{ text, start, end }` and
 * returns the next one; the component turns the difference into a single
 * native edit so the browser's undo stack keeps working.
 */

export type EditorState = {
  text: string;
  /** Selection start (caret when start === end). */
  start: number;
  /** Selection end. */
  end: number;
};

const LIST_MARKER = /^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\]\s+)?/;
const HEADING = /^(#{1,6})\s+/;

// ---------------------------------------------------------------- helpers

function lineStart(text: string, index: number): number {
  return text.lastIndexOf("\n", index - 1) + 1;
}

function lineEnd(text: string, index: number): number {
  const next = text.indexOf("\n", index);
  return next === -1 ? text.length : next;
}

/** The full lines touched by the selection, as one block. */
function selectedLines(state: EditorState) {
  const from = lineStart(state.text, state.start);
  // A selection ending exactly at a line start does not include that line.
  const endIndex = state.end > state.start && state.text[state.end - 1] === "\n" ? state.end - 1 : state.end;
  const to = lineEnd(state.text, endIndex);
  return { from, to, block: state.text.slice(from, to) };
}

function replaceRange(
  state: EditorState,
  from: number,
  to: number,
  insert: string,
  selection: { start: number; end: number },
): EditorState {
  return {
    text: state.text.slice(0, from) + insert + state.text.slice(to),
    start: selection.start,
    end: selection.end,
  };
}

// ---------------------------------------------------------------- inline

/**
 * Wrap the selection in `before`/`after`. If it is already wrapped (either
 * inside or immediately outside the selection) the markers are removed instead.
 * With no selection the markers are inserted around the word under the caret,
 * or around an empty span with the caret between them.
 */
export function toggleInline(state: EditorState, before: string, after = before): EditorState {
  let { start, end } = state;
  const { text } = state;

  if (start === end) {
    // Expand to the word under the caret.
    let ws = start;
    let we = end;
    while (ws > 0 && /\S/.test(text[ws - 1]) && !/[\s*_`~]/.test(text[ws - 1])) ws--;
    while (we < text.length && /\S/.test(text[we]) && !/[\s*_`~]/.test(text[we])) we++;
    start = ws;
    end = we;
  }

  const inner = text.slice(start, end);

  // Markers inside the selection: **bold** selected whole.
  if (inner.startsWith(before) && inner.endsWith(after) && inner.length >= before.length + after.length) {
    const stripped = inner.slice(before.length, inner.length - after.length);
    return replaceRange(state, start, end, stripped, { start, end: start + stripped.length });
  }
  // Markers just outside the selection: bold selected inside **|bold|**.
  if (
    text.slice(start - before.length, start) === before &&
    text.slice(end, end + after.length) === after
  ) {
    return replaceRange(state, start - before.length, end + after.length, inner, {
      start: start - before.length,
      end: start - before.length + inner.length,
    });
  }

  const wrapped = before + inner + after;
  return replaceRange(state, start, end, wrapped, {
    start: start + before.length,
    end: start + before.length + inner.length,
  });
}

export function insertLink(state: EditorState, href = "https://"): EditorState {
  const { text, start, end } = state;
  const label = text.slice(start, end);
  if (label) {
    const insert = `[${label}](${href})`;
    const urlStart = start + label.length + 3;
    return replaceRange(state, start, end, insert, { start: urlStart, end: urlStart + href.length });
  }
  const placeholder = "link text";
  const insert = `[${placeholder}](${href})`;
  return replaceRange(state, start, end, insert, { start: start + 1, end: start + 1 + placeholder.length });
}

// ---------------------------------------------------------------- lines

/**
 * Toggle a per-line prefix over every selected line. If all non-empty lines
 * already carry it, it is removed; otherwise it is added to each line.
 * `ordered` numbers the lines 1..n instead of using a fixed prefix.
 */
export function toggleLinePrefix(
  state: EditorState,
  prefix: string,
  options: { ordered?: boolean; task?: boolean } = {},
): EditorState {
  const { from, to, block } = selectedLines(state);
  const lines = block.split("\n");
  const matcher = options.ordered ? /^(\s*)\d+[.)]\s+/ : null;

  const hasPrefix = (line: string) => {
    if (options.task) return /^\s*[-*+]\s+\[[ xX]\]\s+/.test(line);
    if (matcher) return matcher.test(line);
    return line.trimStart().startsWith(prefix);
  };
  const nonEmpty = lines.filter((line) => line.trim().length > 0);
  const allHave = nonEmpty.length > 0 && nonEmpty.every(hasPrefix);

  const next = lines.map((line, i) => {
    if (allHave) {
      if (options.task) return line.replace(/^(\s*)[-*+]\s+\[[ xX]\]\s+/, "$1");
      if (matcher) return line.replace(matcher, "$1");
      const indent = line.length - line.trimStart().length;
      return line.slice(0, indent) + line.slice(indent + prefix.length);
    }
    if (line.trim().length === 0 && lines.length > 1) return line;
    // Strip any competing list/quote/heading marker before adding ours.
    const cleaned = line.replace(LIST_MARKER, "$1").replace(/^(\s*)>\s?/, "$1");
    const indent = cleaned.length - cleaned.trimStart().length;
    const marker = options.ordered ? `${i + 1}. ` : options.task ? "- [ ] " : prefix;
    return cleaned.slice(0, indent) + marker + cleaned.slice(indent);
  });

  const insert = next.join("\n");
  return replaceRange(state, from, to, insert, { start: from, end: from + insert.length });
}

/** Set (or, if already that level, clear) the heading level of the selected lines. */
export function setHeading(state: EditorState, level: 1 | 2 | 3 | 4 | 5 | 6): EditorState {
  const { from, to, block } = selectedLines(state);
  const lines = block.split("\n");
  const wanted = "#".repeat(level) + " ";
  const allAtLevel = lines.every((line) => line.startsWith(wanted));
  const next = lines.map((line) => {
    const bare = line.replace(HEADING, "");
    return allAtLevel ? bare : wanted + bare;
  });
  const insert = next.join("\n");
  const caretDelta = state.start - from;
  const shift = allAtLevel ? -wanted.length : wanted.length;
  const caret = Math.max(from, from + caretDelta + shift);
  return replaceRange(state, from, to, insert, {
    start: state.start === state.end ? caret : from,
    end: state.start === state.end ? caret : from + insert.length,
  });
}

export function indentLines(state: EditorState, outdent = false): EditorState {
  const { from, to, block } = selectedLines(state);
  const lines = block.split("\n");
  const next = lines.map((line) => (outdent ? line.replace(/^ {1,2}/, "") : "  " + line));
  const insert = next.join("\n");
  if (state.start === state.end) {
    const delta = outdent ? -(lines[0].length - next[0].length) : 2;
    const caret = Math.max(from, state.start + delta);
    return replaceRange(state, from, to, insert, { start: caret, end: caret });
  }
  return replaceRange(state, from, to, insert, { start: from, end: from + insert.length });
}

// ---------------------------------------------------------------- blocks

/** Insert `block` on its own paragraph at the caret, padded with blank lines. */
export function insertBlock(state: EditorState, block: string, select?: { start: number; end: number }): EditorState {
  const { text, start, end } = state;
  const beforeText = text.slice(0, start);
  const afterText = text.slice(end);
  const needsLeading = beforeText.length > 0 && !/\n\n$/.test(beforeText) ? (beforeText.endsWith("\n") ? "\n" : "\n\n") : "";
  const needsTrailing = afterText.length > 0 && !/^\n\n/.test(afterText) ? (afterText.startsWith("\n") ? "\n" : "\n\n") : "";
  const insert = needsLeading + block + needsTrailing;
  const blockStart = start + needsLeading.length;
  const selection = select
    ? { start: blockStart + select.start, end: blockStart + select.end }
    : { start: blockStart + block.length, end: blockStart + block.length };
  return replaceRange(state, start, end, insert, selection);
}

export function insertCodeBlock(state: EditorState, language = ""): EditorState {
  const inner = state.text.slice(state.start, state.end);
  const body = inner || "";
  const block = "```" + language + "\n" + body + "\n```";
  const innerStart = 3 + language.length + 1;
  return insertBlock(state, block, { start: innerStart, end: innerStart + body.length });
}

export function insertTable(state: EditorState): EditorState {
  const block = ["| Column | Column |", "| --- | --- |", "| cell | cell |"].join("\n");
  return insertBlock(state, block, { start: 2, end: 8 });
}

export function insertRule(state: EditorState): EditorState {
  return insertBlock(state, "---");
}

// ---------------------------------------------------------------- enter

/**
 * Continue a list on Enter: repeats the marker (incrementing numbers, keeping
 * task boxes unchecked). Pressing Enter on an empty list item ends the list.
 * Returns null when the caret is not in a list so the default newline applies.
 */
export function continueList(state: EditorState): EditorState | null {
  if (state.start !== state.end) return null;
  const { text, start } = state;
  const from = lineStart(text, start);
  const line = text.slice(from, lineEnd(text, start));
  const match = LIST_MARKER.exec(line);
  if (!match) return null;

  const [marker, indent, bullet, gap, task] = match;
  const content = line.slice(marker.length);
  if (content.trim().length === 0) {
    // Empty item: clear the marker and leave a plain line.
    return replaceRange(state, from, from + line.length, "", { start: from, end: from });
  }

  const nextBullet = /^\d+/.test(bullet)
    ? String(Number.parseInt(bullet, 10) + 1) + bullet.slice(-1)
    : bullet;
  const insert = "\n" + indent + nextBullet + gap + (task ? "[ ] " : "");
  return replaceRange(state, start, start, insert, {
    start: start + insert.length,
    end: start + insert.length,
  });
}

// ---------------------------------------------------------------- metrics

export function caretPosition(text: string, index: number): { line: number; column: number } {
  const before = text.slice(0, index);
  const line = before.split("\n").length;
  const column = index - lineStart(text, index) + 1;
  return { line, column };
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/** Common prefix/suffix of two strings: the minimal range that changed. */
export function diffRange(prev: string, next: string): { from: number; to: number; insert: string } {
  let prefix = 0;
  const max = Math.min(prev.length, next.length);
  while (prefix < max && prev[prefix] === next[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < max - prefix &&
    prev[prev.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix++;
  }
  return { from: prefix, to: prev.length - suffix, insert: next.slice(prefix, next.length - suffix) };
}
