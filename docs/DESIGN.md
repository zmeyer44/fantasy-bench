# Design system

Fantasy Bench's UI is built on shadcn components over Base UI (`components/ui/*`,
configured in `components.json` with the `base-nova` style), styled with Tailwind v4
tokens declared in `app/globals.css`. The visual language follows the Geist/Vercel
guidelines for the product surfaces and the brand mockups for the landing page.

## Tokens

The product is dark only (`color-scheme: dark`; `.dark` is set on `<html>` so shadcn's
`dark:` variants resolve). Every colour is a token; do not introduce literals.

| Role | Token classes | Use |
| --- | --- | --- |
| Canvas, surfaces | `bg-background`, `bg-card`, `bg-muted`, `bg-popover`, `bg-accent` | `accent` is the hover surface only |
| Text | `text-foreground`, `text-muted-foreground`, `text-ink-faint` | three steps of grey |
| Rules | `border-border`, `border-line-strong` | hairline, and one step stronger |
| Lime (brand, action) | `bg-primary`, `text-brand`, `bg-brand-soft`, `border-brand`, `text-brand-strong` | primary button, active state, open windows, positive deltas |
| Blue (data) | `text-blue`, `bg-blue-soft`, `text-blue-strong`, `var(--chart-2)` | informational marks, second chart series, blueprint art |
| Status | `text-destructive`, `text-warning`, `text-success` | never as decoration |

Lime is the colour of action and belongs on one thing per view. Everything else is
monochrome. Radius is 4px (`--radius`); labels are square, not pills.

## Type

- Geist Sans for prose, labels, controls, tables. Body is 14px; never shrink reading
  copy below 12px.
- Geist Mono for identifiers, timestamps, model ids, token counts, money, and the
  small sentence-case `.eyebrow` label used for section markers, stat labels and
  table headers. Its tracked uppercase form, `.eyebrow-caps`, is reserved for brand
  surfaces (landing page and its nav, auth plate) and the single lime kicker above a
  page or panel title. Badges and table headers are sentence case too; the lime
  `brand` button and Russo One display type are the only other caps in the product.
- Russo One (`.display`, `--font-display`) is the brand display face. Landing page,
  wordmark, and auth plate only.

## Composition rules

- Group with spacing and rules (`Section` + `SectionHeader`, `PageHeader`), not
  cards in cards. `Card` is for a genuinely bounded object (a matchup, a trade).
- Tables span their section. Numeric columns pass `numeric` on both `TableHead` and
  `TableCell` so header and cell alignment match.
- Peer statistics use `StatStrip` + `Stat`.
- Buttons that navigate use `<Button render={<Link href=… />}>`; never nest a
  button in a link. Base UI buttons need an explicit `type="button"` inside forms.
- Native `<select>`s use `NativeSelect`; the composite `Select` is for rich menus.
- Status → badge: `success` (lime), `info` (blue), `warning`, `destructive`,
  `secondary` (neutral fill), `outline` (neutral metadata). `default` is solid lime
  and is rare. One badge per row is the norm: the thing that changes colour. Facts
  that never change colour (a model, a config version, a cost) are plain mono text
  or live on the detail page, not a string of outline tags.

## Brand assets

`components/brand/logo.tsx` holds the FB monogram (`LogoMark`) and the
`Wordmark`; `app/icon.svg` is the favicon. Landing-page art lives in
`components/landing/`.

## Markdown editor

`components/editor/markdown-editor.tsx` is the editor owners use for agent context and
skill bodies (`kind="context" | "skill"` picks the Insert scaffolds in `snippets.ts`).
It is a native textarea, so undo, IME, and spellcheck are the browser's; the toolbar and
shortcuts are pure transforms in `markdown-commands.ts` (unit-tested) applied as one
native edit so ⌘Z still works. It offers Write / Split / Preview, fullscreen, a status
bar with the commissioner's character limit and a token estimate, and localStorage draft
recovery keyed by `draftKey`; call `clearDraft(key)` after a successful save.

## NFL club logos

All 32 club marks are self-hosted at `public/nfl/<ABBR>.svg` (Sleeper abbreviations, the
app's canonical team ids). `lib/nfl-teams.ts` maps any feed token to name, short name,
brand colour, and logo path; `components/nfl/team-logo.tsx` renders `TeamLogo`,
`TeamTag` (logo + abbreviation), and `OpponentTag` (keeps the `@` prefix). Anything that
names a player's club should use these rather than the raw abbreviation.
