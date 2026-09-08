/**
 * Create demo accounts for viewing the app and assign a second owner to a team.
 *
 *   npx tsx --env-file=.env.local scripts/seed-accounts.ts
 *
 * Accounts (password `password1234` for all):
 *   demo@fantasybench.dev   — commissioner of demo-league and owner of team 1 (created by seed-convex)
 *   owner@fantasybench.dev  — owner of a second team, assigned by the commissioner (created here)
 *   fan@fantasybench.dev    — signed-in spectator with no membership (created here)
 */
import { ConvexHttpClient } from "convex/browser";

import { api } from "../convex/_generated/api";

const url = process.env.NEXT_PUBLIC_CONVEX_URL;
if (!url) throw new Error("NEXT_PUBLIC_CONVEX_URL is not set");
const PASSWORD = "password1234";

type SignInResult = { tokens?: { token: string } | null };

async function signIn(email: string, name: string): Promise<string> {
  const client = new ConvexHttpClient(url!);
  const attempt = async (flow: "signUp" | "signIn") =>
    (await client.action(api.auth.signIn, {
      provider: "password",
      params: { email, password: PASSWORD, name, flow },
    })) as SignInResult;
  let result: SignInResult;
  try {
    result = await attempt("signUp");
  } catch {
    result = await attempt("signIn");
  }
  if (!result.tokens?.token) throw new Error(`no token for ${email}`);
  return result.tokens.token;
}

async function main() {
  const anon = new ConvexHttpClient(url!);
  const league = (await anon.query(api.leagues.bySlug, { slug: "demo-league" })) as
    | { league?: { _id: string }; _id?: string }
    | null;
  const leagueId = (league?.league?._id ?? league?._id) as string | undefined;
  if (!leagueId) throw new Error("demo-league not found — run `npm run seed:convex` first");

  const demoToken = await signIn("demo@fantasybench.dev", "Demo Owner");
  const ownerToken = await signIn("owner@fantasybench.dev", "Second Owner");
  const fanToken = await signIn("fan@fantasybench.dev", "League Fan");

  const commissioner = new ConvexHttpClient(url!);
  commissioner.setAuth(demoToken);
  const teams = (await commissioner.query(api.views.teams, { leagueId: leagueId as never })) as Array<{
    id: string;
    name: string;
    ownerUserId: string | null;
  }>;
  const unowned = teams.find((t) => !t.ownerUserId);
  if (unowned) {
    await commissioner.mutation(api.commissioner.assignOwnerByEmail, {
      leagueId: leagueId as never,
      teamId: unowned.id as never,
      email: "owner@fantasybench.dev",
    });
  }
  for (const [label, token] of [
    ["demo", demoToken],
    ["owner", ownerToken],
    ["fan", fanToken],
  ] as const) {
    const c = new ConvexHttpClient(url!);
    c.setAuth(token);
    const me = (await c.query(api.users.me, {})) as {
      email: string;
      memberships: Array<{ slug: string; role: string; teamId: string | null }>;
    } | null;
    const m = me?.memberships.find((x) => x.slug === "demo-league");
    console.log(`${label.padEnd(6)} ${me?.email.padEnd(24)} role=${m?.role ?? "-"} team=${m?.teamId ?? "-"}`);
  }
  console.log(`league: ${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}/leagues/${leagueId}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
