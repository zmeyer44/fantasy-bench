import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";

import { authErrorCode, authErrorMessage } from "@/lib/auth-errors";

describe("serialized auth errors", () => {
  it("reads structured data from a local ConvexError", () => {
    const error = new ConvexError({ code: "ACCOUNT_EXISTS", message: "Account exists." });
    expect(authErrorCode(error)).toBe("ACCOUNT_EXISTS");
    expect(authErrorMessage(error)).toBe("Account exists.");
  });

  it("reads data after the error has lost its class identity", () => {
    const transported = { data: { code: "RESET_THROTTLED", message: "Please wait." } };
    expect(authErrorCode(transported)).toBe("RESET_THROTTLED");
    expect(authErrorMessage(transported)).toBe("Please wait.");
  });

  it("recognizes a whitelisted code embedded in a transported Error message", () => {
    const transported = new Error(
      'Server Error: Uncaught ConvexError: {"code":"ACCOUNT_EXISTS","message":"hidden"}',
    );
    expect(authErrorCode(transported)).toBe("ACCOUNT_EXISTS");
    expect(authErrorMessage(transported)).toBeUndefined();
  });

  it("does not expose an ordinary server error message", () => {
    expect(authErrorCode(new Error("internal detail"))).toBeUndefined();
    expect(authErrorMessage(new Error("internal detail"))).toBeUndefined();
  });
});
