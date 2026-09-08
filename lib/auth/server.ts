import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";

import { db } from "@/lib/db";
import { account, session, user, verification } from "@/lib/db/schema/auth";
import { env } from "@/lib/env";

/**
 * better-auth server instance.
 *
 * The adapter looks tables up by the *keys* below (singular, `usePlural: false`)
 * and columns by their drizzle property name, so `lib/db/schema/auth.ts` must
 * keep its camelCase properties. `nextCookies()` has to be the last plugin — it
 * forwards `set-cookie` out of server actions and route handlers.
 */
export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: { user, session, account, verification },
  }),
  emailAndPassword: {
    enabled: true,
    // 8 is the library default; stated explicitly because the signup form
    // validates against the same number.
    minPasswordLength: 8,
    autoSignIn: true,
  },
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  trustedOrigins: [env.BETTER_AUTH_URL, env.NEXT_PUBLIC_APP_URL],
  plugins: [nextCookies()],
});

export type Auth = typeof auth;
export type AuthSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;
export type AuthUser = AuthSession["user"];
