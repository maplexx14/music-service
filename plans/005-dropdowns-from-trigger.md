# 005 — Animate dropdown panels from their trigger

- **Status**: TODO
- **Commit**: 107b32b (+ uncommitted animation changes from plans 001–004)
- **Severity**: MEDIUM
- **Category**: Missed opportunities / Physicality & origin
- **Estimated scope**: 3 CSS files, CSS-only

## Problem

Three trigger-anchored panels appear instantly via conditional render, with no spatial connection to their trigger:

1. `frontend/src/components/Sidebar.jsx:121` → `.profile-dropdown` (`Sidebar.css`, rule starts `position: absolute; bottom: 100%;` — opens UPWARD from the profile button)
2. `frontend/src/components/Player.jsx:985` → `.playlist-add-panel` (`Player.css`, rule starts `position: absolute; bottom: 96px; left: 16px;` — opens upward from the player bar)
3. `frontend/src/pages/Home.jsx:181` → `.mobile-profile-menu` (`Home.css`, rule starts `position: absolute; right: 0; top: 48px;` — opens DOWNWARD from the avatar)

## Target

Enter via `@starting-style`: `opacity: 0; transform: scale(0.96)`, settle over `var(--duration-fast)` (150ms) with `var(--ease-out)` (`cubic-bezier(0.23, 1, 0.32, 1)` — already in `frontend/src/index.css` `:root`). `transform-origin` points at the trigger:

- `.profile-dropdown` → `transform-origin: bottom center;` (trigger is below)
- `.playlist-add-panel` → `transform-origin: bottom left;` (trigger is below-left)
- `.mobile-profile-menu` → `transform-origin: top right;` (trigger is above-right)

No exit animation (out of scope — would need JS unmount delay; instant close is acceptable for menus).

## Repo conventions to follow

- Exemplar for the `@starting-style` + tokens pattern: `frontend/src/components/Toast.css` (`.toast` rule + its `@starting-style` block). Imitate exactly.
- Reduced motion is handled globally in `index.css` (`transition-duration: 0.01ms`) — no per-component handling needed.

## Steps

1. `frontend/src/components/Sidebar.css` — in the `.profile-dropdown` rule add:
   ```css
   transform-origin: bottom center;
   transition: opacity var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out);
   ```
   Immediately after the rule add:
   ```css
   @starting-style {
     .profile-dropdown {
       opacity: 0;
       transform: scale(0.96);
     }
   }
   ```
2. `frontend/src/components/Player.css` — same pattern on `.playlist-add-panel`, with `transform-origin: bottom left;`.
3. `frontend/src/pages/Home.css` — same pattern on `.mobile-profile-menu`, with `transform-origin: top right;`.

## Boundaries

- Do NOT touch JSX — CSS only.
- Do NOT add exit animations.
- Do NOT change positioning/layout properties of these panels.
- If a selector is missing or already has a `transition`, STOP and report.

## Verification

- **Mechanical**: `cd frontend && npm run build` passes.
- **Feel check**: open profile menu in sidebar — it grows from the bottom edge (toward its trigger), not from center; same for the playlist-add panel above the player and the mobile avatar menu. DevTools Animations at 10%: single continuous scale+fade, origin visibly anchored at the trigger side. Rapid open/close: no flicker (close is instant by design).
- **Done when**: all three panels scale in from their trigger side within 150ms.
