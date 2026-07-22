# Animation improvement plans

Written by `improve-animations` at commit `107b32b` (2026-07-18).

| # | Plan | Severity | Status |
| --- | --- | --- | --- |
| 001 | [Motion tokens + replace `transition: all`](001-motion-tokens-and-transition-all.md) | HIGH | DONE |
| 002 | [FullScreenPlayer open/close + velocity drag dismiss](002-fullscreen-player-open-close.md) | HIGH | DONE |
| 003 | [Toast enter transition + animated exit](003-toast-exit-animation.md) | MEDIUM | DONE |
| 004 | [Reduced motion + hover gating](004-reduced-motion-and-hover-gating.md) | MEDIUM | DONE |
| 005 | [Dropdown panels scale from trigger](005-dropdowns-from-trigger.md) | MEDIUM | DONE |
| 006 | [Playlist forms entrance](006-playlist-forms-entrance.md) | LOW | DONE |
| 007 | [Upload success entrance](007-upload-success-entrance.md) | LOW | DONE |
| 008 | [Onboarding picker press + selection pop](008-onboarding-picker-feedback.md) | LOW | DONE |
| 009 | [Mobile topbar fade](009-mobile-topbar-fade.md) | LOW | DONE |

Also applied outside plans (from audit finding #8 + missed opportunities): progress-thumb `scale(0.6)`+fade entrance, grid card stagger, like-button pop, wave-widget ease-in — all in working tree.

## Execution order

1. 001 (DONE) — tokens; everything else references them.
2. 002–004 (DONE).
3. **005 next** — highest remaining leverage (only surface class that still teleports).
4. 006, 007, 008 — any order, independent.
5. 009 last — borderline per the frequency gate; includes its own revert criterion.

## Dependencies

- 005–009 → 001 (tokens) and 004 (global reduced-motion block)
- 008 additionally touches the reduced-motion list in `index.css`
