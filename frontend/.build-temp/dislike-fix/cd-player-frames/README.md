These atlases contain the original Three.js chassis at all 41 reusable skip
angles. They cover the default desktop/mobile camera and appearance, with and
without shadows. Artwork and changing control faces are live
overlays. The camera/appearance key in `manifest.json` prevents using a different
body, finish, lid or perspective. Framing is relative to viewport height, so the
same camera can reuse its atlas at different layout sizes. Content hashes in
asset filenames prevent HTTP caches from mixing poses from different builds.

To regenerate, start Vite and run from `frontend`:

```powershell
node scripts/bake-cd-software-frames.mjs http://127.0.0.1:3001
```

Set `CD_BROWSER_BINARY` for another Chromium binary. The script renders source
poses in headless Chromium, ignoring existing caches, and writes PNG atlases and
their manifest. The committed atlases use lossless WebP compression; PNG output
also works directly. To compress a generated atlas without changing its pixels:

```powershell
npx --yes --package=sharp-cli --package=@img/sharp-win32-x64 sharp -i public/cd-player-frames/desktop-shadows-HASH.png -o public/cd-player-frames/desktop-shadows-HASH.webp --lossless -f webp
```

Repeat for the other atlases and update their extensions in the manifest. Bump
the desktop/mobile version prefixes in `softwareFrameKey()` when changing the
chassis geometry/materials or capture layers, then regenerate the assets. Other
appearances and camera positions are prepared once in idle time and saved in
IndexedDB; playback itself only copies decoded images.
