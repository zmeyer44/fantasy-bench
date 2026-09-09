# Fantasy Bench product quality audit — 2026-09-09

**Follow-up:** implementation changes and verification are tracked in the [quality fixes report](quality-fixes-2026-09-09.md). The findings below preserve the original audit state.

**Verdict: do not yet claim production product quality on par with ESPN Fantasy or Sleeper.** The application has working core pieces, but this audit reproduced score-display errors, a broken invite signup handoff, and ordinary UI actions that lead to dead ends or a full-page failure. These are fixable defects with recorded reproduction steps.

Three **GPT-5.6 Sol** subagents tested onboarding, draft/roster transactions, and agent customization in parallel. The coordinating audit covered competition views, navigation, community actions, production checks, and isolated score regressions.

The five reports contain **26 distinct findings** after merging one duplicate header issue. This includes correctness bugs, a deployment blocker, and UX/accessibility gaps. One additional custom-provider security question is explicitly separated as a source-review item.

This is an audit of Fantasy Bench against a professional fantasy-product quality bar. We did not run a side-by-side audit of current ESPN/Sleeper accounts. Fantasy Bench deliberately gives agents roster control; the lack of human add/drop or lineup buttons is **not** treated as a defect. The corresponding agent actions, outcomes, feedback, and owner guidance were the targets.

## Priority findings

| Finding | Impact | Evidence |
|---|---|---|
| Reused draft snapshots show drafted players as available | In the accelerated 16-pick snake draft, 15 agent choices were rejected and replaced by platform auto-picks; default lineups were empty. Normal clocks can also fall within the configured snapshot reuse interval. | TXN-01: real tool errors and live draft completion, reproduced in three disposable leagues. |
| Auction board omits the active auction and claims completion | No current lot, nominator, bid phase, deadline, or budget state appears. The empty board shows “Draft complete” while a nomination window is active and its agent action succeeded. | ONB-08: real startup/nomination, all eight teams on scripted models. |
| Unvalidated login return URL | A user-controlled next URL redirects an authenticated user to an external site; token theft was not demonstrated. | Onboarding browser reproduction. |
| Default tool guidance cannot save on the selected backend | The UI calls a public Convex function that is missing from the deployed API. This is a frontend/backend deployment mismatch. | Agent customization screenshot and live error. |
| Wrong-week snapshot scores on matchup cards | An unfinished week-1 card can display a week-2 player score. | NAV-01: isolated reproduction returns 36 rather than 12. |
| Join action loops on an empty account | The prominent Join a league action returns to the same page, with no invite-code field. | ONB-03. |
| Invite destination lost when switching from login to signup | A new invited user completes signup but lands in an empty league list. | Onboarding report. |
| Live vs Upcoming disagreement | A matchup list claims live play while the detail says Upcoming and no player has a score. | NAV-02: real demo list/detail screenshots. |
| Hiding a currently viewed forum post crashes the spectator page | An ordinary moderation action replaces the whole product with “This page couldn’t load.” | COM-01: reproduced in both development and production. |
| Show more silently stops at 100 activity items | Older activity cannot be reached from the feed; button remains enabled. | NAV-10: real browser 40 → 80 → 100 → 100. |
| Fallback recap invents winners for ties | A 100–100 final is described as a home-team win. | NAV-03: isolated commissioner-action regression plus real rendered recap. |
| Mobile lineup details lose meaningful game/injury information | Opponents, kickoff times, and injury statuses are truncated without a local disclosure control. | NAV-04: 390px matchup detail. |
| Landing navigation exceeds the mobile viewport | At 320px the menu is offscreen and Get started is clipped; at 390px the page still overflows. | NAV-12: production responsive test and measured widths. |
| Empty required starter reported as a successful lineup | After two valid waiver wins in the compact roster, the agent committed an empty FLEX. The UI reports success without a clear degraded outcome. | TXN-02: qualified scripted-strategy and recovery-feedback issue; FAAB and ownership were correct. |

The linked reports distinguish confirmed behavior from hypotheses, environment limitations, and deliberate product choices. No production application fixes were made during this audit; changes are test specs, regression cases, and reports.

The shared auth-loading header issue appears as both ONB-06 and AGENT-02 and should be tracked once. A settled production check cleared the configuration-page overflow; landing-page overflow persists independently. The custom-provider HTTP/header concern is a source-review item, not a demonstrated exploit.

## Detailed reports

- [League creation, signup, invites, and permissions](/Users/claudius/fantasy-bench/docs/qa/audit-onboarding.md)
- [Draft, waivers, rosters, lineups, and trades](/Users/claudius/fantasy-bench/docs/qa/audit-transactions.md)
- [Agent customization, versions, tools, budgets, and traces](/Users/claudius/fantasy-bench/docs/qa/audit-agents.md)
- [Matchups, standings, navigation, and community reading](/Users/claudius/fantasy-bench/docs/qa/audit-navigation.md)
- [Voting and live moderation](/Users/claudius/fantasy-bench/docs/qa/audit-community.md)

## Coverage map

| Area | What was exercised | Result / limits |
|---|---|---|
| Authentication | New accounts, wrong-password feedback, logout/session revocation, duplicate signup, supplied return URLs | Main auth works; return URL and signup-handoff defects, no recovery flow. |
| Create/join league | Non-default 8-team Half PPR auction settings, persistence, invitation preview, claim, repeat redemption | Creation and claiming pass; invitation-to-signup continuity and empty-account Join action fail. |
| Roles | Commissioner, owner, and anonymous views | Settings denial and spectator read boundaries checked; detailed config findings in agent report. |
| Agent configuration | Context, authored skill, note, model, harness, save/reload, version history, comparison, debounced draft restore | Saved/queued config, versions, and production draft restore pass; default tool guidance blocked by missing deployed endpoint. |
| Custom providers and budgets | Invalid header validation, live provider response, create/disable/reload, three budget caps | Tested operations pass. |
| Trace transparency | Search URL persistence, detail, cooldown redaction, JSON export | Seeded public trace reading/export passes; no separate newly generated owner-private trace journey. |
| Snake draft | Eight teams, two roster places each, all 16 real agent windows; accelerated clock closing | Draft finishes through fallback; 15 stale-ownership rejections and empty draft-default lineups. Full standard-size browser draft remains unverified. |
| Auction | All-team scripted model setup, draft start, first nomination window and successful agent action; five targeted backend tests | Startup/nomination works; board lacks active auction state and falsely claims completion. Full auction completion was not browser-tested. |
| Waivers, add/drop, lineups | 16 competing claims, processing, two additions/two drops, later agent lineup | Two wins, 14 losses, FAAB 100 → 85 correct; later empty FLEX still reported successful. |
| Trades | Live proposals, recipient responses, feed/detail/timeline/trace; backend counter/accept/review/transfer lifecycle | Eight live proposals, three rejected, five pending at observation. Full transfer passes in-memory integration; scripted model does not accept offers in the live flow. |
| Competition views | Home, team directory, standings, matchup list/detail, week picker, desktop/mobile | Pages load; wrong-week and status defects plus mobile metadata/ordering issues. |
| Community | Public reading, sort/flair filters, vote/upvote/downvote/unvote persistence, hide/unhide across two viewers | Vote persistence works; live moderation crashes spectator view; rendering/empty-state defects. |
| Activity history | Real loaded pages at 40, 80, and 100 events | Further paging stalls with an enabled button. |
| Landing page | Six widths from 320 to 1672px, mobile menu, Docs anchor, league/login conversion | Navigation passes; horizontal-fit checks fail at 390 and 320px in production. |
| Production build | Separate webpack build, type checking, public detail/filter/error routes, moderation | Build and public navigation pass; live moderation failure reproduces. |

## Validation baseline

- Existing unit/function/component suite before audit additions: **608 passing tests across 43 files**.
- Transaction-focused suite: **54 passing tests**. A separately targeted proposal → counter → accept → review → completion integration test passed; this is in-memory backend evidence, not live-browser transfer evidence.
- Audit specs load successfully in Playwright. They include retained failures for confirmed product bugs and fixture-dependent observation journeys; they are not an all-green, fixture-independent CI suite.
- Final TypeScript check, targeted ESLint for all audit specs/regressions, and diff whitespace checks passed.
- Three isolated score/recap regression cases reproduce confirmed defects. They are retained as explicit `test.fails` cases, so a future fix changes the result to an unexpected pass and prompts conversion to normal regressions. Their actual wrong results were separately verified with ordinary assertions.
- Real Chromium against the real Convex backend, using distinct browser contexts and disposable QA accounts/leagues for writes. Existing Demo League was read-only.
- Desktop and mobile screenshots were opened and visually inspected; assertions alone were not taken as evidence of visual quality.
- A separate temporary copy passed **Next production build with webpack**, including TypeScript and route generation. Public matchup/filter/404 flow passed against this production server. The live moderation crash also reproduced there.
- Development 404 `Performance.measure` exceptions disappeared in production and are excluded from product defect counts.
- Final production reproduction retained three failing browser journeys: live moderation (`NOT_FOUND` page exception), activity pagination (100 remains 100), and landing responsiveness (390/320px overflow). Their Playwright traces are preserved in `e2e/screenshots/audit-retained-runs/`.
- The existing suite logs some unregistered Workpool component errors from scheduled test jobs despite its passing result. Browser scheduler tests and those unit-suite results should be assessed separately.

## Fix order and release gates

1. **Competition correctness:** refresh draft ownership despite player-data snapshot reuse, use week-scoped scoring snapshots, one shared game-status rule, and tie-aware recap output. Validate consecutive picks and multiweek unfinished/finalized fixtures.
2. **Core journey continuity:** validate same-origin auth return paths and preserve the invite destination through signup/login and make every advertised next action complete or explain why it cannot.
3. **Agent reliability:** distinguish successful agent choices, rejected actions, and fallback outcomes in the draft and transaction UI. Finish any unverified transaction lifecycle before release.
4. **Recovery:** handle live permission/content changes locally; preserve navigation and provide clear unavailable states. Replace capped but enabled pagination actions.
5. **Mobile and presentation:** expose critical player metadata, scroll the current nav section into view, put a concise current matchup above long mobile activity feeds, render Markdown cleanly, and replace database IDs/internal field names with human names.

Release signoff should include a standard-size snake draft, complete auction, live accepted trade through review and roster transfer, waiver conflict resolution with post-transaction legal lineups, saved agent configuration applied at its intended window, and real game-time score refreshes. Gateway-key verification/storage/removal, owner-specific edits distinct from commissioner edits, and the 21-day public reveal were not exercised. Cross-browser, physical-device, and paid-model behavior require separate coverage; this audit does not certify them.

## Artifacts

Tests live under [e2e/tests](/Users/claudius/fantasy-bench/e2e/tests) and the isolated regression file is [audit-quality.test.ts](/Users/claudius/fantasy-bench/convex/audit-quality.test.ts). Screenshots are under ignored `e2e/screenshots/`; the final production failure traces are preserved under [audit-retained-runs](/Users/claudius/fantasy-bench/e2e/screenshots/audit-retained-runs). QA fixture credentials are kept only in ignored local fixture files, not in this report.
