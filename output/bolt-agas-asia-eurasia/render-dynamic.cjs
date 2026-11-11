const fs=require('node:fs'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||path.join(process.env.USERPROFILE,'AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core'));
const ffmpeg=process.env.FFMPEG_PATH||path.join(process.env.USERPROFILE,'.codex/tmp/bolt-video-tools/node_modules/ffmpeg-static/ffmpeg.exe');
const timing=JSON.parse(fs.readFileSync(path.join(__dirname,'karaoke-timing.json'),'utf8'));
const capture=JSON.parse(fs.readFileSync(path.join(__dirname,'assets/service-capture.json'),'utf8'));
fs.writeFileSync(path.join(__dirname,'dynamic-data.js'),`window.DYNAMIC_TIMING=${JSON.stringify(timing)};\nwindow.DYNAMIC_CAPTURE=${JSON.stringify(capture)};\n`);
(async()=>{
  const browser=await chromium.launch({executablePath:process.env.EDGE_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,args:['--allow-file-access-from-files']});let encoder;
  try{
    const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(String(e)));
    await page.goto(pathToFileURL(path.join(__dirname,'dynamic-preview.html')).href);await page.evaluate(()=>window.ready);
    for(const [name,t]of [['png-01-wide',1.1],['png-02-reaction',2.35],['png-03-dash',3.9],['png-04-reverse',4.9],['png-05-oxygen',6.8],['ending-01-arrival',8.1],['ending-02-title',9.6],['ending-03-button',10.9],['ending-04-return',11.95],['ending-05-cta',12.45],['ending-06-final',14.2]]){
      const frame=await page.evaluate(async t=>{await window.renderFrame(t);return document.getElementById('film').toDataURL('image/png').split(',')[1];},t);fs.writeFileSync(path.join(__dirname,`${name}.png`),Buffer.from(frame,'base64'));
    }
    if(errors.length)throw Error(errors.join('\n'));if(process.argv.includes('--stills'))return;
    encoder=spawn(ffmpeg,['-hide_banner','-y','-loglevel','warning','-f','image2pipe','-framerate','30','-vcodec','mjpeg','-i','pipe:0','-i',path.join(__dirname,'bolt-agas-karaoke-v6.mp4'),'-map','0:v:0','-map','1:a:0','-c:v','libx264','-preset','fast','-crf','17','-pix_fmt','yuv420p','-r','30','-c:a','copy','-t','15.3','-movflags','+faststart',path.join(__dirname,'bolt-agas-karaoke-v7.mp4')],{stdio:['pipe','ignore','pipe'],windowsHide:true});
    let log='';encoder.stderr.on('data',b=>log+=b);encoder.stdin.on('error',()=>{});const done=once(encoder,'close');
    for(let i=0;i<459;i++){
      const frame=await page.evaluate(async t=>{await window.renderFrame(t);return document.getElementById('film').toDataURL('image/jpeg',.97).split(',')[1];},i/30);
      if(!encoder.stdin.write(Buffer.from(frame,'base64')))await once(encoder.stdin,'drain');
      if(i%90===0)console.log(`Rendered ${i}/459`);
    }
    encoder.stdin.end();const [code]=await done;if(code!==0)throw Error(log);if(errors.length)throw Error(errors.join('\n'));
    console.log('Complete: 15.3s, 1080x1920, 30fps, photographic PNG camel; v6 audio copied unchanged.');
  }finally{await browser.close();if(encoder&&encoder.exitCode===null)encoder.kill();}
})().catch(e=>{console.error(e);process.exit(1);});
