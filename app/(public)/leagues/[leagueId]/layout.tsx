import { notFound } from "next/navigation";

import { readOrNull } from "@/components/league/convex-errors";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { fetchAuthQuery } from "@/lib/convex/server";

/**
 * League shell. The league's identity and sections live in the site nav
 * (`components/site-nav.tsx`, fed by `leagues.navContext`), so this layout only
 * guards access and frames the page.
 */
export default async function LeagueLayout({ children, params }: LayoutProps<"/leagues/[leagueId]">) {
  const { leagueId } = await params;

  // `leagues.get` runs `requireLeagueRead`: members always, spectators only on
  // public leagues. A missing or private league is a 404, as it was before.
  const view = await readOrNull(() =>
    fetchAuthQuery(api.leagues.get, { leagueId: leagueId as Id<"leagues"> }),
  );
  if (!view) notFound();

  return <div className="mx-auto max-w-7xl px-4 py-5 sm:px-6 sm:py-8">{children}</div>;
}
