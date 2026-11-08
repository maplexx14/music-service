const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('C:/Users/maplex/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core');

const sourcePath = 'C:/Users/maplex/Desktop/мотомото/555/photo_2026-11-08_22-16-08.jpg';
const outputPath = path.join(__dirname, 'ios-notification-edited-v4.png');

(async () => {
  const browser = await chromium.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true,
    args: ['--disable-gpu', '--disable-background-networking'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent('<canvas></canvas>');
    const result = await page.evaluate(async ({ source, regular, semibold }) => {
      const normalFont = new FontFace('SFRegular', `url(data:font/otf;base64,${regular})`, { weight: '400' });
      const boldFont = new FontFace('SFSemibold', `url(data:font/otf;base64,${semibold})`, { weight: '600' });
      await Promise.all([normalFont.load(), boldFont.load()]);
      document.fonts.add(normalFont);
      document.fonts.add(boldFont);
      const original = new Image();
      original.src = `data:image/jpeg;base64,${source}`;
      await original.decode();
      const canvas = document.querySelector('canvas');
      canvas.width = original.naturalWidth;
      canvas.height = original.naturalHeight;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(original, 0, 0);
      const before = context.getImageData(0, 0, canvas.width, canvas.height);
      const repaired = new ImageData(new Uint8ClampedArray(before.data), canvas.width, canvas.height);
      const offset = (x, y) => (y * canvas.width + x) * 4;

      // The notification already has a blurred background. Interpolate between
      // clean rows immediately around the original text and app attribution,
      // leaving the icon, timestamp, border, and the rest of the photograph intact.
      const strips = [
        { left: 108, right: 396, top: 912, bottom: 939 },
        { left: 108, right: 226, top: 940, bottom: 966 },
        { left: 108, right: 496, top: 966, bottom: 995 },
        { left: 108, right: 270, top: 996, bottom: 1023 },
      ];
      for (const strip of strips) {
        for (let x = strip.left; x <= strip.right; x++) {
          const upper = offset(x, strip.top);
          const lower = offset(x, strip.bottom);
          const edge = Math.min(1, (x - strip.left) / 3, (strip.right - x) / 3);
          for (let y = strip.top + 1; y < strip.bottom; y++) {
            const t = (y - strip.top) / (strip.bottom - strip.top);
            const target = offset(x, y);
            for (let channel = 0; channel < 3; channel++) {
              const color = before.data[upper + channel] * (1 - t) + before.data[lower + channel] * t;
              repaired.data[target + channel] = before.data[target + channel] * (1 - edge) + color * edge;
            }
          }
        }
      }

      // Remove the Notification Center label and its close button with a
      // localized fill; retain every original pixel outside these masks.
      const pixelCount = canvas.width * canvas.height;
      const labelCore = new Uint8Array(pixelCount);
      for (let y = 834; y <= 887; y++) {
        for (let x = 22; x <= 444; x++) {
          const index = offset(x, y);
          if (Math.min(before.data[index], before.data[index + 1], before.data[index + 2]) > 180) {
            const samples = [[], [], []];
            for (let dy = -8; dy <= 8; dy += 2) {
              for (let dx = -8; dx <= 8; dx += 2) {
                const sample = offset(x + dx, y + dy);
                for (let channel = 0; channel < 3; channel++) samples[channel].push(before.data[sample + channel]);
              }
            }
            const contrasts = samples.map((values, channel) => {
              values.sort((a, b) => a - b);
              return before.data[index + channel] - values[Math.floor(values.length / 2)];
            });
            if (Math.max(...contrasts) > 20 && Math.min(...contrasts) > 6) labelCore[y * canvas.width + x] = 1;
          }
        }
      }
      const removalMask = new Uint8Array(pixelCount);
      for (let y = 832; y <= 889; y++) {
        for (let x = 20; x <= 446; x++) {
          let marked = false;
          for (let dy = -2; dy <= 2 && !marked; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
              if (dx * dx + dy * dy <= 5 && labelCore[(y + dy) * canvas.width + x + dx]) {
                marked = true;
                break;
              }
            }
          }
          if (marked) removalMask[y * canvas.width + x] = 1;
        }
      }
      for (let y = 829; y <= 887; y++) {
        for (let x = 521; x <= 579; x++) {
          if ((x - 550) ** 2 + (y - 857) ** 2 <= 28 ** 2) removalMask[y * canvas.width + x] = 1;
        }
      }
      const missing = new Uint8Array(removalMask);
      const distance = new Uint16Array(pixelCount);
      const neighbors = [-canvas.width - 1, -canvas.width, -canvas.width + 1, -1, 1, canvas.width - 1, canvas.width, canvas.width + 1];
      let frontier = [];
      let removedPixels = 0;
      for (let index = 0; index < pixelCount; index++) {
        if (!missing[index]) continue;
        removedPixels++;
        if (neighbors.some(step => !missing[index + step])) {
          distance[index] = 1;
          frontier.push(index);
        }
      }
      while (frontier.length) {
        const fills = [];
        for (const index of frontier) {
          const x = index % canvas.width;
          const y = Math.floor(index / canvas.width);
          const radius = x > 500 ? 7 : 4;
          const color = [0, 0, 0];
          let totalWeight = 0;
          for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
              const squaredDistance = dx * dx + dy * dy;
              if (!squaredDistance || squaredDistance > radius * radius) continue;
              const sample = (y + dy) * canvas.width + x + dx;
              if (missing[sample]) continue;
              const weight = 1 / (Math.pow(squaredDistance, 1.5) * (1 + Math.abs(distance[index] - distance[sample])));
              for (let channel = 0; channel < 3; channel++) color[channel] += repaired.data[sample * 4 + channel] * weight;
              totalWeight += weight;
            }
          }
          if (!totalWeight) throw new Error('No source pixels around the removal mask.');
          let restoredColor = color.map(value => value / totalWeight);
          if (x < 500) {
            const observed = [];
            for (const [dx, dy] of [[-3,-3],[0,-3],[3,-3],[-3,0],[3,0],[-3,3],[0,3],[3,3],[-1,0],[1,0],[0,-1],[0,1]]) {
              const target = (y + dy) * canvas.width + x + dx;
              if (!missing[target]) observed.push({ dx, dy, value: [repaired.data[target * 4], repaired.data[target * 4 + 1], repaired.data[target * 4 + 2]] });
            }
            let bestScore = Infinity;
            for (let sourceY = Math.max(790, y - 24); sourceY <= Math.min(890, y + 24); sourceY += 2) {
              for (let sourceX = Math.max(4, x - 24); sourceX <= Math.min(500, x + 24); sourceX += 2) {
                const sourceIndex = sourceY * canvas.width + sourceX;
                if (removalMask[sourceIndex]) continue;
                let error = 0;
                let valid = true;
                for (const point of observed) {
                  const sample = (sourceY + point.dy) * canvas.width + sourceX + point.dx;
                  if (removalMask[sample]) { valid = false; break; }
                  for (let channel = 0; channel < 3; channel++) error += (point.value[channel] - before.data[sample * 4 + channel]) ** 2;
                }
                if (!valid) continue;
                const score = error / Math.max(1, observed.length * 3) + ((sourceX - x) ** 2 + (sourceY - y) ** 2) * .015;
                if (score < bestScore) {
                  bestScore = score;
                  restoredColor = [before.data[sourceIndex * 4], before.data[sourceIndex * 4 + 1], before.data[sourceIndex * 4 + 2]];
                }
              }
            }
          }
          fills.push({ index, color: restoredColor });
        }
        for (const fill of fills) {
          missing[fill.index] = 0;
          for (let channel = 0; channel < 3; channel++) repaired.data[fill.index * 4 + channel] = fill.color[channel];
        }
        const next = [];
        for (const { index } of fills) {
          for (const step of neighbors) {
            const neighbor = index + step;
            if (missing[neighbor] && !distance[neighbor]) {
              distance[neighbor] = distance[index] + 1;
              next.push(neighbor);
            }
          }
        }
        frontier = next;
      }
      // Restore a continuous fur texture through the former label area rather
      // than leaving individually filled glyph shapes visible in the photo.
      const labelRegion = { left: 20, right: 447, top: 831, bottom: 891 };
      for (let y = labelRegion.top + 1; y < labelRegion.bottom; y++) {
        for (let x = labelRegion.left + 1; x < labelRegion.right; x++) {
          const alpha = Math.min(1, (x - labelRegion.left) / 8, (labelRegion.right - x) / 8, (y - labelRegion.top) / 8, (labelRegion.bottom - y) / 8);
          const t = (y - labelRegion.top) / (labelRegion.bottom - labelRegion.top);
          const target = offset(x, y);
          const textureY = y - 62;
          const texture = offset(x, textureY);
          for (let channel = 0; channel < 3; channel++) {
            let localMean = 0;
            for (let dy = -3; dy <= 3; dy++) {
              for (let dx = -3; dx <= 3; dx++) localMean += before.data[offset(x + dx, textureY + dy) + channel];
            }
            localMean /= 49;
            const upper = before.data[offset(x, labelRegion.top) + channel];
            const lower = before.data[offset(x, labelRegion.bottom) + channel];
            const restored = upper * (1 - t) + lower * t + (before.data[texture + channel] - localMean) * .9;
            repaired.data[target + channel] = before.data[target + channel] * (1 - alpha) + restored * alpha;
          }
          removalMask[y * canvas.width + x] = 1;
        }
      }
      // Keep the photo layer original for the dedicated image inpainting pass.
      for (let index = 0; index < pixelCount; index++) {
        if (removalMask[index]) {
          for (let channel = 0; channel < 3; channel++) repaired.data[index * 4 + channel] = before.data[index * 4 + channel];
        }
      }
      context.putImageData(repaired, 0, 0);
      context.fillStyle = 'rgba(255,255,255,0.92)';
      context.textBaseline = 'alphabetic';
      context.font = '600 23px SFSemibold';
      context.fillText('Свежий поток готов', 112, 934);
      const tokens = [
        { text: 'GAZAN,', artist: true },
        { text: 'ICEGERGERT,', artist: true },
        { text: 'Александр\u00a0Пистолетов', artist: true },
        ...'и новые находки — включите, когда будет минутка'.split(' ').map(text => ({ text, artist: false })),
      ];
      const fontFor = token => token.artist ? '600 23px SFSemibold' : '400 23px SFRegular';
      const lines = [];
      let line = [];
      let width = 0;
      for (const token of tokens) {
        context.font = fontFor(token);
        const tokenWidth = context.measureText(token.text).width;
        const spaceWidth = line.length ? context.measureText(' ').width : 0;
        if (line.length && width + spaceWidth + tokenWidth > 438) {
          lines.push(line);
          line = [];
          width = 0;
        }
        const gap = line.length ? spaceWidth : 0;
        line.push({ ...token, gap, width: tokenWidth });
        width += gap + tokenWidth;
      }
      if (line.length) lines.push(line);
      if (lines.length > 3) throw new Error('The complete message must fit in three lines.');
      lines.forEach((tokens, index) => {
        let x = 112;
        for (const token of tokens) {
          x += token.gap;
          context.font = fontFor(token);
          context.fillStyle = 'rgba(255,255,255,0.92)';
          context.fillText(token.text, x, 961 + index * 28);
          x += token.width;
        }
      });
      const after = context.getImageData(0, 0, canvas.width, canvas.height);
      let changedOutsideNotification = 0;
      for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
          if (x >= 108 && x <= 555 && y >= 912 && y <= 1023) continue;
          if (removalMask[y * canvas.width + x]) continue;
          const index = offset(x, y);
          if (before.data[index] !== after.data[index] || before.data[index + 1] !== after.data[index + 1] || before.data[index + 2] !== after.data[index + 2]) changedOutsideNotification++;
        }
      }
      const crop = document.createElement('canvas');
      crop.width = 591;
      crop.height = 240;
      crop.getContext('2d').drawImage(canvas, 0, 814, 591, 240, 0, 0, 591, 240);
      return {
        png: canvas.toDataURL('image/png').split(',')[1],
        crop: crop.toDataURL('image/png').split(',')[1],
        width: canvas.width,
        height: canvas.height,
        lines: lines.map(tokens => tokens.map(token => token.text).join(' ')),
        changedOutsideNotification,
        removedPixels,
      };
    }, {
      source: fs.readFileSync(sourcePath).toString('base64'),
      regular: fs.readFileSync(path.join(__dirname, 'assets/SF-Pro-Display-Regular.otf')).toString('base64'),
      semibold: fs.readFileSync(path.join(__dirname, 'assets/SF-Pro-Display-Semibold.otf')).toString('base64'),
    });
    if (result.changedOutsideNotification !== 0) throw new Error('The edit changed pixels outside the notification text.');
    fs.writeFileSync(outputPath, Buffer.from(result.png, 'base64'));
    fs.writeFileSync(path.join(__dirname, 'notification-detail-v4.png'), Buffer.from(result.crop, 'base64'));
    console.log(JSON.stringify({ outputPath, width: result.width, height: result.height, bodyLines: result.lines, changedOutsideNotification: result.changedOutsideNotification, removedPixels: result.removedPixels }));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
