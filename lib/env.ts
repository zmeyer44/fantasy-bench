import { z } from "zod";

/**
 * Zod-validated environment accessor.
 *
 * Server code should import `env`. Anything reachable from a client bundle must
 * only ever read `NEXT_PUBLIC_*` values, which are inlined at build time and so
 * are read explicitly below rather than off a dynamic key.
 */
const serverSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  BETTER_AUTH_SECRET: z.string().min(1).default("dev-secret-change-me"),
  BETTER_AUTH_URL: z.string().default("http://localhost:3000"),
  NEXT_PUBLIC_APP_URL: z.string().default("http://localhost:3000"),
  AI_GATEWAY_API_KEY: z.string().optional(),
  CRON_SECRET: z.string().default("dev-cron-secret"),
  INTERNAL_SECRET: z.string().default("dev-internal-secret"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type Env = z.infer<typeof serverSchema>;

function emptyToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

let cached: Env | null = null;

/** Parse and cache process.env. Throws with a readable message on first use. */
export function getEnv(): Env {
  if (cached) return cached;
  const parsed = serverSchema.safeParse({
    DATABASE_URL: emptyToUndefined(process.env.DATABASE_URL),
    BETTER_AUTH_SECRET: emptyToUndefined(process.env.BETTER_AUTH_SECRET),
    BETTER_AUTH_URL: emptyToUndefined(process.env.BETTER_AUTH_URL),
    NEXT_PUBLIC_APP_URL: emptyToUndefined(process.env.NEXT_PUBLIC_APP_URL),
    AI_GATEWAY_API_KEY: emptyToUndefined(process.env.AI_GATEWAY_API_KEY),
    CRON_SECRET: emptyToUndefined(process.env.CRON_SECRET),
    INTERNAL_SECRET: emptyToUndefined(process.env.INTERNAL_SECRET),
    NODE_ENV: emptyToUndefined(process.env.NODE_ENV),
  });
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment variables:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/**
 * Lazy proxy so importing this module never throws at import time (which would
 * break `next build` for pages that do not touch the database).
 */
export const env: Env = new Proxy({} as Env, {
  get(_target, prop: string) {
    return getEnv()[prop as keyof Env];
  },
  has(_target, prop: string) {
    return prop in getEnv();
  },
  ownKeys() {
    return Reflect.ownKeys(getEnv());
  },
  getOwnPropertyDescriptor(_target, prop) {
    return { ...Object.getOwnPropertyDescriptor(getEnv(), prop), configurable: true };
  },
});

/** Safe on the client: Next inlines `process.env.NEXT_PUBLIC_APP_URL` at build. */
export const publicEnv = {
  appUrl: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
} as const;
