"""iOS launch images matching the HTML wordmark and equalizer in index.html.

Regenerate with python scripts/make_splash.py. Bump VERSION when changing
the design: iOS caches startup images by URL.
"""
from pathlib import Path

from PIL import Image, ImageDraw

BG = (0, 0, 0)
LOGO_SHARE = 0.46
LOGO_MAX_WIDTH = 192  # CSS pixels
CENTER_Y = 0.485
LOGO_GAP = 28
BAR_WIDTH = 5
BAR_GAP = 6
BAR_HEIGHT = 28
BAR_COLOR = (157, 89, 255)
BAR_LEVELS = (0.3, 0.55, 0.8, 1, 0.75, 0.5, 0.25)
VERSION = "v8"

# (width_px, height_px, scale)
SIZES = [
    (1290, 2796, 3),  # 16 Pro Max / 15 Pro Max
    (1179, 2556, 3),  # 16 Pro / 15 Pro
    (1284, 2778, 3),  # 14 Pro Max / 13 Pro Max / 12 Pro Max
    (1170, 2532, 3),  # 14 / 13 / 12
    (1179, 2556, 3),  # duplicate handled by set below
    (1125, 2436, 3),  # 13 mini / 12 mini / 11 Pro / XS / X
    (1242, 2688, 3),  # 11 Pro Max / XS Max
    (828, 1792, 2),   # 11 / XR
    (1242, 2208, 3),  # 11 / XS Max @3x alt
    (750, 1334, 2),   # 8 / 7 / 6s
    (640, 1136, 2),   # SE 1st gen
]

ROOT = Path(__file__).resolve().parents[1] / "public"


def make(width: int, height: int, scale: int, wordmark: Image.Image) -> Path:
    img = Image.new("RGB", (width, height), BG)
    logo_width = round(min(width * LOGO_SHARE, LOGO_MAX_WIDTH * scale))
    logo_height = round(logo_width * wordmark.height / wordmark.width)
    group_height = logo_height + (LOGO_GAP + BAR_HEIGHT) * scale
    top = round(height * CENTER_Y - group_height / 2)
    logo = wordmark.resize((logo_width, logo_height), Image.LANCZOS)
    img.paste(logo, ((width - logo_width) // 2, top), logo)
    eq_width = (len(BAR_LEVELS) * BAR_WIDTH + (len(BAR_LEVELS) - 1) * BAR_GAP) * scale
    eq_left = (width - eq_width) / 2
    eq_middle = top + logo_height + (LOGO_GAP + BAR_HEIGHT / 2) * scale
    draw = ImageDraw.Draw(img)
    for index, level in enumerate(BAR_LEVELS):
        left = round(eq_left + index * (BAR_WIDTH + BAR_GAP) * scale)
        half_height = BAR_HEIGHT * scale * level / 2
        draw.rounded_rectangle(
            (left, round(eq_middle - half_height), left + BAR_WIDTH * scale - 1, round(eq_middle + half_height) - 1),
            radius=round(BAR_WIDTH * scale / 2), fill=BAR_COLOR,
        )
    out = ROOT / f"apple-splash-{VERSION}-{width}-{height}.png"
    img.save(out, "PNG", optimize=True)
    return out


def main() -> None:
    wordmark = Image.open(ROOT.parent / "src" / "assets" / "bolt-wordmark.webp").convert("RGBA")
    seen = set()
    lines = []
    for w, h, s in SIZES:
        if (w, h) in seen:
            continue
        seen.add((w, h))
        path = make(w, h, s, wordmark)
        media = f"(device-width: {w // s}px) and (device-height: {h // s}px) and (-webkit-device-pixel-ratio: {s})"
        lines.append(f'    <link rel="apple-touch-startup-image" href="/{path.name}" media="{media}" />')
    print("\n".join(lines))


if __name__ == "__main__":
    main()
