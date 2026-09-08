import { ConvexError } from "convex/values";

export type AppErrorCode = "UNAUTHORIZED" | "FORBIDDEN" | "NOT_FOUND" | "BAD_REQUEST" | "CONFLICT";

/** Thrown by public functions; the UI maps `code` to a message. Mirrors the tRPC error codes. */
export function appError(code: AppErrorCode, message: string): ConvexError<{ code: AppErrorCode; message: string }> {
  return new ConvexError({ code, message });
}
