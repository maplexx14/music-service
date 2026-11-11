"""Extract the photographed camel to a transparent PNG with U2-Net."""
from pathlib import Path
import os
import sys

tools_dir = Path.home() / '.codex' / 'tmp'
sys.path.insert(0, str(tools_dir / 'camel-cutout-packages'))
import numpy as np
import onnxruntime as ort
from PIL import Image, ImageFilter

directory = Path(__file__).resolve().parent
source = Image.open(directory / 'camel.jpg').convert('RGB')
small = np.asarray(source.resize((320, 320), Image.Resampling.LANCZOS), dtype=np.float32)
small /= small.max()
small = (small - np.array([.485, .456, .406])) / np.array([.229, .224, .225])
tensor = small.transpose(2, 0, 1)[None].astype(np.float32)
options = ort.SessionOptions()
options.intra_op_num_threads = min(4, os.cpu_count() or 1)
session = ort.InferenceSession(str(tools_dir / 'camel-cutout-models' / 'u2net.onnx'), options, providers=['CPUExecutionProvider'])
mask = session.run(None, {session.get_inputs()[0].name: tensor})[0][0, 0]
mask = (mask - mask.min()) / (mask.max() - mask.min())
mask = np.asarray(Image.fromarray(mask).resize(source.size, Image.Resampling.BICUBIC))
alpha = (np.clip((mask - .08) / .87, 0, 1) * 255).astype(np.uint8)
# Contract the soft edge by one source pixel to remove the pale sky fringe.
alpha = Image.fromarray(alpha).filter(ImageFilter.MinFilter(3))
result = source.copy()
result.putalpha(alpha)
bbox = result.getbbox()
padding = 6
bbox = (max(0, bbox[0]-padding), max(0, bbox[1]-padding), min(source.width, bbox[2]+padding), min(source.height, bbox[3]+padding))
result = result.crop(bbox)
result.save(directory / 'camel.png')
destination = directory.parent / 'bolt-agas-asia-eurasia' / 'assets' / 'camel.png'
result.save(destination)
background = Image.new('RGBA', result.size, '#21162d')
background.alpha_composite(result)
background.convert('RGB').save(directory / 'cutout-check.jpg', quality=95)
print(f'Cutout: {result.size}, source crop: {bbox}; saved {destination}')
