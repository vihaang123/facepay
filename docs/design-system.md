# FacePay design system

Source of truth: `frontend/src/index.css` (tokens, type scale, motion) and `frontend/src/components/ui.jsx` (components).
Look: calm, white-space-led, Apple-minimal in layout, with Indian UPI-app familiarity (large rupee amounts, bank rows, simple
primary actions). Not a copy of any existing app's visual identity.

## Tokens
Components never hardcode a colour. Every colour is a semantic token with a light and a dark value, switched by
`<html data-theme="light|dark">`.

| Token | Light | Dark | Use |
|---|---|---|---|
| canvas | #F7F8FA | #0B0D12 | page background |
| surface | #FFFFFF | #141821 | cards |
| elevated | #FFFFFF | #1B2230 | sheets, dialogs, menus |
| fg / muted | #101828 / #667085 | #F9FAFB / #A1A1AA | primary and secondary text |
| line | #EAECF0 | #293142 | hairline borders |
| field | #858D9D | #6B7488 | input and checkbox borders (3:1 against the surface) |
| brand-700 | #4F46E5 | #818CF8 | THE action colour (hover brand-800) |
| success / warning / danger | #16A36A / #D97706 / #DC2626 | #34D399 / #FBBF24 / #F87171 | fills and icons |
| success-ink / warning-ink / danger-ink | #0B7A4E / #93370D / #B42318 | #6EE7B7 / #FCD34D / #FCA5A5 | text (the solid colours fail as small text on white) |

Green means "paid or verified" and nothing else. The camera surface (`scan`) is dark in both themes on purpose.

## Type, space, shape
Inter (variable). Scale: display 36, page 24, section 16, body 15, support 14, label 13, meta 12; amounts use tabular figures.
4 px spacing base; gutters 16 px (phone) and 24 px (tablet and up). Radius 8 / 12 / 16 / 24 / full. Hit targets at least 44 px.

## Theme
Preference System / Light / Dark, stored in `localStorage` (`facepay.theme`; absent means System). An inline script in
`index.html` applies it before first paint, so there is no flash. Switch: Profile settings, and a header icon on wide screens.

## Layout
Phone: top bar, content, bottom navigation. Desktop: sidebar. Merchant: desktop-first dashboard with a sidebar.

## Motion
Short, purposeful transitions only (sheet rise, toast, success tick). `prefers-reduced-motion` reduces them to near-instant.

## Accessibility checks run
- WCAG contrast computed for every text-on-surface token pair in both themes: all pass; input borders were below 3:1 and were
  fixed with the `field` token.
- axe-core (WCAG 2.0/2.1 A and AA, best practice): 0 violations on 12 customer and 6 merchant screens, both themes, 390 px wide.
  Not covered: dialogs, bottom sheets, the success and failure states reached mid-payment, and desktop width.
- Keyboard focus ring on every interactive element (`:focus-visible`), labelled controls, `aria-live` on status messages.

## PWA
`manifest.webmanifest` plus 192/512 and maskable icons make the app installable (Add to Home Screen). There is **no service
worker**: the app does not work offline and does not cache, deliberately, so a payment screen can never be served stale.
