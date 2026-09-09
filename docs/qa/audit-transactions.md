# Draft and transactions audit

Date: 2026-09-09. Real Chromium against `localhost:3000` and the real development Convex backend. The audit created a unique eight-team league, changed every team to the zero-cost `mock/scripted` model through commissioner UI, and reduced the roster to one FLEX plus one BENCH so the full snake draft required 16 real agent windows. The ignored fixture contains the disposable credentials; no shared demo data was changed.

## Resolution implementation

The original evidence below is retained. TXN-01 now overlays only live roster ownership onto a reused draft snapshot before an agent reads it, keeping the shared frozen projections, injuries, and news intact. Draft finalization applies the same overlay before constructing `draft_default` lineups, so those lineups use the rosters that were actually drafted. The implementation is in [runtime/load.ts](/Users/claudius/fantasy-bench/convex/runtime/load.ts:133) and [draft.ts](/Users/claudius/fantasy-bench/convex/draft.ts:1126). Consecutive-pick and stale-finalization regressions pass in [execute.test.ts](/Users/claudius/fantasy-bench/convex/runtime/execute.test.ts) and [draft.test.ts](/Users/claudius/fantasy-bench/convex/draft.test.ts).

TXN-02 now records lineup warnings in runtime state, reports a committed lineup with empty starters as `partial / lineup_incomplete`, discloses the safety-autopilot fallback, and lets that fallback run even though `set_lineup` committed. The scripted waiver strategy also simulates each cumulative add/drop and skips a claim if it would reduce the roster's maximum starting-slot coverage; it still permits temporary empty starters and legal roster changes. Its draft strategy searches deeply enough to prefer a candidate that covers an open starter before returning to projection order. See [execute.ts](/Users/claudius/fantasy-bench/convex/runtime/execute.ts:780), [runs.ts](/Users/claudius/fantasy-bench/convex/runs.ts:1333), and [mock_model.ts](/Users/claudius/fantasy-bench/convex/runtime/mock_model.ts:224). Focused draft/transaction regressions pass 117 tests across five files.

Post-fix browser verification passed against the production build and the updated development backend. A fresh compact snake league completed 16/16 with 16 agent-authored picks, 16 trace links, no auto-picks, and a populated `draft_default` starter for every team. Team 1 then completed an agent waiver add/drop, moved from $100 to $90 FAAB, and set a complete later lineup without `lineup_incomplete`. A separate fresh compact Auction league completed all eight nomination and sealed-bid phases, resolved eight unique players at $5 each, left every team at $195, and reached `in_season`. The board exposed no bid amounts, bidder IDs, participation counts, or bid collections before resolution. The maintained assertions are in [audit-transactions-fixed-drafts.spec.ts](/Users/claudius/fantasy-bench/e2e/tests/audit-transactions-fixed-drafts.spec.ts).

## TXN-01 — P1: reused draft snapshots make agents repeatedly select an already-drafted player

Reproduction:

1. Create an eight-team snake league and assign `mock/scripted` to all teams.
2. Start the draft.
3. Open each consecutive `draft_pick` window, wait for its run to finish, and close the clock.
4. Inspect the board and the run traces.

Observed: the board reached 16/16, but only pick 1 was agent-authored. Picks 2–16 were 15 platform auto-picks and had no agent trace attached to the pick. All 16 draft windows shared one snapshot. Each of the 15 failed runs returned the same sequence: `search_players` reported Jahmyr Gibbs as a free agent with no owner, `make_draft_pick` selected him, live mutation validation returned **“That player is already drafted,”** and the run ended `partial / all_actions_rejected`. Closing the clock then applied the platform auto-pick. This was reproduced in three independent disposable leagues.

Expected: every on-time agent run sees current draft ownership and records its own available selection. Snapshot reuse may cache stable player projections, but ownership must reflect picks made since the snapshot.

Cause: draft windows deliberately reuse a ready snapshot in [windows.ts](/Users/claudius/fantasy-bench/convex/windows.ts:338); the scripted model selects the first player whose snapshot owner is null in [mock_model.ts](/Users/claudius/fantasy-bench/convex/runtime/mock_model.ts:301). The live validator correctly rejects the duplicate in [draft.ts](/Users/claudius/fantasy-bench/convex/draft.ts:574), and window close fills the unresolved pick through [draft_progression.ts](/Users/claudius/fantasy-bench/convex/draft_progression.ts:275). The default values are a 240-second pick clock and a 600,000 ms reuse period in [defaults.ts](/Users/claudius/fantasy-bench/convex/lib/defaults.ts:74), so normal timing can place multiple consecutive picks inside one stale snapshot; the accelerated QA loop amplified the result to 15 of 16.

The same snapshot also feeds draft finalization in [draft_progression.ts](/Users/claudius/fantasy-bench/convex/draft_progression.ts:102) and [draft.ts](/Users/claudius/fantasy-bench/convex/draft.ts:974). Every generated `draft_default` lineup was empty even though several teams had FLEX-eligible players. The next lineup window corrected Team 1 before waivers.

Evidence: [half-complete board](/Users/claudius/fantasy-bench/e2e/screenshots/audit-transactions/06-draft-half-complete.png), [completed board](/Users/claudius/fantasy-bench/e2e/screenshots/audit-transactions/07-draft-complete.png), and [Team 1 roster with succeeded and rejected draft runs](/Users/claudius/fantasy-bench/e2e/screenshots/audit-transactions/08-roster-after-draft.png). The executable assertions are in [audit-transactions-agent-flows.spec.ts](/Users/claudius/fantasy-bench/e2e/tests/audit-transactions-agent-flows.spec.ts:162).

## TXN-02 — P2: an empty starting lineup is reported as a successful agent lineup with no recovery signal

Reproduction:

1. In the compact FLEX + BENCH league, run the first lineup window. Team 1 starts Jahmyr Gibbs and benches Bo Nix.
2. Run the waiver window. The scripted agent submits two claims, wins Trevor Lawrence for $10 and Justin Herbert for $5, and drops both drafted players.
3. Run `lineup_sun_early` and inspect Team 1 and its trace.

Observed: waiver processing was internally consistent: Team 1 moved from $100 to $85 and its roster contained the two claimed quarterbacks. Because ordinary FLEX does not accept a quarterback, its starter became empty. The later lineup agent explicitly committed `{ slot: "FLEX", playerId: null }`; the tool accepted it with a warning, the run was labeled `succeeded / lineup_set`, and window-close safety autopilot made no change. The team page presents a green **Succeeded** status and the rationale says it started the highest-projected legal lineup, while visibly showing **Empty slot** and 0.0 projected points.

Expected: when an agent commits an empty required starter, the run should expose a degraded/partial outcome and a clear warning or recovery result. This finding does not assume that every add/drop must preserve a complete starting lineup. Empty starters can be valid temporary roster management, and this deliberately small roster had no eligible recovery player. The risk is the false success signal and the scripted strategy's failure to account for roster shape. The same strategy selects top free agents and the weakest roster players without positional checks in [mock_model.ts](/Users/claudius/fantasy-bench/convex/runtime/mock_model.ts:269).

Cause: lineup validation treats an empty starter as a warning in [lineup_pure.ts](/Users/claudius/fantasy-bench/convex/lib/lineup_pure.ts:230). A committed `set_lineup` makes the runtime successful in [execute.ts](/Users/claudius/fantasy-bench/convex/runtime/execute.ts:776), and the completion fallback exits when any `set_lineup` action committed in [runs.ts](/Users/claudius/fantasy-bench/convex/runs.ts:1350). This conflicts with the nearby fallback contract that says a lineup window must not leave an empty lineup.

Evidence: [valid pre-waiver lineup](/Users/claudius/fantasy-bench/e2e/screenshots/audit-transactions/09-agent-lineup-and-bench.png), [processed add/drop and $85 balance](/Users/claudius/fantasy-bench/e2e/screenshots/audit-transactions/12-roster-after-agent-add-drop.png), and [successful post-waiver run with an empty FLEX](/Users/claudius/fantasy-bench/e2e/screenshots/audit-transactions/13-post-waiver-lineup.png).

## Verified behavior

- League creation, roster-rule edits, all-team model replacement, draft start, and post-draft rule freezing worked through visible UI.
- The 16-pick board updated live and finished; the platform fallback prevented the stale agent picks from stalling the draft.
- Agent-only ownership was preserved: team, waiver, and trade pages exposed observability and configuration but no human add, drop, lineup, proposal, accept, reject, or counter controls.
- Eight agents submitted 16 pending waiver claims. Processing produced two wins for Team 1 and 14 losses, linked decision traces, correct two-player add/drop results, and the correct $15 FAAB deduction.
- Eight trade runs finished successfully. They created eight proposals, three of which recipients rejected during the same window, leaving five proposed. The feed, detail, negotiation links, timeline, and proposer trace rendered. The scripted model always rejects an incoming open offer in [mock_model.ts](/Users/claudius/fantasy-bench/convex/runtime/mock_model.ts:340), so this live deterministic run could not produce an acceptance.
- The complete proposal → counter → accept → fairness review → completion lifecycle passed in the in-memory Convex integration at [trades.test.ts](/Users/claudius/fantasy-bench/convex/trades.test.ts:605). It verifies `in_review`, fairness metadata, review expiry processing, both roster transfers, transaction rows, and final `completed` state. This is backend integration coverage, not live-browser acceptance coverage.
- The focused Convex transaction suite passed 54 tests across four discovered files. The isolated trade lifecycle test passed 1 test with 24 skipped. ESLint passed for both audit specs. The resumable Playwright transaction test passed in Chromium with no page exceptions.

## Limits

- Draft clocks were closed through the documented `windows:openNow` and `windows:closeNow` helpers after each real run became terminal. This exercised real snapshots, agent tools, persistence, and UI subscriptions without waiting more than an hour for 16 wall-clock expirations.
- Browser draft coverage used a legal custom two-player roster. Default full-roster correctness remains covered by the repository's backend tests rather than this browser journey.
- Live accepted/reviewed/completed trade coverage was blocked by the deterministic model's hard-coded rejection behavior. The in-memory integration covered that state machine without fabricating browser-only controls or using a paid model.
- Auction startup and bidding are covered by the onboarding audit; this report owns snake draft and transaction flows.

## Artifacts and visual review

Primary spec: [audit-transactions-agent-flows.spec.ts](/Users/claudius/fantasy-bench/e2e/tests/audit-transactions-agent-flows.spec.ts). Checkpoint spec: [audit-transactions-resume.spec.ts](/Users/claudius/fantasy-bench/e2e/tests/audit-transactions-resume.spec.ts). Both use an ignored, mode-0600 fixture and contain no fixed credentials.

Every numbered screenshot was opened at original detail:

| Screenshot | Verdict |
|---|---|
| 01 disposable league | League shell, draft CTA, and empty activity render cleanly. |
| 02 compact rules | Saved FLEX 1 / BENCH 1 controls reflect the intended fixture. |
| 03 scripted model | Replacement reports eight updated teams and the table reports Scripted Mock / 8 teams. |
| 04 draft setup | Pre-draft 0 / — state and Start action render cleanly. |
| 05 first pick | Live 0 / 16 board identifies Team 1 on the clock. |
| 06 half complete | 8 / 16 updates correctly; seven auto-pick badges expose TXN-01. |
| 07 complete | 16 / 16 and Draft complete render; 15 auto-pick badges and only one trace expose TXN-01. |
| 08 post-draft roster | Two roster players are visible; the empty draft-default FLEX and partial trace corroborate TXN-01. |
| 09 first lineup | Agent starts Jahmyr Gibbs at FLEX and benches Bo Nix with a linked trace. |
| 10 pending waivers | All 16 claims, bids, drops, budgets, pending states, and decision links render. |
| 11 processed waivers | Win/loss states and Team 1's $85 budget update render consistently. |
| 12 post-waiver roster | Team 1 owns both winning QBs; the empty FLEX begins TXN-02. |
| 13 later lineup | Green successful run remains alongside Empty slot, confirming TXN-02. |
| 14 trade feed | Five live and three rejected trade cards show both sides, state paths, and navigation. |
| 15 trade detail | Proposal, terms, fairness pending copy, timeline, negotiation, and trace links render cleanly. |
| 16 frozen rules | Frozen banner and disabled scoring/roster controls render clearly after draft. |

Screenshot directory: `/Users/claudius/fantasy-bench/e2e/screenshots/audit-transactions/`. No application code, deployed functions, environment variables, or shared fixtures were changed.

### Post-fix visual verification

Every fixed-state screenshot was opened at original resolution. The review dialogs preserve the dark console design, make the final start action explicit, and show format, scoring, team/roster counts, clock, models, Auction budget, and the unowned-team warning. The completed snake grid shows eight FLEX-eligible first-round players followed by eight quarterbacks, with a trace on every pick. Team 1's post-waiver page shows Amon-Ra St. Brown starting at FLEX, Dak Prescott on the bench, $90 FAAB, and succeeded waiver/lineup runs. The Auction board clearly separates current lot, live lot, sealed-bid privacy, team budgets, and resolved results; the final state shows 8/8 and $195 for all eight teams.

Evidence: [snake start review](/Users/claudius/fantasy-bench/e2e/screenshots/audit-transactions/fixed/snake-01-start-review.png), [snake agent completion](/Users/claudius/fantasy-bench/e2e/screenshots/audit-transactions/fixed/snake-02-agent-complete.png), [post-waiver complete lineup](/Users/claudius/fantasy-bench/e2e/screenshots/audit-transactions/fixed/snake-03-post-waiver-complete-lineup.png), [Auction start review](/Users/claudius/fantasy-bench/e2e/screenshots/audit-transactions/fixed/auction-01-start-review.png), [sealed bidding](/Users/claudius/fantasy-bench/e2e/screenshots/audit-transactions/fixed/auction-02-sealed-bidding.png), and [Auction completion](/Users/claudius/fantasy-bench/e2e/screenshots/audit-transactions/fixed/auction-03-complete.png).
