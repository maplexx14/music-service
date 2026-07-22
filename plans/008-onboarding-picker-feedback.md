# 008 — Onboarding genre picker: press feedback + selection pop

- **Status**: TODO
- **Commit**: 107b32b (+ uncommitted animation changes from plans 001–004)
- **Severity**: LOW
- **Category**: Missed opportunities / Feedback + delight budget (first-run)
- **Estimated scope**: 1 CSS file

## Problem

The first-run preference picker (`frontend/src/components/PreferencePicker.css`) is the one place in the app users see exactly once — the delight budget lives here. Currently genre chips only change color:

```css
/* PreferencePicker.css:34 — current */
.pref-chip {
  ...
  transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}
.pref-chip.active {
  background: #a259ff;
  border-color: #a259ff;
  color: #ffffff;
}
```

No press feedback, no selection moment.

## Target

- Press: `.pref-chip:active { transform: scale(0.96); }` with `transform` added to the transition (`var(--duration-fast) var(--ease-out)`).
- Selection pop on `.pref-chip.active`: keyframe `1 → 1.06 → 1` over 250ms `var(--ease-out)` — generous-but-subtle; this is the only screen where a pop per selection is allowed.
- Same press feedback on `.pref-suggestion` (artist suggestion chips).
- Add the pop keyframe selector to the global reduced-motion kill-list in `frontend/src/index.css`.

## Repo conventions to follow

- Exemplar for the pop: `likePop` in `frontend/src/components/Player.css` (`.like-btn.liked` + `@keyframes likePop`) — same shape, smaller amplitude (1.06 vs 1.18: chips are toggled many times in one session, hearts rarely).
- Reduced-motion kill-list: the `@media (prefers-reduced-motion: reduce)` block in `frontend/src/index.css` already lists `.like-btn.liked` etc. — append there.

## Steps

1. `frontend/src/components/PreferencePicker.css` — in `.pref-chip`, extend the transition:
   ```css
   transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease,
               transform var(--duration-fast) var(--ease-out);
   ```
2. After `.pref-chip:hover` add:
   ```css
   .pref-chip:active {
     transform: scale(0.96);
   }
   ```
3. In `.pref-chip.active` add `animation: prefChipPop 0.25s var(--ease-out);` and after the rule:
   ```css
   /* Поп выбранного жанра: онбординг видят один раз — здесь уместна щедрость. */
   @keyframes prefChipPop {
     0% { transform: scale(1); }
     40% { transform: scale(1.06); }
     100% { transform: scale(1); }
   }
   ```
4. In `.pref-suggestion`, extend transition with `transform var(--duration-fast) var(--ease-out)` and add:
   ```css
   .pref-suggestion:active {
     transform: scale(0.96);
   }
   ```
5. `frontend/src/index.css` — in the reduced-motion block, append `.pref-chip.active` to the `animation: none !important` selector list.

## Boundaries

- Do NOT animate `.pref-tag` add/remove (list churn during typing — too frequent).
- Do NOT touch `PreferencesOnboarding.css` or JSX.

## Verification

- **Mechanical**: `cd frontend && npm run build` passes.
- **Feel check**: on the onboarding screen, tap chips — press-down on touch, small pop on select, no pop on DEselect concern: note the pop also fires when deselect→reselect quickly; acceptable. Reduced-motion: color change only.
- **Done when**: chips have press feedback and a subtle selection pop, gated in reduced motion.
