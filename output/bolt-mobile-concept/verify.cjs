const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || path.join(process.env.USERPROFILE, 'AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core'));
const ffmpeg = process.env.FFMPEG_PATH || path.join(process.env.USERPROFILE, '.codex/tmp/bolt-video-tools/node_modules/ffmpeg-static/ffmpeg.exe');
const dir=__dirname;
const edition=JSON.parse(fs.readFileSync(path.join(dir,'project.json'),'utf8'));
const filmFrames=Math.round((edition.introDuration+edition.sourceDuration+(764/60-edition.sourceDuration)/edition.endingSpeed)*60);
const filmDuration=filmFrames/60;
const editTime=t=>edition.introDuration+(t<=edition.sourceDuration?t:edition.sourceDuration+(t-edition.sourceDuration)/edition.endingSpeed);

(async()=>{
  const capture=JSON.parse(fs.readFileSync(path.join(dir,'capture.json'),'utf8'));
  const intro=JSON.parse(fs.readFileSync(path.join(dir,'intro.json'),'utf8'));
  assert.equal(intro.partial,false);assert.equal(intro.nativeSwipe,true);
  assert.equal(intro.initial.path,'/');assert.equal(intro.final.path,'/search');
  assert.equal(intro.initial.deck,true);assert.equal(intro.initial.playing,true);assert.equal(intro.final.playing,false);
  assert.equal(intro.initial.track,edition.trackTitle);assert.equal(intro.final.track,edition.trackTitle);
  assert.ok(Math.abs(intro.gesture.release-intro.gesture.start-edition.swipeDuration)<.001);
  assert.equal(intro.playerMotion.native,true);assert.equal(intro.playerMotion.animationId,'cd-player-playback-tilt');
  assert.equal(intro.playerMotion.period,18000);assert.equal(intro.playerMotion.keyframes,121);
  assert.ok(intro.playerMotion.pixelDifference>.1);
  assert.equal(intro.pauseAction.time,edition.introPauseAt);
  assert.equal(intro.gesture.easing,'smootherstep');
  assert.ok(new Set(intro.checkpoints.filter(item=>item.path==='/'&&item.nativeMotion).map(item=>item.nativeMotion.transform)).size>=3);
  const introFrames=fs.readdirSync(path.join(dir,'assets/intro')).filter(name=>/^\d{5}\.jpg$/.test(name));
  assert.equal(introFrames.length,Math.round(edition.introDuration*60));
  assert.equal(capture.partial,false);assert.equal(capture.fps,60);assert.equal(capture.count,396);
  assert.equal(new URL(capture.source).hostname,'localhost');
  assert.equal(capture.finalState.track,edition.trackTitle);assert.equal(capture.finalState.dialogs,false);
  assert.equal(capture.cursorBaked,false);assert.deepEqual(capture.artistImages.map(name=>name.toLocaleLowerCase()),edition.artistQueries.map(name=>name.toLocaleLowerCase()));
  assert.equal(capture.device.width,390);assert.equal(capture.device.height,844);assert.equal(capture.device.coarse,true);assert.equal(capture.device.mobileNavVisible,true);
  assert.equal(capture.initialState.playing,false);assert.equal(capture.pausedProof.playing,false);assert.equal(capture.pausedProof.label,'Играть');
  assert.equal(capture.finalState.playing,true);assert.equal(capture.finalState.audioPlaying,true);assert.ok(capture.finalState.ready>=3);
  assert.equal(capture.playbackTransitions.length,1);assert.equal(capture.playbackTransitions[0].from,'paused');assert.equal(capture.playbackTransitions[0].to,'playing');
  assert.ok(Math.abs(capture.playbackTransitions[0].time-edition.playAt)<.05);
  const before=capture.checkpoints.filter(c=>c.time<edition.playAt),after=capture.checkpoints.filter(c=>c.time>edition.playAt+.15);
  assert.ok(before.length>0&&after.length>0);assert.ok(before.every(c=>!c.playing));assert.ok(after.every(c=>c.playing));
  assert.ok(after.some(c=>c.time>5.5&&c.time<6.3&&c.fullscreen&&c.time>edition.playAt));
  assert.ok(capture.finalState.time>=edition.seekSeconds+1);
  const frames=fs.readdirSync(path.join(dir,'assets/live')).filter(name=>/^\d{5}\.jpg$/.test(name));
  assert.equal(frames.length,396);
  const movie=path.join(dir,edition.movie);
  const decoded=spawnSync(ffmpeg,['-hide_banner','-i',movie,'-map','0:v:0','-map','0:a:0','-f','null','NUL'],{windowsHide:true,maxBuffer:4*1024*1024});
  assert.equal(decoded.status,0,decoded.stderr.toString());
  const info=decoded.stderr.toString();
  assert.match(info,/Video: h264/);assert.match(info,/1080x1920/);assert.match(info,/60 fps/);assert.match(info,/Audio: aac/);assert.match(info,/bt709/);
  const counts=Array.from(info.matchAll(/frame=\s*(\d+)/g));assert.equal(Number(counts.at(-1)[1]),filmFrames);
  const silent=spawnSync(ffmpeg,['-hide_banner','-v','error','-i',path.join(dir,edition.silentMovie),'-f','null','NUL'],{windowsHide:true});assert.equal(silent.status,0,silent.stderr.toString());
  const browser=await chromium.launch({executablePath:process.env.EDGE_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1000,height:1200}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(pathToFileURL(path.join(dir,'preview.html')).href);
    await page.locator('video').evaluate(video=>new Promise((resolve,reject)=>{
      if(video.readyState>=1)return resolve();video.addEventListener('loadedmetadata',resolve,{once:true});video.addEventListener('error',()=>reject(new Error(video.error?.message)),{once:true});
    }));
    const metadata=await page.locator('video').evaluate(video=>({width:video.videoWidth,height:video.videoHeight,duration:video.duration}));
    assert.equal(metadata.width,1080);assert.equal(metadata.height,1920);assert.equal(metadata.width/metadata.height,9/16);assert.ok(Math.abs(metadata.duration-filmDuration)<.04);
    for(const t of [.25,.44,edition.swipeStart+edition.swipeDuration*.6,edition.introPauseAt,1.45,...[.8,3.78,4.64,4.88,5.85,7.44,11.25,12.25].map(editTime)]) {
      await page.locator('video').evaluate((video,t)=>new Promise((resolve,reject)=>{
        video.addEventListener('seeked',resolve,{once:true});video.addEventListener('error',()=>reject(new Error(video.error?.message)),{once:true});video.currentTime=t;
      }),t);
      assert.ok(await page.locator('video').evaluate(video=>video.readyState>=2));
    }
    await page.screenshot({path:path.join(dir,'preview-verified.png')});assert.deepEqual(errors,[]);
    const playbackTransitions=[{frame:Math.round(intro.pauseAction.time*60),time:intro.pauseAction.time,from:'playing',to:'paused',label:'Играть'},...capture.playbackTransitions.map(event=>({...event,time:editTime(event.time)}))];
    console.log(JSON.stringify({verified:true,artists:capture.artistImages,realMobileLocalhostFrames:frames.length,homeSwipeFrames:introFrames.length,swipeDuration:intro.gesture.release-intro.gesture.start,playerMotion:intro.playerMotion,filmFrames,format:'1080 × 1920 / 9:16 / 60 fps / H.264 + AAC / BT.709',duration:metadata.duration,playbackTransitions,fileBytes:fs.statSync(movie).size,fullDecode:'passed',browserPreviewAndSeeking:'passed'},null,2));
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
