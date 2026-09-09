export const SECURE_CUSTOM_TOOL_URL_ERROR =
  "Enter a secure HTTPS URL without embedded credentials.";

/** Validate the endpoint before custom headers can ever be sent to it. */
export function customToolUrlError(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return SECURE_CUSTOM_TOOL_URL_ERROR;
  }

  if (
    parsed.protocol !== "https:" ||
    !parsed.hostname ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    return SECURE_CUSTOM_TOOL_URL_ERROR;
  }
  return null;
}
