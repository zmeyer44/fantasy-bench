# Onboarding, league creation, invite, and auth audit

Audit date: 2026-09-09  
Target: `http://localhost:3000`, Chromium, real configured Convex development backend  
Result: the audit reproduced nine product-quality findings; the resolution pass below records the implemented fixes and final production-build verification.

## Coverage and result

The audit used fresh `example.test` accounts and fresh leagues on every run. Browser contexts were isolated between commissioner, owner, and anonymous roles. The final maintained journeys are:

- [`audit-onboarding-auth-create.spec.ts`](../../e2e/tests/audit-onboarding-auth-create.spec.ts): signed-out route guard, signup, empty account state, league creation with 8 teams / Half PPR / Auction, persistence in commissioner rules and team list, invite visibility, mobile settings, and menu logout.
- [`audit-onboarding-invite-permissions.spec.ts`](../../e2e/tests/audit-onboarding-invite-permissions.spec.ts): anonymous invite preview, auth handoff, first-time owner signup, team claim, owner agent landing, repeat invite redemption, owner settings denial, and anonymous settings denial.
- [`audit-onboarding-login-validation.spec.ts`](../../e2e/tests/audit-onboarding-login-validation.spec.ts): wrong-password feedback, password login with `next`, explicit logout page, session revocation, and duplicate-email signup failure.
- [`audit-onboarding-auction.spec.ts`](../../e2e/tests/audit-onboarding-auction.spec.ts): fresh isolated Auction league, league-wide replacement of all eight configs with `mock/scripted`, draft start, open nomination window, successful first agent nomination, trace, and post-nomination board state.

Core onboarding batch:

```text
npx playwright test audit-onboarding --project=chromium --reporter=line
3 passed (9.4s)
```

The login-validation journey was rerun after adding the duplicate-email check and passed in 6.7s. The auth-create journey was rerun after adding rule/team persistence checks and passed in 4.9s. All maintained journeys observed zero uncaught page errors. The floating `Rendering…` badge in a few screenshots is the Next development overlay and is excluded from product findings.

The bounded Auction journey passed separately in 12.2s (`npx playwright test audit-onboarding-auction.spec.ts --project=chromium --reporter=line`) against a fresh account and league. It stopped after the first real `mock/scripted` nomination. A full UI completion was not practical: default rules create 120 roster spots (15 per team), and every lot has a 240-second nomination window followed by a 240-second sealed-bid window, for roughly 16 hours of scheduled phases. There is no commissioner control for the draft clock in the settings UI. No paid model was invoked.

Targeted in-memory Auction coverage also passed:

```text
convex/draft.test.ts -t "the auction"              2 passed
convex/scheduling.test.ts -t "an auction draft"   2 passed
convex/runtime/tools.test.ts -t "auction"          1 passed
```

## Resolution implementation

The onboarding findings were addressed after this audit. The original evidence below is retained so each correction remains traceable.

| Finding | Resolution | Verification |
| --- | --- | --- |
| ONB-01 | Login, Sign up, and recovery links now carry one normalized `next` path. A new owner returns directly to the invitation after signup. | The updated invite journey passes and captures [preserved signup](../../e2e/screenshots/audit-onboarding/11-invite-destination-preserved-on-signup.png) and [return to invite](../../e2e/screenshots/audit-onboarding/12-invited-new-user-returned-to-invite.png). |
| ONB-02 | [`normalizeReturnPath`](../../lib/auth-return.ts) accepts only same-origin application paths and falls back to `/leagues` for absolute URLs, protocol-relative values, backslashes, and script schemes. | [`components/auth-return.test.ts`](../../components/auth-return.test.ts) passes eight cases. The login journey now asserts that an external `next` lands on `/leagues`. |
| ONB-03 | The league console now has an eight-character invite-code form and the header Join action targets it directly. | The auth-create journey asserts the labeled field and `#join-league` target; [empty-console screenshot](../../e2e/screenshots/audit-onboarding/03-new-account-empty-leagues.png). |
| ONB-04 | Convex Auth's real `reset` and `reset-verification` flows are wired to a six-digit, email-bound code with a 15-minute expiry. Requests use an atomic 60-second cooldown per normalized email. When delivery is configured, unknown and known addresses get the same public accepted state; unknown addresses do not create a code or trigger mail. Verification changes the password, invalidates other sessions, signs the user in, and restores `next`. The verification screen offers both Request new code and Use another email. An indexed exact-case fallback keeps password accounts created before lowercase normalization recoverable. No code is logged. | The recovery form and preserved return link render in [screenshot 18a](../../e2e/screenshots/audit-onboarding/18a-password-recovery.png). [`convex/password_reset.test.ts`](../../convex/password_reset.test.ts) passes database cooldown cases and an action-level known/unknown response test with mail stubbed, including a legacy mixed-case provider ID. Delivery is operationally blocked until `AUTH_RESEND_KEY` (or `RESEND_API_KEY`) and `AUTH_EMAIL_FROM` are set in the Convex environment; browser checks confirm the same persistent unavailable state for an [unknown address](../../e2e/screenshots/audit-onboarding/18b-recovery-delivery-unavailable.png) and a [known address](../../e2e/screenshots/audit-onboarding/18c-known-recovery-delivery-unavailable.png), without claiming a code was sent. |
| ONB-05 | The password provider now checks for an existing normalized email before `signUp` and returns an explicit account-exists error even when the submitted password is correct. Client error parsing handles both local and transported Convex error shapes while ignoring ordinary internal error messages. | The updated development-backend login-validation journey passes both a different and matching password. [Screenshot 21](../../e2e/screenshots/audit-onboarding/21-duplicate-signup-feedback.png) shows the actionable account-exists state. |
| ONB-06 | The unresolved-viewer placeholder uses a narrow mobile width, keeping the immediate invitation render within 390px. | Updated invite journey passes its pre-hydration width assertion; [screenshot 09a](../../e2e/screenshots/audit-onboarding/09a-mobile-anonymous-invite-auth-loading.png). |
| ONB-07 | Login, signup, and recovery Suspense boundaries plus the auth route-group loading boundary render a stable form-shaped loading shell. | [Screenshot 10](../../e2e/screenshots/audit-onboarding/10-invite-login-handoff.png) now shows the shell during the transition. |
| ONB-08 | The public draft query now publishes an Auction-specific phase, current lot, nominator, nominated player, opening bid, phase deadline, remaining team budgets, and resolved results. During bidding it publishes only `bidsSealed: true`; bidder identity, participation, and bid amounts remain private until resolution. The board renders these states instead of deriving a false completion state from an empty snake grid. | Auction read-model tests cover setup, scheduled nomination, bidding, bid privacy, post-resolution reads, and resolution in [`convex/draft.test.ts`](../../convex/draft.test.ts) and [`convex/scheduling.test.ts`](../../convex/scheduling.test.ts). A fresh compact live Auction completed all eight lots at 8/8 with budgets and trace-linked results; [sealed-bid board](../../e2e/screenshots/audit-transactions/fixed/auction-02-sealed-bidding.png) and [completion](../../e2e/screenshots/audit-transactions/fixed/auction-03-complete.png). |
| ONB-09 | `Review and start` now opens a confirmation dialog with format, team and roster counts, scoring, clock, Auction budget, model assignments, and unowned/paid-model warnings. Its final action explicitly starts the selected draft type and explains that scoring and roster rules freeze. | The review payload is asserted in [`convex/draft.test.ts`](../../convex/draft.test.ts) and the dialog passed in both fresh snake and Auction browser journeys; [Auction review](../../e2e/screenshots/audit-transactions/fixed/auction-01-start-review.png). |

The landing header now fits a 320px viewport by collapsing the wordmark and tightening the CTA, and the shared unresolved-viewer placeholder no longer causes transient overflow. The settings console adds an explicit mobile swipe affordance; the invite URL occupies its own row with Copy and Rotate aligned beneath it. The auth-create journey passes the 320px/390px width and control-alignment assertions, with visual evidence in [mobile landing](../../e2e/screenshots/audit-onboarding/08a-mobile-landing-header.png) and [mobile settings](../../e2e/screenshots/audit-onboarding/07-mobile-commissioner-settings.png).

Focused verification after implementation:

The final browser regression used the production build on `http://localhost:3301`; screenshots were visually reviewed after that run.

```text
components/auth-return.test.ts                         8 passed
components/auth-errors.test.ts                         4 passed
convex/password_reset.test.ts                          3 passed
audit-onboarding-auth-create.spec.ts                   1 passed (3.7s, production)
audit-onboarding-invite-permissions.spec.ts            1 passed (6.4s, production)
audit-onboarding-login-validation.spec.ts              2 passed (6.5s, production)
focused ESLint                                         passed
TypeScript                                             passed
```

## Findings

| ID | Severity | Type | Finding | Evidence / source | Recommended correction |
| --- | --- | --- | --- | --- | --- |
| ONB-01 | High | Functional onboarding bug | A first-time invitee loses the invite destination when switching from Log in to Sign up. The invite correctly opens `/login?next=%2Fleagues%2Fjoin%2F<code>`, but the Sign up link goes to bare `/signup`. Successful registration then lands on an empty `/leagues` page. The owner can only recover by reopening the original invite URL. | Screenshots [10](../../e2e/screenshots/audit-onboarding/10-invite-login-handoff.png), [11](../../e2e/screenshots/audit-onboarding/11-invite-destination-lost-on-signup.png), and [12](../../e2e/screenshots/audit-onboarding/12-invited-new-user-empty-console.png). Fixed auth-mode links are declared in [`components/auth-form.tsx:29`](../../components/auth-form.tsx#L29) and rendered at [`components/auth-form.tsx:170`](../../components/auth-form.tsx#L170). | Preserve a sanitized `next` value in both Login ↔ Sign up links. The invite page should also offer a direct “Create account” action carrying that destination. |
| ONB-02 | High | Security / trust | The login and signup pages accept an arbitrary `next` query value and pass it to `router.push`. A real login with `?next=https%3A%2F%2Fexample.com` authenticated successfully and then navigated off-site to `https://example.com/`, confirming an open redirect. A `javascript:` probe did not execute in this Next build, but left the now-authenticated form stuck on “Working…”. | The untrusted value is read at [`components/auth-form.tsx:55`](../../components/auth-form.tsx#L55) and passed to navigation at [`components/auth-form.tsx:84`](../../components/auth-form.tsx#L84). The stuck state is [screenshot 22](../../e2e/screenshots/audit-onboarding/22-untrusted-next-result.png). Next 16's installed `useRouter` guide explicitly warns against unsanitized URLs. | Parse once and accept only same-origin application paths beginning with `/` and not `//`; otherwise fall back to `/leagues`. Reuse only that normalized value in redirects and auth-mode links. |
| ONB-03 | High | Dead-end UX | A signed-in account with no memberships sees a prominent “Join a league” header action that links to the page it is already on, while the page contains only a Create league form and no invite-code field. This makes ONB-01 much harder to recover from and gives an uninvited user no working join path. | [Screenshot 12](../../e2e/screenshots/audit-onboarding/12-invited-new-user-empty-console.png). The self-link is built at [`components/site-nav.tsx:176`](../../components/site-nav.tsx#L176); the page only renders the league list and create form at [`app/(console)/leagues/page.tsx:18`](../../app/(console)/leagues/page.tsx#L18). | Add an invite-code input or join panel to the empty league console. Point the header action to that control and focus it, or remove the self-link until a distinct join route exists. |
| ONB-04 | Medium | Competitor parity gap | There is no password-reset or account-recovery entry point on either auth page and no recovery route or mutation in the repository. A forgotten password therefore strands a league owner. ESPN and Sleeper-quality account onboarding needs a recovery path. | [Screenshot 18](../../e2e/screenshots/audit-onboarding/18-invalid-password-feedback.png); the form ends with only the auth-mode switch at [`components/auth-form.tsx:170`](../../components/auth-form.tsx#L170). Repository search found no password reset/recovery implementation. | Add “Forgot password?” with rate-limited, non-enumerating recovery. Keep the invite `next` destination through recovery so an invited owner returns to the claim screen. |
| ONB-05 | Medium | Unexpected auth behavior | Submitting the Sign up form for an existing email with the existing password signs into that account and redirects to `/leagues`, even though the action says “Create account.” A different password correctly fails. This appears to be provider behavior, but the UI presents it as account creation and gives no indication that an existing account was used. | Reproduced with a disposable account. The different-password state is [screenshot 21](../../e2e/screenshots/audit-onboarding/21-duplicate-signup-feedback.png); both modes call the same password provider with only `flow` changed at [`components/auth-form.tsx:70`](../../components/auth-form.tsx#L70). | Detect the existing-email result or use a provider flow that reports it explicitly. Tell the user the account already exists and direct them to Log in/recovery rather than silently changing the meaning of the submit action. |
| ONB-06 | Low | Mobile layout shift | At 390px, the signed-out invite page briefly measures 394px wide while `users.me` is unresolved. The `w-40` auth placeholder plus menu is the overflow source; ten immediate-load probes reproduced `scrollWidth=394`. The page returns to 390px after auth state resolves, so this is a hydration shift rather than persistent content overflow. | [Screenshot 09a](../../e2e/screenshots/audit-onboarding/09a-mobile-anonymous-invite-auth-loading.png) captures the transition vicinity. Placeholder source: [`components/site-nav.tsx:170`](../../components/site-nav.tsx#L170); the always-present mobile menu begins at [`components/site-nav.tsx:219`](../../components/site-nav.tsx#L219). | Give the placeholder the same responsive width as the settled controls or hide/resize it below `sm`. Add an overflow assertion both before and after auth hydration. |
| ONB-07 | Low | Loading polish | Clicking Sign in from the invite updates the URL before the auth form appears, producing a completely blank main area during the route transition. The auth pages deliberately use `Suspense fallback={null}`. This is brief, but it looks like a failed navigation on a core conversion flow. | [Screenshot 10](../../e2e/screenshots/audit-onboarding/10-invite-login-handoff.png). Null fallbacks: [`app/(auth)/login/page.tsx:8`](../../app/(auth)/login/page.tsx#L8) and [`app/(auth)/signup/page.tsx:8`](../../app/(auth)/signup/page.tsx#L8). | Render a form-sized loading shell or keep the invitation summary visible until the form is ready. |
| ONB-08 | High | Core Auction flow | The live Auction draft board does not render Auction state. Immediately after start it says `live`, but also shows `On the clock —`, `Draft complete`, `0 / —`, `No draft order yet`, and `No picks yet`. The league home simultaneously shows an open `Auction nominate` window, and the trace records a successful nomination, yet returning to the board produces the same empty state. There is no current lot, nominator, nominated player, opening price, bid phase, deadline, team budgets, or bid status for owners or spectators. | Screenshots [A05](../../e2e/screenshots/audit-onboarding/auction/05-live-auction-board-missing-lot.png), [A06](../../e2e/screenshots/audit-onboarding/auction/06-open-nomination-visible-only-on-home.png), [A07](../../e2e/screenshots/audit-onboarding/auction/07-first-mock-nomination-trace.png), and [A08](../../e2e/screenshots/audit-onboarding/auction/08-post-nomination-board-still-empty.png). The board query only reads `draft_picks` at [`convex/draft.ts:98`](../../convex/draft.ts#L98), while active Auction state is stored in `auction_nominations` beginning at [`convex/draft.ts:350`](../../convex/draft.ts#L350). The false completion label comes from the `0 === 0` fallback at [`components/draft/draft-board.tsx:63`](../../components/draft/draft-board.tsx#L63). | Add an Auction-specific read model and board: current lot and phase, nominating team, player, opening bid, phase deadline, remaining budgets, and sealed-bid submission state. Gate “Draft complete” on league status rather than zero-row equality. |
| ONB-09 | Medium | Irreversible-action UX | `Start the draft` is a single immediate button. Clicking it starts the real draft and locks league rules without a confirmation or final review of draft type, team count, roster size, budget, clock, or model assignment. The setup copy warns that rules lock, but there is no chance to catch an accidental click once pressed. | [Screenshot A04](../../e2e/screenshots/audit-onboarding/auction/04-auction-setup-board.png); the button invokes the mutation directly at [`components/draft/start-draft-button.tsx:18`](../../components/draft/start-draft-button.tsx#L18). | Open a confirmation dialog summarizing the locked settings and require an explicit final Start action. Include readiness warnings for unowned teams and paid model assignments. |

### Lower-priority visual notes

- The mobile commissioner settings tab row is horizontally scrollable but hides the scrollbar and stops mid-label, so later tabs such as Teams and Change log have little discovery affordance. See [screenshot 07](../../e2e/screenshots/audit-onboarding/07-mobile-commissioner-settings.png) and [`components/settings/settings-console.tsx:41`](../../components/settings/settings-console.tsx#L41).
- On the same screen, the invite URL and Copy button occupy the first line while Rotate wraps alone to the next line. It remains usable, but the control group looks unfinished compared with mature fantasy products. See [screenshot 07](../../e2e/screenshots/audit-onboarding/07-mobile-commissioner-settings.png) and [`components/settings/league-tab.tsx:122`](../../components/settings/league-tab.tsx#L122).
- Duplicate-email failure copy combines “already registered” and “password too weak,” even though the user needs different remedies. This avoids email enumeration but could provide clearer next steps, such as a direct Log in/recovery action, without confirming which condition applied.
- Auction setup and live states both label the zero-row board “Draft complete.” This is included in ONB-08 because it becomes especially misleading alongside the live indicator.

## Verified passes

- `/leagues` redirects a signed-out visitor to `/login?next=%2Fleagues`, and logout revokes access immediately.
- Fresh signup succeeds through the real password provider. Wrong-password login stays on the form and shows an inline actionable error.
- League creation persists all tested inputs: 8 teams, Half PPR, Auction, public visibility, and $100 FAAB. Eight unowned teams and initial agent config v1 rows appear in commissioner settings.
- A commissioner can read a freshly minted eight-character invite code. The invite preview exposes only league summary data before authentication.
- A signed-in invitee claims Team 1 and lands directly in that team's Edit agent screen. Reopening the invite is idempotent and shows “You are already in this league.”
- Owner navigation omits Settings. Direct owner and anonymous requests to the settings URL render an explicit 403 view; the anonymous view offers a sign-in recovery action.
- Stable mobile auth, invite, settings, and agent-editor content stays within the viewport after the viewer subscription resolves.
- No uncaught page exceptions occurred in the maintained runs; the auth-create journey also observed no console errors.

## Intentional agent-only behavior

The following differences from ESPN/Sleeper were checked against the product architecture and are intentional rather than defects:

- Creating a league makes the user commissioner but does not assign them a team. All teams begin unowned and can draft with default agent configs.
- Joining claims the lowest-numbered unowned team and opens Edit agent instead of a manual roster-management wizard. Humans tune context, tools, skills, model, and harness; agents make roster decisions.
- The freshly joined owner sees scheduled config-lock language. Agent changes apply at the configured unlock boundary rather than becoming immediate manual roster moves.
- Public league pages are spectator-readable, while commissioner settings remain role-gated.

## Visual review index

| Screenshot | State | Verdict |
| --- | --- | --- |
| [01](../../e2e/screenshots/audit-onboarding/01-signed-out-route-guard.png) | Protected league-console redirect | Pass; desktop login form is complete and readable. |
| [02](../../e2e/screenshots/audit-onboarding/02-signup-form.png) | Signup entry | Pass; labels, password minimum, and alternate login link are visible. |
| [03](../../e2e/screenshots/audit-onboarding/03-new-account-empty-leagues.png) | New empty account | Pass after resolution; a labeled invite-code form and direct header anchor provide a working join path. |
| [04](../../e2e/screenshots/audit-onboarding/04-create-league-filled.png) | Non-default create choices | Pass; entered values remain visible before submission. |
| [05](../../e2e/screenshots/audit-onboarding/05-new-league-home.png) | New Auction league home | Pass; setup status, draft CTA, settings CTA, and eight-team standings are coherent. |
| [06](../../e2e/screenshots/audit-onboarding/06-commissioner-invite-settings.png) | Commissioner invite | Pass; code and URL are visible only in authorized settings. |
| [06a](../../e2e/screenshots/audit-onboarding/06a-created-rules-applied.png) | Persisted rules | Pass; Half PPR and $100 FAAB match creation. Development Rendering badge ignored. |
| [06b](../../e2e/screenshots/audit-onboarding/06b-created-eight-teams.png) | Persisted teams | Pass; exactly eight unowned teams with v1 default configs. |
| [07](../../e2e/screenshots/audit-onboarding/07-mobile-commissioner-settings.png) | Mobile settings | Pass after resolution; the swipe hint is visible and Copy/Rotate align beneath the invite URL. |
| [08](../../e2e/screenshots/audit-onboarding/08-after-signout-route-guard.png) | Mobile guard after logout | Pass; session is gone and login form is usable. |
| [09a](../../e2e/screenshots/audit-onboarding/09a-mobile-anonymous-invite-auth-loading.png) | Invite during auth hydration | Pass after resolution; the immediate and settled states remain within the 390px viewport. |
| [09](../../e2e/screenshots/audit-onboarding/09-mobile-anonymous-invite.png) | Settled anonymous invite | Pass; identity, season, team count, status, and Sign in action are clear. |
| [10](../../e2e/screenshots/audit-onboarding/10-invite-login-handoff.png) | Invite-to-login transition | Pass after resolution; a form-shaped loading shell fills the route transition. |
| [11](../../e2e/screenshots/audit-onboarding/11-invite-destination-lost-on-signup.png) | Auth-mode switch | ONB-01; signup URL no longer contains the invite destination. |
| [12](../../e2e/screenshots/audit-onboarding/12-invited-new-user-empty-console.png) | New invitee after signup | ONB-01/03; user is stranded in an empty console with a self-linking Join CTA. |
| [13](../../e2e/screenshots/audit-onboarding/13-signed-in-invite-ready.png) | Reopened invite | Pass; claim behavior and remaining-team count are clear. |
| [14](../../e2e/screenshots/audit-onboarding/14-owner-agent-editor-after-join.png) | Team claim success | Pass for the agent-only product; editor is long but readable on mobile. |
| [15](../../e2e/screenshots/audit-onboarding/15-repeat-invite-member-state.png) | Repeat invite redemption | Pass; idempotent state and recovery CTA are explicit. |
| [16](../../e2e/screenshots/audit-onboarding/16-owner-settings-forbidden.png) | Owner settings denial | Pass; 403 is explicit and Settings is absent from league navigation. |
| [17](../../e2e/screenshots/audit-onboarding/17-anonymous-settings-forbidden.png) | Anonymous settings denial | Pass; league context remains visible and Sign in is offered. |
| [18](../../e2e/screenshots/audit-onboarding/18-invalid-password-feedback.png) | Wrong password | Pass after resolution; inline feedback and the recovery entry point are both visible. |
| [19](../../e2e/screenshots/audit-onboarding/19-password-login-restored.png) | Successful password login | Pass; destination and account chrome are restored. |
| [20](../../e2e/screenshots/audit-onboarding/20-explicit-logout-page.png) | Explicit logout page | Pass; scope of logout is explained before action. |
| [21](../../e2e/screenshots/audit-onboarding/21-duplicate-signup-feedback.png) | Existing email, different password | Pass after resolution; signup stays on-page with explicit Log in/reset guidance. |
| [22](../../e2e/screenshots/audit-onboarding/22-untrusted-next-result.png) | `javascript:` next probe | Original ONB-02 evidence; the final production journey confirms an external `next` now lands on `/leagues`. |
| [A01](../../e2e/screenshots/audit-onboarding/auction/01-mock-replacement-ready.png) | Auction model replacement prepared | Pass; the source model covers all eight teams and Scripted Mock is visibly zero-cost. |
| [A02](../../e2e/screenshots/audit-onboarding/auction/02-all-agents-replaced.png) | League-wide replacement result | Pass; the UI reports eight updated teams and the allowlist includes the mock. The repeated sticky header in this full-page capture is a Playwright screenshot artifact. |
| [A03](../../e2e/screenshots/audit-onboarding/auction/03-eight-mock-teams.png) | Team config verification | Pass; all eight unowned teams show `mock/scripted · v2`. |
| [A04](../../e2e/screenshots/audit-onboarding/auction/04-auction-setup-board.png) | Auction setup board | ONB-09; start is one immediate action. The premature `Draft complete` label is part of ONB-08. |
| [A05](../../e2e/screenshots/audit-onboarding/auction/05-live-auction-board-missing-lot.png) | Immediately after Auction start | ONB-08; live status conflicts with an empty, “complete” board. |
| [A06](../../e2e/screenshots/audit-onboarding/auction/06-open-nomination-visible-only-on-home.png) | League home during first nomination | Pass as corroboration; an Auction nominate window is visibly open even though the board has no lot. |
| [A07](../../e2e/screenshots/audit-onboarding/auction/07-first-mock-nomination-trace.png) | First scripted nomination trace | Pass; the run succeeded with `draft action recorded`, six steps, three actions, and no cost rendered. |
| [A08](../../e2e/screenshots/audit-onboarding/auction/08-post-nomination-board-still-empty.png) | Board after successful nomination | ONB-08; no lot or bid state appears after the committed action. |

## Disposable fixtures left for follow-up

These exist only on the selected development backend and may be used for read-only follow-up or deliberately mutated by another QA run. No seed/demo account or league was touched. Disposable emails, passwords, and invite links are stored in ignored local file [`e2e/screenshots/audit-onboarding/fixtures.json`](../../e2e/screenshots/audit-onboarding/fixtures.json), not in this tracked report.

### Unowned creation fixture

- League: `m57epazd38h41q5z614z9ysfxn8e3fp6`
- Rules: 8 teams, Half PPR, Auction, public, $100 FAAB; all eight teams are now `mock/scripted · v2`
- State: drafting; the first nomination was submitted by a scripted mock run

### Latest self-contained Auction run

- League: `m57edp3zpaec74sztn16fn9w058e3m57`
- State: drafting; first nomination submitted; all eight teams use `mock/scripted · v2`
- The one-use QA credentials were intentionally not logged or retained. Public league and draft pages remain readable.

### Joined-owner fixture

- League: `m573vj1am2h0ejj9pxe7qk3qhd8e31z6`
- Team 1: `qh70p09nwng72t32hcfyfrxhah8e2xem`
- Seven teams remain unowned.

### Login-only fixture

- No memberships

For a new isolated fixture, use any unique `example.test` email, an 8+ character password, and the accessible selectors `Name`, `Email`, `Password`, `Create account`, `League name`, `Teams`, `Scoring`, `Draft`, and `Create league`. The first settings tab exposes the new invite through the `Invite link` label.
