/** Tiny classnames joiner. No dependency, no variance API — keep it boring. */
export type ClassValue = string | number | false | null | undefined;

export function cn(...values: ClassValue[]): string {
  return values.filter(Boolean).join(" ");
}
