import { toNextJsHandler } from "better-auth/next-js";

import { auth } from "@/lib/auth/server";

// better-auth mounts everything under `basePath` (default `/api/auth`).
export const { GET, POST } = toNextJsHandler(auth);
