# Draft and transactions second audit — 2026-09-09

Fresh Chromium and real development Convex backend audit. The run created a unique public eight-team league, left the default roster at QB 1 / RB 2 / WR 2 / TE 1 / FLEX 1 / K 1 / DEF 1 / BENCH 6, and changed all eight unowned teams to `mock/scripted`. It advanced each draft window with the documented `windows:openNow` / `windows:closeNow` helpers only after the real run was terminal. Credentials remain in the ignored mode-0600 `.cache/reaud-drafts-full-fixture.json`; no Demo data, paid model, application source, deployed function, or shared fixture was changed.

## REAUD-TXN-01 — P2: default scripted agents fail 15 late standard-draft picks and require system fallback

Classification: **new coverage finding**. The earlier TXN-01 fix remains effective for current ownership: the first 104 picks completed without fallback or duplicate-player rejection, and 105 picks were agent-authored in total. The prior fixed browser regression used a two-player roster and did not reach the standard draft's kicker/defense rounds.

Reproduction:

1. Create a fresh eight-team snake league and retain the default 15-player roster.
2. Replace all eight default agents with `mock/scripted` through Settings.
3. Review and start the 120-pick draft in the UI.
4. For picks 1–120, call `windows:openNow` for `draft_pick`, wait until `terminalRunCount === runCount`, then call `windows:closeNow`.
5. Inspect the completed draft board, persisted picks, and late run traces.

Observed: the draft reached 120/120 with 120 unique players, but only 105 picks had agent run IDs. Fifteen picks were system auto-picks: overall picks **105, 106, 107, and 109–120**. They are concentrated in rounds 14–15 and comprise seven defenses and eight kickers. Pick 108 (Bhayshul Tuten, RB) was the only agent-authored pick in that span. The completed board explicitly labels the 15 fallbacks `Auto-pick` and says the best available player was selected after the clock expired.

The exact Team 1 pick-113 trace is `pd7fcmzx6cwhkadxbdz13vkvbn8e24t6`. Its `search_players` call requested free agents by projection with a limit of 50, it selected Jordan Addison (WR), and `make_draft_pick` was rejected with: **“Taking another WR leaves you unable to fill 1 required starting slot(s) with 0 pick(s) remaining.”** The run ended `partial / all_actions_rejected`; clock fallback then drafted Spencer Shrader (K). Team 1's preceding pick 112 followed the same partial/rejected pattern before the fallback drafted Los Angeles Chargers (DEF).

Cause is limited to the deterministic scripted/default-agent strategy. It requests only the top 50 projected free agents in [mock_model.ts](/Users/claudius/fantasy-bench/convex/runtime/mock_model.ts:413), then chooses the candidate with best starting coverage from that truncated list in [mock_model.ts](/Users/claudius/fantasy-bench/convex/runtime/mock_model.ts:277). Late in a standard draft, the required K/DEF candidate can fall outside those 50. The live positional validator correctly rejects a pick that makes the remaining required starter impossible in [draft.ts](/Users/claudius/fantasy-bench/convex/draft.ts:752). The clock fallback deliberately bypasses that veto to prevent a stall in [draft_progression.ts](/Users/claudius/fantasy-bench/convex/draft_progression.ts:315). This audit does not establish the same failure for other models.

Impact: standard leagues complete and receive legal rosters, but 12.5% of this draft was decided by system projection fallback rather than the configured agents, those picks have no agent trace, and team pages show partial rejected draft runs. This weakens the product's core claim that every pick links to the run that made it.

Evidence: [completed 120-pick board with 15 fallback badges](/Users/claudius/fantasy-bench/e2e/screenshots/reaudit-transactions/full-snake/04-full-draft-with-late-autopicks.png) and [Team 1 roster with two partial draft runs](/Users/claudius/fantasy-bench/e2e/screenshots/reaudit-transactions/full-snake/05-full-roster-complete-starters.png). Executable reproduction: [reaud-drafts-full.spec.ts](/Users/claudius/fantasy-bench/e2e/tests/reaud-drafts-full.spec.ts).

## REAUD-TXN-02 — P1: a completed trade silently empties both teams' active starting slots

Classification: **new fixture-driven integration finding**. The counter and acceptance were deliberately submitted through existing internal mutations because `mock/scripted` normally rejects incoming offers. They used Team 2 and Team 7's actual isolated `trade_a` run IDs, matching team/window/week context, and fresh idempotency keys. No guard was bypassed, no backend function or model was changed, and all rows belong to the disposable QA league. This proves deployed state-machine and UI behavior; it does not measure autonomous agent decision quality.

Reproduction:

1. In the disposable default-roster league, take Team 7's live proposal of Caleb Williams for Team 2's Joe Burrow.
2. Call the existing `trades:respond` internal mutation as Team 2 with its actual trade-window run context and counter with the same one-for-one terms.
3. Call `trades:respond` as Team 7 with its actual matching run context and accept the child proposal.
4. Observe fairness 0.96 and `in_review` in the browser, then call the existing `trades:processReviews` at the persisted `reviewEndsAt`.
5. Reload the completed trade and both team pages.

Observed: the real deployed backend completed the trade and moved both roster rows. Team 7 received Joe Burrow and Team 2 received Caleb Williams. On both team pages, however, the incoming quarterback appears on the bench while the active QB starter renders **Empty slot**. The append-only persisted lineups still name the traded-away players: Team 7's QB slot retains Caleb Williams's ID and Team 2's retains Joe Burrow's ID. Each page labels the historical lineup **Set by agent**, and its earlier `lineup_sun_early` run remains green **Succeeded / lineup set**. The completed trade page and timeline contain no current degraded-lineup warning or recovery disclosure.

Expected: trade completion must either preserve a legal active lineup by placing the incoming player into the outgoing player's slot, run an explicit safety fallback, or mark the lineup incomplete and disclose the required recovery. A completed transaction must not silently turn two previously populated starters into empty slots while continuing to present the prior lineup as successfully set.

Cause: `completeTrade` explicitly leaves the current week's lineup untouched in [trades.ts](/Users/claudius/fantasy-bench/convex/trades.ts:1593), then deletes and recreates only `roster_slots` in [trades.ts](/Users/claudius/fantasy-bench/convex/trades.ts:1644). Once the outgoing player is no longer on the roster, the lineup view cannot resolve that starter; the incoming player has no lineup assignment and renders on the bench. The persisted `completed` event records `lockedPlayerIds: []`, so neither player was locked and the intentional locked-player scoring policy does not apply to this fixture.

The scoring path makes the stale unlocked lineup more severe than a visual hole. `scoreLeagueWeek` reads the latest stored lineup and adds points for every starting `playerId` without checking current roster ownership in [scoring.ts](/Users/claudius/fantasy-bench/convex/scoring.ts:189). The public live-score aggregation follows the same stored-ID pattern in [views.ts](/Users/claudius/fantasy-bench/convex/views.ts:241). Therefore, until another lineup version replaces it, Team 7 can receive Caleb Williams's points after trading him away and Team 2 can receive Joe Burrow's points after trading him away, while their team pages simultaneously show empty QB slots. The focused in-memory regression completes an unlocked QB swap through the actual review processor, assigns the former starters 31 and 7 points, calls the actual scorer, and receives `{ formerA: 31, formerB: 7 }` instead of the visible-lineup-consistent `{ formerA: 0, formerB: 0 }`. Retaining locked-player scoring may be intended, but the regression also asserts the completion event's `lockedPlayerIds` is empty.

Impact: both teams lose a visible required starter immediately after a successful review transfer, while matchup scoring can credit the traded-away player to the former team. A later lineup window can repair the state, but between transfer and that window the displayed roster, active lineup, and authoritative scoring inputs disagree. This is why the finding is P1.

Evidence: [accepted counter in review](/Users/claudius/fantasy-bench/e2e/screenshots/reaudit-transactions/assisted-trade/01-counter-accepted-in-review.png), [completed after reload](/Users/claudius/fantasy-bench/e2e/screenshots/reaudit-transactions/assisted-trade/02-completed-after-reload.png), [Team 7 receives Burrow but has an empty QB](/Users/claudius/fantasy-bench/e2e/screenshots/reaudit-transactions/assisted-trade/03-team-a-roster-after-transfer.png), and [Team 2 receives Williams but has an empty QB](/Users/claudius/fantasy-bench/e2e/screenshots/reaudit-transactions/assisted-trade/04-team-b-roster-after-transfer.png). Executable verification: [reaud-transactions-assisted-trade.spec.ts](/Users/claudius/fantasy-bench/e2e/tests/reaud-transactions-assisted-trade.spec.ts).

## Verified transaction behavior

- Draft start review accurately showed Snake, eight teams, PPR, four-minute clock, `mock/scripted × 8`, and **15 per team · 120 total**.
- At pick 60, all 60 picks were agent-authored and uniquely owned. The final board contained 120 unique players: 32 QB, 26 RB, 38 WR, 8 TE, 8 K, and 8 DEF.
- Despite the late agent failures, draft finalization gave every one of the eight teams exactly 15 roster entries and nine populated required starters with `draft_default` as the source. The system fallback therefore prevented roster corruption.
- Eight agents submitted 16 legal pending waiver claims against the same two targets, demonstrating FAAB conflicts. Processing yielded two wins and 14 losses with explicit “higher bid” explanations, preserved 15-player roster capacity for every team, and reduced only Team 1 from $100 to $85 in the final persisted state.
- A following `lineup_sun_early` window finished for all eight teams. Every team retained nine populated starters, no team had a `lineup_incomplete` recent outcome, and the displayed lineup source became `agent`. This confirms the prior TXN-02 correction under the default roster shape.
- One live trade window produced eight real proposals. Scripted recipients rejected three and left five proposed. The feed and detail timeline rendered all supported stages and trace links without human proposal/accept/counter controls.
- Fixture-driven deployed counter/accept/review/transfer completed with real run-context guards and browser verification as described in REAUD-TXN-02. Separately, `convex/trades.test.ts` passed the focused **propose → counter → accept → review → complete moves the rosters** test (1 passed, 24 skipped).

## Visual review

Every meaningful screenshot was opened at original resolution. The start dialog, live board, 60-pick board, completed board, full roster, waiver feed, lineup, trade feed, and trade detail used the intended dark console layout without overlap or clipped controls. The long 120-pick board remained readable and the fallback badges were conspicuous. The waiver page clearly separated pending bids from won/lost outcomes and showed FAAB totals. The post-waiver team page showed all nine starters and six bench players. The trade detail correctly kept fairness pending until acceptance.

Screenshots: [start review](/Users/claudius/fantasy-bench/e2e/screenshots/reaudit-transactions/full-snake/01-default-start-review.png), [first pick](/Users/claudius/fantasy-bench/e2e/screenshots/reaudit-transactions/full-snake/02-first-agent-pick.png), [60 picks](/Users/claudius/fantasy-bench/e2e/screenshots/reaudit-transactions/full-snake/03-half-drafted.png), [full roster](/Users/claudius/fantasy-bench/e2e/screenshots/reaudit-transactions/full-snake/05-full-roster-complete-starters.png), [pending waivers](/Users/claudius/fantasy-bench/e2e/screenshots/reaudit-transactions/full-snake/06-default-roster-waivers-pending.png), [waiver results](/Users/claudius/fantasy-bench/e2e/screenshots/reaudit-transactions/full-snake/07-default-roster-waiver-results.png), [post-waiver lineup](/Users/claudius/fantasy-bench/e2e/screenshots/reaudit-transactions/full-snake/08-post-waiver-full-lineup.png), [trade feed](/Users/claudius/fantasy-bench/e2e/screenshots/reaudit-transactions/full-snake/09-scripted-trade-proposals-and-rejections.png), and [trade detail](/Users/claudius/fantasy-bench/e2e/screenshots/reaudit-transactions/full-snake/10-scripted-trade-detail.png).

## Validation

Post-fix verification on the development backend closed both findings. A fresh eight-team default draft completed **120/120 with 120 agent run IDs, zero automatic picks, and 120 unique players**. All eight teams had 15 roster entries and nine populated starters. The same browser journey produced 16 waiver claims, two wins and 14 losses, then retained complete lineups when the harness opened the new `lineup_weekly` window after its materialized deadline; all eight attempted writes were correctly rejected by the weekly lock and the safety fallback preserved the existing complete lineups. The focused Playwright test passed in 7.3 minutes with trace disabled; all eight new screenshots were opened and visually reviewed. A separate untouched week-2 window, before its stored Wednesday deadline, then produced eight fresh successful `lineup_set` runs and eight persisted lineups with 9/9 starters; its focused browser check passed in 23.9 seconds.

The bounded legacy trade repair inspected the existing completed fixture and wrote two corrected lineup versions before the weekly deadline. Its browser regression then passed in 4.8 seconds: Team 7's active QB was Joe Burrow, Team 2's active QB was Caleb Williams, neither former roster retained its outgoing player, neither page rendered an empty slot, and the completed review timeline survived reload. Unit regressions also cover current `processReviews` completion, scoring ownership, exact Wednesday 7:00 PM ET preservation, post-deadline preservation, and repair idempotence.

- `reaud-transactions-resume.spec.ts`: 1 Chromium test passed in 24.1 seconds with trace disabled and a unique Playwright output directory.
- `reaud-transactions-assisted-trade.spec.ts`: 1 Chromium test passed in 4.8 seconds on its repeatable completed-state verification; the first pass performed acceptance and review resolution before stopping on an overly specific message assertion, after all state transitions had succeeded.
- `reaud-drafts-full.spec.ts`: reached all 120 real windows and intentionally failed its no-fallback assertion with the 105/15 split above.
- ESLint passed for both new specs.
- TypeScript reported no errors in either new spec.
- Focused trade lifecycle integration: 1 passed, 24 skipped.
- Focused unlocked-transfer scoring regression: intentionally fails with former-team scores **31 and 7** where both transferred starters are unlocked and absent from those teams' visible rosters. The executable regression is in [trades.test.ts](/Users/claudius/fantasy-bench/convex/trades.test.ts:687).
