# 004 — Reduced-motion support + gate hover motion on capable pointers

- **Status**: TODO
- **Commit**: 107b32b
- **Severity**: MEDIUM
- **Category**: Accessibility
- **Estimated scope**: index.css + ~4 component CSS files

## Problem

Zero `prefers-reduced-motion` handling in CSS (only `frontend/src/components/Grainient.jsx:138` checks it in JS). Infinite decorative animations run unconditionally:

- `frontend/src/pages/Home.css:150` — `animation: waveWidgetPulse 4s ease-in-out infinite;`
- `frontend/src/pages/PlaylistDetail.css:239` — `animation: nowPlayingBar 0.9s ease-in-out infinite;`
- `frontend/src/components/Player.css:171` — `animation: player-buffering-rotate 0.8s linear infinite;` (spinner — keep; it conveys state)
- `frontend/src/components/Spinner.css:20` — spinner rotation (keep)

Also zero `@media (hover: hover)` gating — this is a touch-heavy app (drag gestures, `100dvh`, safe-area insets), so transform-bearing hover styles stick after taps.

## Target

1. Global reduced-motion block at the end of `frontend/src/index.css` (before the `.lite-mode` section). Reduce, don't nuke — keep opacity/color feedback and state-conveying spinners:

```css
/* Уменьшенная анимация: убираем движение и декоративные циклы,
   оставляем цвет/прозрачность и спиннеры состояния. */
@media (prefers-reduced-motion: reduce) {
  * {
    transition-duration: 0.01ms !important;
  }
  .wave-widget.is-playing,
  .now-playing-bars span {
    animation: none !important;
  }
}
```

(`transition-duration` override keeps transitions functional — final states still apply — while removing perceived motion. Spinners are deliberately NOT disabled: they indicate loading state.)

2. Gate transform-bearing hover rules behind `@media (hover: hover) and (pointer: fine)`. Only rules whose `:hover` changes `transform` (scale/translate) — color-only hovers stay ungated. Find them with `grep -rn -A3 ":hover" frontend/src --include="*.css" | grep -B2 "transform"` and wrap each matching `:hover` rule, e.g.:

```css
/* was */
.playlist-card:hover { transform: translateY(-4px); ... }
/* target */
@media (hover: hover) and (pointer: fine) {
  .playlist-card:hover { transform: translateY(-4px); ... }
}
```

Move ONLY the transform declaration into the gated block if the hover rule also changes colors — colors stay in the ungated rule.

## Repo conventions to follow

- Global CSS lives in `frontend/src/index.css`; the `.lite-mode` block there (lines 194–208) is the exemplar for a global "calm down" override, including its Russian comment style.
- Per-component hover rules stay in their component CSS files.

## Steps

1. Add the reduced-motion block to `frontend/src/index.css` above `.lite-mode`.
2. Sweep all CSS in `frontend/src/components` and `frontend/src/pages` for `:hover` rules containing `transform`; wrap/split each per Target. Known candidates (verify each): `pages/Playlists.css` (`.playlist-card:hover`), `pages/Home.css`, `components/Player.css:142` (`translateY(-1px)` hover), `components/FullScreenPlayer.css:203` (`scale(1.04)`).
3. Leave `:active` press feedback (`scale(0.96)` etc.) untouched everywhere — press feedback is wanted on touch.

## Boundaries

- Do NOT modify `.lite-mode` rules.
- Do NOT disable spinners or progress animations under reduced motion.
- Do NOT touch JSX.

## Verification

- **Mechanical**: `cd frontend && npm run build` passes; `grep -rn "prefers-reduced-motion" frontend/src/index.css` matches.
- **Feel check**: DevTools → Rendering → emulate `prefers-reduced-motion: reduce`: wave widget stops pulsing, now-playing bars freeze, hovers still change color instantly, buffering spinner still spins. Device-mode touch emulation: tapping a playlist card no longer leaves it stuck lifted.
- **Done when**: reduced-motion emulation shows no positional movement anywhere, and no transform-hover fires under touch emulation.
