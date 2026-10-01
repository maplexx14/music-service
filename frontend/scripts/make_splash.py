"""Генератор iOS-сплэшинов: apple-touch-startup-image под актуальные iPhone.

Иконка приложения (мастер favicon-64.png) в скруглённом квадрате ~24.5%
ширины по центру почти чёрного фона — как системный экран запуска
нативного приложения. Имена с суффиксом -vN: iOS запоминает сплэш по URL
при добавлении на экран «Домой», при смене картинки суффикс поднимать
(VERSION) и вставлять напечатанные <link> в index.html. Размеры —
логические точки x 3 (Retina), список покрывает iPhone SE..16 Pro Max
(устройства с вырезом/островом и без). Регенерация: python scripts/make_splash.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

BG = (5, 5, 5)  # чуть светлее чёрного фона иконки — квадрат читается
ICON_SHARE = 0.245  # ширина иконки от ширины экрана
CORNER = 0.225  # радиус скругления от стороны иконки, как у iOS
ICON_Y = 0.485  # центр иконки по высоте: чуть выше середины, как у системного сплэша
VERSION = "v2"

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


def make(width: int, height: int, scale: int, icon: Image.Image) -> Path:
    img = Image.new("RGB", (width, height), BG)
    side = int(width * ICON_SHARE)
    # Рисуем маску в 4x и сжимаем — иначе край скругления лесенкой.
    mask = Image.new("L", (side * 4, side * 4), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, side * 4 - 1, side * 4 - 1), radius=int(side * 4 * CORNER), fill=255
    )
    mask = mask.resize((side, side), Image.LANCZOS)
    img.paste(icon.resize((side, side), Image.LANCZOS), ((width - side) // 2, int(height * ICON_Y) - side // 2), mask)
    out = ROOT / f"apple-splash-{VERSION}-{width}-{height}.png"
    img.save(out, "PNG", optimize=True)
    return out


def main() -> None:
    master = Image.open(ROOT / "favicon-64.png").convert("RGBA")
    icon = Image.new("RGBA", master.size, (0, 0, 0, 255))
    icon.alpha_composite(master)
    icon = icon.convert("RGB")
    seen = set()
    lines = []
    for w, h, s in SIZES:
        if (w, h) in seen:
            continue
        seen.add((w, h))
        path = make(w, h, s, icon)
        media = f"(device-width: {w // s}px) and (device-height: {h // s}px) and (-webkit-device-pixel-ratio: {s})"
        lines.append(f'    <link rel="apple-touch-startup-image" href="/{path.name}" media="{media}" />')
    print("\n".join(lines))


if __name__ == "__main__":
    main()
