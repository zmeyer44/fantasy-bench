/**
 * Mapping Convex read errors onto Next.js responses.
 *
 * `convex/lib/auth.ts` throws `ConvexError({ code, message })` — `NOT_FOUND`
 * for a missing league/team and `UNAUTHORIZED`/`FORBIDDEN` for a private league
 * a spectator may not read. The pages that used to `notFound()` on a missing
 * row (or on a non-member of a private league) keep doing exactly that.
 *
 * A route param that is not a Convex id at all (an old Postgres uuid in a
 * bookmark, say) fails argument validation before the handler runs; that is the
 * same "no such league" outcome from the reader's point of view.
 */
import { ConvexError } from "convex/values";

export type AppErrorCode = "UNAUTHORIZED" | "FORBIDDEN" | "NOT_FOUND" | "BAD_REQUEST";

/** The `code` carried by a `ConvexError` from `convex/lib/errors.ts`, if any. */
export function convexErrorCode(error: unknown): AppErrorCode | null {
  if (!(error instanceof ConvexError)) return null;
  const data = error.data as { code?: string } | string | undefined;
  const code = typeof data === "object" && data !== null ? data.code : undefined;
  return code === "UNAUTHORIZED" ||
    code === "FORBIDDEN" ||
    code === "NOT_FOUND" ||
    code === "BAD_REQUEST"
    ? code
    : null;
}

/** True when the read failed because the row is missing or unreadable. */
export function isUnreadable(error: unknown): boolean {
  const code = convexErrorCode(error);
  if (code) return code === "NOT_FOUND" || code === "FORBIDDEN" || code === "UNAUTHORIZED";
  const message = error instanceof Error ? error.message : "";
  return /ArgumentValidationError|Validator error|is not a valid|Invalid argument/i.test(message);
}

/** HTTP status for a Convex read error, for the export route handlers. */
export function statusForError(error: unknown): number {
  switch (convexErrorCode(error)) {
    case "UNAUTHORIZED":
      return 401;
    case "FORBIDDEN":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "BAD_REQUEST":
      return 400;
    default:
      return isUnreadable(error) ? 404 : 500;
  }
}

/** The message a Convex error carries, for the export route handlers. */
export function messageForError(error: unknown, fallback = "Not found"): string {
  if (error instanceof ConvexError) {
    const data = error.data as { message?: string } | string | undefined;
    if (typeof data === "string") return data;
    if (data && typeof data.message === "string") return data.message;
  }
  return fallback;
}

/**
 * Run a Convex read, returning `null` instead of throwing when the row is
 * missing or the viewer may not read it. Real errors still propagate.
 */
export async function readOrNull<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if (isUnreadable(error)) return null;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Write paths (client components)
// ---------------------------------------------------------------------------

/** One field-level complaint from a mutation, e.g. `configs.save` validation. */
export type ConvexIssue = { field: string; message: string };

/**
 * The message to show a human after a failed `useMutation(...)` call.
 *
 * Convex rethrows a server `ConvexError` on the client with its `data` intact,
 * so the `{ code, message }` payload from `convex/lib/errors.ts` is what the UI
 * renders — exactly the string the tRPC `TRPCError` used to carry. Anything else
 * (a dropped connection, a validator rejection) falls back to the raw message.
 */
export function mutationErrorMessage(
  error: unknown,
  fallback = "Something went wrong. Try again.",
): string {
  if (error instanceof ConvexError) {
    const data = error.data as { message?: unknown } | string | undefined;
    if (typeof data === "string" && data.length > 0) return data;
    if (data && typeof data === "object" && typeof data.message === "string" && data.message) {
      return data.message;
    }
  }
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

/**
 * The structured `issues` a validation error carries (`configs.save` attaches
 * one per rejected field), so a form can point at the field that failed rather
 * than only showing the joined sentence.
 */
export function mutationErrorIssues(error: unknown): ConvexIssue[] {
  if (!(error instanceof ConvexError)) return [];
  const data = error.data as { issues?: unknown } | string | undefined;
  if (!data || typeof data !== "object" || !Array.isArray(data.issues)) return [];
  return data.issues.filter(
    (issue): issue is ConvexIssue =>
      typeof issue === "object" &&
      issue !== null &&
      typeof (issue as ConvexIssue).field === "string" &&
      typeof (issue as ConvexIssue).message === "string",
  );
}
