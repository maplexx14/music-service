const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {chromium}=require(path.join(process.env.USERPROFILE,'AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core'));
const ffmpeg=path.join(process.env.USERPROFILE,'.codex/tmp/bolt-video-tools/node_modules/ffmpeg-static/ffmpeg.exe');
const id='6b3546a3-8ab0-47a6-8c5e-51735d6c79c1';
(async()=>{
  const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
  try{
    const context=await browser.newContext({viewport:{width:540,height:960},deviceScaleFactor:2,isMobile:true,hasTouch:true,recordVideo:{dir:path.join(__dirname,'assets/service-raw'),size:{width:540,height:960}}});
    // The live guest route currently loses its useParams ID. Correct only that
    // request to the public URL for this track; all returned data is live.
    await context.route('**/api/tracks/undefined',async route=>{
      const response=await route.fetch({url:`https://boltmusic.lat/api/tracks/${id}`});
      await route.fulfill({response});
    });
    const started=performance.now(),page=await context.newPage();
    await page.goto(`https://boltmusic.lat/track/${id}`,{waitUntil:'domcontentloaded',timeout:30000});
    await page.getByRole('heading',{name:/Азия.*Евразия/i}).waitFor({timeout:20000});
    await page.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(i=>i.decode().catch(()=>{})));document.querySelector('audio').muted=true;});
    await page.waitForFunction(()=>document.querySelector('audio')?.readyState>=3,{timeout:20000});
    await page.waitForTimeout(450);
    const clipStart=(performance.now()-started)/1000;
    await page.screenshot({path:path.join(__dirname,'assets/service-before.png')});
    await page.waitForTimeout(3650);
    const button=page.getByRole('button',{name:'Слушать',exact:true});
    const bounds=await button.boundingBox();
    const clickAt=(performance.now()-started)/1000-clipStart;
    await button.tap();
    await page.waitForFunction(()=>{const a=document.querySelector('audio');return !a.paused&&a.currentTime>.2;},{timeout:15000});
    await page.waitForTimeout(4800);
    const playback=await page.locator('audio').evaluate(a=>({paused:a.paused,currentTime:a.currentTime,duration:a.duration,readyState:a.readyState,error:a.error?.message||null}));
    if(playback.paused||playback.currentTime<3||playback.error)throw Error(`Live playback failed: ${JSON.stringify(playback)}`);
    await page.screenshot({path:path.join(__dirname,'assets/service-playing.png')});
    const video=page.video();await context.close();const raw=await video.path();
    const metadata={source:`https://boltmusic.lat/track/${id}`,recording:'Live browser recording; guest metadata request ID corrected in browser.',clipStart,clickAt,click:{x:(bounds.x+bounds.width/2)*2,y:(bounds.y+bounds.height/2)*2},playback};
    fs.writeFileSync(path.join(__dirname,'assets/service-capture.json'),JSON.stringify(metadata,null,2)+'\n');
    const encoded=spawnSync(ffmpeg,['-hide_banner','-y','-loglevel','error','-ss',String(clipStart),'-i',raw,'-t','9.2','-vf','crop=540:960:0:0,fps=30,scale=1080:1920:flags=lanczos','-c:v','libx264','-preset','fast','-crf','17','-pix_fmt','yuv420p','-an','-movflags','+faststart',path.join(__dirname,'assets/service.mp4')],{windowsHide:true,encoding:'utf8'});
    if(encoded.status!==0)throw Error(encoded.stderr);
    console.log(JSON.stringify(metadata,null,2));
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
