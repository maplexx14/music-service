"""Генератор iOS-сплэшинов: apple-touch-startup-image под актуальные iPhone.

Лого центрируется (~28% ширины) на фирменном фоне #252933. Размеры —
логические точки x 3 (Retina), список покрывает iPhone SE..16 Pro Max
(устройства с вырезом/островом и без). Регенерация: python scripts/make_splash.py
"""
from pathlib import Path

from PIL import Image

BG = (37, 41, 51)  # #252933 — theme-color приложения

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


def make(width: int, height: int, scale: int, logo: Image.Image) -> Path:
    img = Image.new("RGB", (width, height), BG)
    # Лого ~28% ширины экрана, по центру
    target = int(width * 0.28)
    logo_scaled = logo.resize((target, target), Image.LANCZOS)
    img.paste(
        logo_scaled,
        ((width - target) // 2, (height - target) // 2),
        logo_scaled if logo_scaled.mode == "RGBA" else None,
    )
    out = ROOT / f"apple-splash-{width}-{height}.png"
    img.save(out, "PNG", optimize=True)
    return out


def main() -> None:
    logo = Image.open(ROOT / "logoBoltwo.webp").convert("RGBA")
    seen = set()
    lines = []
    for w, h, s in SIZES:
        if (w, h) in seen:
            continue
        seen.add((w, h))
        path = make(w, h, s, logo)
        media = f"(device-width: {w // s}px) and (device-height: {h // s}px) and (-webkit-device-pixel-ratio: {s})"
        lines.append(f'    <link rel="apple-touch-startup-image" href="/{path.name}" media="{media}" />')
    print("\n".join(lines))


if __name__ == "__main__":
    main()
