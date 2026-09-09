# Community actions audit

## Follow-up resolution — 2026-09-09

COM-01 is resolved. `forum.get` now returns a nullable post detail when a post becomes unavailable, keeping the live subscription and league shell mounted. The spectator sees a scoped **This post is no longer available** state with a semantic return link; unhiding the post restores the same detail view live without a reload. Post and comment bodies also render Markdown instead of exposing source markers.

The repaired journey passed against both development and the webpack production build. It confirmed vote persistence and reversal, commissioner access to the hidden post, immediate spectator removal, semantic unavailable-state navigation, live recovery after unhide, restored score `0`, and no page errors. The test now restores a hidden fixture in cleanup even if a later assertion fails. Final evidence: [spectator unavailable state](/Users/claudius/fantasy-bench/e2e/screenshots/audit-community/05-spectator-post-hidden-live.png), [commissioner hidden state](/Users/claudius/fantasy-bench/e2e/screenshots/audit-community/06-owner-hidden-post.png), and [spectator live recovery](/Users/claudius/fantasy-bench/e2e/screenshots/audit-community/07-spectator-restored.png).

The section below is preserved as the original audit record and its failure language is superseded by this resolution.

## Original audit record

Date: 2026-09-09. Real browser against the real Convex backend, first using development at port 3000 and then a separate webpack production build at port 3301. Only a disposable QA league and scripted commissioner posts were modified. Commissioner model was verified as `mock/scripted`; the fixture recap reported $0 cost.

## COM-01 — P2: live moderation replaces the reader’s entire application with an error screen

Reproduction:

1. Commissioner and anonymous spectator open the same visible forum post in separate browser contexts.
2. Commissioner chooses **Hide**.
3. The spectator’s live `forum.get` subscription throws `NOT_FOUND`.
4. The complete application shell disappears and is replaced by **“This page couldn’t load — Reload to try again, or go back.”** This is confirmed in the production build, not just the Next development overlay.

Expected: retain the league navigation and show a contextual “This post is no longer available” state with a return-to-Commons link. Hiding a post is an ordinary state change, not an application failure. A reload while it remains hidden can only return a 404.

Cause: [forum query](/Users/claudius/fantasy-bench/convex/forum.ts:323) throws for hidden content; [PostView](/Users/claudius/fantasy-bench/components/forum/post-view.tsx:31) has no local handling for a formerly readable post becoming unavailable. Consider a nullable/unavailable read model or a scoped query error boundary.

Production evidence: [spectator error screen](/Users/claudius/fantasy-bench/e2e/screenshots/audit-community-production/05-spectator-post-hidden-live.png). The exact exception is recorded in [observations](/Users/claudius/fantasy-bench/e2e/screenshots/audit-community-production/observations.json).

## Verified behavior

- Commissioner can open the generated post.
- Upvote changes score from 0 to 1 and persists after reload.
- Switching to downvote changes score to −1.
- Clicking downvote again clears the vote and restores 0.
- Anonymous viewer sees disabled voting controls.
- Hide retains the post for the commissioner with a Hidden badge and Unhide control.
- Unhide restores anonymous readability after server confirmation and reload.
- Fixture post ended visible, with no remaining vote from the audit.

The Playwright journey fails at its final no-page-exceptions assertion due to COM-01. Initial production recovery check had a test race against the optimistic Unhide button; the spec now waits for the server-backed Hidden badge to disappear. Rerun confirmed restoration succeeds and the remaining failure is the live-moderation exception.

## Artifacts and visual review

Spec: [audit-community.spec.ts](/Users/claudius/fantasy-bench/e2e/tests/audit-community.spec.ts). It requires the ignored `.cache/audit-community-fixture.json` credentials and a disposable league with scripted Awards post. Credentials are not included in reports.

Every numbered screenshot was opened in both development and production:

| Screenshot | Verdict |
|---|---|
| 01-owner-post | Loaded post and owner moderation control; raw Markdown duplicates NAV-06. |
| 02-upvote-persisted | Score 1 and active upvote survive reload. |
| 03-downvote | Score −1 displays correctly. |
| 04-vote-cleared | Score returns to 0. |
| 05-spectator-post-hidden-live | Confirmed application error screen; production reproduces without dev overlay. |
| 06-owner-hidden-post | Commissioner retains access and sees Hidden + Unhide. |
| 07-spectator-restored | Post readable again; screenshot catches navigation/karma subscriptions still hydrating. |

Directories: `e2e/screenshots/audit-community/` and `e2e/screenshots/audit-community-production/`. Playwright traces: `test-results/audit-community/` and `test-results/audit-community-production/`. No application code or test IDs were changed.
