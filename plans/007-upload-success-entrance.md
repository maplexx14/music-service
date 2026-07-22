# 007 — Upload success message entrance

- **Status**: TODO
- **Commit**: 107b32b (+ uncommitted animation changes from plans 001–004)
- **Severity**: LOW
- **Category**: Missed opportunities / Delight (rare moment)
- **Estimated scope**: 1 CSS file

## Problem

`frontend/src/pages/UploadTrack.jsx:165` renders `<div className="success-message">` after a long upload completes — a rare, high-emotion moment — and it appears flat. Current CSS (`frontend/src/pages/UploadTrack.css`):

```css
.success-message {
  padding: 16px;
  background-color: #a259ff;
  color: #ffffff;
  border-radius: 8px;
  margin-bottom: 24px;
  font-size: 14px;
}
```

## Target

Modest scale+fade entrance (dashboard personality — no bounce): `@starting-style` `opacity: 0; transform: scale(0.97)` → settled over 250ms `var(--ease-out)` (`cubic-bezier(0.23, 1, 0.32, 1)`).

## Repo conventions to follow

- Exemplar: `frontend/src/components/Toast.css` `@starting-style` pattern; tokens in `frontend/src/index.css`.

## Steps

1. `frontend/src/pages/UploadTrack.css` — add to `.success-message`:
   ```css
   transition: opacity 250ms var(--ease-out), transform 250ms var(--ease-out);
   ```
2. After the rule:
   ```css
   /* Успех загрузки — редкий момент: мягкое появление вместо плоского. */
   @starting-style {
     .success-message {
       opacity: 0;
       transform: scale(0.97);
     }
   }
   ```

## Boundaries

- Do NOT touch `.error-message` (errors should be instant — urgency).
- Do NOT touch JSX.

## Verification

- **Mechanical**: `cd frontend && npm run build` passes.
- **Feel check**: upload a track — success block breathes in over ~250ms. Error path unchanged (instant).
- **Done when**: success eases in, error does not.
