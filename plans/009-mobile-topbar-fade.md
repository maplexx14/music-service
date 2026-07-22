# 009 — Mobile topbar fade (opacity only)

- **Status**: TODO
- **Commit**: 107b32b (+ uncommitted animation changes from plans 001–004)
- **Severity**: LOW (lowest priority — skip if it feels off)
- **Category**: Missed opportunities / Preventing a jarring change
- **Estimated scope**: 1 CSS file

## Problem

`frontend/src/components/Layout.jsx:58` — `{showMobileBack && (<div className="mobile-topbar">…)}` — the mobile top bar (back button) pops in/out instantly on navigation between root and sub-pages. Frequency is tens/day, so per the gate only near-imperceptible motion qualifies: opacity fade, no movement.

## Target

Entry-only fade via `@starting-style`: `opacity: 0` → `1` over `var(--duration-fast)` (150ms) `var(--ease-out)`. NO transform (a moving fixed header would shift the perceived layout). No exit animation (unmount is instant; adding JS delay is not worth it at this tier).

Note: `.main-content.has-mobile-topbar { padding-top: 56px; }` still jumps — out of scope; animating padding is a layout animation and worse than the jump.

## Repo conventions to follow

- Exemplar: `@starting-style` in `frontend/src/components/Toast.css`; tokens in `index.css`.

## Steps

1. `frontend/src/components/Layout.css` — inside the existing `@media (max-width: 768px)` block, add to `.mobile-topbar`:
   ```css
   transition: opacity var(--duration-fast) var(--ease-out);
   ```
   and after the rule (still inside the media query):
   ```css
   @starting-style {
     .mobile-topbar {
       opacity: 0;
     }
   }
   ```

## Boundaries

- Do NOT add transform — opacity only.
- Do NOT animate `.main-content` padding.
- Do NOT touch JSX.

## Verification

- **Mechanical**: `cd frontend && npm run build` passes.
- **Feel check** (mobile emulation): navigate Home → any subpage repeatedly — the bar fades in fast enough not to register as animation, and never feels laggy. **If in real use it makes navigation feel slower, revert this plan** — the gate verdict for this tier is "reject or near-imperceptible", and reverting is the intended escape hatch.
- **Done when**: bar fades in at 150ms with zero perceived navigation delay, or plan is consciously reverted.
