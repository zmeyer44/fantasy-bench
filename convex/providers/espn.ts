/**
 * ESPN's undocumented site API: true UTC kickoffs (our player lock times),
 * the league-wide injury report, and news.
 *
 * Port of `lib/providers/espn.ts`; instants are epoch milliseconds (see
 * `./types`), and the article `raw` blob is dropped — `news_items` stores a
 * headline, a body and a url, and a Convex document is capped at 1 MiB.
 *
 * The athlete `id` field is null throughout these payloads — the id has to be
 * parsed out of `links[].href` (`/id/4870808/`), which is the fiddly bit
 * docs/DATA_PROVIDERS.md calls out. Join back to Sleeper via `espn_id`.
 */
import { fetchJson, num, providerLog, str, type HttpOptions } from "./http";
import { normalizeTeam, teamFromDisplayName } from "./teams";
import type { NormalizedGame, NormalizedInjury, NormalizedNews } from "./types";

export const ESPN_SOURCE = "espn";

const SITE = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";

/** `https://www.espn.com/nfl/player/_/id/4870808/jeremiyah-love` -> `4870808`. */
export function espnAthleteIdFromHref(href: string | null | undefined): string | null {
  if (!href) return null;
  const match = /\/id\/(\d+)/.exec(href);
  return match ? match[1] : null;
}

type EspnLink = { href?: string | null; rel?: string[] | null };

export function espnAthleteIdFromLinks(links: unknown): string | null {
  if (!Array.isArray(links)) {
    // News articles nest links as an object map instead of an array.
    if (links && typeof links === "object") {
      for (const value of Object.values(links as Record<string, unknown>)) {
        const found = espnAthleteIdFromLinks(value);
        if (found) return found;
        if (value && typeof value === "object" && "href" in (value as Record<string, unknown>)) {
          const id = espnAthleteIdFromHref(str((value as { href?: unknown }).href));
          if (id) return id;
        }
      }
    }
    return null;
  }
  for (const link of links as EspnLink[]) {
    const id = espnAthleteIdFromHref(str(link?.href));
    if (id) return id;
  }
  return null;
}

/** Our stable game key, independent of any provider's event id. */
export function makeGameId(season: number, week: number, away: string, home: string): string {
  return `${season}_${String(week).padStart(2, "0")}_${away}_${home}`;
}

// ------------------------------------------------------------- scoreboard

type EspnCompetitor = {
  homeAway?: string;
  score?: string | number | null;
  team?: { abbreviation?: string | null; displayName?: string | null } | null;
};
type EspnCompetition = {
  id?: string;
  date?: string;
  competitors?: EspnCompetitor[];
  status?: { type?: { name?: string; state?: string; completed?: boolean } | null } | null;
};
type EspnEvent = {
  id?: string;
  date?: string;
  week?: { number?: number } | null;
  season?: { year?: number; type?: number } | null;
  competitions?: EspnCompetition[];
  status?: { type?: { name?: string; state?: string; completed?: boolean } | null } | null;
};

export function parseScoreboard(
  payload: unknown,
  season: number,
  week: number,
): NormalizedGame[] {
  const root = payload as { events?: EspnEvent[] } | null;
  if (!root || !Array.isArray(root.events)) return [];
  const out: NormalizedGame[] = [];
  for (const event of root.events) {
    try {
      const comp = event.competitions?.[0];
      const competitors = comp?.competitors ?? [];
      const home = competitors.find((c) => c.homeAway === "home");
      const away = competitors.find((c) => c.homeAway === "away");
      const homeTeam = normalizeTeam(home?.team?.abbreviation ?? home?.team?.displayName);
      const awayTeam = normalizeTeam(away?.team?.abbreviation ?? away?.team?.displayName);
      const iso = str(comp?.date ?? event.date);
      if (!homeTeam || !awayTeam || !iso) continue;
      const kickoffAt = Date.parse(iso);
      if (Number.isNaN(kickoffAt)) continue;
      const statusType = comp?.status?.type ?? event.status?.type ?? null;
      const eventWeek = num(event.week?.number) ?? week;
      const eventSeason = num(event.season?.year) ?? season;
      out.push({
        season: eventSeason,
        week: eventWeek,
        gameId: makeGameId(eventSeason, eventWeek, awayTeam, homeTeam),
        espnId: str(event.id ?? comp?.id),
        homeTeam,
        awayTeam,
        kickoffAt,
        status: normalizeGameStatus(statusType?.name, statusType?.completed),
        homeScore: num(home?.score),
        awayScore: num(away?.score),
        source: ESPN_SOURCE,
      });
    } catch (err) {
      providerLog("espn", "skipping malformed scoreboard event", err);
    }
  }
  return out;
}

/** ESPN `STATUS_*` names collapsed to the three states the app cares about. */
export function normalizeGameStatus(name?: string | null, completed?: boolean | null): string {
  if (completed) return "final";
  switch (name) {
    case "STATUS_FINAL":
    case "STATUS_FINAL_OVERTIME":
      return "final";
    case "STATUS_IN_PROGRESS":
    case "STATUS_HALFTIME":
    case "STATUS_END_PERIOD":
      return "in_progress";
    case "STATUS_POSTPONED":
      return "postponed";
    case "STATUS_CANCELED":
      return "canceled";
    default:
      return "scheduled";
  }
}

export async function fetchScoreboard(
  season: number,
  week: number,
  opts: HttpOptions = {},
): Promise<NormalizedGame[]> {
  const payload = await fetchJson<unknown>(
    `${SITE}/scoreboard?dates=${season}&seasontype=2&week=${week}`,
    { ...opts, label: "espn" },
  );
  return parseScoreboard(payload, season, week);
}

// --------------------------------------------------------------- injuries

type EspnInjuryEntry = {
  status?: string | null;
  date?: string | null;
  shortComment?: string | null;
  longComment?: string | null;
  details?: { type?: string | null; fantasyStatus?: { description?: string | null } | null } | null;
  athlete?: {
    displayName?: string | null;
    fullName?: string | null;
    links?: unknown;
    team?: { abbreviation?: string | null } | null;
  } | null;
};

export function parseInjuries(payload: unknown, now: number = Date.now()): NormalizedInjury[] {
  const root = payload as
    | { injuries?: Array<{ displayName?: string; injuries?: EspnInjuryEntry[] }> }
    | null;
  if (!root || !Array.isArray(root.injuries)) return [];
  const out: NormalizedInjury[] = [];
  for (const group of root.injuries) {
    const groupTeam = teamFromDisplayName(group.displayName);
    for (const entry of group.injuries ?? []) {
      try {
        const playerName = str(entry.athlete?.displayName ?? entry.athlete?.fullName);
        const designation = str(entry.status);
        if (!playerName || !designation) continue;
        const dateIso = str(entry.date);
        const parsed = dateIso ? Date.parse(dateIso) : Number.NaN;
        out.push({
          espnAthleteId: espnAthleteIdFromLinks(entry.athlete?.links),
          playerName,
          nflTeam: normalizeTeam(entry.athlete?.team?.abbreviation) ?? groupTeam,
          designation,
          practiceStatus: str(entry.details?.fantasyStatus?.description),
          comment: str(entry.shortComment ?? entry.longComment),
          effectiveAt: Number.isNaN(parsed) ? now : parsed,
          source: ESPN_SOURCE,
        });
      } catch (err) {
        providerLog("espn", "skipping malformed injury entry", err);
      }
    }
  }
  return out;
}

export async function fetchInjuries(opts: HttpOptions = {}): Promise<NormalizedInjury[]> {
  return parseInjuries(
    await fetchJson<unknown>(`${SITE}/injuries`, {
      ...opts,
      label: "espn",
      timeoutMs: opts.timeoutMs ?? 30_000,
    }),
  );
}

// ------------------------------------------------------------------- news

type EspnArticle = {
  id?: number | string;
  headline?: string | null;
  description?: string | null;
  published?: string | null;
  lastModified?: string | null;
  links?: { web?: { href?: string | null } | null } | null;
  categories?: Array<{
    type?: string;
    athleteId?: number | string | null;
    athlete?: { id?: number | string | null; links?: unknown } | null;
  }> | null;
};

export function parseNews(payload: unknown): NormalizedNews[] {
  const root = payload as { articles?: EspnArticle[] } | null;
  if (!root || !Array.isArray(root.articles)) return [];
  const out: NormalizedNews[] = [];
  for (const article of root.articles) {
    try {
      const headline = str(article.headline);
      if (!headline) continue;
      const url = str(article.links?.web?.href);
      const published = str(article.published ?? article.lastModified);
      const athleteCategory = (article.categories ?? []).find((c) => c?.type === "athlete");
      const espnAthleteId =
        str(athleteCategory?.athleteId) ??
        str(athleteCategory?.athlete?.id) ??
        espnAthleteIdFromLinks(athleteCategory?.athlete?.links);
      const publishedAt = published ? Date.parse(published) : Number.NaN;
      out.push({
        externalId: str(article.id) ?? url ?? headline,
        espnAthleteId,
        headline,
        body: str(article.description),
        url,
        publishedAt: Number.isNaN(publishedAt) ? null : publishedAt,
        source: ESPN_SOURCE,
      });
    } catch (err) {
      providerLog("espn", "skipping malformed news article", err);
    }
  }
  return out;
}

export async function fetchNews(limit = 50, opts: HttpOptions = {}): Promise<NormalizedNews[]> {
  return parseNews(
    await fetchJson<unknown>(`${SITE}/news?limit=${Math.min(Math.max(limit, 1), 100)}`, {
      ...opts,
      label: "espn",
    }),
  );
}
