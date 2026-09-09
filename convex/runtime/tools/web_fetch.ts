/** Live web reads. HTML is returned verbatim, without parsing or executing it. */
import { tool } from "ai";
import { z } from "zod";

import type { ToolResult } from "../types";
import { describeTool } from "./catalog";

export const WEB_FETCH_TIMEOUT_MS = 10_000;
export const WEB_FETCH_MAX_BYTES = 256 * 1024;

async function readHtml(response: Response): Promise<string> {
  const tooLarge = () => new Error(`Response exceeds the ${WEB_FETCH_MAX_BYTES}-byte limit.`);
  if (Number(response.headers.get("content-length")) > WEB_FETCH_MAX_BYTES) {
    await response.body?.cancel();
    throw tooLarge();
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let html = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return html + decoder.decode();
      bytes += value.byteLength;
      if (bytes > WEB_FETCH_MAX_BYTES) {
        await reader.cancel();
        throw tooLarge();
      }
      html += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

export async function fetchHtml(url: string, abortSignal?: AbortSignal): Promise<ToolResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
      return { ok: false, errors: ["Use an HTTP or HTTPS URL without embedded credentials."] };
    }
  } catch {
    return { ok: false, errors: ["Enter a valid HTTP or HTTPS URL."] };
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  abortSignal?.addEventListener("abort", onAbort, { once: true });
  if (abortSignal?.aborted) onAbort();
  const timer = setTimeout(onAbort, WEB_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(parsed, {
      method: "GET",
      headers: { accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8" },
      redirect: "follow",
      signal: controller.signal,
    });
    const html = await readHtml(response);
    const result = {
      url: response.url || parsed.href,
      status: response.status,
      contentType: response.headers.get("content-type"),
      html,
      untrusted: true,
    };
    return response.ok
      ? { ok: true, ...result }
      : { ok: false, ...result, errors: [`The URL returned HTTP ${response.status}.`] };
  } catch (error) {
    return {
      ok: false,
      errors: [
        controller.signal.aborted
          ? abortSignal?.aborted
            ? "Web fetch was cancelled because the run stopped."
            : `Web fetch timed out after ${WEB_FETCH_TIMEOUT_MS / 1000}s.`
          : `Web fetch failed: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  } finally {
    clearTimeout(timer);
    abortSignal?.removeEventListener("abort", onAbort);
  }
}

export function buildWebTools() {
  return {
    web_fetch: tool({
      description: describeTool("web_fetch"),
      inputSchema: z.object({
        url: z.string().url().describe("HTTP or HTTPS URL to fetch with GET."),
      }),
      execute: async ({ url }, { abortSignal }) => fetchHtml(url, abortSignal),
    }),
  };
}
