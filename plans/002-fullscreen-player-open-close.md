# 002 — Animate FullScreenPlayer open/close + velocity-based drag dismiss

- **Status**: TODO
- **Commit**: 107b32b
- **Severity**: HIGH
- **Category**: Interruptibility / Missed opportunities
- **Estimated scope**: 3 files (FullScreenPlayer.jsx, FullScreenPlayer.css, Layout.jsx not touched)

Depends on plan 001 (uses `--ease-drawer` token).

## Problem

The fullscreen player is conditionally mounted (`frontend/src/components/Layout.jsx:82` — `{isFullScreen && <FullScreenPlayer />}`) with no enter/exit animation: the app's largest surface change teleports. Drag-to-dismiss uses a distance-only threshold and always snaps back symmetrically:

```jsx
// frontend/src/components/FullScreenPlayer.jsx:103-117 — current
const handleTouchEnd = (e) => {
  const g = gestureRef.current
  if (!g) return
  const t = e.changedTouches[0]
  const dx = t.clientX - g.x
  const dy = t.clientY - g.y
  gestureRef.current = null
  setIsDragging(false)
  setDragY(0)
  if (g.axis === 'x' && Math.abs(dx) >= 60) {
    if (dx < 0) nextTrack()
    else previousTrack()
  } else if (g.axis === 'y' && dy >= 120) {
    closeFullScreen()
  }
}
```

```jsx
// frontend/src/components/FullScreenPlayer.jsx:171-175 — current
style={{
  transform: dragY ? `translateY(${dragY}px)` : undefined,
  opacity: dragY ? dragOpacity : undefined,
  transition: isDragging ? 'none' : 'transform 0.3s ease, opacity 0.3s ease',
}}
```

Problems: (a) no entry animation; (b) closing unmounts instantly — even after a drag past threshold the sheet vanishes rather than continuing down; (c) a fast flick under 120px snaps back — no velocity check.

## Target

- **Entry**: slide up from bottom, 400ms `var(--ease-drawer)` (`cubic-bezier(0.32, 0.72, 0, 1)`, defined in plan 001), via `@starting-style`.
- **Exit**: on close (button, Escape-equivalent, or drag past threshold), animate `translateY(100%)` over 300ms `var(--ease-drawer)` FIRST, then call `closeFullScreen()` (unmount) on `transitionend` with a 350ms `setTimeout` fallback.
- **Velocity dismiss**: track gesture start time; dismiss if `dy >= 120` OR (`dy > 30` AND `dy / elapsedMs > 0.11`).
- **Snap-back** (dismiss not triggered): keep current behavior (`setDragY(0)` with transition re-enabled) but use `transform 0.3s var(--ease-drawer), opacity 0.3s var(--ease-drawer)`.

## Repo conventions to follow

- Local component state via `useState`, gesture bookkeeping via `useRef` (see `gestureRef` in this file) — extend those, don't add libraries. `motion` is installed but unused; do NOT introduce it.
- Comments in this file are Russian; write new comments in Russian matching the existing tone.

## Steps

1. `FullScreenPlayer.css` — at the end of the `.fullscreen-player` rule add:
   ```css
   transition: transform 0.4s var(--ease-drawer), opacity 0.3s var(--ease-drawer);
   ```
   and after the rule add:
   ```css
   @starting-style {
     .fullscreen-player {
       transform: translateY(100%);
     }
   }
   .fullscreen-player.is-closing {
     transform: translateY(100%);
     opacity: 0.4;
     transition: transform 0.3s var(--ease-drawer), opacity 0.3s var(--ease-drawer);
   }
   ```
2. `FullScreenPlayer.jsx` — add state `const [isClosing, setIsClosing] = useState(false)` and:
   ```jsx
   // Закрытие с анимацией: сначала уводим шторку вниз, затем размонтируем.
   const startClose = () => {
     if (isClosing) return
     setIsClosing(true)
     setTimeout(closeFullScreen, 350)
   }
   ```
   Replace every direct `closeFullScreen` call/handler in this component (`onClick={closeFullScreen}` on the chevron button and the call in `handleTouchEnd`) with `startClose`.
3. Gesture timing: in `handleTouchStart` store `t0: performance.now()` in `gestureRef.current`. In `handleTouchEnd` compute `const elapsed = performance.now() - g.t0` and change the dismiss condition to:
   ```jsx
   } else if (g.axis === 'y' && (dy >= 120 || (dy > 30 && dy / elapsed > 0.11))) {
     startClose()
   }
   ```
   Also: when dismissing via drag, do NOT `setDragY(0)` (let `.is-closing` take over from the current dragged position); only reset `dragY` on snap-back.
4. Root div className/style:
   ```jsx
   className={`fullscreen-player${isClosing ? ' is-closing' : ''}`}
   style={{
     transform: dragY && !isClosing ? `translateY(${dragY}px)` : undefined,
     opacity: dragY && !isClosing ? dragOpacity : undefined,
     transition: isDragging ? 'none' : undefined,
   }}
   ```
   (inline `transition` only overrides to `none` while dragging; otherwise CSS rules apply).

## Boundaries

- Do NOT touch `Layout.jsx`, `playerStore.js`, or the horizontal-swipe track switching.
- Do NOT add dependencies or import `motion`.
- If line numbers/code excerpts don't match, STOP and report.

## Verification

- **Mechanical**: `cd frontend && npm run build` passes; `npm run lint` no new errors.
- **Feel check** (real mobile device or DevTools touch emulation):
  - Opening: sheet slides up from the bottom edge; no flash of the fully-open state first.
  - Chevron close: sheet slides down, then disappears — never blinks out.
  - Slow drag to 130px + release → continues down and closes from that position (does not jump back to top first).
  - Fast flick ~60px → closes; slow drag 60px + release → snaps back.
  - DevTools Animations panel at 10% speed: entry uses one continuous curve, no double-start.
- **Done when**: all feel checks pass and no instant mount/unmount of `.fullscreen-player` is observable.
