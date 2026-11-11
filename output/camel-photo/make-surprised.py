"""Make a playful photographic reaction sticker from the existing camel cutout."""
from pathlib import Path
import sys
sys.path.insert(0, str(Path.home() / '.codex/tmp/camel-cutout-packages'))
import numpy as np
from PIL import Image, ImageFilter

directory = Path(__file__).resolve().parent
cutout = Image.open(directory / 'camel.png').convert('RGBA')
stage = Image.new('RGBA', (1280, 960))
stage.alpha_composite(cutout, (241, 212))
head = stage.crop((840, 200, 1040, 445)).resize((600, 735), Image.Resampling.LANCZOS)

def bulge(image, center, radius, strength):
    rgba = np.asarray(image, dtype=np.float32) / 255
    rgba[:, :, :3] *= rgba[:, :, 3:4]
    height, width = rgba.shape[:2]
    y, x = np.mgrid[:height, :width].astype(np.float32)
    dx, dy = x-center[0], y-center[1]
    distance = np.sqrt((dx/radius[0])**2 + (dy/radius[1])**2)
    factor = 1-strength*np.maximum(0, 1-distance)**2
    sx = np.clip(center[0]+dx*factor, 0, width-1.001)
    sy = np.clip(center[1]+dy*factor, 0, height-1.001)
    ix, iy = sx.astype(int), sy.astype(int)
    fx, fy = (sx-ix)[..., None], (sy-iy)[..., None]
    result = ((1-fx)*(1-fy)*rgba[iy, ix] + fx*(1-fy)*rgba[iy, ix+1]
              + (1-fx)*fy*rgba[iy+1, ix] + fx*fy*rgba[iy+1, ix+1])
    result[:, :, :3] /= np.maximum(result[:, :, 3:4], 1/255)
    return Image.fromarray((np.clip(result, 0, 1)*255).astype(np.uint8))

# Enlarge the actual photographed eye and mouth, retaining their texture.
head = bulge(head, ((938-840)*3, (245-200)*3), (91, 99), .78)
head = bulge(head, ((1009-840)*3, (271-200)*3), (87, 87), .65)
# Round off the neck at the bottom of the reaction sticker.
pixels = np.asarray(head).copy()
y, x = np.mgrid[:head.height, :head.width]
bottom = 704 - .0015*(x-180)**2
pixels[:, :, 3] = (pixels[:, :, 3]*np.clip((bottom-y)/9, 0, 1)).astype(np.uint8)
head = Image.fromarray(pixels)
sticker = Image.new('RGBA', (648, 783))
alpha = Image.new('L', sticker.size)
alpha.paste(head.getchannel('A'), (24, 24))
outline = alpha.filter(ImageFilter.MaxFilter(15)).filter(ImageFilter.GaussianBlur(.6))
rim = Image.new('RGBA', sticker.size, '#f8efff')
rim.putalpha(outline)
sticker.alpha_composite(rim)
sticker.alpha_composite(head, (24, 24))
output = directory.parent / 'bolt-agas-asia-eurasia/assets/camel-surprised.png'
sticker.save(output)
preview = Image.new('RGBA', sticker.size, '#21162d')
preview.alpha_composite(sticker)
preview.convert('RGB').save(directory / 'surprised-check.jpg', quality=96)
print(f'Saved {output}, {sticker.size}')
