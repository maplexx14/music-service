const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || path.join(process.env.USERPROFILE, 'AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core'));

(async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--disable-background-networking'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 920 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const query = process.env.DEMO_QUERY || 'Daft Punk';
    await page.goto('http://localhost/search?q=' + encodeURIComponent(query), { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6000);
    await page.screenshot({ path: path.join(__dirname, 'live-search.png') });
    const info = await page.evaluate(() => ({
      url: location.href,
      authenticated: Boolean(JSON.parse(localStorage.getItem('auth-storage') || 'null')?.token),
      text: document.body.innerText.slice(0, 2000),
      buttons: Array.from(document.querySelectorAll('button')).slice(0, 12).map(e => ({ text: e.innerText, label: e.getAttribute('aria-label'), title: e.title, class: e.className })),
      images: Array.from(document.images).slice(0, 8).map(e => ({ alt: e.alt, loaded: e.complete && e.naturalWidth > 0 })),
    }));
    console.log(JSON.stringify({ ...info, errors }, null, 2));
    if (process.argv.includes('--interact')) {
      await page.locator('button.search-filter').filter({ hasText: /^Лучшие$/ }).click();
      await page.waitForTimeout(1500);
      const rows = await page.locator('.tracks-table tbody tr').allTextContents();
      console.log('Best rows:', JSON.stringify(rows.slice(0, 5)));
      await page.screenshot({ path: path.join(__dirname, 'live-filter.png') });
      await page.locator('.track-name[title="One More Time"]').first().click();
      await page.waitForTimeout(6000);
      console.log('Playback:', await page.evaluate(() => ({ text: document.querySelector('.player')?.innerText, audio: Array.from(document.querySelectorAll('audio')).map(e => ({ playing: !e.paused, time: e.currentTime, ready: e.readyState, error: e.error?.message })) })));
      await page.locator('.player-cover-wrap').click();
      await page.waitForTimeout(1500);
      await page.screenshot({ path: path.join(__dirname, 'live-player.png') });
      console.log('Fullscreen:', JSON.stringify(await page.evaluate(() => ({ text: document.body.innerText.slice(-1200), buttons: Array.from(document.querySelectorAll('button')).slice(-24).map(e => ({ label: e.getAttribute('aria-label'), title: e.title, class: e.className })), dialogs: Array.from(document.querySelectorAll('dialog')).map(e => e.open) })), null, 2));
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
