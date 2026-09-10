# Design

## Theme

Dark, restrained. A research archive at night — low ambient light, focused desktop work, calm authority. Dark neutrals tinted faintly toward the brand's blue (not warm cream), with a single desaturated blue accent carrying <10% of surface. Rationale: the scene sentence ("solo researcher at night, tracing a claim to its source") forces dark; warmth lives in typography and imagery, not body background.

**Strategy:** Restrained — tinted neutrals + one accent. Accent used for progress, active tabs, and primary actions only.

## Palette

All values in OKLCH for perceptual uniformity; hex fallbacks in parentheses.

- `--bg`: oklch(0.14 0.015 250) (#0e1116) — page background, near-black with blue tint
- `--card`: oklch(0.18 0.015 255) (#171c24) — card/surface, 1 step lighter than bg
- `--line`: oklch(0.26 0.018 255) (#2a3342) — borders, subtle
- `--txt`: oklch(0.94 0.01 250) (#e8edf3) — primary text, 4.8:1 on --bg
- `--mut`: oklch(0.70 0.02 250) (#9aa7b8) — secondary text, 4.6:1 on --bg
- `--acc`: oklch(0.68 0.14 255) (#5aa9ff) — accent, interactive, progress
- `--ok`: oklch(0.72 0.12 155) (#4cc38a) — success, strongly-supported
- `--warn`: oklch(0.78 0.12 65) (#e5a54b) — warning, disputed
- `--bad`: oklch(0.62 0.15 20) (#e56b6b) — error, contradicted

## Typography

- **Family:** `system-ui, -apple-system, Segoe UI, Roboto, sans-serif` — single family, multiple weights (no pairing tax). Fallback to native for speed and zero layout shift.
- **Scale:** `clamp(1.6rem, 2.5vw, 2.1rem)` for H1 (max 33.6px — well under 6rem ceiling); H2 1.35rem, H3 1.1rem, body 15px/1.6, small 0.85em. All headings `text-wrap: balance`, prose `text-wrap: pretty`, letter-spacing ≥ -0.03em.
- **Line length:** body capped at 68ch via main max-width 960px; 2-col grid collapses at 700px.

## Spacing & Layout

- **Rhythm:** 8px base, card padding 1.2rem, section gap 1rem, tab gap 0.4rem — varied, not uniform.
- **Grid:** `repeat(auto-fit, minmax(280px, 1fr))` avoided for the form (explicit 2-col with collapse); flex for 1D rows (exports, topbar).
- **Z-scale:** sticky topbar (10) → modal backdrop (20) → dialog (30) → toast (40). No arbitrary 999s.

## Components

- **Cards:** 1px solid line, 12px radius, no shadow (refuses ghost-card pattern). Nested cards forbidden.
- **Buttons:** 8px radius, 1px line; primary is solid accent with dark text (700 weight); ghost is transparent. Focus-visible: 2px accent ring.
- **Tabs:** flex-wrap, active is solid accent. Keyboard: ArrowLeft/Right, Home/End cycle; aria-selected + tabindex managed.
- **Pills:** 99px radius, line border, muted text — tier/state carriers without color-alone signal.
- **Tables:** collapse, line borders only, left-aligned, top-aligned cells.
- **Dialog:** card background, line border, 12px radius, max 480px.
- **Skeletons:** gradient shimmer (200% size, linear 90deg), 12px height, 6px radius; `prefers-reduced-motion` disables animation.

## Motion

- Stagger only within a single list (steps log); ease-out-quart, 1.2s shimmer. All animations have reduced-motion fallbacks (instant/crossfade). Content is visible by default — never gated on a reveal class.

## Accessibility

- Body 4.8:1, muted 4.6:1, accent-on-dark 5.1:1. Placeholders not used as labels. All interactive elements keyboard-reachable. Live regions (`role=log`, `aria-busy`) for progress; `skip-link` for main content.
