# Animation improvement plans

Written by `improve-animations` at commit `107b32b` (2026-07-18). Plans 010–012 added at commit `24eadd5` (2026-08-31), scoped to `frontend/src/pages/Home.css` and `Home.jsx`.

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
| 010 | [Card & CTA press feedback: instant in, eased out](010-press-feedback-timing.md) | HIGH | DONE |
| 011 | [Profile menu: animated exit, interruptible toggle](011-profile-menu-exit.md) | MEDIUM | DONE |
| 012 | [Tab content swap fade](012-tab-content-fade.md) | LOW | DONE |

Also applied outside plans (from audit finding #8 + missed opportunities): progress-thumb `scale(0.6)`+fade entrance, grid card stagger, like-button pop, wave-widget ease-in — all in working tree.

## Execution order

1. 001 (DONE) — tokens; everything else references them.
2. 002–004 (DONE).
3. 005 (DONE).
4. 006–009 (DONE).
5. **010 first** — highest leverage of the new batch: the page's primary CTA (wave GIF button) has no press feedback at all, and the asymmetric press timing affects every card. Single file, no markup changes.
6. **011 next** — touches both `Home.css` and `Home.jsx`; independent of 010.
7. **012 last** — also touches both files and rewrites the stagger block in `Home.css:301-312`; run it after 011 to avoid merge friction in the same file regions (011 edits `Home.css:475+` and `Home.jsx:277-307`; 012 edits `Home.css:277+`/`301-312` and `Home.jsx:413/429/494`).

## Dependencies

- 005–009 → 001 (tokens) and 004 (global reduced-motion block)
- 008 additionally touches the reduced-motion list in `index.css`
- 010–012 → 001 (tokens); they rely on the global reduced-motion block from 004 remaining in `index.css`
- 010, 011, 012 are mutually independent but all edit `Home.css` — apply sequentially, in that order, re-checking line numbers after each
