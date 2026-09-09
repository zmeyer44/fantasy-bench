// @vitest-environment node
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildWebTools, fetchHtml, WEB_FETCH_MAX_BYTES, WEB_FETCH_TIMEOUT_MS } from "./tools/web_fetch";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("web_fetch", () => {
  it("executes GET, follows redirects and preserves raw HTML through the built tool", async () => {
    const html = '<!doctype html>\n<html><script>doNotExecute()</script><body> café &amp; </body></html>\n';
    const requests: Array<{ method: string | undefined; url: string | undefined }> = [];
    const server = createServer((req, res) => {
      requests.push({ method: req.method, url: req.url });
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "/page?q=1" }).end();
      } else {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing server address");
      const origin = `http://127.0.0.1:${address.port}`;
      const tool = buildWebTools().web_fetch;
      const result = await tool.execute!({ url: `${origin}/redirect` }, {
        toolCallId: "fetch-page",
        messages: [],
        context: undefined as never,
      });
      expect(result).toEqual({
        ok: true,
        url: `${origin}/page?q=1`,
        status: 200,
        contentType: "text/html; charset=utf-8",
        html,
        untrusted: true,
      });
      expect(requests).toEqual([
        { method: "GET", url: "/redirect" },
        { method: "GET", url: "/page?q=1" },
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("returns the raw error page and HTTP status for a failed HTTP response", async () => {
    const html = "<html><h1>Not found</h1></html>";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(html, { status: 404 })));
    expect(await fetchHtml("https://example.com/missing")).toMatchObject({
      ok: false,
      status: 404,
      html,
      errors: ["The URL returned HTTP 404."],
    });
  });

  it.each(["not a url", "file:///etc/passwd", "data:text/html,hello", "https://user:secret@example.com"])(
    "rejects an invalid or unsupported URL before fetching: %s", async (url) => {
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      expect(await fetchHtml(url)).toMatchObject({ ok: false, errors: [expect.any(String)] });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("decodes UTF-8 split across chunks without changing the HTML", async () => {
    const bytes = new TextEncoder().encode("<p>é</p>");
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, 4));
        controller.enqueue(bytes.slice(4));
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
    expect(await fetchHtml("https://example.com")).toMatchObject({ ok: true, html: "<p>é</p>" });
  });

  it("enforces the byte limit on a stream without content-length and cancels it", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) {
        // Fewer than 256K characters, but more than 256 KiB of UTF-8 bytes.
        controller.enqueue(new TextEncoder().encode("é".repeat(WEB_FETCH_MAX_BYTES / 2 + 1)));
      },
      cancel,
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
    expect(await fetchHtml("https://example.com")).toMatchObject({
      ok: false,
      errors: [expect.stringContaining("byte limit")],
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("aborts stalled requests at the timeout", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url, options) => {
      signal = options.signal;
      return new Promise((_resolve, reject) => {
        signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }));
    const result = fetchHtml("https://example.com");
    await vi.advanceTimersByTimeAsync(WEB_FETCH_TIMEOUT_MS);
    expect(await result).toEqual({ ok: false, errors: ["Web fetch timed out after 10s."] });
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a fetch when the enclosing run stops", async () => {
    vi.stubGlobal("fetch", vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })));
    const controller = new AbortController();
    const result = fetchHtml("https://example.com", controller.signal);
    controller.abort();
    expect(await result).toEqual({ ok: false, errors: ["Web fetch was cancelled because the run stopped."] });
  });

  it("returns network errors to the model", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection failed")));
    expect(await fetchHtml("https://example.com")).toEqual({
      ok: false,
      errors: ["Web fetch failed: connection failed"],
    });
  });
});
