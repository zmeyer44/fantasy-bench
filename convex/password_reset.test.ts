import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "./_generated/api";
import { resetRequestDecision } from "./password_reset";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

function newTest() {
  return convexTest(schema, modules);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("password recovery request policy", () => {
  it("accepts an unknown normalized address without scheduling email", async () => {
    const t = newTest();

    const first = await t.mutation(internal.password_reset.begin, {
      email: "  Nobody@Example.Test ",
    });
    expect(first).toMatchObject({ allowed: true, accountExists: false, retryAfterSeconds: 0 });
    expect(resetRequestDecision(first)).toBe("accept-without-email");

    const repeatedWithDifferentCase = await t.mutation(internal.password_reset.begin, {
      email: "nobody@example.test",
    });
    expect(repeatedWithDifferentCase.allowed).toBe(false);
    expect(repeatedWithDifferentCase.accountExists).toBe(false);
    expect(repeatedWithDifferentCase.retryAfterSeconds).toBeGreaterThan(0);
    expect(resetRequestDecision(repeatedWithDifferentCase)).toBe("throttled");
  });

  it("applies the same cooldown to an existing password account", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { email: "owner@example.test" });
      await ctx.db.insert("authAccounts", {
        userId,
        provider: "password",
        providerAccountId: "owner@example.test",
        secret: "test-only-hash",
      });
    });

    const first = await t.mutation(internal.password_reset.begin, {
      email: "OWNER@EXAMPLE.TEST",
    });
    expect(first).toMatchObject({ allowed: true, accountExists: true, retryAfterSeconds: 0 });
    expect(resetRequestDecision(first)).toBe("send");

    const repeated = await t.mutation(internal.password_reset.begin, {
      email: "owner@example.test",
    });
    expect(repeated.allowed).toBe(false);
    expect(repeated.accountExists).toBe(true);
    expect(resetRequestDecision(repeated)).toBe("throttled");
  });

  it("returns the same public result for known and unknown addresses", async () => {
    vi.stubEnv("AUTH_RESEND_KEY", "test-resend-key");
    vi.stubEnv("AUTH_EMAIL_FROM", "Fantasy Bench <test@example.test>");
    vi.stubEnv("SITE_URL", "http://localhost:3000");
    const send = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", send);
    const t = newTest();
    await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { email: "Known.Legacy@example.test" });
      await ctx.db.insert("authAccounts", {
        userId,
        provider: "password",
        providerAccountId: "Known.Legacy@example.test",
        secret: "test-only-hash",
      });
    });

    const unknownResult = await t.action(api.auth.signIn, {
      provider: "password",
      params: { flow: "reset", email: "unknown@example.test" },
    });
    expect(unknownResult).toEqual({ tokens: null });
    expect(send).not.toHaveBeenCalled();

    const knownResult = await t.action(api.auth.signIn, {
      provider: "password",
      params: { flow: "reset", email: "Known.Legacy@example.test" },
    });
    expect(knownResult).toEqual(unknownResult);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
