/**
 * The league navigation model, shared by the desktop tabs, the mobile tab row
 * and the drawer so the three never disagree about what a league contains.
 *
 * Twelve flat sections did not fit a 56px bar, so the read-mostly pages fold
 * into two groups: "League" (the competition itself) and "More" (the agent's
 * paper trail plus the commissioner console). `Settings` is only offered to
 * commissioners; the route itself renders a 403 for everyone else regardless.
 */

export type LeagueNavContext = {
  leagueId: string;
  isCommissioner: boolean;
  myTeamId: string | null;
};

export type LeagueNavLink = {
  href: string;
  label: string;
  active: boolean;
};

export type LeagueNavEntry =
  | ({ kind: "link" } & LeagueNavLink)
  | { kind: "group"; label: string; active: boolean; items: LeagueNavLink[] };

type Leaf = { segment: string; label: string; commissionerOnly?: boolean };

const LEAGUE_GROUP: Leaf[] = [
  { segment: "matchups", label: "Matchups" },
  { segment: "standings", label: "Standings" },
  { segment: "teams", label: "Teams" },
  { segment: "draft", label: "Draft" },
];

const MORE_GROUP: Leaf[] = [
  { segment: "traces", label: "Traces" },
  { segment: "cost", label: "Cost" },
  { segment: "settings", label: "Settings", commissionerOnly: true },
];

/** Resolve the nav for one league against the current pathname. */
export function leagueNavEntries(ctx: LeagueNavContext, pathname: string): LeagueNavEntry[] {
  const base = `/leagues/${ctx.leagueId}`;
  const myTeamHref = ctx.myTeamId ? `${base}/teams/${ctx.myTeamId}` : null;
  const onMyTeam = myTeamHref !== null && within(pathname, myTeamHref);

  const leaf = ({ segment, label }: Leaf): LeagueNavLink => {
    const href = `${base}/${segment}`;
    // The viewer's own team lives under /teams but reads as "My Team".
    const active = segment === "teams" ? within(pathname, href) && !onMyTeam : within(pathname, href);
    return { href, label, active };
  };
  const group = (label: string, leaves: Leaf[]): LeagueNavEntry => {
    const items = leaves.filter((l) => !l.commissionerOnly || ctx.isCommissioner).map(leaf);
    return { kind: "group", label, active: items.some((i) => i.active), items };
  };

  const entries: LeagueNavEntry[] = [
    { kind: "link", href: base, label: "Home", active: pathname === base },
  ];
  if (myTeamHref) entries.push({ kind: "link", href: myTeamHref, label: "My Team", active: onMyTeam });
  entries.push(
    group("League", LEAGUE_GROUP),
    { kind: "link", ...leaf({ segment: "waivers", label: "Players" }) },
    { kind: "link", ...leaf({ segment: "trades", label: "Trades" }) },
    { kind: "link", ...leaf({ segment: "commons", label: "Commons" }) },
    group("More", MORE_GROUP),
  );
  return entries;
}

/** The same nav with groups unfolded, for surfaces that scroll horizontally. */
export function flattenLeagueNav(entries: LeagueNavEntry[]): LeagueNavLink[] {
  return entries.flatMap((entry) => (entry.kind === "group" ? entry.items : [entry]));
}

/**
 * The league id in a pathname, or null when the page is not inside a league.
 * `/leagues/join/...` is the invite flow, not a league.
 */
export function leagueIdFromPathname(pathname: string): string | null {
  const match = /^\/leagues\/([^/]+)/.exec(pathname);
  if (!match || match[1] === "join") return null;
  return match[1];
}

function within(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
