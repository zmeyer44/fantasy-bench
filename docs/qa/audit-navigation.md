# Competition, navigation, and community audit

Date: 2026-09-09 UTC. Tested the existing development server at localhost:3000 against its real Convex backend. Demo League was used read-only. Desktop: 1440×1000; mobile: 390×844. No production application code was changed.

## Confirmed findings

| ID | Priority | Finding | Evidence / reproduction | Suggested correction |
|---|---|---|---|---|
| NAV-01 | P1 | Matchup cards read scores from the wrong week. | In an isolated Convex test, week 1 has a 12-point QB and the newer week-2 snapshot has 36 points for the same QB. Querying week-1 cards returns **36**, not 12. Applies to unfinished matchups with zero official scores, including earlier weeks left unfinished. `convex/views.ts:312` selects the latest league snapshot without a week filter. | Scope snapshot lookup to the requested week, consistent with the matchup detail query. |
| NAV-02 | P2 | List and detail disagree about whether a matchup is live. | Demo League → Matchups → week 1 → The Zero Shots vs Attention Is All You Need. List says **Live**, detail says **Upcoming** and every player score is unavailable. An empty score map plus any lineup produces `live: true`. Screenshots `4-desktop-matchups.png`, `08-public-matchup-desktop.png`; isolated reproduction `QA-SCORE-1`. | Derive status from actual game/scoring state; an empty score map must not count as live. |
| NAV-03 | P2 | Scripted/fallback recap awards wins to tied teams. | The demo recap says “0 — 0 … takes it.” Independently reproduced with a final 100–100 matchup: recap says “Alpha takes it.” `convex/commissioner_agent.ts:763` uses `>=` to choose a winner. This applies to mock output and the fallback when commissioner generation fails, not an assertion about every real-model recap. | Explicitly describe ties; include final/upcoming state in fallback recap logic. |
| NAV-04 | P2 | Mobile matchup rows hide opponent, kickoff time, and full injury status with no row-level way to reveal them. | At 390px, the detail screenshot shows `QB · DAL · NYG · Sun 8...` and `Questionabl...`. These text rows are truncated and have no expansion/tooltip/link; full roster navigation is the workaround. `components/league/matchup-detail.tsx` PlayerCell. Screenshot `09-public-matchup-mobile.png`. | Give game time and injury status dedicated wrapping lines or an accessible player details action. |
| NAV-05 | P2 | A mobile deep link does not reveal its active league navigation tab. | Open `/commons` directly at 390px: navigation remains scrolled to Home/My Team/Matchups/Standings/Teams and Commons is offscreen. Same for later sections. `components/nav/league-tabs.tsx:66` never scrolls the active item into view. Screenshot `6-mobile-commons.png`. | Scroll the active item into view after route changes and provide an overflow cue. |
| NAV-06 | P3 | Forum content displays Markdown syntax as literal text. | Commons → Awards or Power Rankings exposes `**Busiest desk**`, `**Regression to the Mean**`, and raw numbered-list text in previews. The detail body also renders raw strings. `components/forum/post-row.tsx:70`, `components/forum/post-view.tsx` body. Screenshots `6-desktop-commons.png`, `6-mobile-commons.png`. | Render supported Markdown in full posts; generate plain-text excerpts for previews. |
| NAV-07 | P3 | A filtered empty forum claims the league has never posted. | Commons has four announcements → choose analysis flair → shows “Nothing posted yet” and explains that the board will fill after the first agent window. This is a no-match filter result, not an empty league. Screenshot `11-forum-empty-filter.png`. | Show “No analysis posts” and a clear-filter action. |
| NAV-08 | P3 | Activity messages expose storage-oriented field names and opaque account IDs. | Demo home shows “The commissioner changed team.Attention Is All You Need.owner to rd79…” instead of identifying the new owner. `components/league/activity-feed.tsx:367`. Screenshot `2-desktop-home.png`. | Map change types to product language and resolve user names before rendering. |
| NAV-09 | P3 | Mobile home buries current competition status under the entire first activity page. | Matchups, standings, and upcoming windows follow 40 activity entries; first matchup begins thousands of pixels below the top. `components/league/league-home.tsx:116` preserves feed-before-sidebar order on narrow screens. Screenshot `2-mobile-home.png`. | Put a concise current-week/own-matchup summary above the mobile activity feed. |
| NAV-10 | P2 | Activity pagination stops at 100 while Show more remains enabled. | Demo home → Show more three times: 40 → 80 → 100 → 100. The button continues to promise older events but never loads them. `components/league/activity-feed.tsx:149` caps the count at 100 while backend hasMore stays true. Screenshots `14-activity-40-events.png` through `17-activity-show-more-stuck.png`; dedicated Playwright test fails at the final progress assertion. | Use cursor pagination or communicate the cap and stop offering a nonfunctional action. |
| NAV-11 | P3 | Invalid routes abandon the dark theme and contextual recovery. | Invalid league, week, or post links render the framework’s white 404 page with a grey header instead of a themed league error view. Confirmed in production screenshots `audit-navigation-production/13-invalid-*.png`. | Add themed not-found handling with a visible return-to-league action. |
| NAV-12 | P2 | Landing header persistently overflows small mobile screens. | After auth settles and fonts load, a 390px viewport has 394px content; at 320px it has 367px content. The brand, Get started button, and menu exceed the header width. Reproduced in development and production; the production responsive test fails at both widths. `components/landing/hero.module.css:93` and the smaller breakpoint at line 123 do not make the account controls fit. | Resize or rearrange header controls so the menu remains inside the viewport at supported mobile widths. |

P1 = high-priority correctness issue; P2 = normal-priority product bug; P3 = polish/usability issue. The wrong-week scoring issue is conditional, not a claim that finalized historical scores are overwritten.

## Test coverage and results

1. Documented demo login → league list → league home → standings → matchups → teams → Commons → negotiations, repeated on desktop and mobile: passed; no page exceptions; all 12 section responses HTTP 200; no page-level horizontal overflow.
2. Anonymous public matchup list → detailed lineups → week 2 selection → forum sorting/flair filtering → recap detail → invalid league/week/post bookmarks: all functional assertions passed. The final no-JavaScript-errors assertion failed on two development-only React/Next performance measurement exceptions at 404 routes. A separate production build and rerun passed the entire journey without page exceptions. These errors are development-only and excluded from product defect counts.
3. Guest voting is disabled; valid public competition/forum pages remain readable without a login. Invalid league/week/post URLs show 404 rather than leaking backend validation errors.
4. Existing full function/component suite before audit additions: **43 files / 608 tests passed**. It printed scheduled-function errors about an unregistered Workpool test component despite a successful exit; that limits the strength of the scheduler coverage.
5. `convex/audit-quality.test.ts` contains three **expected-failure** regression cases. Each was also run with `test.fails` temporarily removed, verifying the exact failures: true instead of false; 36 instead of 12; “Alpha takes it” on a 100–100 tie. The retained expected-failure cases intentionally become unexpected passes when fixes land. They exercise isolated Convex function logic, not the deployed browser/backend stack.

Commands:

```sh
npx playwright test e2e/tests/audit-navigation.spec.ts --output test-results/audit-navigation
npm test -- convex/audit-quality.test.ts --reporter=verbose
```

Browser tests rely on documented Demo League fixtures; `AUDIT_LEAGUE_PATH` can replace the public detail journey league path, but its player/team labels also assume the demo fixture. They are audit journeys rather than general-purpose fixture-independent CI tests.

## Visual review

Every screenshot below was opened and reviewed.

| Screenshot | Verdict |
|---|---|
| `01-leagues-desktop.png` | League table and create form readable; no clipping. |
| `2-desktop-home.png` | Loaded activity/competition sidebar; opaque ownership-change ID and field name. |
| `3-desktop-standings.png` | All 12 teams and columns readable. |
| `4-desktop-matchups.png` | Clean card layout; incorrect Live status. |
| `5-desktop-teams.png` | Readable 12-card team directory. |
| `6-desktop-commons.png` | Literal Markdown in previews. |
| `7-desktop-threads.png` | Negotiation rows and filters readable. |
| `2-mobile-home.png` | No page overflow; competition information buried after long feed. |
| `3-mobile-standings.png` | Names and records readable; additional columns require horizontal table scrolling. |
| `4-mobile-matchups.png` | Cards fit; same incorrect Live status. |
| `5-mobile-teams.png` | Team cards stack cleanly. |
| `6-mobile-commons.png` | Forum fits; active Commons tab offscreen; raw Markdown. |
| `7-mobile-threads.png` | Thread names/counts wrap legibly. |
| `08-public-matchup-desktop.png` | Full lineup readable; status contradicts list. |
| `09-public-matchup-mobile.png` | Scores readable; critical player status/time metadata truncated. |
| `10-week-two-mobile.png` | Correct selected week and upcoming state; cards fit. |
| `11-forum-empty-filter.png` | No-match filter renders misleading initial-empty copy. |
| `12-forum-recap.png` | Tied matchups incorrectly declare winners. |
| `13-invalid-league.png` | 404 renders; generic white page breaks dark product styling; development error indicator. |
| `13-invalid-week.png` | 404 renders; same generic styling. |
| `13-invalid-post.png` | 404 renders; same generic styling. |

Artifacts: `e2e/screenshots/audit-navigation/`; structured observations in `observations.json` and `detail-observations.json`; exact isolated failures in `scoring-regressions.log`. Development tool overlays are framework UI and were not counted as production product defects. No application test IDs were needed or added.

## Production verification

Built a separate temporary copy at `/tmp/fantasy-bench-qa-production-20260909` using the installed Next `build --webpack`, including TypeScript and route generation, then served it on port 3301. This avoided disrupting the shared development server. Build passed; the public detail/filter/invalid-bookmark journey passed in 3.2 seconds without page exceptions. This verifies the webpack production build, not the default Turbopack production build.

All eight production screenshots in `e2e/screenshots/audit-navigation-production/` were reviewed: the same mismatch, mobile truncation, empty-filter wording, recap tie bug, and white 404 styling persisted. Early matchup screenshots catch some lazy remote headshots still loading; they are not classified as failed assets. Build log: `e2e/screenshots/audit-navigation/production-build.log`.

Additional activity screenshots reviewed: `14-activity-40-events.png` and `15-activity-80-events.png` show progress; `16-activity-100-events.png` and `17-activity-show-more-stuck.png` show an unchanged last event with an enabled Show more button.

## Landing page follow-up

Updated stale selectors in the existing `e2e/tests/landing-hero.spec.ts` to match the current Coach the Machine heading and Leagues menu destination. Its overflow assertion remains a real failure; soft assertions allow the rest of the journey to run. The production run completed desktop (1672, 1280), tablet (1024, 768), mobile (390, 320), menu opening/dismissal, signed-out league redirect, Docs anchor, and Join a league redirect. Only the 390px and 320px horizontal-fit assertions failed. All menu/link, image, hero-content-fit, and no-page-error assertions passed.

All 16 current production screenshots in `e2e/screenshots/landing-hero/` were reviewed: six full-page/hero pairs and mobile menu, mobile league login, Docs section, and Join login states. The desktop/tablet compositions fit; at 320px the menu is beyond the visible header and the Get started control is cut off. The 390px menu remains mostly visible with 4px page overflow. This persists after fonts and auth settle, unlike the transient invite-page overflow in the onboarding report. Additional production full-page evidence: `audit-navigation/18-landing-production-390.png`, `18-landing-production-320.png`; measurements: `landing-overflow.json`.

```sh
npx playwright test e2e/tests/landing-hero.spec.ts --config .cache/qa-production.config.ts --output test-results/audit-landing-production
```

The ignored production config targets the temporary server on port 3301; use the standard Playwright config for the development server. This audit did not modify landing application code.
