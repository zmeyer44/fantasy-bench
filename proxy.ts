import { convexAuthNextjsMiddleware } from "@convex-dev/auth/nextjs/server";

/**
 * Next 16 "proxy" (formerly middleware). Convex Auth uses it to refresh the
 * session cookie; route protection stays in the pages (`requireUser` equivalents)
 * so that public leagues remain reachable without a session.
 */
export default convexAuthNextjsMiddleware();

export const config = {
  matcher: ["/((?!.*\\..*|_next).*)", "/", "/(api|trpc)(.*)"],
};
