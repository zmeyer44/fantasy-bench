type AuthErrorData = string | { code?: string; message?: string };

/** Convex action errors can cross a serialization boundary and lose class identity. */
export function authErrorData(error: unknown): AuthErrorData | undefined {
  if (!error || typeof error !== "object" || !("data" in error)) return undefined;
  const data = (error as { data?: unknown }).data;
  if (typeof data === "string") return data;
  if (!data || typeof data !== "object") return undefined;
  const { code, message } = data as { code?: unknown; message?: unknown };
  if (typeof code !== "string" && typeof message !== "string") return undefined;
  return {
    ...(typeof code === "string" ? { code } : {}),
    ...(typeof message === "string" ? { message } : {}),
  };
}

export function authErrorCode(error: unknown): string | undefined {
  const data = authErrorData(error);
  if (typeof data === "object" && data.code) return data.code;
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  // Convex action errors may arrive as an Error whose message embeds the
  // serialized ConvexError data instead of retaining a `data` property.
  const match = message.match(/\b(ACCOUNT_EXISTS|RESET_THROTTLED)\b/);
  return match?.[1];
}

export function authErrorMessage(error: unknown): string | undefined {
  const data = authErrorData(error);
  return typeof data === "string" ? data : data?.message;
}
