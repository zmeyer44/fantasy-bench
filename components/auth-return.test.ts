import { describe, expect, test } from "vitest";

import { authHref, normalizeReturnPath } from "@/lib/auth-return";

describe("auth return paths", () => {
  test.each([
    [null, "/leagues"],
    ["", "/leagues"],
    ["https://example.com/steal", "/leagues"],
    ["//example.com/steal", "/leagues"],
    ["javascript:alert(1)", "/leagues"],
    ["/\\example.com", "/leagues"],
    ["/leagues/join/ABCD2345?from=mail#claim", "/leagues/join/ABCD2345?from=mail#claim"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeReturnPath(input)).toBe(expected);
  });

  test("carries the normalized destination between auth routes", () => {
    expect(authHref("/signup", "/leagues/join/ABCD2345")).toBe(
      "/signup?next=%2Fleagues%2Fjoin%2FABCD2345",
    );
  });
});
