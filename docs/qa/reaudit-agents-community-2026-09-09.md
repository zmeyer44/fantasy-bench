# Agent customization and community re-audit — 2026-09-09

Fresh second audit against the corrected webpack production build at `http://localhost:3301` with real Chromium and the real Convex backend. Writes used two existing disposable QA accounts and newly created disposable leagues; the seeded demo remained read-only. The completed journeys used `mock/scripted`; the rejected default-provider attempt during fixture setup is disclosed below. No successful paid model execution or real provider secret was used.

## Confirmed finding

### REAUD-AGENT-01 — P2 — stale save toast makes an unsaved tool reset look persisted

This is new coverage of the previously unverified reset/re-enable and applied-window experience.

1. As a regular team owner during a locked edit window, open **Agent → Tools → search_players**.
2. Add owner guidance and save it. The page reports that it will take effect at the next unlock.
3. Select **Reset to default**.
4. Observe the page immediately after the successful reset.

Expected: changing or resetting the form clears the earlier save confirmation and marks the reset as unsaved, or the reset action persists immediately with fresh confirmation.

Actual: **Reset to default** only changes the local form, but the earlier green **Changes saved — they take effect at the next unlock** toast remains visible. The body becomes empty/**Default**, so the reset appears saved. Reload restores the previous guidance, proving it was never persisted. A second reset followed by the separate **Save changes** action does persist correctly. This can cause an owner to leave the page believing the reset was queued and lose the change.

Evidence: [saved guidance](/Users/claudius/fantasy-bench/e2e/screenshots/reaudit-agents/03-owner-tool-guidance.png), [unsaved reset with stale success toast](/Users/claudius/fantasy-bench/e2e/screenshots/reaudit-agents/04-owner-tool-reset.png), and [reload restores guidance](/Users/claudius/fantasy-bench/e2e/screenshots/reaudit-agents/04b-owner-tool-reset-reloaded.png). Relevant UI: [tool-detail.tsx](/Users/claudius/fantasy-bench/components/config/tool-detail.tsx).

### REAUD-AGENT-02 — P3 — failed-provider trace duplicates a raw diagnostic stack in the UI

During an initial promotion probe, a fresh league still had its default Claude configuration. With no gateway key, its run failed before model execution and fell back at zero cost. The trace detail rendered the complete `Unauthenticated` diagnostic stack twice: once inside the fallback explanation and again as an alert. The text includes internal module paths and runtime frames. No credential, token, request header, or other protected data appeared, so this is error-presentation noise rather than a demonstrated secret disclosure; trace diagnostics may intentionally retain technical detail. The duplicated error wall nevertheless overwhelms the useful run explanation.

Evidence: [failed trace screenshot](/Users/claudius/fantasy-bench/e2e/screenshots/reaudit-agents/11-provider-error-duplicate-stack.png). [trace-view.tsx](/Users/claudius/fantasy-bench/components/traces/trace-view.tsx:136) renders the fallback detail verbatim, then [renders `run.error` separately](/Users/claudius/fantasy-bench/components/traces/trace-view.tsx:158). The attempt was unintended, rejected as unauthenticated before paid model work, and recorded no spend. Every later window was gated on verifying all eight actual team configurations as `mock/scripted`.

## Queued-to-applied follow-up

The previously open promotion gap passed against a fresh league. The commissioner first saved `mock/scripted` on all eight actual team configurations. A regular owner then queued recognizable context and tool versions while the editor was locked. The existing `configs:applyPending` unlock helper promoted pending configurations; every team's reloaded model selector was verified as `mock/scripted` before any window opened.

After one real `forum` window completed, Team 1 history showed the latest version **Applied**, no **Queued** version, and the older immutable versions retained as **Never applied** or **Superseded**. The Team 1 trace recorded **Scripted Mock**, the latest config summary, the recognizable owner context verbatim, 3,600 input/450 output tokens, and **$0.00000** cost. This proves the run consumed the promoted version while the older version records remained in history.

Evidence: [promoted history](/Users/claudius/fantasy-bench/e2e/screenshots/reaudit-agents/08-promoted-version-history.png), [completed mock traces](/Users/claudius/fantasy-bench/e2e/screenshots/reaudit-agents/09-promoted-window-traces.png), and [promoted context and zero-cost trace](/Users/claudius/fantasy-bench/e2e/screenshots/reaudit-agents/10-promoted-run-context-zero-cost.png).

## Passing coverage

- A separately invited regular owner edited only their own team, saved context plus harness changes, reloaded them, and saw the queued immutable version in history. This closes the prior audit's commissioner-only write gap.
- Direct navigation to another team's cooling configuration exposed **Under wraps** and no editor at 390 px, with no horizontal overflow.
- Default-tool guidance saved successfully, and reset persisted when followed by **Save changes**. The finding above concerns stale feedback before that explicit save.
- Invalid negative USD caps and a 999-token weekly cap failed native field validity and did not persist after reload. Valid saved budgets and their spend-panel display passed in the broader retained journey.
- Context draft recovery after debounce, HTTPS-only provider validation, default/custom tool persistence, version comparison, spectator redaction, trace search/detail, usage ledger, and redacted JSON export all passed in production.
- Community voting persisted across reload, switched from +1 to -1, and cleared back to zero. A live anonymous reader received a scoped unavailable state when the commissioner hid the post, while the commissioner retained the hidden content; unhide restored the same reader without reload.
- All numbered screenshots in `e2e/screenshots/reaudit-agents/` and its `community/` child was opened at original detail. No additional clipping, overflow, missing assets, raw Markdown, or error UI was found. The offset sticky navigation in long full-page captures is a Playwright capture artifact rather than the interactive viewport state.

## Commands

- `npx playwright test e2e/tests/reaud-agents-owner.spec.ts --config .cache/qa-production.config.ts --output .cache/test-results-reaud-agents-promotion-pass --workers=1 --trace=off` — 1 passed, including real promotion and the no-cost mock window.
- `npx playwright test e2e/tests/audit-agents.spec.ts e2e/tests/audit-agents-validation.spec.ts e2e/tests/audit-agents-draft.spec.ts --config .cache/qa-production.config.ts --output .cache/test-results-reaud-agents-broad-prod --workers=1 --trace=off` — 3 passed.
- `AUDIT_SCREENSHOTS=e2e/screenshots/reaudit-agents/community npx playwright test e2e/tests/audit-community.spec.ts --config .cache/qa-production.config.ts --output .cache/test-results-reaud-community-prod --workers=1 --trace=off` — 1 passed.

Fresh spec: [reaud-agents-owner.spec.ts](/Users/claudius/fantasy-bench/e2e/tests/reaud-agents-owner.spec.ts). Screenshot directory: [reaudit-agents](/Users/claudius/fantasy-bench/e2e/screenshots/reaudit-agents/).

## Coverage limits

No paid gateway key was available, so valid-key verification, encrypted key lifecycle, paid provider execution, provider redirect behavior during a real call, and cap bypass were not exercised. The custom-provider audit covered browser validation and the retained source/unit protections only. Promotion used the existing direct unlock helper rather than waiting for the weekly wall clock, but the subsequent window and trace used the real scheduler/runtime path. Community coverage used an existing scripted post; deletion, hidden/deleted bookmarks, nested-comment moderation, unusual Markdown beyond the retained Awards list, and large-board pagination were not independently fixture-generated. Physical devices, non-Chromium browsers, and the 21-day public reveal were outside this run.
