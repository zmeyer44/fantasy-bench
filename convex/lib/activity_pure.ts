/** The feed's sort key: newest first, then insertion order, then id. */
export type ActivityCursor = { at: number; order: number; id: string };

/** Shared by the server merge and the client's optimistic re-sort so pages never interleave. */
export function compareActivity(a: ActivityCursor, b: ActivityCursor): number {
  return b.at - a.at || b.order - a.order || (a.id === b.id ? 0 : a.id < b.id ? 1 : -1);
}
