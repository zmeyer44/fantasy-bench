# Product quality fixes — 2026-09-09

This is the resolution record for the [26-finding audit](product-quality-audit-2026-09-09.md). The original reports retain their reproduction evidence. Three GPT-5.6 Sol agents implemented and re-tested onboarding, drafting/transactions, and agent customization/community; the coordinating agent handled scoring, navigation, activity history, and integrated verification.

## Resolution matrix

| Finding | Implemented correction |
|---|---|
| ONB-01 | Preserve the invite destination through login, signup, and password recovery. |
| ONB-02 | Accept only local return paths; reject external, protocol-relative, and backslash redirects. |
| ONB-03 | Add an invite-code form to the league console and point Join to it. |
| ONB-04 | Add password recovery, expiring codes, consistent unknown-account responses, and request cooldowns. **Email delivery still requires deployment configuration and a real delivery/reset check.** |
| ONB-05 | Report an existing account explicitly instead of silently signing in from Create account. |
| ONB-06 / AGENT-02 | Make loading and settled header controls fit mobile widths. This is one shared finding. |
| ONB-07 | Show an auth form loading shell both during route-module loading and Suspense transitions. |
| ONB-08 | Render auction phase, lot, nominator, deadline, budgets, and sealed-bid submission state. Completion follows actual league state. |
| ONB-09 | Review draft settings and readiness before confirming the draft start. |
| NAV-01 | Scope matchup score snapshots to the selected week. |
| NAV-02 | Use real starter scores for live status; distinguish missing scores from numeric zero, and retain authoritative final results. |
| NAV-03 | Describe tied and unfinished games correctly in fallback recaps. |
| NAV-04 | Wrap player injury, opponent, and kickoff metadata on mobile. |
| NAV-05 | Reveal the active mobile league tab after navigation and resizing; expose Negotiations in the shared navigation model. |
| NAV-06 | Render post Markdown and produce clean plain-text excerpts. |
| NAV-07 | Explain empty filter results and provide Clear filter. |
| NAV-08 | Render readable rule-change labels and owner names instead of storage keys and account IDs. |
| NAV-09 | Put a current matchup summary above mobile activity. |
| NAV-10 | Replace the 100-event cap with stable cursor pagination, deduplication, and retry feedback. Keep historical moderation and message visibility reactive. |
| NAV-11 | Render themed unavailable pages with recovery links. |
| NAV-12 | Fit landing header controls at 390px and 320px. |
| COM-01 | Handle a hidden/deleted post locally and recover reactively when it is restored. |
| TXN-01 | Overlay current draft ownership on reused player snapshots and generate default lineups from actual final rosters. |
| TXN-02 | Report incomplete committed lineups as partial, disclose safety fallback, and preserve starter coverage across scripted waiver claims. |
| AGENT-01 | Synchronize the frontend's default-tool save endpoint with the development backend; preserve the success confirmation during refresh and verify save/reload/version behavior. |
| AGENT-03 | Give empty and permission-state titles semantic headings. |

The additional provider review item is addressed in form validation, mutations, and runtime dispatch: HTTPS is required, embedded credentials and header newlines are rejected, and redirects cannot forward configured headers.

## Verification

- Integrated unit/function/component suite: **649 tests across 52 files passed** after the auction, scripted-draft, and auth feedback corrections.
- Next production build with webpack and TypeScript passed. ESLint reported no errors and one existing warning in `convex/auth.config.ts`.
- Development Convex functions synchronized successfully, including the previously missing default-tool save endpoint and the new history/recovery queries.
- Real backend activity pagination returned **233 unique events in six pages (40/40/40/40/40/33)**, then correctly reported exhaustion. Chromium also passed 40 → 80 → 120 → older history.
- Production Chromium passed matchup details, week selection, forum filter recovery, Markdown rendering, and themed invalid league/week/post links.
- Desktop/mobile navigation passed after adding the missing Negotiations destination. Screenshots verify active-tab visibility, a matchup above mobile activity, readable injury/game metadata, and human owner-change text.
- Production landing checks passed at **1672, 1280, 1024, 768, 390, and 320 pixels**, including menu dismissal, Docs navigation, and the login conversion route.
- Production community moderation passed across two viewers: hiding content gives a scoped unavailable state; restoration recovers the post. Custom-provider HTTPS validation passed.
- Full compact snake draft passed against the real development backend through the production frontend: **16 unique agent picks, zero auto-picks, and populated default lineups for all eight teams**. Agent waivers changed the roster and FAAB; the subsequent lineup retained a valid starter.
- Full compact auction passed: **eight lots completed**, each exercising nomination and sealed bidding; awards, budgets, final state, and bid privacy matched the backend. The post-resolution board crash found during verification is fixed.
- **Final production agent journey passed (7.4 seconds):** default-tool save confirmation, reload persistence, version history, custom-provider persistence, budgets, spectator permissions, trace detail, and export; no page exceptions.
- **Final production onboarding passed four tests:** account/league creation (3.7 seconds), invite and permissions (6.4 seconds), and login/recovery (two tests, 6.5 seconds total). Coverage includes login/logout, duplicate signup with either password, safe return URLs, invitation signup/claim continuity, and the auth loading shell. Known and unknown email addresses showed the same delivery-unavailable feedback.
- **Final production navigation passed all three journeys (13.7 seconds total):** desktop/mobile primary pages, complete activity pagination, and public competition/forum/error-state reading.

Screenshots for these checks were opened and visually reviewed. Root artifacts are in `e2e/screenshots/quality-fixes-navigation`, `quality-fixes-navigation-final`, `quality-fixes-navigation-production-final`, and `landing-hero`; the detailed area reports record the agents' evidence. Final successful concurrent runs disabled Playwright tracing after a temporary-artifact cleanup collision; assertions and screenshots remained enabled.

Existing historical recaps, traces, and previously completed audit leagues were preserved. Corrected recap generation and lineup outcomes apply to new runs; the fix does not rewrite old agent output.

The passing unit harness still logs existing scheduled-job registration/teardown diagnostics. Real backend draft and waiver runs provide separate scheduler evidence. Full standard-size drafts, live accepted trade transfer, paid-model behavior, real mailbox recovery, physical devices, and cross-browser coverage remain outside this verification.

## Remaining external setup

Password recovery needs `AUTH_RESEND_KEY` (or `RESEND_API_KEY`) and a verified sender in `AUTH_EMAIL_FROM` on the Convex deployment. Without these values, the UI reports that delivery is unavailable rather than claiming an email was sent. No recovery codes are logged. A real mailbox delivery and reset completion remain unverified until that setup is available.

These fixes do not by themselves certify competitor parity, cross-browser behavior, paid-model quality, or real NFL game-time scoring. The audit's broader release coverage limits remain applicable.
