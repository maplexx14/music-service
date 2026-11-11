const fs=require('node:fs'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||path.join(process.env.USERPROFILE,'AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core'));
const ffmpeg=process.env.FFMPEG_PATH||path.join(process.env.USERPROFILE,'.codex/tmp/bolt-video-tools/node_modules/ffmpeg-static/ffmpeg.exe');
const timing=JSON.parse(fs.readFileSync(path.join(__dirname,'neutral-timing.json'),'utf8'));
const capture=JSON.parse(fs.readFileSync(path.join(__dirname,'assets/service-capture.json'),'utf8'));
fs.writeFileSync(path.join(__dirname,'neutral-data.js'),`window.DYNAMIC_TIMING=${JSON.stringify(timing)};\nwindow.DYNAMIC_CAPTURE=${JSON.stringify(capture)};\n`);
(async()=>{
  const browser=await chromium.launch({executablePath:process.env.EDGE_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,args:['--allow-file-access-from-files']});let encoder;
  try{
    const page=await browser.newPage(),errors=[];
    page.on('pageerror',e=>errors.push(String(e)));
    await page.goto(pathToFileURL(path.join(__dirname,'neutral-preview.html')).href);
    await page.evaluate(()=>window.ready);
    for(const [name,t]of [['effects-01-wide',.2],['effects-02-reaction',1.86],['effects-03-dash',3.5],['effects-04-oxygen',5.76],['effects-05-click',11.05],['effects-06-arrival',13.45],['effects-07-final',14.5]]){
      const frame=await page.evaluate(async t=>{await window.renderFrame(t);return document.getElementById('film').toDataURL('image/png').split(',')[1];},t);
      fs.writeFileSync(path.join(__dirname,`${name}.png`),Buffer.from(frame,'base64'));
    }
    if(errors.length)throw Error(errors.join('\n'));
    if(process.argv.includes('--stills'))return;
    const output=path.join(__dirname,'bolt-agas-karaoke-neutral-v2.mp4');
    encoder=spawn(ffmpeg,['-hide_banner','-y','-loglevel','warning','-f','image2pipe','-framerate',String(timing.fps),'-vcodec','mjpeg','-i','pipe:0','-i',path.join(__dirname,'bolt-agas-karaoke-neutral.mp4'),'-map','0:v:0','-map','1:a:0','-c:v','libx264','-preset','fast','-crf','17','-pix_fmt','yuv420p','-r',String(timing.fps),'-c:a','copy','-t',String(timing.duration),'-metadata','comment=Neutral script and synthesized narration. Camel photo: Darthjipsu, CC BY-SA 4.0, https://commons.wikimedia.org/wiki/File:Camel_walking_on_the_Rub_al_Khali.jpg; background removed, cropped, expression warped and animated.','-movflags','+faststart',output],{stdio:['pipe','ignore','pipe'],windowsHide:true});
    let log='';encoder.stderr.on('data',b=>log+=b);encoder.stdin.on('error',()=>{});const done=once(encoder,'close');
    const count=Math.round(timing.duration*timing.fps);
    for(let i=0;i<count;i++){
      const frame=await page.evaluate(async t=>{await window.renderFrame(t);return document.getElementById('film').toDataURL('image/jpeg',.97).split(',')[1];},i/timing.fps);
      if(!encoder.stdin.write(Buffer.from(frame,'base64')))await once(encoder.stdin,'drain');
      if(i%90===0)console.log(`Rendered ${i}/${count}`);
    }
    encoder.stdin.end();const [code]=await done;
    if(code!==0)throw Error(log);if(errors.length)throw Error(errors.join('\n'));
    console.log(`Complete: ${output}; neutral narration, ${timing.duration}s, 1080x1920, ${timing.fps}fps.`);
  }finally{await browser.close();if(encoder&&encoder.exitCode===null)encoder.kill();}
})().catch(e=>{console.error(e);process.exit(1);});
