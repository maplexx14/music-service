const fs=require('node:fs'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const {spawn,spawnSync}=require('node:child_process');
const {once}=require('node:events');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||path.join(process.env.USERPROFILE,'AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core'));
const ffmpeg=process.env.FFMPEG_PATH||path.join(process.env.USERPROFILE,'.codex/tmp/bolt-video-tools/node_modules/ffmpeg-static/ffmpeg.exe');
const timing=JSON.parse(fs.readFileSync(path.join(__dirname,'karaoke-timing.json'),'utf8'));
const rate=timing.playbackRate||1,outputDuration=timing.duration/rate;
const capture=JSON.parse(fs.readFileSync(path.join(__dirname,'assets/service-capture.json'),'utf8'));
fs.writeFileSync(path.join(__dirname,'karaoke-data.js'),`window.KARAOKE=${JSON.stringify(timing)};\nwindow.CAPTURE=${JSON.stringify(capture)};\n`);
(async()=>{
  const browser=await chromium.launch({executablePath:process.env.EDGE_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,args:['--disable-background-networking','--allow-file-access-from-files']});
  let encoder;
  try{
    const page=await browser.newPage({viewport:{width:1400,height:2000},deviceScaleFactor:1});const errors=[];page.on('pageerror',e=>errors.push(String(e)));
    await page.goto(pathToFileURL(path.join(__dirname,'karaoke-preview.html')).href);await page.evaluate(()=>window.ready);
    for(const [name,t]of [['karaoke-01-midword',.56],['karaoke-02-complete',8.7],['karaoke-03-service',10],['karaoke-04-playing',15]]){
      const frame=await page.evaluate(async t=>{await window.renderFrame(t);return document.getElementById('film').toDataURL('image/png').split(',')[1];},t/rate);
      fs.writeFileSync(path.join(__dirname,`${name}.png`),Buffer.from(frame,'base64'));
    }
    if(errors.length)throw Error(errors.join('\n'));
    if(process.argv.includes('--stills'))return;
    const output=path.join(__dirname,'bolt-agas-karaoke-v2.mp4');
    // Narration and visual timings share the same 1.1x speed. atempo preserves
    // voice pitch; padding supplies only the final hold after the narration.
    encoder=spawn(ffmpeg,['-hide_banner','-y','-loglevel','warning','-f','image2pipe','-framerate',String(timing.fps),'-vcodec','mjpeg','-i','pipe:0','-i',path.join(__dirname,'ozv.mp3'),'-map','0:v:0','-map','1:a:0','-c:v','libx264','-preset','fast','-crf','17','-pix_fmt','yuv420p','-r',String(timing.fps),'-af',`atempo=${rate},apad`,'-c:a','aac','-ar','48000','-b:a','192k','-t',String(outputDuration),'-movflags','+faststart',output],{stdio:['pipe','ignore','pipe'],windowsHide:true});
    let log='';encoder.stderr.on('data',b=>log+=b);encoder.stdin.on('error',()=>{});const done=once(encoder,'close');
    const count=Math.round(timing.fps*outputDuration);
    for(let i=0;i<count;i++){
      const frame=await page.evaluate(async t=>{await window.renderFrame(t);return document.getElementById('film').toDataURL('image/jpeg',.97).split(',')[1];},i/timing.fps);
      if(!encoder.stdin.write(Buffer.from(frame,'base64')))await once(encoder.stdin,'drain');
      if(i%90===0)console.log(`Rendered ${i}/${count}`);
    }
    encoder.stdin.end();const [code]=await done;if(code!==0)throw Error(log);if(errors.length)throw Error(errors.join('\n'));
    const silent=spawnSync(ffmpeg,['-hide_banner','-y','-loglevel','error','-i',output,'-c:v','copy','-an','-movflags','+faststart',path.join(__dirname,'bolt-agas-karaoke-v2-silent.mp4')],{windowsHide:true,encoding:'utf8'});
    if(silent.status!==0)throw Error(silent.stderr);
    console.log(`Complete: ${outputDuration}s, 1080x1920, ${timing.fps} fps, ozv.mp3 at ${rate}x.`);
  }finally{await browser.close();if(encoder&&encoder.exitCode===null)encoder.kill();}
})().catch(e=>{console.error(e);process.exit(1);});
