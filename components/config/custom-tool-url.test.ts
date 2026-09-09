import { describe, expect, it } from "vitest";

import { customToolUrlError } from "@/convex/lib/custom_tool_url";

describe("customToolUrlError", () => {
  it("accepts external HTTPS endpoints", () => {
    expect(customToolUrlError("https://api.example.com/weather")).toBeNull();
    expect(customToolUrlError("  https://api.example.com/v1?q=week  ")).toBeNull();
  });

  it.each([
    "http://api.example.com/weather",
    "ftp://api.example.com/weather",
    "api.example.com/weather",
    "https://user:secret@api.example.com/weather",
    "",
  ])("rejects an unsafe endpoint: %s", (url) => {
    expect(customToolUrlError(url)).toMatch(/secure HTTPS URL/);
  });
});
