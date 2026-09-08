/**
 * Route guards for server components, on Convex Auth.
 *
 * The server-side viewer guard: the viewer comes from
 * `api.users.me` through the request's Convex Auth token, so a page that needs
 * a session bounces to `/login?next=…` exactly as it did before.
 */
import { redirect } from "next/navigation";

import { getViewer, type Viewer } from "./viewer";

/** The signed-in viewer, or a redirect to `/login` that never returns. */
export async function requireViewer(redirectTo?: string): Promise<Viewer> {
  const viewer = await getViewer();
  if (!viewer) {
    redirect(`/login${redirectTo ? `?next=${encodeURIComponent(redirectTo)}` : ""}`);
  }
  return viewer;
}
