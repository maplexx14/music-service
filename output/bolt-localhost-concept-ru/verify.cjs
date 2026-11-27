const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || path.join(process.env.USERPROFILE, 'AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core'));
const ffmpeg = process.env.FFMPEG_PATH || path.join(process.env.USERPROFILE, '.codex/tmp/bolt-video-tools/node_modules/ffmpeg-static/ffmpeg.exe');
const dir=__dirname;
const edition=JSON.parse(fs.readFileSync(path.join(dir,'project.json'),'utf8'));

(async()=>{
  const capture=JSON.parse(fs.readFileSync(path.join(dir,'capture.json'),'utf8'));
  assert.equal(capture.partial,false);assert.equal(capture.fps,60);assert.equal(capture.count,374);
  assert.equal(new URL(capture.source).hostname,'localhost');
  assert.equal(capture.finalState.track,edition.trackTitle);assert.equal(capture.finalState.dialogs,false);
  assert.equal(capture.cursorBaked,false);assert.deepEqual(capture.artistImages.map(name=>name.toLocaleLowerCase()),edition.artistQueries.map(name=>name.toLocaleLowerCase()));
  assert.ok(capture.finalState.audio.some(audio=>audio.playing&&audio.ready>=3&&!audio.error));
  const frames=fs.readdirSync(path.join(dir,'assets/live')).filter(name=>/^\d{5}\.jpg$/.test(name));
  assert.equal(frames.length,374);
  const movie=path.join(dir,edition.movie);
  const decoded=spawnSync(ffmpeg,['-hide_banner','-i',movie,'-map','0:v:0','-map','0:a:0','-f','null','NUL'],{windowsHide:true,maxBuffer:4*1024*1024});
  assert.equal(decoded.status,0,decoded.stderr.toString());
  const info=decoded.stderr.toString();
  assert.match(info,/Video: h264/);assert.match(info,/1920x1080/);assert.match(info,/60 fps/);assert.match(info,/Audio: aac/);assert.match(info,/bt709/);
  const counts=Array.from(info.matchAll(/frame=\s*(\d+)/g));assert.equal(Number(counts.at(-1)[1]),764);
  const silent=spawnSync(ffmpeg,['-hide_banner','-v','error','-i',path.join(dir,edition.silentMovie),'-f','null','NUL'],{windowsHide:true});assert.equal(silent.status,0,silent.stderr.toString());
  const browser=await chromium.launch({executablePath:process.env.EDGE_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1050}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(pathToFileURL(path.join(dir,'preview.html')).href);
    await page.locator('video').evaluate(video=>new Promise((resolve,reject)=>{
      if(video.readyState>=1)return resolve();video.addEventListener('loadedmetadata',resolve,{once:true});video.addEventListener('error',()=>reject(new Error(video.error?.message)),{once:true});
    }));
    const metadata=await page.locator('video').evaluate(video=>({width:video.videoWidth,height:video.videoHeight,duration:video.duration}));
    assert.equal(metadata.width,1920);assert.equal(metadata.height,1080);assert.ok(Math.abs(metadata.duration-764/60)<.04);
    for(const t of [.8,3.97,5.68,7.18,11.25,12.25]) {
      await page.locator('video').evaluate((video,t)=>new Promise((resolve,reject)=>{
        video.addEventListener('seeked',resolve,{once:true});video.addEventListener('error',()=>reject(new Error(video.error?.message)),{once:true});video.currentTime=t;
      }),t);
      assert.ok(await page.locator('video').evaluate(video=>video.readyState>=2));
    }
    await page.screenshot({path:path.join(dir,'preview-verified.png')});assert.deepEqual(errors,[]);
    console.log(JSON.stringify({verified:true,realLocalhostFrames:frames.length,filmFrames:764,format:'1920 × 1080 / 60 fps / H.264 + AAC / BT.709',duration:metadata.duration,fileBytes:fs.statSync(movie).size,fullDecode:'passed',browserPreviewAndSeeking:'passed'},null,2));
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
