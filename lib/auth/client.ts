"use client";

import { createAuthClient } from "better-auth/react";

/**
 * Browser auth client. Same-origin by default, so `baseURL` only matters when
 * the app is served from a different host than the API.
 */
export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_APP_URL ?? undefined,
});

export const { signIn, signUp, signOut, useSession } = authClient;
