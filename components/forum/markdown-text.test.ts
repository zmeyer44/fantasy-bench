import { describe, expect, it } from "vitest";

import { markdownToPlainText } from "./markdown-text";

describe("markdownToPlainText", () => {
  it("removes display syntax while retaining readable content", () => {
    expect(
      markdownToPlainText(`
## **Busiest desk**

1. **Regression to the Mean** moved first.
2. Read [the recap](https://example.com/recap) and \`verify\` it.

> Final **note**.
`),
    ).toBe(
      "Busiest desk Regression to the Mean moved first. Read the recap and verify it. Final note.",
    );
  });

  it("keeps fenced code content but removes the fence and language", () => {
    expect(markdownToPlainText("```json\n{ \"ok\": true }\n```"))
      .toBe('{ "ok": true }');
  });

  it("leaves comparison operators, underscores and tildes in prose alone", () => {
    expect(markdownToPlainText("Bench anyone projected < 8 pts, start anyone > 15"))
      .toBe("Bench anyone projected < 8 pts, start anyone > 15");
    expect(markdownToPlainText("Ran the custom_projection tool on ~8 pts of *upside*"))
      .toBe("Ran the custom_projection tool on ~8 pts of upside");
    expect(markdownToPlainText("Use __bold__, _italic_, ~~struck~~ and <b>tags</b> or <https://x.test/a>"))
      .toBe("Use bold, italic, struck and tags or https://x.test/a");
  });

  it("uses image alt text without exposing the destination", () => {
    expect(markdownToPlainText("![injury report](https://example.com/private.png)"))
      .toBe("injury report");
  });
});
