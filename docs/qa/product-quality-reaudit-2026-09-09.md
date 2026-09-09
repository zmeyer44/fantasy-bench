# Product quality second audit — 2026-09-09

**Follow-up:** The fixes, Wednesday 7 p.m. Eastern lineup deadline, migration, and verification are recorded in [the resolution report](reaudit-fixes-2026-09-09.md). The findings below preserve the original audit evidence.

Three fresh **GPT-5.6 Sol** subagents re-tested onboarding/league management, drafts/transactions, and agent customization/community. The coordinating agent covered scoring, activity history, player scouting, navigation regressions, and integrated validation. The audit used real Chromium and the development Convex backend, plus a fresh local production frontend. Existing fixes and historical content were preserved; this pass adds tests and reports, not application fixes.

**Result: 10 confirmed findings — 3 high (P1), 6 medium (P2), and 1 low (P3).** The game-day guards exclude the Wednesday season opener, the UI can ignore newer scoring results in favor of a frozen agent snapshot, and unlocked trades leave outgoing starters credited to their former teams. The broader draft and waiver tests also exposed a scripted-agent limitation that the previous compact fixtures could not reveal.

## Confirmed findings

| Priority | ID | Reproduction and user impact | Relationship to prior fixes |
|---|---|---|---|
| P1 | REAUD-SCORE-02 | At September 9, 2026, 9 p.m. ET, scoring returns `skipped: true`; both scoring and ingestion weekday guards return false. Normal cron updates exclude the Wednesday opener. | New schedule coverage. |
| P1 | REAUD-SCORE-01 | The actual scorer persists 20 points, but list and detail continue showing the frozen snapshot's 12, even after reload. | Score freshness remains unresolved beyond NAV-01/NAV-02's week/status fixes. |
| P1 | REAUD-TXN-02 | Completing an unlocked QB swap moves roster ownership but retains both outgoing QB IDs in their former teams' starting lineups. Roster pages show Empty; actual scoring still credits the former teams 31 and 7 points in the focused regression. | New accepted-trade integration coverage; separate from intentional locked-player point retention. |
| P2 | REAUD-ONB-01 | A ninth account sees “Watch instead” on a full private-league invite; the action leads to a 404 because no spectator membership exists. | New private/full-invite edge. |
| P2 | REAUD-ONB-02 | Settings → League still calls Start the draft directly, bypassing the review added to the draft board. | **ONB-09 incompletely fixed.** |
| P2 | REAUD-TXN-01 | Standard 8-team × 15-round snake finishes with 105 agent picks and 15 system fallbacks. Late scripted picks cannot fill required K/DEF slots from their truncated candidate set. | New full-size coverage; ownership and default-lineup fixes still work. |
| P2 | REAUD-FEED-01 | Load 100 events, receive five, then receive 40 more: five previously visible arrivals disappear. The feed has 140 of 145 rows and no Show more until reload. | **NAV-10 incompletely fixed for live arrivals.** |
| P2 | REAUD-AGENT-01 | Save guidance, then Reset to default: the previous green saved toast remains although reset is unsaved. Reload restores the old guidance. | Save feedback needs to invalidate when the form becomes dirty. |
| P2 | REAUD-PLAYER-01 | At 320px, the Players table clips injury status and game time without a detail link or tooltip; “Questionable” becomes “Quest…”. | NAV-04 fixed matchup metadata, but scouting remains affected. |
| P3 | REAUD-AGENT-02 | A failed-provider trace repeats a complete diagnostic stack in both fallback and error alerts, overwhelming the useful explanation. No secret leakage was observed. | New error-presentation coverage. |

The [official Patriots schedule](https://www.patriots.com/news/patriots-announce-2026-schedule) confirms the Wednesday opener used for the calendar reproduction. The audit exercised the corresponding timestamp; it did not wait for a real game or claim an actual ingestion outage was observed live. Development ingestion is intentionally disabled, so its calendar defect was isolated through the exported guard as well as source inspection.

## Evidence and detailed reproduction

- [Scoring, calendar, history, and scouting](reaudit-scoring-history-2026-09-09.md): actual scorer results, stable 145 → 140 feed loss, mobile injury bounds, focused calendar regressions, screenshots, and source locations.
- [Onboarding and league management](reaudit-onboarding-2026-09-09.md): three account/invite/permissions journeys, the private spectator dead end, and alternate draft-start entry point.
- [Drafts and transactions](reaudit-transactions-2026-09-09.md): all 120 draft windows, exact rejected late-pick trace, all eight final rosters, conflicting waivers, following lineups, and trade coverage.
- [Auction follow-up](reaudit-auction-2026-09-09.md): 16 real lots, availability after each award, sealed-bid privacy, exact budget transitions, complete rosters, and browser proof of the alternate start-button bypass.
- [Agent configuration and community](reaudit-agents-community-2026-09-09.md): regular-owner edits, cross-team privacy, save/reset/reload proof, budgets, traces/export, voting, and two-viewer moderation.

## What remains corrected

The second pass verified normalized login/signup, duplicate-account feedback, safe return URLs, logout, invite rotation and repeated redemption, settings persistence, owner assignment/reassignment, and live revocation of the old owner's editing controls. Public/private permission states remained readable and non-leaking.

The standard snake draft produced 120 unique rostered players. Despite the 15 late scripted failures, **all eight teams received 15-player rosters and nine populated starters**. Sixteen competing waiver claims produced two wins and fourteen losses; only the winning team spent FAAB. The following lineup window again left all eight teams with nine starters and no incomplete-lineup outcome. This materially expands the previous two-player fixture coverage.

A fixture-assisted trade used real run/window contexts and normal guarded mutations on the development backend. Proposal → counter → accept → fairness review → completion transferred both players correctly and persisted through browser reload. The completed event explicitly recorded no locked players. The defect above concerns the starting lineups left behind after that otherwise successful transfer. This verifies the transaction machinery; the deterministic scripted model itself rejected or left pending its live incoming offers, so it does not establish realistic acceptance decisions by paid models.

The separate eight-team, two-slot auction completed **16/16 unique, non-auto, run-linked awards** at $5 each. Every team finished with two players and $190. Sealed phases exposed neither bids nor participation counts; balances changed only after resolution and awarded players disappeared from availability. This used the supported $200 starting budget. Tight-budget exhaustion and minimum-dollar reservation remain unverified.

Regular owners could save and reload their own agent configuration while other teams' cooling configurations remained private. Pending versions were promoted with the existing unlock helper; the next real forum run consumed the recognizable promoted context and configuration, with `mock/scripted` and zero cost. Older immutable versions remained in history. Default/custom tool persistence, config history/comparison, local draft recovery, provider URL validation, budget bounds, traces, and redacted export passed. Votes persisted and reversed correctly; hiding and restoring a post updated an already-open spectator view.

The three existing desktop/mobile navigation journeys passed again: home, standings, matchup lists/details/week selection, teams, Commons filters/Markdown, Negotiations, static pagination beyond 100 events, invalid links, active mobile tabs, and the mobile matchup summary. This does not mean every earlier finding was independently re-created: fresh recap generation and real email recovery remain separately bounded.

## Validation and interpretation

- Final full unit/function/component suite: **649 passed, 3 failed, 652 total across 53 files**. The original 649 tests remain green.
- Added scoring regressions: **2 calendar failures**, each receiving false for the official Wednesday opening-night timestamp, and **1 unlocked-trade failure**, receiving former-team scores 31/7 instead of 0/0. These tests assert desired behavior and are intentionally left failing pending fixes.
- New scoring/history/scouting Chromium regressions: **3 failures** with persisted backend or measured-layout evidence. History was repeated after waiting for visibility subscriptions, ruling out a transient loading measurement.
- Full-size draft regression: completed all 120 windows, then failed the no-fallback assertion with 105 agent picks and 15 system picks.
- Existing navigation: **3 production Chromium journeys passed**; onboarding: **3 passed**; agent/community including promotion: **5 passed**; post-draft transaction continuation: **1 passed**; deployed assisted trade verification: **1 passed**; production 16-lot auction: **1 passed**.
- Fresh webpack production build passed; TypeScript passed. ESLint found no errors. The existing anonymous-default-export warning in `convex/auth.config.ts` remains.

Some audit journeys assert and record the current broken state to preserve evidence, so their passing runner status is not a claim that the flow has no findings. The baseline suite was green before adding the three scoring regressions; a current full test command includes those new failures. All browser captures were opened and visually reviewed by the responsible agent. Full-page captures can place sticky navigation partway down a long image; that capture artifact is excluded from findings.

## Environment and limits

The temporary production test server was stopped after verification; the existing development server was left running. The isolated production copy initially omitted `proxy.ts`. This caused authentication failures on port 3301 while port 3000 worked; the copy was rebuilt with the middleware before production validation. That harness mistake is excluded from application findings.

Fixtures were disposable and existing Demo data stayed read-only. Scoring fixtures used isolated season 2097 statistics so current-season player data was not changed. Backend clock/window acceleration is identified in the area reports; it is separate from testing model decision quality. One early promotion fixture accidentally retained a default Claude configuration and made an unauthenticated gateway attempt; it failed before paid model work and recorded no spend. Subsequent windows were gated on verifying all eight actual configurations as `mock/scripted`. No email was sent and password recovery remains blocked on the previously documented sender/provider setup. Non-Chromium browsers, physical devices, provider outages with valid paid credentials, and real game-time data ingestion remain outside this audit. These results do not certify competitor parity.
