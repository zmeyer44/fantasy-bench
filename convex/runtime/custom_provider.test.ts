import { afterEach, describe, expect, test, vi } from "vitest";

import { callProvider } from "./tools/custom";

afterEach(() => vi.unstubAllGlobals());

describe("custom provider transport security", () => {
  test("legacy HTTP definitions fail closed before making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await callProvider(
      {
        name: "Legacy feed",
        config: {
          url: "http://provider.example/data",
          method: "GET",
          headers: { "X-API-Key": "secret" },
        },
      },
      undefined,
      () => new Date(0),
    );

    expect(result).toEqual({
      ok: false,
      errors: ['Provider "Legacy feed" must use a secure HTTPS URL.'],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("HTTPS requests refuse redirects that could forward custom headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"weather":"clear"}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await callProvider(
      {
        name: "Weather feed",
        config: {
          url: "https://provider.example/data",
          method: "GET",
          headers: { "X-API-Key": "secret" },
        },
      },
      "Boston",
      () => new Date(0),
    );

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://provider.example/data?query=Boston"),
      expect.objectContaining({
        redirect: "error",
        headers: expect.objectContaining({ "X-API-Key": "secret" }),
      }),
    );
  });
});
