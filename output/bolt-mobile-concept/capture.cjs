const fs=require('node:fs'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||path.join(process.env.USERPROFILE,'AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core'));
const dir=__dirname,edition=JSON.parse(fs.readFileSync(path.join(dir,'project.json'),'utf8'));
const assets=path.join(dir,'assets'),frames=path.join(assets,'live');
const origin=process.env.BOLT_URL||'http://localhost';
if(!['localhost','127.0.0.1','[::1]'].includes(new URL(origin).hostname))throw new Error('BOLT_URL must point to localhost.');
const ffmpeg=process.env.FFMPEG_PATH||path.join(process.env.USERPROFILE,'.codex/tmp/bolt-video-tools/node_modules/ffmpeg-static/ffmpeg.exe');
const fps=60,count=Math.round(edition.sourceDuration*fps),stillsOnly=process.argv.includes('--stills');
const stillFrames=new Set([0,36,68,72,114,150,161,170,186,222,258,280,281,282,283,286,294,312,336,366,395]);
const canonical=name=>name.toLocaleLowerCase().replace(/\s+/g,'');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const phone={viewport:edition.viewport,deviceScaleFactor:edition.pixelRatio,isMobile:true,hasTouch:true,serviceWorkers:'block',userAgent:'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36'};
const trackNode=page=>page.locator('.search-mobile-tracks:visible .track-item-title').filter({hasText:edition.trackTitle}).first();

async function rect(locator) {
  return locator.first().evaluate(e=>{const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height}});
}
async function dismissInstall(page) {
  const close=page.getByRole('button',{name:'Закрыть подсказку',exact:true});
  if(await close.isVisible())await close.tap();
}
async function readySearch(page,query) {
  await page.goto(origin+'/search?q='+encodeURIComponent(query),{waitUntil:'domcontentloaded'});
  await page.locator('.search-filter').first().waitFor({timeout:30000});
  await page.waitForFunction(()=>{
    const visible=e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0;
    return !Array.from(document.querySelectorAll('.spinner-wrap')).some(visible)&&Array.from(document.querySelectorAll('.artist-card,.track-item')).some(visible);
  },{},{timeout:45000});
  await page.locator('.search-input').evaluate(e=>e.blur());await page.evaluate(()=>document.fonts.ready);
  await page.waitForFunction(()=>Array.from(document.images).filter(e=>{
    const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.top<innerHeight&&r.bottom>0&&r.left<innerWidth&&r.right>0;
  }).every(e=>e.complete&&e.naturalWidth>0),{},{timeout:25000});
  await page.evaluate(()=>Promise.all(Array.from(document.images).filter(e=>e.complete&&e.naturalWidth).map(e=>e.decode().catch(()=>{}))));
  await page.waitForTimeout(500);
  await dismissInstall(page);
}
async function artist(context,name) {
  const page=await context.newPage();
  try {
    await readySearch(page,name);
    const item=await page.locator('.artist-card img').evaluateAll((images,name)=>{
      const canonical=value=>value.toLocaleLowerCase().replace(/\s+/g,'');
      const found=images.find(e=>canonical(e.alt)===canonical(name));
      return found?{sourceName:found.alt,url:found.currentSrc||found.src}:null;
    },name);
    if(!item)throw new Error('Requested artist is missing from the real app: '+name);
    const response=await context.request.get(item.url);if(!response.ok())throw new Error('Could not load artist artwork: '+name);
    return {...item,name,body:await response.body()};
  } finally {await page.close();}
}
async function state(page) {
  return page.evaluate(()=>{
    const full=document.querySelector('.fullscreen-controls .fullscreen-play');
    const mini=document.querySelector('.play-pause-btn');
    const label=(full||mini)?.getAttribute('aria-label');
    const audio=Array.from(document.querySelectorAll('audio')).find(e=>!e.paused&&e.currentSrc&&!e.currentSrc.startsWith('data:'))||Array.from(document.querySelectorAll('audio')).find(e=>e.currentSrc&&!e.currentSrc.startsWith('data:')&&e.readyState>=3);
    return {track:document.querySelector('.player-left .player-track-title')?.innerText,artist:document.querySelector('.player-left .player-track-artist')?.innerText,label,playing:label==='Пауза',audioPlaying:audio?!audio.paused:false,ready:audio?.readyState||0,time:audio?.currentTime||0,error:audio?.error?.message||null,source:audio?.currentSrc||null,fullscreen:!!document.querySelector('.fullscreen-player'),dialogs:Array.from(document.querySelectorAll('dialog')).some(e=>e.open)||!!document.querySelector('.install-prompt'),progress:document.querySelector('.fullscreen-progress-time span')?.textContent};
  });
}
async function waitAudio(page) {
  for(let i=0;i<150;i++) {
    const value=await state(page);
    if(value.track&&value.track!==edition.trackTitle)throw new Error('The real app skipped the requested track: '+value.track);
    if(value.error||value.dialogs)throw new Error('Real playback failed: '+JSON.stringify(value));
    if(value.playing&&value.audioPlaying&&value.ready>=3)return value;
    await sleep(150);
  }
  throw new Error('The real mobile stream did not start.');
}
async function seek(page,seconds) {
  const slider=page.getByRole('slider',{name:'Перемотка',exact:true});
  const value=await slider.evaluate(e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y+r.height/2,width:r.width,duration:Number(e.getAttribute('aria-valuemax'))}});
  await page.touchscreen.tap(value.x+Math.max(.003,Math.min(.997,seconds/value.duration))*value.width,value.y);
  await page.waitForTimeout(450);
}

(async()=>{
  fs.mkdirSync(frames,{recursive:true});
  const browser=await chromium.launch({executablePath:process.env.EDGE_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,args:['--disable-background-networking','--force-color-profile=srgb']});
  const context=await browser.newContext(phone),errors=[];
  try {
    const result=await Promise.allSettled(edition.artistQueries.map(name=>artist(context,name)));
    const artistImages=result.map(r=>{if(r.status!=='fulfilled')throw r.reason;return r.value});
    artistImages.forEach((item,i)=>fs.writeFileSync(path.join(assets,`artist-${i+1}.jpg`),item.body));
    const project=path.resolve(dir,'../..');
    fs.copyFileSync(path.join(project,'frontend/src/assets/brand-mark.png'),path.join(assets,'mark.png'));
    for(const name of ['geologica-cyrillic.woff2','geologica-latin.woff2'])fs.copyFileSync(path.join(project,'output/bolt-concept-ad/assets',name),path.join(assets,name));

    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
    await readySearch(page,edition.query);await page.waitForTimeout(3300);await dismissInstall(page);
    await page.locator('.search-filter').filter({hasText:/^Лучшие$/}).tap();await trackNode(page).waitFor();
    await trackNode(page).tap();const audioProof=await waitAudio(page);
    await page.locator('.player-cover-wrap').tap();await page.locator('.fullscreen-controls .fullscreen-play').waitFor();await page.waitForTimeout(1000);
    await seek(page,edition.seekSeconds);await waitAudio(page);
    const source=(await state(page)).source;
    // Use an actual excerpt of this same localhost stream for the audible play action.
    if(!source||!/^https?:/.test(source))throw new Error('The mobile audio stream has no readable source URL.');
    const clip=spawnSync(ffmpeg,['-hide_banner','-y','-loglevel','error','-ss',String(edition.seekSeconds),'-i',source,'-t',String(edition.sourceDuration-edition.playAt),'-ar','48000','-ac','2','-c:a','pcm_s16le',path.join(assets,'demo-track.wav')],{windowsHide:true,timeout:60000,maxBuffer:2*1024*1024});
    if(clip.status!==0)throw new Error('Could not extract the real playing fragment: '+clip.stderr?.toString());
    await dismissInstall(page);
    await page.locator('.fullscreen-controls .fullscreen-play').tap();
    await page.waitForFunction(()=>document.querySelector('.fullscreen-controls .fullscreen-play')?.getAttribute('aria-label')==='Играть');await page.waitForTimeout(650);
    await seek(page,edition.seekSeconds);
    const controls=await rect(page.locator('.fullscreen-controls .fullscreen-play'));
    const fullscreenArt=await rect(page.locator('.fullscreen-art'));
    const logoUrl=await page.locator('.fullscreen-logo').getAttribute('src');
    const logoResponse=await context.request.get(new URL(logoUrl,origin).href);if(!logoResponse.ok())throw new Error('Bolt wordmark did not load.');
    fs.writeFileSync(path.join(assets,'bolt.webp'),await logoResponse.body());
    await dismissInstall(page);
    const pausedProof=await state(page);if(pausedProof.playing||pausedProof.label!=='Играть'||pausedProof.dialogs)throw new Error('The mobile player was not prepared paused.');
    await page.screenshot({path:path.join(dir,'source-player-paused.png')});
    await page.getByRole('button',{name:'Закрыть',exact:true}).tap();await page.locator('.fullscreen-player').waitFor({state:'detached'});
    const selected=await rect(trackNode(page));
    const selectedRow=await trackNode(page).evaluate(e=>{const r=e.closest('.track-item').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height}});
    await page.locator('.search-filter').filter({hasText:/^Все$/}).tap();await page.waitForTimeout(500);
    const best=await rect(page.locator('.search-filter').filter({hasText:/^Лучшие$/}));
    const miniCover=await rect(page.locator('.player-cover-wrap'));
    const device=await page.evaluate(()=>({width:innerWidth,height:innerHeight,touch:navigator.maxTouchPoints,coarse:matchMedia('(pointer: coarse)').matches,mobileNavVisible:document.querySelector('.mobile-nav-global')?.getBoundingClientRect().height>0,sidebarVisible:document.querySelector('.sidebar')?.getBoundingClientRect().width>0}));
    if(!device.coarse||!device.mobileNavVisible||device.width!==edition.viewport.width)throw new Error('The source is not the real mobile layout.');
    const initial=await state(page);if(initial.playing)throw new Error('Recording must begin paused.');
    await page.clock.install();await page.clock.pauseAt(await page.evaluate(()=>Date.now()+50));
    await page.evaluate(()=>{
      const animations=new Map();window.__filmSync=ms=>{
        for(const animation of document.getAnimations()) {
          let item=animations.get(animation);if(!item){item={start:ms,base:Number(animation.currentTime)||0,done:false};animations.set(animation,item);animation.pause()}
          if(item.done)continue;const t=item.base+ms-item.start,timing=animation.effect.getComputedTiming();
          if(Number.isFinite(timing.endTime)&&t>=timing.endTime){animation.currentTime=timing.endTime;try{animation.finish()}catch{}item.done=true}else animation.currentTime=Math.max(0,t);
        }
        return animations.size;
      };window.__filmSync(0);
    });
    let lastPlaying=false,nativeAnimationCount=0;
    const playbackTransitions=[],checkpoints=[];
    const openFrame=Math.round(edition.openAt*fps),playFrame=Math.round(edition.playAt*fps);
    for(let i=0;i<count;i++) {
      const t=i/fps;
      if(i===70)await page.touchscreen.tap(best.x,best.y);
      if(i===openFrame)await page.touchscreen.tap(miniCover.x,miniCover.y);
      if(i===playFrame) {
        const before=await state(page);if(before.playing||before.label!=='Играть'||!before.fullscreen)throw new Error('Play must start from the paused fullscreen player.');
        await page.touchscreen.tap(controls.x,controls.y);
      }
      if(i>0)await page.clock.runFor(1000/fps);
      if(i>=playFrame)await page.evaluate(({time,offset})=>{
        const audio=Array.from(document.querySelectorAll('audio')).find(e=>!e.paused&&e.currentSrc&&!e.currentSrc.startsWith('data:'));
        if(audio&&audio.readyState>=3&&Math.abs(audio.currentTime-(offset+time))>.075)audio.currentTime=offset+time;
      },{time:t-edition.playAt,offset:edition.seekSeconds});
      nativeAnimationCount=await page.evaluate(ms=>window.__filmSync(ms),t*1000);
      const current=await state(page);
      if(current.track!==edition.trackTitle||current.dialogs||current.error)throw new Error('The actual mobile demo changed unexpectedly: '+JSON.stringify(current));
      if(current.playing!==lastPlaying){playbackTransitions.push({frame:i,time:t,from:lastPlaying?'playing':'paused',to:current.playing?'playing':'paused',label:current.label});lastPlaying=current.playing}
      if(i<playFrame&&current.playing)throw new Error('Playback started before the one Play tap.');
      if(stillFrames.has(i))checkpoints.push({...current,source:undefined,frame:i,time:t,audioTime:current.time});
      if(!stillsOnly||stillFrames.has(i))await page.screenshot({path:path.join(frames,String(i).padStart(5,'0')+'.jpg'),type:'jpeg',quality:96});
      if(i%60===0)console.log(`Mobile recording ${i}/${count}`);
    }
    const final=await state(page);
    if(!final.playing||!final.audioPlaying||final.ready<3||playbackTransitions.length!==1||playbackTransitions[0].from!=='paused'||playbackTransitions[0].to!=='playing')throw new Error('The recording must contain exactly one paused → playing transition: '+JSON.stringify(playbackTransitions));
    if(errors.length)throw new Error(errors.join('\n'));
    const metadata={source:origin+'/search',query:edition.query,trackTitle:edition.trackTitle,capturedAt:new Date().toISOString(),fps,count,width:edition.viewport.width,height:edition.viewport.height,pixelRatio:edition.pixelRatio,partial:stillsOnly,cursorBaked:false,device,artistImages:edition.artistQueries,artistImageSources:artistImages.map(e=>({name:e.name,sourceName:e.sourceName})),best,selected,selectedRow,miniCover,controls,fullscreenArt,playAt:edition.playAt,openAt:edition.openAt,seekSeconds:edition.seekSeconds,nativeAnimationCount,audioProof:{...audioProof,source:undefined},initialState:{...initial,source:undefined},pausedProof:{...pausedProof,source:undefined},finalState:{...final,source:undefined},playbackTransitions,checkpoints,actions:[{time:70/fps,action:'Tap Лучшие'},{time:edition.openAt,action:'Open the already-paused mobile player'},{time:edition.playAt,action:'Tap Play once; paused → playing'}]};
    fs.writeFileSync(path.join(dir,'capture.json'),JSON.stringify(metadata,null,2)+'\n');
    console.log('Mobile one-tap playback verified:',JSON.stringify({artist:final.artist,track:final.track,transitions:playbackTransitions,device}));
    if(!stillsOnly){const encoded=spawnSync(ffmpeg,['-hide_banner','-y','-loglevel','error','-framerate',String(fps),'-i',path.join(frames,'%05d.jpg'),'-frames:v',String(count),'-c:v','libx264','-preset','fast','-crf','19','-pix_fmt','yuv420p','-movflags','+faststart',path.join(dir,'localhost-mobile-demo.mp4')],{windowsHide:true});if(encoded.status!==0)throw new Error(encoded.stderr.toString())}
  } finally {await context.close();await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
