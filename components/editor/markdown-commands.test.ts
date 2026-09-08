import { describe, expect, it } from "vitest";

import {
  caretPosition,
  continueList,
  countWords,
  diffRange,
  indentLines,
  insertBlock,
  insertCodeBlock,
  insertLink,
  setHeading,
  toggleInline,
  toggleLinePrefix,
  type EditorState,
} from "./markdown-commands";

const at = (text: string, start: number, end = start): EditorState => ({ text, start, end });

describe("toggleInline", () => {
  it("wraps a selection and selects the inner text", () => {
    const next = toggleInline(at("start the RB", 10, 12), "**");
    expect(next.text).toBe("start the **RB**");
    expect(next.text.slice(next.start, next.end)).toBe("RB");
  });

  it("unwraps when the selection is already wrapped", () => {
    const next = toggleInline(at("a **bold** word", 2, 10), "**");
    expect(next.text).toBe("a bold word");
    expect(next.text.slice(next.start, next.end)).toBe("bold");
  });

  it("unwraps when the markers sit just outside the selection", () => {
    const next = toggleInline(at("a **bold** word", 4, 8), "**");
    expect(next.text).toBe("a bold word");
  });

  it("expands to the word under the caret when nothing is selected", () => {
    const next = toggleInline(at("prefer floor", 9), "_");
    expect(next.text).toBe("prefer _floor_");
  });

  it("inserts an empty pair on whitespace", () => {
    const next = toggleInline(at("a ", 2), "`");
    expect(next.text).toBe("a ``");
    expect(next.start).toBe(3);
    expect(next.end).toBe(3);
  });
});

describe("toggleLinePrefix", () => {
  it("adds bullets to every selected line and removes them again", () => {
    const state = at("one\ntwo\nthree", 0, 13);
    const bulleted = toggleLinePrefix(state, "- ");
    expect(bulleted.text).toBe("- one\n- two\n- three");
    const back = toggleLinePrefix(bulleted, "- ");
    expect(back.text).toBe("one\ntwo\nthree");
  });

  it("numbers lines sequentially", () => {
    const next = toggleLinePrefix(at("a\nb", 0, 3), "", { ordered: true });
    expect(next.text).toBe("1. a\n2. b");
  });

  it("swaps a bullet for a task box rather than stacking markers", () => {
    const next = toggleLinePrefix(at("- read injuries", 3), "", { task: true });
    expect(next.text).toBe("- [ ] read injuries");
  });

  it("does not include the line after a selection that ends on a newline", () => {
    const next = toggleLinePrefix(at("a\nb\nc", 0, 4), "> ");
    expect(next.text).toBe("> a\n> b\nc");
  });
});

describe("setHeading", () => {
  it("sets, replaces, and clears heading levels", () => {
    const h2 = setHeading(at("Lineup", 3), 2);
    expect(h2.text).toBe("## Lineup");
    expect(h2.start).toBe(6);
    const h1 = setHeading(h2, 1);
    expect(h1.text).toBe("# Lineup");
    const cleared = setHeading(h1, 1);
    expect(cleared.text).toBe("Lineup");
  });
});

describe("indentLines", () => {
  it("indents and outdents selected lines by two spaces", () => {
    const indented = indentLines(at("a\nb", 0, 3));
    expect(indented.text).toBe("  a\n  b");
    const outdented = indentLines(indented, true);
    expect(outdented.text).toBe("a\nb");
  });
});

describe("continueList", () => {
  it("repeats a bullet", () => {
    const next = continueList(at("- one", 5));
    expect(next?.text).toBe("- one\n- ");
    expect(next?.start).toBe(8);
  });

  it("increments a numbered item and keeps task boxes unchecked", () => {
    expect(continueList(at("3. c", 4))?.text).toBe("3. c\n4. ");
    expect(continueList(at("- [x] done", 10))?.text).toBe("- [x] done\n- [ ] ");
  });

  it("ends the list on an empty item", () => {
    const next = continueList(at("- one\n- ", 8));
    expect(next?.text).toBe("- one\n");
  });

  it("does nothing outside a list", () => {
    expect(continueList(at("plain", 5))).toBeNull();
  });
});

describe("blocks", () => {
  it("pads inserted blocks with blank lines", () => {
    const next = insertBlock(at("before\nafter", 6), "---");
    expect(next.text).toBe("before\n\n---\n\nafter");
  });

  it("wraps a selection in a fenced block and keeps it selected", () => {
    const next = insertCodeBlock(at("x = 1", 0, 5), "py");
    expect(next.text).toBe("```py\nx = 1\n```");
    expect(next.text.slice(next.start, next.end)).toBe("x = 1");
  });

  it("turns a selection into link text and selects the url", () => {
    const next = insertLink(at("see docs", 4, 8));
    expect(next.text).toBe("see [docs](https://)");
    expect(next.text.slice(next.start, next.end)).toBe("https://");
  });
});

describe("metrics", () => {
  it("reports 1-based line and column", () => {
    expect(caretPosition("ab\ncd", 4)).toEqual({ line: 2, column: 2 });
  });

  it("counts words", () => {
    expect(countWords("  a b\nc ")).toBe(3);
    expect(countWords("")).toBe(0);
  });

  it("finds the minimal changed range", () => {
    expect(diffRange("hello world", "hello **big** world")).toEqual({
      from: 6,
      to: 6,
      insert: "**big** ",
    });
    expect(diffRange("aXb", "ab")).toEqual({ from: 1, to: 2, insert: "" });
  });
});
