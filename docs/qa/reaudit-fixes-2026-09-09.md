# Re-audit fixes — September 9, 2026

Resolution record for the ten findings in [the second product-quality audit](product-quality-reaudit-2026-09-09.md). The original audit remains the record of the failing behavior.

| Finding | Resulting behavior | Regression coverage |
| --- | --- | --- |
| REAUD-SCORE-02 | Scoring and game-day ingestion use indexed NFL kickoff times instead of a weekday allowlist. Wednesday, Friday, Saturday, and overnight games receive the same treatment as Sunday games. | `reaudit-calendar.test.ts`, ingestion and scheduling tests |
| REAUD-SCORE-01 | Matchup cards, detail, league home, and team lineups read current weekly player stats with the same scoring calculation as the scorer. Frozen agent snapshots no longer override live scores. Zero remains valid data; final matchup totals remain authoritative. | Current-stat and zero-score tests; real browser update from 12 to 20 points |
| REAUD-TXN-02 | Completed trades reconcile unlocked starting assignments with actual roster ownership. Locked historical starters retain their points and appear in the lineup with an explanatory label. An idempotent repair handles existing stale assignments. | Trade completion, scoring, repair, kickoff, and weekly deadline tests |
| REAUD-ONB-01 | Full private invitations explain that spectator access is unavailable and omit the inaccessible Watch action. | Eight members plus a ninth visitor in the invitation browser journey |
| REAUD-ONB-02 | Settings uses the shared draft review dialog, showing current teams, roster size, scoring, models, auction budget, and scheduled start. | Settings review and auction browser journeys |
| REAUD-TXN-01 | Scripted draft agents search the required position when their remaining picks must fill missing starters, including kicker and defense. | Required-position unit tests and a fresh 120-pick draft |
| REAUD-FEED-01 | Paginated activity retains observed arrivals after they leave the 40-item live head. Historical privacy and moderation subscriptions remain active. | Real 100 → 105 → 145 event browser sequence and reload |
| REAUD-AGENT-01 | Editing or resetting tool settings clears the prior Saved confirmation. | Owner configuration browser assertions |
| REAUD-PLAYER-01 | Names, injury status, and game information wrap within a 320-pixel player row. | Desktop and mobile scouting browser journey |
| REAUD-AGENT-02 | A failed run shows one concise error, with full diagnostics available in a collapsed disclosure. | Existing failed-provider trace, collapsed and expanded |

## Wednesday roster deadline

The weekly starting lineup has a **hard deadline of Wednesday at 7 p.m. America/New_York time**. The sole default lineup window opens Wednesday at 4 p.m. and closes at 7 p.m.; submissions use the full window, without the usual ten-minute lead. Eastern daylight saving transitions are handled in calendar time.

Backend validation rejects later agent lineup submissions. Waiver/drop checks protect weekly locked players. Trades may still transfer ownership, while locked starters retain their scoring assignment for that week. A closing-window safety fallback can complete in the background after the cutoff; this does not reopen agent submissions. Draft initialization remains available while a league is still drafting.

This fixed lineup policy replaces the former Thursday/Sunday/Monday default lineup windows and cannot be moved through commissioner window overrides. Agent-configuration edit locks remain a separate setting. Settings, team pages, and the landing schedule explain the new lineup deadline.

The development migration updated **33 materialized weeks across 17 leagues**, created 33 weekly lineup windows, retired 123 superseded windows, and repaired two stale trade lineups. Completed window history was preserved. Future week rollover uses the new defaults. The Demo League's week-one submission and closing timestamps were read back as `2026-09-09T23:00:00.000Z` (Wednesday 7 p.m. EDT).

## Validation

- Full Convex/component suite: 668 tests passed across 53 files.
- TypeScript passed. ESLint has no errors and one existing anonymous-default-export warning in `convex/auth.config.ts`.
- `git diff --check` passed.
- Development Convex backend synced successfully, including the kickoff index and migration helpers.
- Fresh webpack production build passed; frontend source hashes match the workspace.
- Production Chromium navigation, scoring, feed-history, and mobile-player journeys: 6 passed. Screenshots were reviewed.
- Additional focused browser checks passed for private invitations, Settings review, deadline visibility, stale save feedback, collapsed trace diagnostics, and the complete customization/promotion journey (eight successful zero-cost runs).
- Fresh 120-pick snake draft: 120 unique, agent-authored picks; zero automatic fallbacks. All eight teams finished with 15 players and 9/9 starting slots filled.
- Following waiver flow: eight terminal runs, 16 claims, two wins and 14 losses; $15 charged to the winning team, roster limits preserved. A manually forced expired week rejected late lineup writes and retained complete starters. A fresh week-two window then produced eight successful `lineup_set` runs, zero partial runs, and eight persisted lineups with 9/9 starters. The browser verification passed in 23.9 seconds.
- Full production auction: 16 unique awards, complete rosters, and $190 remaining for each team; sealed bid privacy verified.
- Repaired historical trade: actual completed counter/accept/review fixture renders both incoming quarterbacks as starters with no empty slots; state survives reload.
- Historical locked traded starter: real browser confirms the player remains visible with the locked-for-this-week explanation and 12.5 points.
- Scheduler test cleanup now holds fake time through asynchronous work and drains in-progress functions before restoring the environment. The final suite exits successfully without teardown errors.
- Both template and enforcement tests cover daylight saving changes, including legacy week rows stored at 5 a.m. Tuesday instead of 6 a.m.

## Environment limits

Agent execution tests use `mock/scripted`; they do not measure paid-model decision quality. Development ingestion remains intentionally disabled to protect shared fixtures. Email delivery still requires the previously missing provider credentials and sender configuration. No production deployment or real email sending was performed.

Detailed execution logs, disposable fixture identifiers, and migration results are retained in the ignored `.cache` directory; screenshots are under `e2e/screenshots`.
