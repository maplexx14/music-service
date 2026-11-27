const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const sharp = require('sharp');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || path.join(process.env.USERPROFILE, 'AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core'));
const dir = __dirname;
const edition = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
const origin = process.env.BOLT_URL || 'http://localhost';
const ffmpeg=process.env.FFMPEG_PATH||path.join(process.env.USERPROFILE,'.codex/tmp/bolt-video-tools/node_modules/ffmpeg-static/ffmpeg.exe');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname)) throw new Error('Capture requires localhost.');
const fps = 60, count = Math.round(edition.introDuration * fps);
const frames = path.join(dir, 'assets/intro');
const username = 'bolt_video_' + Date.now();
const gesture = { start: edition.swipeStart, release: edition.swipeStart + edition.swipeDuration, from: { x: 325, y: 660 }, to: { x: 65, y: 660 } };

// A separate, temporary local account keeps recording out of existing users' libraries.
function backendPython(script) {
  const result = spawnSync('docker', ['exec', '-i', 'music_backend', 'python', '-'], { input: script, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || 'Local recording setup failed.');
  return result.stdout;
}
async function state(page) {
  return page.evaluate(() => ({
    path: location.pathname,
    track: document.querySelector('.player-left .player-track-title')?.textContent,
    playing: document.querySelector('.play-pause-btn')?.getAttribute('aria-label') === 'Пауза',
    deck: !!document.querySelector('.screen[data-active] .desktop-cd-player'),
    activeScreen: document.querySelector('.screen[data-active]')?.dataset.screen,
    nativeMotion: (()=>{
      const animation=document.getAnimations().find(item=>item.id==='cd-player-playback-tilt');
      return animation?{id:animation.id,elapsed:Number(animation.currentTime)||0,duration:Number(animation.effect.getTiming().duration),keyframes:animation.effect.getKeyframes().length,transform:getComputedStyle(animation.effect.target).transform}:null;
    })(),
  }));
}

(async () => {
  fs.mkdirSync(frames, { recursive: true });
  let browser, recordingPage;
  try {
    const session = JSON.parse(backendPython(`
import json, secrets
from datetime import timedelta
from app.database import SessionLocal
from app.models import User
from app.auth import get_password_hash, create_access_token
from app.schemas import UserResponse
with SessionLocal() as db:
    user = User(username=${JSON.stringify(username)}, email=${JSON.stringify(username + '@example.com')}, hashed_password=get_password_hash(secrets.token_urlsafe(24)), email_verified=True, onboarding_completed=True, player_setup_completed=True, preferred_artists=['CUPSIZE'], push_releases=False, push_reminders=False)
    db.add(user)
    db.commit()
    db.refresh(user)
    token = create_access_token({'sub': user.username}, expires_delta=timedelta(minutes=30))
    print(json.dumps({'token': token, 'user': UserResponse.model_validate(user).model_dump(mode='json')}))
`));
    browser = await chromium.launch({ executablePath: process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--disable-background-networking', '--force-color-profile=srgb'] });
    const context = await browser.newContext({ viewport: edition.viewport, deviceScaleFactor: edition.pixelRatio, isMobile: true, hasTouch: true, serviceWorkers: 'block', userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36' });
    await context.addInitScript(({ token, user, origin }) => {
      if (location.origin !== origin) return;
      const request = window.requestAnimationFrame.bind(window);
      const cancel = window.cancelAnimationFrame.bind(window);
      const pending = new Map();
      let manual = false, nextId = 0;
      window.requestAnimationFrame = callback => {
        const id = ++nextId;
        const entry = { callback, native: null };
        pending.set(id, entry);
        if (!manual) entry.native = request(at => { pending.delete(id); callback(at); });
        return id;
      };
      window.cancelAnimationFrame = id => {
        const entry = pending.get(id);
        if (entry?.native !== null) cancel(entry?.native);
        pending.delete(id);
      };
      window.boltCaptureClock = {
        start() { manual = true; for (const entry of pending.values()) if (entry.native !== null) cancel(entry.native); },
        paint(at) { const batch = [...pending.values()]; pending.clear(); for (const entry of batch) entry.callback(at); },
      };
      localStorage.setItem('auth-storage', JSON.stringify({ token, user, isAuthenticated: true }));
      localStorage.setItem('cd-player-unboxed:' + user.id, '1');
      // Device emulation: the same standalone display mode as the installed PWA.
      const matchMedia = window.matchMedia.bind(window);
      window.matchMedia = query => {
        const result = matchMedia(query);
        if (query === '(display-mode: standalone)') Object.defineProperty(result, 'matches', { value: true });
        return result;
      };
    }, { token: session.token, user: session.user, origin });
    const page = await context.newPage();
    recordingPage = page;
    // Start the capture clock before the service initializes its GPU cadence.
    // Installing it later resets performance.now below the last rendered frame.
    await page.clock.install();
    await page.addLocatorHandler(page.getByRole('dialog',{name:'Новая версия для Android',exact:true}),async()=>{
      await page.getByRole('button',{name:'Позже',exact:true}).tap();
    });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/search?q=' + encodeURIComponent(edition.query), { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    await page.locator('.search-filter').filter({ hasText: /^Лучшие$/ }).waitFor({ timeout: 45000 });
    const dismiss = page.getByRole('button', { name: 'Закрыть подсказку', exact: true });
    const dismissHint = async () => {
      if (!await dismiss.isVisible()) return;
      try { await dismiss.tap({ timeout: 3000 }); }
      catch (error) { if (await dismiss.isVisible()) throw error; }
    };
    await dismissHint();
    const later = page.getByRole('button', { name: 'Позже', exact: true });
    if (await later.isVisible()) { try { await later.tap({ timeout: 3000 }); } catch (error) { if (await later.isVisible()) throw error; } }
    await page.locator('.search-filter').filter({ hasText: /^Лучшие$/ }).tap();
    const track = page.locator('.search-mobile-tracks:visible .track-item-title').filter({ hasText: edition.trackTitle }).first();
    await track.waitFor({ timeout: 45000 }); await track.tap();
    await page.waitForFunction(() => document.querySelector('.play-pause-btn')?.getAttribute('aria-label') === 'Пауза', {}, { timeout: 30000 });
    await dismissHint();
    if (await later.isVisible()) { try { await later.tap({ timeout: 3000 }); } catch (error) { if (await later.isVisible()) throw error; } }
    await page.locator('.search-filter').filter({ hasText: /^Все$/ }).tap();
    await page.locator('.search-input').evaluate(element => element.blur());
    await page.waitForTimeout(1500);
    await page.locator('.mobile-nav-global-item[href="/"]').tap();
    await page.locator('.screen[data-screen="tab:/"][data-active] .hero-section').waitFor({ timeout: 30000 });
    await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(4500);
    await dismissHint();
    if (await later.isVisible()) { try { await later.tap({ timeout: 3000 }); } catch (error) { if (await later.isVisible()) throw error; } }
    await page.waitForFunction(()=>document.getAnimations().some(animation=>animation.id==='cd-player-playback-tilt'&&animation.playState==='running'),{},{timeout:30000});
    const initial = await state(page);
    if (initial.path !== '/' || !initial.playing || !initial.nativeMotion || initial.track !== edition.trackTitle) throw new Error('The homepage was not prepared with native playback motion: ' + JSON.stringify(initial));
    const swipeY = await page.evaluate(() => [660,650,640,190,170,150].find(y => [325,195,65].every(x => {
      const target=document.elementFromPoint(x,y);
      return target?.closest('.main-content')&&!target.closest('[data-swipe-ignore],button,input,[role="slider"],.cd-mobile-queue');
    })));
    if(swipeY===undefined)throw new Error('No free homepage area is available for the tab swipe.');
    gesture.from.y=swipeY;gesture.to.y=swipeY;
    await page.screenshot({ path: path.join(dir, 'source-home.png') });
    if (process.argv.includes('--probe')) { console.log(JSON.stringify(initial)); return; }

    const cdp = await context.newCDPSession(page);
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 50));
    await page.evaluate(() => window.boltCaptureClock.start());
    const nativeAnimations = await page.evaluateHandle(() => {
      const known = new Map();
      return ms => {
        for (const animation of document.getAnimations()) {
          // The PWA scrubs paused drag animations by finger position. Their
          // currentTime is a coordinate, so the capture clock must not advance it.
          const target=animation.effect?.target;
          if(animation.playState==='paused'&&!known.has(animation)&&(target?.classList.contains('screen')||target?.classList.contains('mobile-nav-global-pill')))continue;
          let entry = known.get(animation);
          if (!entry) {
            entry = { start: ms, base: Number(animation.currentTime) || 0 };
            known.set(animation, entry);
            animation.playbackRate = 0;
            // Film frames already provide a fixed 60 Hz cadence. A second
            // steps() quantizer can repeat poses around floating boundaries.
            if (/^cd-.*(spin|playback-tilt)$/.test(animation.id)) animation.effect.updateTiming({ easing: 'linear' });
          }
          if (entry.done) continue;
          const time = entry.base + ms - entry.start, timing = animation.effect.getComputedTiming();
          if (Number.isFinite(timing.endTime) && time >= timing.endTime) { animation.currentTime = timing.endTime; try { animation.finish(); } catch {} entry.done = true; }
          else animation.currentTime = Math.max(0, time);
        }
      };
    });
    const startFrame = Math.round(gesture.start * fps), releaseFrame = Math.round(gesture.release * fps);
    const pauseFrame=Math.round(edition.introPauseAt*fps);
    const checkpoints = [];
    let pausePoint;
    let introAudio;
    for (let frame = 0; frame < count; frame++) {
      // Audio timers can refresh the GPU too. Set the pose before advancing
      // either timers or rAF so every paint sees this frame's timestamp.
      await page.evaluate(({ sync, ms }) => sync(ms), { sync: nativeAnimations, ms: frame * 1000 / fps });
      if (frame > 0) await page.clock.runFor(1000 / fps);
      if(frame===0)introAudio=await page.evaluate(()=>{
        const audio=[...document.querySelectorAll('audio')].find(element=>!element.paused&&element.currentSrc&&!element.currentSrc.startsWith('data:'));
        return audio?{source:audio.currentSrc,time:audio.currentTime}:null;
      });
      if (frame >= startFrame && frame <= releaseFrame) {
        const p = (frame - startFrame) / (releaseFrame - startFrame);
        const eased=p*p*p*(10+p*(-15+6*p));
        const x = gesture.from.x + (gesture.to.x - gesture.from.x) * eased;
        await cdp.send('Input.dispatchTouchEvent', { type: frame === startFrame ? 'touchStart' : frame === releaseFrame ? 'touchEnd' : 'touchMove', touchPoints: frame === releaseFrame ? [] : [{ x, y: gesture.from.y, id: 1, radiusX: 6, radiusY: 6, force: 1 }] });
      }
      if(frame===pauseFrame) {
        if(!(await page.evaluate(()=>location.pathname==='/search')))throw new Error('The native swipe has not settled before the pause tap.');
        pausePoint=await page.locator('.play-pause-btn').evaluate(button=>{const bounds=button.getBoundingClientRect();return {x:bounds.x+bounds.width/2,y:bounds.y+bounds.height/2}});
        await page.touchscreen.tap(pausePoint.x,pausePoint.y);
      }
      await page.evaluate(({ sync, ms }) => sync(ms), { sync: nativeAnimations, ms: frame * 1000 / fps });
      // Present at the next display boundary, after all timer-driven refreshes.
      // This also ensures the GPU's frame budget cannot discard this capture.
      await page.evaluate(() => window.boltCaptureClock.paint(performance.now() + 1000 / 60));
      await page.evaluate(() => window.boltCaptureClock.paint(performance.now() + 2000 / 60));
      await page.evaluate(() => {
        for (const canvas of document.querySelectorAll('canvas')) {
          const gl = canvas.getContext('webgl2') || canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
          gl?.finish();
        }
      });
      // Flush the compositor once before saving; screenshots may otherwise
      // reuse the previously submitted WebGL surface under GPU load.
      await page.screenshot({ type: 'jpeg', quality: 96 });
      if ([0,15,30,startFrame,Math.round((startFrame+releaseFrame)/2),releaseFrame,66,pauseFrame,count-1].includes(frame)) checkpoints.push({ frame, ...(await state(page)) });
      await page.screenshot({ path: path.join(frames, String(frame).padStart(5, '0') + '.jpg'), type: 'jpeg', quality: 96 });
      if (frame % 30 === 0) console.log(`Home swipe recording ${frame}/${count}`);
    }
    const final = await state(page);
    if (final.path !== '/search' || final.playing || final.track !== edition.trackTitle) throw new Error('The native swipe did not reach the paused search screen: ' + JSON.stringify(final));
    if (errors.length) throw new Error(errors.join('\n'));
    const poses=new Set(checkpoints.filter(item=>item.path==='/'&&item.nativeMotion).map(item=>item.nativeMotion.transform));
    if(poses.size<3)throw new Error('Native player motion did not advance in the homepage recording.');
    const region={left:120,top:650,width:850,height:950};
    const bitmaps=await Promise.all([0,30].map(frame=>sharp(path.join(frames,String(frame).padStart(5,'0')+'.jpg')).extract(region).raw().toBuffer()));
    let pixelDifference=0;for(let i=0;i<bitmaps[0].length;i++)pixelDifference+=Math.abs(bitmaps[0][i]-bitmaps[1][i]);
    pixelDifference/=bitmaps[0].length;
    if(pixelDifference<.1)throw new Error('The native GPU player stayed visually frozen despite its animation clock advancing.');
    if(!introAudio)throw new Error('Native homepage playback has no audio source.');
    const audioClip=spawnSync(ffmpeg,['-hide_banner','-y','-loglevel','error','-ss',String(introAudio.time),'-i',introAudio.source,'-t',String(edition.introPauseAt),'-ar','48000','-ac','2','-c:a','pcm_s16le',path.join(dir,'assets/intro-track.wav')],{windowsHide:true,timeout:60000});
    if(audioClip.status!==0)throw new Error('Could not capture the homepage track audio: '+audioClip.stderr?.toString());
    fs.writeFileSync(path.join(dir, 'intro.json'), JSON.stringify({ source: origin + '/', fps, count, width: edition.viewport.width, height: edition.viewport.height, gesture:{...gesture,easing:'smootherstep'}, pauseAction:{time:edition.introPauseAt,point:pausePoint}, playerMotion:{native:true,animationId:'cd-player-playback-tilt',period:initial.nativeMotion.duration,keyframes:initial.nativeMotion.keyframes,pixelDifference,synchronizedCapture:true}, initial, final, checkpoints, nativeSwipe: true, partial: false }, null, 2) + '\n');
    console.log('Native playing CD player → smooth search swipe → pause captured.');
  } catch(error) {
    if(recordingPage) {
      await recordingPage.screenshot({path:path.join(dir,'intro-error.png')}).catch(()=>{});
      console.error(JSON.stringify(await recordingPage.evaluate(()=>({path:location.pathname,text:document.body.innerText.slice(0,1200)})).catch(()=>({}))));
    }
    throw error;
  } finally {
    if (browser) await browser.close();
    backendPython(`
from app.database import SessionLocal
from app.models import User
with SessionLocal() as db:
    user = db.query(User).filter(User.username == ${JSON.stringify(username)}).one_or_none()
    if user is not None:
        db.delete(user)
        db.commit()
`);
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
