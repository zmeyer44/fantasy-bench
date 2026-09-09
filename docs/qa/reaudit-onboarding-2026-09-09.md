# Onboarding, account, and league-management re-audit — 2026-09-09

Target: real Chromium against the configured Convex development backend through development (`http://localhost:3000`) and corrected production (`http://localhost:3301`) frontends. All accounts and leagues were unique disposable `example.test` fixtures. No demo data, paid model, email delivery, application source, backend function, or deployment was changed.

## Result

## Resolution follow-up

Both findings were corrected after the audit. A full private league invitation now explains that the league is not open to spectators and offers no inaccessible watch action; the fresh eight-owner lifecycle passes with [corrected mobile evidence](../../e2e/screenshots/reaudit-onboarding/invite-05-full-private-safe-state.png). League settings now uses the same review-and-start component as the draft board, built from its live saved rules, teams, and model assignments; the management journey passes with [the shared Auction review](../../e2e/screenshots/reaudit-onboarding/league-01b-settings-start-review.png). Focused ESLint passes. TypeScript reaches an unrelated concurrent error in `convex/runtime/mock_model.ts` (`position` is undefined at line 439), outside these owned changes.

Three production journeys passed after the audit assertions were aligned with intended read-only states:

```text
reaud-onboarding-auth.spec.ts                 1 passed (5.7s)
reaud-onboarding-league-management.spec.ts    1 passed (10.2s)
reaud-onboarding-invite-lifecycle.spec.ts     1 passed (24.5s)
```

All successful runs used isolated Playwright output directories and `--trace=off`. Every named screenshot was opened and visually reviewed. An earlier production harness copy omitted `proxy.ts`, causing fresh signup to fail; the coordinator rebuilt the production server with the middleware included. Those harness-only failures are excluded from product findings.

## Findings

### REAUD-ONB-01 — Medium — full private invitation offers a spectator dead end (new)

When all eight teams in a private league are owned, a ninth authenticated user can still open the current invitation. The page says “You can still watch this league as a spectator” and offers **Watch instead**. Activating it opens the private league URL, which renders the themed 404 because the user was never granted spectator membership.

Reproduction:

1. Create an eight-team league and turn off **Public league**.
2. Rotate its invite and redeem the current code with eight distinct accounts.
3. Sign in as a ninth account and open the current invite.
4. Confirm “Every team is taken” and activate **Watch instead**.
5. Observe `404 · Page unavailable` instead of the advertised spectator view.

Expected: the action either grants a spectator membership before navigation, or explains that the private league is full without offering an inaccessible destination.

Observed: [full private invite offer](../../e2e/screenshots/reaudit-onboarding/invite-05-full-private-watch-offer.png) → [private league dead end](../../e2e/screenshots/reaudit-onboarding/invite-06-private-watch-dead-end.png).

Source: the full branch promises spectator access and links directly to the league at [`app/(public)/leagues/join/[code]/page.tsx:75`](../../app/(public)/leagues/join/[code]/page.tsx#L75). The invite query reports `isPublic` but the page does not use it to choose the full-state action; see [`convex/leagues.ts:213`](../../convex/leagues.ts#L213).

### REAUD-ONB-02 — Medium — settings still bypasses the draft-start review (preexisting, incompletely fixed)

The previous ONB-09 resolution added a review dialog to the draft board, but the commissioner League settings tab still renders **Start the draft** and invokes `commissioner.startDraft` directly. A commissioner can therefore bypass the promised final review of format, roster count, model assignments, and paid/unowned warnings from a second core entry point.

Evidence: [production league settings](../../e2e/screenshots/reaudit-onboarding/league-01-private-settings-saved.png) visibly retains the immediate button. The direct mutation call is at [`components/settings/league-tab.tsx:176`](../../components/settings/league-tab.tsx#L176).

Expected: every UI entry point routes through the same review-and-confirm step.

Observed: the settings action has no dialog or second confirmation. The initial onboarding journey did not activate it while default models were configured. The subsequent [auction follow-up](reaudit-auction-2026-09-09.md) verified all eight actual configurations as `mock/scripted`, then activated this button and confirmed immediate start with no review dialog.

## Verified behavior

- Signup accepted a padded, mixed-case email; later padded uppercase login resolved the same account. Equivalent-email signup returned the explicit account-exists guidance.
- A safe local `next` containing query and fragment survived signup. Protocol-relative and backslash variants returned to `/leagues` rather than leaving the application.
- Menu logout revoked the active browser session immediately; a protected `/leagues` navigation returned to login.
- League name, private visibility, and Auction format persisted together across a hard reload.
- Team name and abbreviation persisted. Padded uppercase owner assignment resolved the intended account.
- Owner assignment appeared after reload without reauthentication. Owner settings stayed commissioner-only.
- Reassignment revoked the former owner's edit controls and exposed only the delayed public/read-only config state; the new owner received the editable agent screen. Evidence: [old owner](../../e2e/screenshots/reaudit-onboarding/league-04-old-owner-controls-revoked.png) and [new owner](../../e2e/screenshots/reaudit-onboarding/league-05-new-owner-controls-granted.png).
- An anonymous direct request to a private league returned a themed, non-leaking 404 at 320px. The owner-only 403 state fit 390px without document overflow.
- Invite rotation changed the current code, invalidated the old URL, accepted a lowercase current URL, and allowed eight distinct claims. Repeat redemption remained idempotent.
- The eighth owner exhausted exactly the last team. The ninth account saw the explicit full state rather than a failed join mutation.
- No product page exceptions occurred in corrected production runs. Development emitted Next's known performance instrumentation error (`LeagueLayout cannot have a negative time stamp`) while rendering a not-found route; production did not.

## Visual review

The 17 named captures in [`e2e/screenshots/reaudit-onboarding`](../../e2e/screenshots/reaudit-onboarding) were reviewed. Desktop auth and settings were legible; 320px/390px auth, permission, private-404, full-invite, and agent views fit the viewport. The long replacement-owner agent page remained readable without horizontal overflow. Full-page screenshots of sticky desktop navigation can repeat the sticky header midway through the capture; this is a Playwright capture artifact.

## Coverage limits

Password-reset delivery and completion remain untested because controlled mailbox credentials and a configured sender were unavailable; no real email was sent. The audit did not test cross-browser or physical-device behavior, simultaneous last-team redemption, paid models, or draft execution in these initial three journeys; the separate auction follow-up covers execution. Loading was observed through normal auth and server navigation, but transport-level retry UI was not fault-injected. Session revocation was verified for the signed-out browser context, not as a global revoke-all-sessions feature.

Specs: [`reaud-onboarding-auth.spec.ts`](../../e2e/tests/reaud-onboarding-auth.spec.ts), [`reaud-onboarding-league-management.spec.ts`](../../e2e/tests/reaud-onboarding-league-management.spec.ts), and [`reaud-onboarding-invite-lifecycle.spec.ts`](../../e2e/tests/reaud-onboarding-invite-lifecycle.spec.ts).
