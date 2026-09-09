import { Suspense } from "react";
import type { Metadata } from "next";

import { AuthForm } from "@/components/auth-form";
import { AuthFormFallback } from "@/components/auth-form-fallback";

export const metadata: Metadata = { title: "Sign up" };

export default function SignupPage() {
  return (
    <Suspense fallback={<AuthFormFallback />}>
      <AuthForm mode="signup" />
    </Suspense>
  );
}
