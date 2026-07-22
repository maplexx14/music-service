# 003 — Toast enter via transition + animated exit

- **Status**: TODO
- **Commit**: 107b32b
- **Severity**: MEDIUM
- **Category**: Interruptibility
- **Estimated scope**: 3 files (Toast.css, Toast.jsx, store/toastStore.js)

Depends on plan 001 (uses `--ease-out`, `--duration-fast` tokens).

## Problem

Toasts enter with `@keyframes` (restarts from zero; can't retarget when stacking) and are removed from the store with **no exit animation** — they blink out on timeout or close click.

```css
/* frontend/src/components/Toast.css:23 — current */
  animation: toast-in 0.2s ease-out;
```
```js
// frontend/src/store/toastStore.js — current removal
removeToast: (id) =>
  set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
```

## Target

- Enter: CSS transition + `@starting-style` (`opacity: 0; transform: translateY(8px)` → resting), 200ms `var(--ease-out)`.
- Exit: a `leaving` flag on the toast triggers `.toast-leaving { opacity: 0; transform: translateY(8px); }` over 150ms `var(--ease-out)`; actual removal 180ms later.

## Repo conventions to follow

- Store: zustand `create((set) => ...)` with `useToastStore.getState()` for out-of-band calls — see existing `addToast` timeout in `frontend/src/store/toastStore.js`.
- CSS classes are kebab/BEM-ish `toast-*` — follow.

## Steps

1. `frontend/src/components/Toast.css` — in `.toast`, delete `animation: toast-in 0.2s ease-out;`, add:
   ```css
   transition: opacity var(--duration-base) var(--ease-out), transform var(--duration-base) var(--ease-out);
   ```
   Delete the `@keyframes toast-in` block. Add:
   ```css
   @starting-style {
     .toast {
       opacity: 0;
       transform: translateY(8px);
     }
   }
   .toast-leaving {
     opacity: 0;
     transform: translateY(8px);
     transition: opacity var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out);
   }
   ```
2. `frontend/src/store/toastStore.js` — add a `dismissToast` action that marks then removes:
   ```js
   // Плавное скрытие: сначала помечаем toast как уходящий (CSS-анимация),
   // затем удаляем из списка.
   dismissToast: (id) => {
     set((state) => ({
       toasts: state.toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t)),
     }))
     setTimeout(() => {
       useToastStore.getState().removeToast(id)
     }, 180)
   },
   ```
   In `addToast`, change the timeout body to call `dismissToast(id)` instead of `removeToast(id)`.
3. `frontend/src/components/Toast.jsx` — use `dismissToast` from the store for the close button; render class as:
   ```jsx
   <div key={t.id} className={`toast toast-${t.type}${t.leaving ? ' toast-leaving' : ''}`}>
   ```

## Boundaries

- Do NOT change toast positioning, colors, timing of the 4000ms display duration.
- Do NOT touch other stores or components.
- Keep `removeToast` exported/working — other code may call it.

## Verification

- **Mechanical**: `cd frontend && npm run build` passes.
- **Feel check**: trigger several toasts quickly (e.g. like/unlike repeatedly) — new toasts slide in without restarting existing ones' animation; timeout and close-button exits fade+slide out, never blink; remaining toasts reflow after one leaves.
- **Done when**: no `@keyframes toast-in` remains and exits are visibly animated.
