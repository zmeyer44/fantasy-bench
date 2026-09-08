/**
 * Convex Auth (`@convex-dev/auth`) — email + password, per docs/CONVEX_NOTES.md §12.
 *
 * All five exports must stay public: the client calls `signIn`/`signOut` (actions),
 * `store` (mutation) and `isAuthenticated` (query) by name.
 *
 * `profile()` is where the sign-up params become the `users` document. It doubles
 * as input validation, so it is the only place that decides which params reach the
 * row: everything else on `users` is Convex Auth's own.
 *
 * Note for callers: `identity.subject` is `"<userId>|<sessionId>"`, never a user id.
 * Always resolve the viewer through `convex/lib/auth.ts` (`getAuthUserId`).
 */
import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth } from "@convex-dev/auth/server";

import type { DataModel } from "./_generated/dataModel";

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    Password<DataModel>({
      profile: (params) => ({
        email: params.email as string,
        name: params.name as string | undefined,
      }),
    }),
  ],
});
