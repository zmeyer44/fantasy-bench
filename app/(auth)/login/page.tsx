import { Suspense } from "react";
import type { Metadata } from "next";

import { AuthForm } from "@/components/auth-form";

export const metadata: Metadata = { title: "Log in" };

export default function LoginPage() {
  return (
    // `useSearchParams()` needs a Suspense boundary so the shell can prerender.
    <Suspense fallback={null}>
      <AuthForm mode="login" />
    </Suspense>
  );
}
