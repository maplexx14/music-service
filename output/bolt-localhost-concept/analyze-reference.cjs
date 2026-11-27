const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const sharp = require('sharp');
const dir = path.join(__dirname, 'reference');
const ffmpeg = process.env.FFMPEG_PATH || path.join(process.env.USERPROFILE, '.codex/tmp/bolt-video-tools/node_modules/ffmpeg-static/ffmpeg.exe');
const reference = process.env.REFERENCE_PATH || 'C:/Users/maplex/Downloads/Spotify 2.0 Concept 🎶.mp4';

(async () => {
  fs.mkdirSync(dir, { recursive: true });
  const result = spawnSync(ffmpeg, ['-hide_banner', '-y', '-loglevel', 'error', '-i', reference, '-vf', 'fps=4,scale=480:270', '-q:v', '2', path.join(dir, '%03d.jpg')], { windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr.toString());
  const files = fs.readdirSync(dir).filter(name => /^\d{3}\.jpg$/.test(name)).sort();
  const columns = 5, tileW = 480, tileH = 299, rows = Math.ceil(files.length / columns);
  const composite = [];
  for (let i = 0; i < files.length; i++) {
    const left = (i % columns) * tileW, top = Math.floor(i / columns) * tileH;
    composite.push({ input: path.join(dir, files[i]), left, top });
    composite.push({ input: Buffer.from(`<svg width="480" height="29"><rect width="480" height="29" fill="#17131e"/><text x="12" y="20" fill="#f8f4ff" font-family="Arial" font-size="17">${(i / 4).toFixed(2)} s</text></svg>`), left, top: top + 270 });
  }
  await sharp({ create: { width: columns * tileW, height: rows * tileH, channels: 3, background: '#17131e' } }).composite(composite).jpeg({ quality: 88 }).toFile(path.join(__dirname, 'reference-timeline.jpg'));
  console.log(`Extracted ${files.length} reference frames at 4 fps.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
