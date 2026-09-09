# Second audit: scoring, activity history, and player scouting

Date: 2026-09-09. Tested the current uncommitted fixes using a fresh local production build on port 3301 and the real development Convex backend. Application/backend source was not changed. New Playwright reproductions are in `e2e/tests/reaud-scoring-history.spec.ts`.

## REAUD-SCORE-02 — P1: game-day ingestion and scoring skip the 2026 opener

**New, time-sensitive finding.** Both scheduled pipelines hard-code Thursday, Sunday, Monday, and early Tuesday as the only NFL game days. Wednesday, Friday, and Saturday are unconditionally skipped. The [official Patriots schedule](https://www.patriots.com/news/patriots-announce-2026-schedule) confirms the 2026 season opens Wednesday, September 9. A game at that time falls outside both guards.

Direct real-backend reproduction at **September 9, 2026, 9 p.m. ET** (`2026-09-10T01:00:00.000Z`):

```sh
npx convex run season:tickAll '{"now":1789002000000}'
# { "leagues": 0, "skipped": true }
npx convex run ingest:tick '{"mode":"gameday","now":1789002000000}'
# { "scheduled": false }
```

No clock, game, provider response, or shared league was changed by these calls: both functions returned before scheduling work. The development deployment also has `INGEST_DISABLED=1`, so the ingestion return by itself does not isolate its weekday gate. Two focused tests in `convex/reaudit-calendar.test.ts` invoke the exported `isGameDayET` functions at the same timestamp: both expect true and receive false, independently confirming both guards. The production crons call these exact functions without a force override. This is backend schedule verification; it is not a claim that an actual game was live during the audit.

Source: `convex/season.ts:31`, `convex/ingest.ts:731`, and the 15-minute scoring/5-minute game-day ingestion registrations in `convex/crons.ts:31`. Normal live statistics ingestion and scoring therefore do not run during the Wednesday opener. Check actual scheduled/live game records rather than assuming a fixed weekday set, and cover nontraditional game days and overnight endings. Existing unit tests explicitly encode the narrow weekday assumption, which explains why the baseline suite passes.

## REAUD-SCORE-01 — P1: live scoreboard ignores newer scoring results

**Reopens scoring freshness coverage adjacent to NAV-01/NAV-02.** Week scoping and final-score precedence work, but an unfinished matchup prefers the frozen agent snapshot over fresh scoring output.

Reproduction (backend-assisted fixture, real browser and scorer):

1. Create an isolated public QA league, lineup, and unfinished matchup. Give its frozen snapshot a starter score of 12.
2. Open the matchup: the scoreboard correctly shows 12.
3. Supply newer player statistics worth 20 and run the actual `scoring:scoreLeague` mutation.
4. Verify `views.matchup.home.officialScore` is 20. Reload the detail and open the matchup list.
5. Both UI surfaces still display 12; the detail says “Scoring in progress” and “leads by 12.00.” The card query returns 12 as well.

The scorer updates unfinished `matchups.homeScore/awayScore` in `convex/scoring.ts:212`. The list instead selects any numeric snapshot total in `convex/views.ts:286`, and the detail does the same in `components/league/matchup-detail.tsx:41`. The season tick scores the game without rebuilding the frozen agent snapshot (`convex/season.ts:108`). Frozen agent inputs should remain immutable; the human scoreboard needs current scoring data separately.

Evidence: `e2e/screenshots/reaudit-scoring-history/01-before-score-update.png`, `02-after-score-update.png`, `03-stale-matchup-card.png`, and `scoring-observations.json`. The exact regression assertions fail: expected 20, received 12. Fixture statistics/game rows use isolated season **2097**; existing NFL player records were read only and current-season statistics were untouched. This tests score propagation, not external NFL ingestion.

## REAUD-FEED-01 — P2: events disappear after the live feed head advances

**Reopens NAV-10 beyond static pagination.** Loading all older history works, but events received afterward are not retained once they leave the first live page.

Reproduction (isolated real backend posts):

1. Open a QA league with 100 posts, numbered 0–99; click Show more twice to load all 100.
2. Add five posts 100–104. All 105 are visible, including post 100.
3. Add 40 more posts, 105–144. Wait for historical visibility subscriptions to finish revalidating.
4. The settled feed contains **140**, not 145, rows. It jumps directly from 105 to 99. Posts 100–104 have disappeared, and Show more is absent.
5. Reload and paginate again: all 145 rows are present.

Confirmed twice after explicitly waiting for the visibility queries, excluding a temporary 40-row loading state. `components/league/activity-feed.tsx:105` saves the live head into history only when Show more is clicked. Subsequent arrivals live solely in the capped 40-row head; when displaced, they were never added to history. The exhausted historical cursor also hides the recovery button (`:91`).

Evidence: screenshots `04-history-100-loaded.png` through `07-reloaded-history-restored.png`, plus `history-observations.json`. Screenshot 06 visibly shows the 105 → 99 gap; screenshot 07 shows the restored 103/102/101/100 sequence. Posts were inserted through the existing seed fixture API; there were no browser response mocks or changes to existing community content.

## REAUD-PLAYER-01 — P2: mobile scouting truncates injury status and game time

**Additional surface missed by NAV-04.** Matchup metadata wrapping is fixed, but the Players scouting table retains truncation in the only information surface available for free agents.

1. Open the existing public Demo League’s Players page, without modifying it.
2. Search for Kyle Monangai. Desktop shows “Questionable” and the full game time.
3. Set viewport to 320px. The same row displays “Quest…” and truncates the game time. There is no player detail link or title tooltip to reveal the information.

The injury span extends to x=206 while its overflow-hidden parent ends at x=186. `components/league/waivers-view.tsx:199` places the injury status inside the truncated player-name line, and `:207` truncates game metadata. These fields should remain readable at supported mobile widths.

Evidence: `08-player-desktop-injury.png`, `10-player-mobile-injury.png`, and `scouting-observations.json`. The regression assertion requires the injury span to fit and fails. Search is case/whitespace tolerant; pagination 30 → 60, position filtering, empty-result recovery, and claim activity navigation passed. This is a readability defect, not a claim execution failure.

## Regression checks that still pass

- Replayed all three existing navigation journeys on the production build: **3 passed in 13.0s**.
- Desktop/mobile home, standings, matchup lists, teams, Commons, and Negotiations; selected mobile tab visibility; no document-width overflow at 390px; current matchup above mobile activity.
- Complete static activity pagination beyond 100 events, including exhaustion.
- Public matchup detail and week selection; filtered Commons empty-state recovery; Markdown rendering; themed invalid league/week/post URLs.
- Integrated existing unit/function/component suite: **649 tests in 52 files passed** before adding the two calendar regressions. The two new calendar tests fail as documented above, so a current full `npm test` is intentionally no longer green.

All root screenshots, including failure captures, were opened and visually reviewed. Prior historical demo recaps and auto-picks were preserved; their old content is not counted as a new regression. The initial production copy briefly lacked `proxy.ts`; that harness mistake was corrected before these checks and is excluded from application findings.

To rerun the three new regression journeys, use the local production Playwright config at `.cache/qa-production.config.ts`, with one worker, tracing off, and a unique output directory. They intentionally assert the correct behavior and currently fail on the three defects above; they are not marked as expected failures or skipped.
