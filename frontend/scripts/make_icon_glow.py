import sys, math
from PIL import Image, ImageChops
# Иконка приложения со свечением акцентом (#a259ff) снизу. Запуск из frontend/public:
#   python3 ../scripts/make_icon_glow.py .
# пишет master.png 1025×1025; из него режутся apple-touch-icon-vN.png (180),
# icon-192-vN.webp, icon-512-vN.webp и favicon-64-vN.png (64) (LANCZOS), сам master не коммитится.
out_dir = sys.argv[1]
src = Image.open('apple-touch-icon.png').convert('RGB')
N = src.size[0]
# свечение акцентом: эллипс с центром ниже нижнего края, как на референсе
M = 256
g = Image.new('L', (M, M))
px = g.load()
for j in range(M):
    for i in range(M):
        x, y = (i+0.5)/M, (j+0.5)/M
        d = math.hypot((x-0.72)/1.05, (y-1.12)/0.78)
        px[i, j] = round(255*max(0.0, 1-d)**1.5*1.0)
g = g.resize((N, N), Image.BICUBIC)
glow = Image.merge('RGB', [g.point(lambda v, c=c: v*c//255) for c in (0xa2, 0x59, 0xff)])
# рисунок лежит на чёрном, т.е. уже премультиплицирован: альфа из яркости
r, gg, b = src.split()
a = ImageChops.lighter(ImageChops.lighter(r, gg), b).point(lambda v: min(255, v*255//90))
under = Image.composite(Image.new('RGB', (N, N)), glow, a)
ImageChops.add(under, src).save(f'{out_dir}/master.png')
