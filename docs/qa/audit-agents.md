# Agent customization QA audit

## Follow-up resolution — 2026-09-09

The findings below are preserved as the original audit record. The implementation and development Convex deployment were subsequently brought into sync, and the complete owner/spectator journey passed against the final webpack production build at `http://localhost:3301`.

- **AGENT-01 resolved:** `configs.saveToolOverride` is deployed and covered by integration tests. A real owner-guidance edit displayed the saved status, survived reload, and produced a queued immutable version with the submitted change summary. The tool page now keeps a stable client key across its server refresh, so the success toast remains visible instead of being immediately remounted away. Final evidence: [saved default tool](/Users/claudius/fantasy-bench/e2e/screenshots/audit-agents/09-owner-default-tool-saved.png) and [version history](/Users/claudius/fantasy-bench/e2e/screenshots/audit-agents/07-owner-version-history.png).
- **AGENT-02 verified settled:** the final anonymous mobile pages waited for authentication hydration and rendered Get started without horizontal overflow. The original transient screenshot remains below as historical evidence and stays deduplicated with ONB-06.
- **AGENT-03 resolved:** the shared empty-state title is now an `h2`. Production assertions locate **Under wraps** and **403 — commissioner only** as headings. Evidence: [spectator redaction](/Users/claudius/fantasy-bench/e2e/screenshots/audit-agents/15-spectator-agent-under-wraps-mobile.png) and [commissioner boundary](/Users/claudius/fantasy-bench/e2e/screenshots/audit-agents/17-spectator-settings-forbidden-mobile.png).
- **Custom-provider transport review resolved:** the form and server reject non-HTTPS URLs, malformed URLs, embedded credentials, and header values containing CR/LF. Runtime calls independently fail closed for legacy insecure records and refuse redirects so configured headers cannot be forwarded to an unexpected origin. Evidence: [HTTPS validation](/Users/claudius/fantasy-bench/e2e/screenshots/audit-agents/21-custom-tool-https-validation.png).

Final production command:

`npx playwright test e2e/tests/audit-agents.spec.ts --config .cache/qa-production.config.ts --output .cache/test-results-audit-agent-production-final-2 --workers=1 --trace=off` — **1 passed**. The journey covers save feedback, reload persistence, version history, custom-tool state, commissioner budgets, spectator cooldown redaction, settings authorization, trace search/detail, and redacted JSON export with no uncaught page errors. The focused HTTPS browser validation also passed against the production build. The integrated automated suite reported **649 passing tests across 52 files**, with TypeScript and ESLint clean.

All **21 PNG files** currently retained in [e2e/screenshots/audit-agents](/Users/claudius/fantasy-bench/e2e/screenshots/audit-agents/) were opened at original detail and visually reviewed after the final run. This count includes the original audit states retained for history as well as the final production evidence.

## Original audit record

Audited 2026-09-09 in Chromium against the local Next development app at `http://localhost:3000`. The draft-recovery check was repeated against the production build at `http://localhost:3301`. Desktop coverage used 1440 × 1000 and mobile coverage used 390 × 844.

Writes were confined to one purpose-built QA account and league. Its reusable credentials and IDs live in ignored `.cache/qa-agents.json`; no live fixture credentials are tracked. The configured model was `mock/scripted`, so no LLM request or model cost was incurred. The custom-tool test used the public JSONPlaceholder fixture and a non-secret placeholder header.

## Confirmed findings

### AGENT-01 — Release blocker — default-tool customizations cannot be saved in the running deployment

**Reproduction**

1. Sign in as a team editor or commissioner.
2. Open **Agent → Tools → search_players**.
3. Enter owner guidance and a change summary.
4. Select **Save changes**.

**Expected:** A new configuration version is applied or queued, and the tool guidance persists.

**Observed:** The page remains dirty and displays `[CONVEX M(configs:saveToolOverride)] ... Could not find public function for 'configs:saveToolOverride'. Called by client`.

The client calls the mutation at [components/config/tool-detail.tsx](/Users/claudius/fantasy-bench/components/config/tool-detail.tsx:99), and the source tree exports it at [convex/configs.ts](/Users/claudius/fantasy-bench/convex/configs.ts:634). This is consistent with a Convex deployment/codegen mismatch in the environment rather than a missing source implementation. It blocks all default-tool on/off and owner-guidance saves in this environment.

Evidence: [09-owner-default-tool-save-error.png](/Users/claudius/fantasy-bench/e2e/screenshots/audit-agents/09-owner-default-tool-save-error.png)

### AGENT-02 — Low, duplicate of ONB-06 — the mobile auth placeholder briefly creates horizontal page overflow

**Reproduction**

1. Open the anonymous team configuration URL at a 390 px viewport.
2. Compare `document.documentElement.scrollWidth` with `window.innerWidth`.

**Expected:** The document stays within the viewport and does not pan horizontally.

**Observed during auth hydration:** `scrollWidth` is 394 px while `innerWidth` is 390 px. DOM measurement isolates the right edge of the account/menu wrapper and its 28 px mobile menu button at 394.1875 px. Both screenshots still show the auth placeholder rather than Get started. The shared wrapper begins at [components/site-nav.tsx](/Users/claudius/fantasy-bench/components/site-nav.tsx:164).

**Settled production verification:** the coordinating audit waited for Get started and loaded fonts on the same anonymous config route. The document then measured 390 px and the menu's right edge was 374 px. This is the same transient placeholder issue as ONB-06, not a separate persistent configuration-page bug. The persistent landing overflow is separately documented as NAV-12. Evidence: [settled production header](/Users/claudius/fantasy-bench/e2e/screenshots/audit-navigation/19-agent-header-settled-production.png).

Evidence: [15a-spectator-agent-hydrating-mobile.png](/Users/claudius/fantasy-bench/e2e/screenshots/audit-agents/15a-spectator-agent-hydrating-mobile.png), plus [settled production header](/Users/claudius/fantasy-bench/e2e/screenshots/audit-navigation/19-agent-header-settled-production.png).

### AGENT-03 — Medium accessibility — empty and permission states expose their titles only as generic text

**Reproduction**

1. As an anonymous spectator, open a newly customized team's configuration and then its league settings URL.
2. Inspect the accessibility tree for **Under wraps** and **403 — commissioner only**.

**Expected:** Each page-level state title is exposed as a heading so assistive-technology users can navigate to and identify the state.

**Observed:** Both strings are visible but neither has heading semantics. The shared `EmptyTitle` primitive renders a `div` at [components/ui/empty.tsx](/Users/claudius/fantasy-bench/components/ui/empty.tsx:57). The settings-denied page consequently has no content heading at all.

Evidence: [15-spectator-agent-under-wraps-mobile.png](/Users/claudius/fantasy-bench/e2e/screenshots/audit-agents/15-spectator-agent-under-wraps-mobile.png), [17-spectator-settings-forbidden-mobile.png](/Users/claudius/fantasy-bench/e2e/screenshots/audit-agents/17-spectator-settings-forbidden-mobile.png)

## Security review item

The custom-provider validator accepts both HTTPS and plain HTTP endpoints at [convex/custom_tools.ts](/Users/claudius/fantasy-bench/convex/custom_tools.ts:113), while the same form accepts arbitrary request-header values. An HTTP endpoint can expose those header values in transit. This audit did not send a plaintext request or attempt private-network access, so this is source-confirmed behavior and a review item rather than a demonstrated exploit. Require HTTPS if authenticated headers are an intended use case.

## Passing coverage

- Created and reused an isolated QA account and public league without touching demo records.
- Saved a context, public skill, note, `mock/scripted` model, max steps, per-run token budget, temperature, and deliberate-mode choice during a locked edit window. The app queued version 2 and preserved every value after reload.
- Previewed skill Markdown, published and attached the skill, and confirmed the owner note was appended to the next saved context and cleared from the note field.
- Verified immutable version history and first-to-latest comparison for model, harness, skills, context, and folded-in note. Anonymous spectators saw cooldown redaction and no compare link.
- Verified production draft recovery after the 600 ms debounce: the `fb:draft:` localStorage record appeared, reload showed the recovery banner, and **Restore** recovered the draft. An earlier development-only observation made before a settled debounce was discarded and is not treated as a bug.
- Verified model capability behavior: `mock/scripted` hides reasoning effort because the selected model does not support it. The gateway-key input correctly keeps **Verify & save key** disabled when blank.
- Verified malformed custom header `Bad Header` is rejected, corrected `X-QA-Token` succeeds, the live endpoint test returns `OK — 83 bytes returned`, and the created custom tool remains disabled after reload. The owner tools page did not overflow at 390 px.
- Saved commissioner caps of $0.75 per team per week, 50,000 tokens per team per week, and $12.34 for the league. Reload preserved them and the team spend meters reflected all three.
- Verified anonymous access boundaries: a cooling configuration renders **Under wraps** without an editor; history withholds private details; direct settings access renders `403 — commissioner only`.
- On the seeded demo league, verified trace search persists `q=set_lineup` in the URL, trace detail shows usage and committed actions, cooling owner context is redacted, and JSON export returns HTTP 200 with attachment headers, schema version 1, steps, and the redacted owner-context placeholder.
- The retained Playwright specs report no uncaught browser `pageerror` events in the covered owner/editor or spectator journeys.

## Limits and blocked flows

- AGENT-01 prevented persistence testing for default-tool enable/disable and guidance. Source presence was confirmed, but changing or deploying the backend was outside this audit.
- No disposable valid Vercel AI Gateway key was available. Key verification, encrypted storage, removal, and cap bypass were not exercised.
- The isolated league intentionally ran no agent windows to avoid external model calls. Trace search/detail/export used seeded demo runs read-only; a separate owner-only trace-detail journey was not created.
- Post-cooldown public reveal was not exercised because it requires 21 days or changing persisted timestamps.
- The editor role exercised for writes was the isolated league commissioner. A separately owned team was not modified, so owner-specific authorization distinct from commissioner authorization remains unverified.

## Automation and evidence

- `npx playwright test e2e/tests/audit-agents.spec.ts --project=chromium --output=test-results/audit-agents` — **1 passed**
- `npx playwright test e2e/tests/audit-agents-draft.spec.ts --project=chromium --output=test-results/audit-agents-draft` — **1 passed** against the production server

The retained tests skip cleanly when ignored `.cache/qa-agents.json` is absent. Screenshots are under [e2e/screenshots/audit-agents](/Users/claudius/fantasy-bench/e2e/screenshots/audit-agents/); every retained image was opened and visually reviewed. The misleading pre-debounce draft screenshot was removed.
