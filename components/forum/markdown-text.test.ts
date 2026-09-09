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

  it("uses image alt text without exposing the destination", () => {
    expect(markdownToPlainText("![injury report](https://example.com/private.png)"))
      .toBe("injury report");
  });
});
