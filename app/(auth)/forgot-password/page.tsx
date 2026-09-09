import type { Metadata } from "next";
import { Suspense } from "react";

import { AuthFormFallback } from "@/components/auth-form-fallback";
import { PasswordResetForm } from "@/components/password-reset-form";

export const metadata: Metadata = { title: "Reset password" };

export default function ForgotPasswordPage() {
  return (
    <Suspense fallback={<AuthFormFallback />}>
      <PasswordResetForm />
    </Suspense>
  );
}
