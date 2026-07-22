# 006 — Ease in the create/import playlist forms

- **Status**: TODO
- **Commit**: 107b32b (+ uncommitted animation changes from plans 001–004)
- **Severity**: LOW
- **Category**: Missed opportunities / Preventing a jarring change
- **Estimated scope**: 1 CSS file

## Problem

Both inline forms on the Playlists page are conditionally rendered and appear instantly, teleporting the grid below them:

- `frontend/src/pages/Playlists.jsx:158` — `{showImportForm && (` → `.import-playlist-form`
- `frontend/src/pages/Playlists.jsx:215` — `{showCreateForm && (` → `.create-playlist-form`

Current CSS (`frontend/src/pages/Playlists.css`): `.create-playlist-form` and `.import-playlist-form` rules have background/radius/padding/margin but no transition.

## Target

Enter via `@starting-style`: `opacity: 0; transform: translateY(-8px)` → settled, `transition: opacity var(--duration-base) var(--ease-out), transform var(--duration-base) var(--ease-out)` (200ms, `cubic-bezier(0.23, 1, 0.32, 1)` from `index.css` tokens). Transform/opacity only — do NOT animate height (layout property; the grid below will still jump, which is acceptable — the form itself easing in is the bridge).

## Repo conventions to follow

- Exemplar: `frontend/src/components/Toast.css` — `.toast` transition + `@starting-style` block.
- Tokens `--duration-base` / `--ease-out` live in `frontend/src/index.css` `:root`.

## Steps

1. `frontend/src/pages/Playlists.css` — add to BOTH `.create-playlist-form` and `.import-playlist-form` rules:
   ```css
   transition: opacity var(--duration-base) var(--ease-out), transform var(--duration-base) var(--ease-out);
   ```
2. After those rules add one shared block:
   ```css
   /* Плавное появление инлайн-форм вместо телепортации. */
   @starting-style {
     .create-playlist-form,
     .import-playlist-form {
       opacity: 0;
       transform: translateY(-8px);
     }
   }
   ```

## Boundaries

- Do NOT touch JSX.
- Do NOT animate height/margin/padding.
- Do NOT add exit animations.

## Verification

- **Mechanical**: `cd frontend && npm run build` passes.
- **Feel check**: click «Создать плейлист» / import — the form fades in sliding down 8px; toggling rapidly doesn't stutter (transition retargets). Reduced-motion emulation: form still appears, near-instantly.
- **Done when**: both forms ease in; closing remains instant.
