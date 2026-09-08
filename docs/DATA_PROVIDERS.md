# Data providers — research & decisions (verified live 2026-09-08)

## Where this lives

The provider clients are `convex/providers/{sleeper,espn,nflverse,fantasypros}.ts` behind the
contract in `convex/providers/types.ts`; every instant they return is epoch milliseconds. The one
entry point that pulls is **`internal.ingest.pull`** (an `internalAction`, in `convex/ingest.ts`) —
`{ mode: "full" | "regular" | "gameday", season?, week?, now? }`, where `mode` selects the plan
(`planFor`). `internal.ingest.tick` is what `convex/crons.ts` calls: it evaluates the Eastern-time
guard and schedules `pull`. To pull by hand:

```bash
npx convex run ingest:pullNow '{"mode":"full"}'
```

`INGEST_DISABLED=1` on a deployment mutes every scheduled pull. `FANTASYPROS_API_KEY` enables the
fallback projection provider. Recorded responses for every endpoint below live in
`convex/providers/fixtures/` and back `convex/providers.test.ts`, so the parsers are tested with no
network.

## Decision

- **Default projections:** Sleeper undocumented projections endpoint (Rotowire-sourced). Free, keyless,
  native Sleeper IDs (100% join to `players/nfl`), precomputed `pts_ppr` / `pts_half_ppr` / `pts_std`,
  QB/RB/WR/TE/K/DEF, weeks 1–18, refreshed intraday. CDN cache `s-maxage=600` → poll no tighter than 10 min.
- **Fallback projections:** FantasyPros v2 API (`x-api-key`, $8.99/mo personal). Different signal (expert
  consensus). Map `fpid` → `mflid` → DynastyProcess crosswalk → `sleeper_id`.
- **Players / injuries / crosswalk:** `GET https://api.sleeper.app/v1/players/nfl` (14.6 MB, once daily).
  Carries `injury_status`, `injury_body_part`, `injury_notes`, `practice_participation`, `news_updated`,
  and cross IDs (`gsis_id`, `espn_id`, `yahoo_id`, `rotowire_id`, `sportradar_id`, `fantasy_data_id`).
- **News:** Sleeper has no news endpoint. Use ESPN:
  `https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries` (status, details, comments) and
  `https://site.api.espn.com/apis/site/v2/sports/football/nfl/news?limit=50`. ESPN athlete `id` is null in
  the payload — parse it from `athlete.links[].href` (`/id/4870808/`). Join to Sleeper via `espn_id`
  (~90% hit), then name+team+pos fallback; log misses.
- **Schedule / kickoff (lock times):** ESPN scoreboard gives true UTC + live status — **use for locks**:
  `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=2026&seasontype=2&week=1`
  (`"date":"2026-09-10T00:20Z"`, `status.type.name`). Season backfill from nflverse
  `https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv` (`gametime` is ET without TZ;
  localize with America/New_York; has `espn` event id column). CC-BY-4.0.
- **Actual stats:** `https://api.sleeper.com/stats/nfl/{season}/{week}?season_type=regular`
  (`category:"stat"`, same `pts_*` keys as projections). nflverse for play-by-play later.
- **Secondary crosswalk:** `https://github.com/dynastyprocess/data/raw/master/files/db_playerids.csv`
  (`sleeper_id, gsis_id, espn_id, fantasypros_id, mfl_id`, …). Never use as sole bridge.
- **Extras:** `https://api.sleeper.app/v1/state/nfl` (current week), trending adds
  `https://api.sleeper.app/v1/players/nfl/trending/add?lookback_hours=24&limit=25`, ownership
  `https://api.sleeper.com/players/nfl/research/regular/2026/1` → `{"<id>":{"owned":99.7,"started":98.8}}`.

## Projections endpoint

```
GET https://api.sleeper.com/projections/nfl/2026/1?season_type=regular
    &position[]=QB&position[]=RB&position[]=WR&position[]=TE&position[]=K&position[]=DEF
    &order_by=pts_ppr
```
Response row (trimmed):
```json
{ "player_id": "9221", "week": 1, "season": "2026", "season_type": "regular",
  "category": "proj", "company": "rotowire", "team": "DET", "opponent": "NO",
  "game_id": "202610111", "date": "2026-09-13", "last_modified": 1788874254646,
  "player": { "first_name": "Jahmyr", "last_name": "Gibbs", "position": "RB", "team": "DET",
              "injury_status": null, "years_exp": 3 },
  "stats": { "pts_ppr": 23.68, "pts_half_ppr": 21.38, "pts_std": 19.08, "rush_att": 17.29,
             "rush_yd": 90.73, "rush_td": 0.94, "rec": 4.6, "rec_tgt": 5.43, "rec_yd": 30.67,
             "rec_td": 0.22, "fum_lost": 0.09, "gp": 1.0, "adp_dd_ppr": 1.0 } }
```
DEF rows: `player_id` is the team abbreviation (`"JAX"`), stats include `pts_allow`, `sack`, `int`, `def_td`, `yds_allow`.
Do not use `?company=sportradar` (sparse).

## Normalized mapping → `player_projections`

| field | from |
|---|---|
| source | `'sleeper_rotowire'` |
| playerId | lookup `players.by_sleeperId = row.player_id` (DEF: team abbrev) |
| season, week | same |
| projectedPointsPpr / Half / Std | `stats.pts_ppr` / `stats.pts_half_ppr` / `stats.pts_std` |
| stats | whole `stats` minus `adp_dd_ppr`, `pos_adp_dd_ppr` (+ `team`, `opponent`, `game_id`) |
| effectiveAt | `last_modified` (epoch ms, verbatim) |

`player_projection_latest` carries the newest `effectiveAt` per player-week; an unchanged feed
writes nothing.

FantasyPros maps identically: `points_ppr`/`points_half`/`points` → the three columns, `stats[]` → jsonb.

## Caveats

1. **ToS:** Sleeper API is free for non-commercial use and undocumented; FantasyPros Premium is personal /
   non-commercial. Both fine for a free-to-play league; monetizing requires a commercial quote or
   SportsData.io ($99/mo, 100 calls/day). Keep the provider layer swappable (it is).
2. **Team abbreviation normalization:** nflverse `LA` = Sleeper `LAR`; ESPN `WSH` = Sleeper `WAS`;
   DynastyProcess `LVR` = `LV`. Keep one canonical team table keyed to Sleeper abbreviations.
3. **DEF has no numeric ID anywhere** — join on team abbreviation.
4. Kicker 50+ FG bucket is not projected; derive as `fgm − Σ buckets` if scoring needs it.
5. Sleeper lists 273 games vs nflverse 272 for 2026 — reconcile on ingest, prefer ESPN for kickoff.
6. Snapshot at window open using `last_modified` as `effective_at` (PRD 6.5 projection vintage pinning).

## Comparison (short)

| Provider | Cost | Auth | Projections | News/Injury | ID space |
|---|---|---|---|---|---|
| Sleeper (undoc.) | Free | none | all positions, wk 1–18 | injury fields only | Sleeper |
| FantasyPros v2 | $8.99/mo | x-api-key | all positions, weekly + ROS | news + injuries | fpid/mflid (no sleeper) |
| ESPN (undoc.) | Free | none | raw stat map, 39 MB | free injuries + news | espn id |
| SportsData.io | $99/mo | key | yes (100 calls/day) | yes | own + paid crosswalk |
| Tank01 (RapidAPI) | free 1k/mo | key | hourly | yes | has sleeperBotID |
| nflverse | Free (CC-BY) | none | none (actuals only) | injuries csv | gsis_id |
