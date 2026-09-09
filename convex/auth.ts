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
import { Email } from "@convex-dev/auth/providers/Email";
import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";

import { internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import { resetRequestDecision } from "./password_reset";

/**
 * Eight digits, not six: `@convex-dev/auth` looks a submitted code up by the
 * global hash of the bare code (`authVerificationCodes.code`, `.unique()`),
 * so two outstanding codes that collide break verification for both users.
 * Eight digits keeps that one-in-a-hundred-million per pair inside a 15-minute
 * window while still being typeable from an email.
 */
export const RESET_CODE_LENGTH = 8;

function resetCode(): string {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  const span = 9 * 10 ** (RESET_CODE_LENGTH - 1);
  return String(10 ** (RESET_CODE_LENGTH - 1) + (values[0]! % span));
}

function requireResetEmailConfiguration() {
  const apiKey = process.env.AUTH_RESEND_KEY ?? process.env.RESEND_API_KEY;
  const from = process.env.AUTH_EMAIL_FROM;
  if (!apiKey || !from) {
    throw new Error("Password reset email delivery is not configured.");
  }
  return { apiKey, from };
}

const resetEmail = {
  ...Email({
    sendVerificationRequest: async ({ identifier, token }) => {
      const { apiKey, from } = requireResetEmailConfiguration();
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: [identifier],
          subject: "Your Fantasy Bench password reset code",
          text: `Your Fantasy Bench password reset code is ${token}. It expires in 15 minutes. If you did not request this, you can ignore this email.`,
          html: `<p>Your Fantasy Bench password reset code is:</p><p style="font-size:28px;font-weight:700;letter-spacing:0.18em">${token}</p><p>It expires in 15 minutes. If you did not request this, you can ignore this email.</p>`,
        }),
      });
      if (!response.ok) throw new Error("Password reset email delivery failed.");
    },
  }),
  id: "password-reset",
  name: "Fantasy Bench password reset",
  from: process.env.AUTH_EMAIL_FROM ?? "Fantasy Bench <password-reset@invalid.local>",
  maxAge: 15 * 60,
  generateVerificationToken: async () => resetCode(),
};

const basePassword = Password<DataModel>({
  reset: resetEmail,
  profile: (params) => ({
    // The wrapper below supplies either the canonical lowercase address or an
    // exact legacy provider ID after an indexed lookup.
    email: (params.email as string).trim(),
    name: params.name as string | undefined,
  }),
});
// ConvexCredentials stores its real implementation under the internal
// `options` object; the top-level `authorize` is only a materialization stub.
const baseOptions = (basePassword as typeof basePassword & {
  options: { authorize: NonNullable<typeof basePassword.authorize> };
}).options;
const baseAuthorize = baseOptions.authorize;
const password = {
  ...basePassword,
  options: {
    ...baseOptions,
    authorize: async (...args: Parameters<typeof baseAuthorize>) => {
      const [params, ctx] = args;
      const submittedEmail = String(params.email ?? "").trim();
      const email = submittedEmail.toLowerCase();
      if (params.flow === "reset") {
        // Fail consistently for every address when delivery is unavailable. Once
        // configured, unknown addresses receive the same successful public result
        // without creating a verification code or sending mail.
        requireResetEmailConfiguration();
        const attempt = await ctx.runMutation(internal.password_reset.begin, {
          email: submittedEmail,
        });
        const decision = resetRequestDecision(attempt);
        if (decision === "throttled") {
          throw new ConvexError({
            code: "RESET_THROTTLED",
            message: `Please wait ${attempt.retryAfterSeconds} seconds before requesting another code.`,
          });
        }
        if (decision === "accept-without-email") return null;
        return baseAuthorize({ ...params, email: attempt.accountEmail ?? email }, ctx);
      }
      if (params.flow === "signUp") {
        const [existingUser, existingAccount] = await Promise.all([
          ctx.runQuery(internal.users.byEmail, { email }),
          ctx.runQuery(internal.password_reset.resolveAccountEmail, { email: submittedEmail }),
        ]);
        if (existingUser || existingAccount) {
          throw new ConvexError({
            code: "ACCOUNT_EXISTS",
            message: "An account with that email already exists. Log in or reset its password.",
          });
        }
      }
      if (params.flow === "signIn" || params.flow === "reset-verification") {
        const existingAccount = await ctx.runQuery(internal.password_reset.resolveAccountEmail, {
          email: submittedEmail,
        });
        return baseAuthorize({ ...params, email: existingAccount ?? email }, ctx);
      }
      return baseAuthorize({ ...params, email }, ctx);
    },
  },
};

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [password],
});
