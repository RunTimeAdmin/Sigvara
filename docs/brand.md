# Sigvara Brand Identity

## CSS and Layout Styling Guide

**Brand:** Sigvara
**Primary use:** Protocol website, developer documentation, dashboards, SDK surfaces, and social assets
**Visual position:** Calm, technical, verifiable, and quietly futuristic
**Core idea:** Make machine trust legible

## 1. Design principles

Sigvara should look like infrastructure that can be trusted. The interface must feel precise without becoming sterile, and advanced without relying on noisy crypto visual language.

Use dark surfaces, restrained borders, luminous signal colors, and generous spacing. Put information inside clear systems. Let gradients and glow identify active trust signals rather than decorate every component.

The visual language should communicate three ideas:

- **Identity:** a distinct mark, stable naming, and clear provenance.
- **Signal:** violet-to-cyan gradients, status indicators, score bars, and directional lines.
- **Accountability:** structured cards, explicit states, evidence, and readable metadata.

Avoid gold-on-black finance styling, generic neon cyberpunk, excessive glassmorphism, cartoon mascots, and unbounded gradients. Sigvara is trust infrastructure, not a trading interface.

## 2. Color system

### Core tokens

```css
:root {
  --sig-bg: #090b16;
  --sig-bg-soft: #0f1221;
  --sig-surface: #121629;
  --sig-surface-raised: #181c31;

  --sig-text: #f5f7ff;
  --sig-text-soft: #c4cbe0;
  --sig-text-muted: #9ca5bf;
  --sig-text-faint: #6d7691;

  --sig-violet: #9b7cff;
  --sig-violet-bright: #b8a5ff;
  --sig-violet-pale: #d7cfff;
  --sig-cyan: #6fe5ea;
  --sig-mint: #a3f1c6;
  --sig-orange: #ffbf7a;

  --sig-line: rgba(154, 166, 220, 0.15);
  --sig-line-strong: rgba(154, 166, 220, 0.28);
  --sig-danger: #ff8585;

  --sig-gradient-signal: linear-gradient(
    110deg,
    #c5b7ff 5%,
    #9b7cff 47%,
    #6fe5ea 100%
  );
  --sig-gradient-action: linear-gradient(135deg, #c5b7ff, #8f71ff);
}
```

### Usage rules

| Token group | Use |
| --- | --- |
| `--sig-bg` | Page background and full-bleed shells |
| `--sig-bg-soft` | Code blocks, recessed controls, and secondary surfaces |
| `--sig-surface` | Cards, navigation panels, and content containers |
| `--sig-text` | Primary headlines and important values |
| `--sig-text-soft` | Lead copy and selected metadata |
| `--sig-text-muted` | Descriptions, labels, and supporting text |
| `--sig-violet` | Primary action, active state, and brand emphasis |
| `--sig-cyan` | Live status, verification, network, and positive signal accents |
| `--sig-mint` | Confirmed success and verified states |
| `--sig-orange` | Caution, pending review, or non-fatal warning |
| `--sig-line` | Default dividers and borders |
| `--sig-line-strong` | Hover borders, focused controls, and highlighted containers |

### Background recipe

Use layered radial gradients over `--sig-bg` to establish depth without adding an image dependency.

```css
.sig-page {
  background:
    radial-gradient(900px 520px at 74% -10%,
      rgba(123, 93, 255, .20), transparent 66%),
    radial-gradient(700px 500px at -8% 34%,
      rgba(50, 157, 190, .10), transparent 64%),
    var(--sig-bg);
}
```

Keep the strongest color concentration near the hero or active state. Do not place bright gradients behind dense body copy.

## 3. Typography

Use a system sans stack for the primary interface. This keeps the site fast and makes the brand portable across documentation, dashboards, and wallets.

```css
:root {
  --sig-font-sans: Inter, ui-sans-serif, system-ui, -apple-system,
    BlinkMacSystemFont, "Segoe UI", sans-serif;
  --sig-font-mono: "SFMono-Regular", Consolas,
    "Liberation Mono", monospace;
}

body {
  font-family: var(--sig-font-sans);
  color: var(--sig-text);
  -webkit-font-smoothing: antialiased;
}

code,
.mono,
[data-mono="true"] {
  font-family: var(--sig-font-mono);
}
```

### Type scale

| Role | Desktop | Mobile | Weight | Letter spacing |
| --- | --- | --- | --- | --- |
| Hero title | `clamp(48px, 7vw, 86px)` | `clamp(47px, 15vw, 72px)` | 750 | `-0.065em` |
| Section title | `clamp(30px, 4vw, 48px)` | `32–40px` | 700 | `-0.055em` |
| Card title | `17px` | `17px` | 700 | `-0.02em` |
| Lead paragraph | `clamp(17px, 2vw, 20px)` | `17px` | 400 | normal |
| Body | `14–15px` | `14px` | 400 | normal |
| Metadata | `10–12px` | `10–12px` | 500–700 | `.08–.14em` |

Headlines should be compact and confident. Body copy should remain readable and should not use the violet gradient. Use the gradient only for short emphasis, a key phrase, or a primary signal.

```css
.sig-gradient-text {
  color: var(--sig-violet-bright);
  background: var(--sig-gradient-signal);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}
```

## 4. Logo and avatar system

The primary mark is an **S-shaped signal path** with two endpoint nodes. The path represents a signed signal moving between identity and outcome. The endpoints make the shape recognizable at small sizes.

The master avatar is `site/assets/sigvara-avatar.svg`. Use it for:

- Browser favicon.
- Social profile image.
- Open Graph preview image.
- GitHub organization or repository avatar.
- Product shell icon.

### Mark rules

- Preserve the square silhouette and rounded outer field.
- Keep the two endpoint nodes visible.
- Use the violet-to-cyan gradient on dark backgrounds.
- Do not add text inside the avatar.
- Do not flatten the mark into a generic checkmark or shield.
- Do not use the mark on a busy photographic background.
- Maintain clear space equal to at least 20% of the mark width.

### Inline SVG sizing

```css
.sig-brand-mark {
  width: 34px;
  height: 34px;
  filter: drop-shadow(0 0 18px rgba(155, 124, 255, .34));
}

.sig-avatar {
  width: 48px;
  height: 48px;
  border-radius: 15px;
}
```

Use a 32–36px mark in navigation, 40–56px in cards, and 96px or larger only for profile/avatar contexts.

## 5. Layout system

### Container

```css
.sig-wrap {
  width: min(1160px, calc(100% - 40px));
  margin-inline: auto;
}

@media (max-width: 650px) {
  .sig-wrap {
    width: min(100% - 30px, 560px);
  }
}
```

The 1160px maximum keeps protocol pages readable while allowing two-column hero layouts. Use the 30px mobile gutter consistently; do not let cards touch the viewport edge.

### Spacing scale

Use a small, predictable spacing system. Prefer these values over one-off margins:

```css
:root {
  --sig-space-1: 4px;
  --sig-space-2: 8px;
  --sig-space-3: 12px;
  --sig-space-4: 16px;
  --sig-space-5: 20px;
  --sig-space-6: 24px;
  --sig-space-7: 32px;
  --sig-space-8: 40px;
  --sig-space-9: 48px;
  --sig-space-10: 64px;
  --sig-space-11: 88px;
}
```

Use 88px vertical section spacing on desktop and 64–68px on mobile. Use 14–16px gaps for repeated cards. Use 24–40px internal padding for major content blocks.

### Grid patterns

```css
.sig-hero-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.05fr) minmax(380px, .95fr);
  gap: 76px;
  align-items: center;
}

.sig-three-up {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 14px;
}

@media (max-width: 860px) {
  .sig-hero-grid {
    grid-template-columns: 1fr;
    gap: 35px;
  }
}

@media (max-width: 650px) {
  .sig-three-up {
    grid-template-columns: 1fr;
  }
}
```

Use a single dominant reading direction. On mobile, stack the hero copy before the visual and stack cards vertically.

## 6. Surfaces, borders, and elevation

Sigvara surfaces should feel layered rather than glossy. Use translucent panels only where the background remains quiet enough to preserve text contrast.

```css
.sig-card {
  border: 1px solid var(--sig-line);
  border-radius: 20px;
  background: linear-gradient(
    145deg,
    rgba(24, 28, 49, .78),
    rgba(14, 17, 30, .65)
  );
}

.sig-card-raised {
  border-color: rgba(174, 166, 255, .26);
  background: linear-gradient(
    145deg,
    rgba(28, 31, 57, .92),
    rgba(14, 17, 31, .90)
  );
  box-shadow: 0 24px 80px rgba(0, 0, 0, .32),
    0 0 60px rgba(116, 83, 255, .12);
  backdrop-filter: blur(14px);
}
```

Recommended radius values:

- Buttons and compact controls: `10–12px`.
- Cards: `18–22px`.
- Pills and status labels: `999px`.
- Do not use excessive rounding on tables or dense developer interfaces.

## 7. Navigation

Navigation should be quiet and low density. The brand mark and wordmark remain the strongest visual element. Use text links for secondary destinations and one rounded outline CTA for updates or access.

```css
.sig-nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding-block: 24px;
}

.sig-nav-links {
  display: flex;
  align-items: center;
  gap: 26px;
  color: var(--sig-text-muted);
  font-size: 13px;
}

.sig-nav-links a {
  text-decoration: none;
  transition: color .2s ease;
}

.sig-nav-links a:hover {
  color: var(--sig-text);
}
```

On screens below 650px, hide secondary links or replace them with a compact menu. Keep the primary CTA visible.

## 8. Buttons and actions

Primary actions use the violet gradient. Secondary actions use a transparent dark surface with a visible border. Never use the same visual weight for both.

```css
.sig-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
  min-height: 44px;
  padding: 13px 18px;
  border-radius: 11px;
  font-size: 14px;
  font-weight: 650;
  text-decoration: none;
  transition: transform .2s ease, border-color .2s ease,
    background .2s ease, box-shadow .2s ease;
}

.sig-button:hover {
  transform: translateY(-2px);
}

.sig-button-primary {
  color: #0b0c18;
  background: var(--sig-gradient-action);
  box-shadow: 0 10px 30px rgba(139, 106, 255, .24);
}

.sig-button-secondary {
  color: var(--sig-text);
  border: 1px solid var(--sig-line-strong);
  background: rgba(255, 255, 255, .035);
}

.sig-button-secondary:hover {
  border-color: var(--sig-violet);
  background: rgba(155, 124, 255, .09);
}
```

Buttons must have a visible keyboard focus state.

```css
.sig-button:focus-visible,
a:focus-visible,
button:focus-visible {
  outline: 3px solid rgba(111, 229, 234, .55);
  outline-offset: 3px;
}
```

## 9. Status, verification, and score components

Use cyan for live network status and mint for a confirmed verification state. Do not use color alone to communicate status; include a label or icon.

```css
.sig-status {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--sig-text-muted);
  font-size: 13px;
}

.sig-status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--sig-cyan);
  box-shadow: 0 0 0 5px rgba(111, 229, 234, .10),
    0 0 24px rgba(111, 229, 234, .65);
}

.sig-verified {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--sig-mint);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .04em;
}

.sig-score {
  font-size: 48px;
  line-height: .9;
  letter-spacing: -.07em;
  font-weight: 750;
}
```

For progress bars, use a neutral recessed track and a violet-to-cyan fill. Provide a numeric value in addition to the bar.

```css
.sig-progress-track {
  height: 5px;
  overflow: hidden;
  border-radius: 999px;
  background: #242841;
}

.sig-progress-fill {
  height: 100%;
  border-radius: inherit;
  background: var(--sig-gradient-signal);
}
```

## 10. Hero visual language

The hero may use an abstract orbit or signal field behind a primary verification card. The visual should support the message rather than compete with it.

Recommended elements:

- One soft violet radial glow.
- One or two thin elliptical orbit lines.
- One cyan signal node.
- One raised verification card.
- No more than three simultaneous animated elements.

```css
.sig-hero-visual {
  position: relative;
  min-height: 440px;
  display: grid;
  place-items: center;
}

.sig-orb {
  position: absolute;
  width: 430px;
  height: 430px;
  border-radius: 50%;
  background: radial-gradient(
    circle at 42% 37%,
    rgba(155, 124, 255, .22),
    rgba(70, 46, 169, .08) 44%,
    transparent 70%
  );
}
```

Motion should be optional. Respect `prefers-reduced-motion` and keep the product useful when animation is disabled.

## 11. Data and developer surfaces

Developer-facing views should prioritize legibility over visual effects.

Use:

- Monospace for addresses, chain IDs, transaction hashes, and raw identifiers.
- 13–14px body text for metadata tables.
- `--sig-bg-soft` for code blocks.
- Explicit copy buttons for long addresses.
- Human-readable labels next to raw values.
- Chain name and chain ID together for every deployment-specific value.

```css
.sig-code {
  overflow-x: auto;
  padding: 14px 16px;
  border: 1px solid var(--sig-line);
  border-radius: 10px;
  color: var(--sig-text-soft);
  background: var(--sig-bg-soft);
  font: 13px/1.65 var(--sig-font-mono);
}
```

Never hide network context. A contract address without its chain is incomplete information.

## 12. Accessibility and contrast

The dark visual system must remain usable without relying on glow or color nuance.

- Use `--sig-text` for primary text and `--sig-text-muted` only for supporting text.
- Pair every status color with a word such as **Verified**, **Pending**, or **Failed**.
- Use visible keyboard focus outlines.
- Preserve a minimum 44px hit area for primary controls.
- Provide meaningful `aria-label` text for icon-only buttons and marks.
- Include alternative text for diagrams or explanatory visuals.
- Do not use thin violet text on the darkest background for important content.
- Respect `prefers-reduced-motion`.

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: .01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: .01ms !important;
    scroll-behavior: auto !important;
  }
}
```

## 13. Responsive behavior

Use three practical layout ranges:

| Range | Behavior |
| --- | --- |
| `> 860px` | Two-column hero, three-up cards, full navigation |
| `650–860px` | Single-column hero, full-width content blocks, reduced visual gap |
| `< 650px` | Stacked cards, compact navigation, 30px page gutter, reduced section spacing |

Do not simply shrink desktop typography. Recompose the layout so the headline, visual, and primary action remain in a clear order.

## 14. Content and voice

Sigvara copy should be direct, technically credible, and outcome-oriented.

Prefer:

- "Make machine trust legible."
- "Signed identity."
- "Computed reputation."
- "Stake-backed action."
- "Read an agent's score before routing a task."
- "Built on ERC-8004. Deploying on Arc."

Avoid:

- "Revolutionary decentralized intelligence."
- "The future of Web3 trust."
- "Unstoppable AI."
- Claims that imply a live `did:sigvara` method before it exists.
- Claims that imply Sigvara is owned or operated by Arc or Circle.
- Claims about a token, a launch, or a bond asset before that decision is made.

## 15. Implementation checklist

- [ ] Add the token variables to the shared stylesheet (`site/assets/style.css`).
- [ ] Replace one-off colors with named Sigvara tokens.
- [ ] Add `sigvara-avatar.svg` as favicon and social image on every page.
- [ ] Use the S-shaped signal mark consistently across navigation and cards.
- [ ] Implement the 1160px container and 30px mobile gutter.
- [ ] Add visible focus states to all links, buttons, and controls.
- [ ] Add reduced-motion handling.
- [ ] Test text contrast and mobile wrapping.
- [ ] Verify the visual hierarchy at 320px, 768px, and 1440px widths.
- [ ] Confirm no page carries legacy branding.
- [ ] Confirm Arc and chain IDs are shown wherever network-specific data appears.

## References

- [Sigvara source repository](https://github.com/RunTimeAdmin/sigvara)
- [Arc RPC endpoints and network parameters](https://docs.arc.io/arc/references/rpc-endpoints)
- [Arc wallet connection and network configuration](https://docs.arc.io/arc/references/connect-to-arc)
- [Arc contract addresses and native USDC model](https://docs.arc.io/arc/references/contract-addresses)
