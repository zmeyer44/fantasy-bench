# Landing hero helmet

- Asset: `public/images/hero-helmet.png`
- Generated with the built-in image generation tool; the tool does not expose a model selector or model identity, so GPT Image 2.5 could not be verified.
- Original: 1254 × 1254 PNG, with a verified alpha channel. The original output is copied unchanged; Next Image supplies responsive optimized versions.
- Supporting construction grid, registration marks, football field, and blue panel are native SVG/CSS in `components/landing/hero-art.tsx` and `hero.module.css`.

## Generation prompt

Create a production website hero asset, a single American football helmet isolated on a genuinely transparent background with alpha. Use case: product-mockup. Square canvas, helmet nearly fills canvas with 5% breathing room. Three quarter view facing right, camera at helmet eye level, entire helmet including face guard visible. Precisely split vertically at the middle: left half photorealistic matte white/light gray helmet shell, subtle scratches, small black minimalist interlocking FB monogram on left side, white metal face cage, dark interior. Right half is the exact continuation of the same helmet rendered in electric cobalt blue with fine luminous icy blue wireframe mesh contour lines, dark navy interior and blue face cage. Hard vertical clean division, no gap, continuous aligned geometry. Dramatic premium studio product photography, bright white upper left lighting, extremely detailed realistic hardware. Reference aesthetic: scientific football equipment scan, stark editorial sports campaign. ONLY the helmet, NO background panels, NO grid outside helmet, NO words, NO labels, NO pedestal, NO shadow outside object. Transparent background essential.

## Browser verification

Run `npx playwright test e2e/tests/landing-hero.spec.ts`. Playwright is added as a development dependency; no production dependency is added.

Screenshots are written to the ignored directory `e2e/screenshots/landing-hero/`. Each viewport has a full-page capture and a `-hero.png` capture including the header.

| Screenshot | Viewport | Visual review |
| --- | --- | --- |
| desktop-reference-hero.png | 1672 × 941 | Three-line headline, full helmet, blue panel and annotations align with the reference composition. Existing new FB header logo retained. |
| laptop-hero.png | 1280 × 800 | Both columns remain balanced; buttons and annotations fit. |
| tablet-landscape-hero.png | 1024 × 768 | Compact two-column layout, no clipped headline or buttons. |
| tablet-portrait-hero.png | 768 × 1024 | Artwork stacks beneath the copy; menu replaces desktop navigation. |
| mobile-hero.png | 390 × 844 | Full-width copy, two visible actions, complete helmet below. |
| small-mobile-hero.png | 320 × 740 | Brand name wraps, navigation fits, headline and both actions remain in bounds. |
| mobile-menu.png | 390 × 844 | Open navigation sheet displays League, Docs, Leaderboard, and Log in. |
| docs-section.png | 390 × 844 | Docs closes the menu and scrolls to the existing How it works section. |
| join-login.png | 390 × 844 | Join a league reaches the real authentication form. |

The browser test verifies image loading, horizontal overflow, action bounds, mobile navigation dismissal, destination links, and absence of uncaught page errors. Leaderboard points to the existing `/bench` destination, whose cross-league rankings remain a planned product feature. No new leaderboard backend was introduced.
