const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || path.join(process.env.USERPROFILE, 'AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core'));

const root = __dirname;
const assets = path.join(root, 'assets');
const frames = path.join(assets, 'live');
const ffmpeg = process.env.FFMPEG_PATH || path.join(process.env.USERPROFILE, '.codex/tmp/bolt-video-tools/node_modules/ffmpeg-static/ffmpeg.exe');
const origin = process.env.BOLT_URL || 'http://localhost';
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname)) throw new Error('BOLT_URL must point to localhost.');
const fps = 60, count = 374, width = 1040, height = 1000, pixelRatio = 1.5;
const stillsOnly = process.argv.includes('--stills');
const stillFrames = new Set([0, 36, 66, 72, 114, 171, 192, 207, 216, 234, 285, 331, 347, 373]);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clamp = x => Math.max(0, Math.min(1, x));
const ease = x => { x = clamp(x); return x * x * (3 - 2 * x); };
function point(a, b, p) { return { x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p }; }

async function rect(page, selector) {
  return page.locator(selector).first().evaluate(e => {
    const r = e.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, width: r.width, height: r.height };
  });
}

async function prepare(page) {
  await page.goto(origin + '/search?q=Daft%20Punk', { waitUntil: 'domcontentloaded' });
  await page.locator('.search-filter').first().waitFor({ timeout: 25000 });
  await page.locator('.artist-card img').first().waitFor({ timeout: 25000 });
  if (!(await page.locator('.sidebar').evaluate(e => e.classList.contains('collapsed')))) await page.locator('.collapse-btn').click();
  await page.locator('.search-input').evaluate(e => e.blur());
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(700);
  await page.locator('.artist-card img').first().evaluate(e => e.decode().catch(() => {}));
  await page.evaluate(() => Promise.all(Array.from(document.images).filter(e => e.complete && e.naturalWidth > 0).map(e => e.decode().catch(() => {}))));
}

async function waitForAudio(page) {
  for (let i = 0; i < 140; i++) {
    const info = await page.evaluate(() => {
      const audio = Array.from(document.querySelectorAll('audio')).find(e => !e.paused && e.currentSrc && !e.currentSrc.startsWith('data:'));
      return audio ? { ready: audio.readyState, playing: !audio.paused, time: audio.currentTime, error: audio.error?.message } : null;
    });
    if (info?.error) throw new Error(info.error);
    if (info?.ready >= 3 && info.time > 0) return info;
    await sleep(150);
  }
  throw new Error('The real localhost audio stream did not start.');
}

(async () => {
  fs.mkdirSync(frames, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--disable-background-networking', '--force-color-profile=srgb'] });
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: pixelRatio, serviceWorkers: 'block' });
  const errors = [];
  try {
    const warm = await context.newPage();
    warm.on('pageerror', error => errors.push(error.message));
    await prepare(warm);
    const artistImages = await warm.locator('.artist-card img').evaluateAll(images => images.slice(0, 3).map(e => ({ name: e.alt, url: e.currentSrc })));
    for (let i = 0; i < artistImages.length; i++) {
      const response = await context.request.get(artistImages[i].url);
      if (!response.ok()) throw new Error('Could not capture an artist image from localhost.');
      fs.writeFileSync(path.join(assets, `artist-${i + 1}.jpg`), await response.body());
    }
    const project = path.resolve(root, '../..');
    fs.copyFileSync(path.join(project, 'frontend/src/assets/brand-mark.png'), path.join(assets, 'mark.png'));
    for (const name of ['geologica-cyrillic.woff2', 'geologica-latin.woff2']) fs.copyFileSync(path.join(project, 'output/bolt-concept-ad/assets', name), path.join(assets, name));

    await warm.locator('.search-filter').filter({ hasText: /^Лучшие$/ }).click();
    await warm.locator('.track-name[title="One More Time"]').first().waitFor();
    await warm.locator('.track-name[title="One More Time"]').first().click();
    const audioProof = await waitForAudio(warm);
    await warm.locator('.player-cover-wrap').click();
    await warm.locator('.fullscreen-play').first().waitFor();
    await warm.waitForTimeout(850);
    const logoUrl = await warm.locator('.fullscreen-logo').getAttribute('src');
    const logoResponse = await context.request.get(new URL(logoUrl, origin).href);
    if (!logoResponse.ok()) throw new Error('The real Bolt wordmark could not be loaded.');
    fs.writeFileSync(path.join(assets, 'bolt.webp'), await logoResponse.body());
    const controls = await rect(warm, '.fullscreen-controls .fullscreen-play');
    const fullscreenArt = await rect(warm, '.fullscreen-art');
    await warm.screenshot({ path: path.join(root, 'source-player-proof.png') });
    await warm.close();

    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await prepare(page);
    const best = await rect(page, '.search-filter:nth-child(2)');
    await page.locator('.search-filter').filter({ hasText: /^Лучшие$/ }).click();
    const selected = await rect(page, '.track-name[title="One More Time"]');
    const selectedRow = await rect(page, '.tracks-table tbody tr:nth-child(3)');
    await page.locator('.search-filter').filter({ hasText: /^Все$/ }).click();
    await page.waitForTimeout(400);

    await page.clock.install();
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 50));
    await page.evaluate(() => {
      const cursor = document.createElement('div');
      cursor.id = '__film-cursor';
      cursor.innerHTML = '<svg width="32" height="39" viewBox="0 0 32 39"><path d="M2 2v29l8-7 6 13 6-3-6-12 13-1Z" fill="white" stroke="#17121f" stroke-width="1.4" stroke-linejoin="round"/></svg>';
      Object.assign(cursor.style, { position: 'fixed', left: '0', top: '0', zIndex: '2147483647', pointerEvents: 'none', filter: 'drop-shadow(0 2px 3px #0008)', transformOrigin: '2px 2px' });
      document.body.appendChild(cursor);
      const animations = new Map();
      window.__filmSync = (ms, x, y, alpha, press) => {
        cursor.style.opacity = String(alpha);
        cursor.style.transform = `translate(${x}px,${y}px) scale(${press ? 0.91 : 1})`;
        for (const animation of document.getAnimations()) {
          let state = animations.get(animation);
          if (!state) {
            state = { start: ms, base: Number(animation.currentTime) || 0, done: false };
            animations.set(animation, state);
            animation.pause();
          }
          if (state.done) continue;
          const time = state.base + ms - state.start;
          const timing = animation.effect.getComputedTiming();
          if (Number.isFinite(timing.endTime) && time >= timing.endTime) {
            animation.currentTime = timing.endTime;
            try { animation.finish(); } catch {}
            state.done = true;
          } else {
            animation.currentTime = Math.max(0, time);
          }
        }
        return animations.size;
      };
      window.__filmSync(0, 0, 0, 0, false);
    });

    let animationCount = 0, playback = null;
    for (let i = 0; i < count; i++) {
      const t = i / fps;
      let cursor = point({ x: 800, y: 520 }, best, ease((t - .42) / .62));
      if (t >= 1.65 && t < 3.45) cursor = point(best, selected, ease((t - 2.35) / .72));
      if (t >= 3.45) cursor = point({ x: controls.x + 175, y: controls.y + 70 }, controls, ease((t - 4.52) / .88));
      const alpha = t < .32 ? 0 : t < 3.35 ? 1 : t < 4.5 ? 1 - clamp((t - 3.35) / .15) : (t < 5.78 ? clamp((t - 4.5) / .2) : 1 - clamp((t - 5.78) / .25));
      const pressed = (i >= 66 && i < 70) || (i >= 188 && i < 192) || (i >= 331 && i < 335);
      if (i === 66) { await page.mouse.move(best.x, best.y); await page.mouse.down(); }
      if (i === 70) await page.mouse.up();
      if (i === 188) { await page.mouse.move(selected.x, selected.y); await page.mouse.down(); }
      if (i === 192) {
        await page.mouse.up();
        playback = await waitForAudio(page);
      }
      if (i === 201) await page.locator('.player-cover-wrap').dispatchEvent('click');
      if (i === 331) { await page.mouse.move(controls.x, controls.y); await page.mouse.down(); }
      if (i === 335) await page.mouse.up();
      if (i === 346) await page.locator('.fullscreen-controls .fullscreen-play').dispatchEvent('click');
      if (i > 0) await page.clock.runFor(1000 / fps);
      if (i >= 192) {
        await page.evaluate(t => {
          const audio = Array.from(document.querySelectorAll('audio')).find(e => e.currentSrc && !e.currentSrc.startsWith('data:') && e.readyState >= 3);
          if (audio && Math.abs(audio.currentTime - (t - 3.2)) > .075) audio.currentTime = Math.max(.02, t - 3.2);
        }, t);
      }
      animationCount = await page.evaluate(({ ms, cursor, alpha, pressed }) => window.__filmSync(ms, cursor.x, cursor.y, alpha, pressed), { ms: t * 1000, cursor, alpha, pressed });
      if (!stillsOnly || stillFrames.has(i)) await page.screenshot({ path: path.join(frames, String(i).padStart(5, '0') + '.jpg'), type: 'jpeg', quality: 96 });
      if (i % 60 === 0) console.log(`Localhost capture ${i}/${count}`);
    }
    const finalState = await page.evaluate(() => ({
      authenticated: Boolean(JSON.parse(localStorage.getItem('auth-storage') || 'null')?.token),
      url: location.href,
      track: document.querySelector('.fullscreen-track-name')?.innerText || document.querySelector('.player-track-title')?.innerText,
      action: document.querySelector('.fullscreen-controls .fullscreen-play')?.getAttribute('aria-label'),
      dialogs: Array.from(document.querySelectorAll('dialog')).some(e => e.open),
      audio: Array.from(document.querySelectorAll('audio')).filter(e => e.currentSrc && !e.currentSrc.startsWith('data:')).map(e => ({ playing: !e.paused, ready: e.readyState, error: e.error?.message || null })),
    }));
    if (errors.length) throw new Error(errors.join('\n'));
    if (finalState.dialogs || finalState.track !== 'One More Time' || finalState.action !== 'Пауза' || !finalState.audio.some(e => e.playing && e.ready >= 3 && !e.error)) throw new Error('Localhost recording did not finish in the expected real playing state: ' + JSON.stringify(finalState));
    const metadata = { source: origin + '/search', query: 'Daft Punk', capturedAt: new Date().toISOString(), fps, count, width, height, pixelRatio, partial: stillsOnly, artistImages: artistImages.map(e => e.name), best, selected, selectedRow, controls, fullscreenArt, nativeAnimationCount: animationCount, audioProof, playback, finalState, actions: [{ time: 70 / fps, action: 'Click the real Лучшие filter' }, { time: 192 / fps, action: 'Play the real One More Time search result' }, { time: 201 / fps, action: 'Open the real fullscreen player' }, { time: 335 / fps, action: 'Pause using the real player control' }, { time: 346 / fps, action: 'Resume using the real player control' }] };
    fs.writeFileSync(path.join(root, 'capture.json'), JSON.stringify(metadata, null, 2) + '\n');
    console.log('Real localhost recording verified:', JSON.stringify(finalState));
    if (!stillsOnly) {
      const result = spawnSync(ffmpeg, ['-hide_banner', '-y', '-loglevel', 'error', '-framerate', String(fps), '-i', path.join(frames, '%05d.jpg'), '-frames:v', String(count), '-c:v', 'libx264', '-preset', 'fast', '-crf', '19', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(root, 'localhost-demo.mp4')], { windowsHide: true });
      if (result.status !== 0) throw new Error(result.stderr.toString());
    }
  } finally { await context.close(); await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
