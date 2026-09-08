"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";

import { auth } from "@/lib/auth/server";

/**
 * Server action logout. `nextCookies()` forwards the cleared session cookie.
 * `redirect()` throws, so it must be the last statement and outside try/catch.
 */
export async function logoutAction() {
  await auth.api.signOut({ headers: await headers() });
  redirect("/");
}
