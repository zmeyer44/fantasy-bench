# Compact Auction re-audit — 2026-09-09

Target: corrected production frontend at `http://localhost:3301`, real configured Convex development backend, Chromium. Audit only; no application/backend code or deployment was changed.

## Result

## Resolution follow-up

The Settings draft-start bypass was corrected after this audit. Settings now opens the shared review dialog with the current saved draft type, roster, budget, model assignments, and warnings before the final start action. The updated compact Auction spec requires this corrected behavior; the focused management journey also verifies the same shared review at the standard 15-player configuration. Evidence: [Settings review dialog](../../e2e/screenshots/reaudit-onboarding/league-01b-settings-start-review.png).

```text
reaud-onboarding-auction.spec.ts  1 passed (4.5m)
```

The passing run created a unique disposable eight-team Auction league, reduced the roster to `FLEX 1 + BENCH 1`, replaced all eight actual default configurations with `mock/scripted · v2`, and completed 16 nominations plus 16 sealed-bid windows. It used a unique Playwright output directory and `--trace=off`.

Two earlier disposable attempts were not reused. One stopped immediately after start because the test omitted the returned `paid: false` model-assignment property. The second completed all 16 lots but the test incorrectly expected `views.team` to expose `draftBudgetRemaining`; it also revealed that resolution can settle asynchronously after `windows.closeNow`, so the maintained test polls the authoritative board before checking the award. These were test-harness corrections, not product failures.

## Verified behavior

- The pre-start board reported two roster spots per team, 16 total awards, `$200` draft budget, and exactly `mock/scripted × 8` with `paid: false`.
- Settings exposed **Start the draft** with no dialog. Activating it moved directly to the started state with no confirmation. This is browser confirmation of `REAUD-ONB-02`, the incompletely fixed ONB-09 review bypass. Evidence: [direct settings start](../../e2e/screenshots/reaudit-onboarding/auction/01-settings-direct-start.png).
- Every nomination selected a player present in `waivers.available` before award and never selected any previously awarded player.
- During every bidding phase the public board reported `bidsSealed: true`; its lot object exposed no bids, amounts, bidder IDs, participation count, or submitted count.
- The board's public remaining budgets stayed unchanged while bids were sealed. After each resolution, their sum fell by exactly the `$5` winning price.
- Each resolved player disappeared from `waivers.available` immediately after the board published the award.
- All 16 picks had distinct players, a winning run, `$5` price, and `auto: false`. No duplicate award appeared in picks or team rosters.
- All eight teams finished with exactly two distinct rostered players. The tie-break distribution gave every team two wins and a final `$190` budget.
- The league reached `in_season`; the spectator board rendered `Auction complete`, `16 / 16`, all budgets, and all 16 results.
- No page exception occurred.

## Visual review

All four screenshots were opened in order:

| Screenshot | State | Verdict |
| --- | --- | --- |
| [01](../../e2e/screenshots/reaudit-onboarding/auction/01-settings-direct-start.png) | Commissioner settings before start | Functional bypass confirmed: immediate start action, no review dialog. Layout is legible. |
| [02](../../e2e/screenshots/reaudit-onboarding/auction/02-first-sealed-bid.png) | Lot 1 at 390px | Pass: player and nominator visible, participation/amounts hidden, all budgets `$200`, no resolved results. |
| [03](../../e2e/screenshots/reaudit-onboarding/auction/03-final-sealed-bid.png) | Lot 16 at 390px | Pass: 15/16, sealed final lot, 15 results, and the one-win team retains `$195` until the last award. |
| [04](../../e2e/screenshots/reaudit-onboarding/auction/04-complete-16-of-16.png) | Complete board at 390px | Pass: 16/16, complete state, 16 results, and all teams at `$190`. |

The tall mobile result list remains within the viewport width and is readable. Player/result density is high but no content overlaps or clips horizontally.

## Budget-edge limitation

The supported commissioner UI and `commissioner.updateRules` patch schema do not expose `league_rules.draftBudget`; new leagues always use the fixed `$200` default. The test therefore verifies public sealed-budget stability, exact post-award debits, and complete roster distribution at the supported default budget. It does **not** prove minimum-dollar reservation behavior under a tight `$6` budget for two slots.

An additional backend-assisted tight-budget fixture could be constructed with the existing seed helper, but it was not run in this pass. Tight-budget exhaustion, zero-dollar bids, and minimum `$1` reservation remain unverified; the passing result is limited to the supported default-budget flow.

Maintained spec: [`reaud-onboarding-auction.spec.ts`](../../e2e/tests/reaud-onboarding-auction.spec.ts).
