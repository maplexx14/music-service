# 001 — Introduce motion tokens and replace all `transition: all`

- **Status**: TODO
- **Commit**: 107b32b
- **Severity**: HIGH
- **Category**: Performance / Cohesion & tokens
- **Estimated scope**: ~10 CSS files, ~30 small edits

## Problem

28 rules use `transition: all 0.2s` (no easing → weak built-in `ease`, and `all` animates unintended properties off-GPU, including layout properties). There are no shared motion tokens; durations/easings are hand-typed everywhere.

Occurrences (`transition: all 0.2s;` verbatim at each):

- `frontend/src/components/Sidebar.css:90, 118, 300`
- `frontend/src/pages/Auth.css:61, 88`
- `frontend/src/pages/Home.css:274, 334`
- `frontend/src/pages/LikedSongs.css:71, 148`
- `frontend/src/pages/PlaylistDetail.css:82, 100, 143`
- `frontend/src/pages/Playlists.css:26, 63, 86, 102, 137, 158, 235`
- `frontend/src/pages/Search.css:13, 53, 173, 223`
- `frontend/src/pages/UploadTrack.css:58, 131, 169, 199, 221`

## Target

1. Tokens in `frontend/src/index.css`, added inside the existing `:root {}` block (after `--icon-2xl: 48px;`):

```css
  /* Motion tokens */
  --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
  --ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);
  --ease-drawer: cubic-bezier(0.32, 0.72, 0, 1);
  --duration-fast: 150ms;
  --duration-base: 200ms;
```

2. Every `transition: all 0.2s;` replaced with an explicit property list using the tokens. For each rule, look at what actually changes in its `:hover`/`:active`/state variants and list ONLY those properties. Typical result:

```css
/* was: transition: all 0.2s; */
transition: background-color var(--duration-base) var(--ease-out),
            color var(--duration-base) var(--ease-out),
            border-color var(--duration-base) var(--ease-out),
            transform var(--duration-base) var(--ease-out);
```

Rules where the hover state changes only `background`/`color` should list only those two. If a hover changes `box-shadow`, include `box-shadow`. If a hover changes `width`/`height`/`padding` (layout), keep that property in the list (behavior preservation) but add a CSS comment `/* layout prop — kept for parity */`.

## Repo conventions to follow

- Tokens live in `frontend/src/index.css` `:root` (see `--text-*`, `--icon-*` there — same style, kebab-case).
- Explicit-property transitions already exist as exemplar: `frontend/src/components/Player.css:215` — `transition: background 0.2s ease, color 0.2s ease, border-color 0.2s ease, transform 0.2s ease;`. Imitate that shape, but with the new tokens.

## Steps

1. Add the token block to `frontend/src/index.css` `:root`.
2. For each of the 28 listed occurrences: open the file, find the selector's hover/active/state variants, replace `transition: all 0.2s;` with the explicit list per Target. Do not change any other declaration.

## Boundaries

- Do NOT touch JSX files.
- Do NOT change which properties visually animate — the hover/active look must be identical, just explicit.
- Do NOT add new dependencies.
- If a listed line no longer contains `transition: all 0.2s`, STOP and report.

## Verification

- **Mechanical**: `grep -rn "transition: all" frontend/src` returns nothing. `cd frontend && npm run build` succeeds.
- **Feel check**: hover playlist cards, search rows, sidebar links — hover feedback unchanged in what animates, slightly snappier settle (strong ease-out).
- **Done when**: zero `transition: all` in `frontend/src`, tokens present in `index.css`, build passes.
