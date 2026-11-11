const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');

const home = process.env.USERPROFILE;
const playwright = process.env.PLAYWRIGHT_MODULE || path.join(home,'AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core');
const { chromium } = require(playwright);
const ffmpeg = process.env.FFMPEG_PATH || path.join(home,'.codex/tmp/bolt-video-tools/node_modules/ffmpeg-static/ffmpeg.exe');
const outDir = __dirname, fps = 30, duration = 12;

// Original transition effects only. No sample, melody, or vocal from the song.
function createSoundDesign() {
  const sr=48000,n=duration*sr,data=new Float64Array(n);
  let seed=12617;
  function noise(){seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2147483648-1;}
  function effect(at,len,kind,gain){
    const start=Math.round(at*sr),count=Math.round(len*sr);let prev=0;
    for(let i=0;i<count&&start+i<n;i++){
      const t=i/sr,p=i/count;let v=0;
      if(kind==='click')v=(Math.sin(2*Math.PI*1100*t)*.65+noise()*.35)*Math.exp(-t*100);
      if(kind==='swoosh'){const rand=noise();prev=.75*prev+.25*rand;v=prev*Math.pow(Math.sin(Math.PI*p),1.4);}
      if(kind==='impact')v=Math.sin(2*Math.PI*(48*t+60*.02*(1-Math.exp(-t/.02))))*Math.exp(-t*10)+noise()*.06*Math.exp(-t*35);
      if(kind==='chime')v=(Math.sin(2*Math.PI*660*t)+.35*Math.sin(2*Math.PI*990*t))*Math.exp(-t*7)*Math.min(1,t/.005);
      data[start+i]+=v*gain;
    }
  }
  effect(.03,.09,'click',.22);effect(.48,.08,'click',.13);
  effect(3.22,.42,'swoosh',.7);effect(3.50,.65,'impact',.46);
  effect(8.1,.43,'swoosh',.65);effect(8.42,.65,'impact',.36);effect(9.04,.8,'chime',.12);
  const wave=Buffer.alloc(44+n*4);wave.write('RIFF',0);wave.writeUInt32LE(36+n*4,4);wave.write('WAVEfmt ',8);wave.writeUInt32LE(16,16);wave.writeUInt16LE(1,20);wave.writeUInt16LE(2,22);wave.writeUInt32LE(sr,24);wave.writeUInt32LE(sr*4,28);wave.writeUInt16LE(4,32);wave.writeUInt16LE(16,34);wave.write('data',36);wave.writeUInt32LE(n*4,40);
  for(let i=0;i<n;i++){const sample=Math.round(Math.tanh(data[i])*28000);wave.writeInt16LE(sample,44+i*4);wave.writeInt16LE(sample,46+i*4);}
  fs.writeFileSync(path.join(outDir,'sound-design.wav'),wave);
}

(async()=>{
  createSoundDesign();
  const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,args:['--disable-background-networking','--allow-file-access-from-files']});
  let encoder;
  try {
    const page=await browser.newPage({viewport:{width:1400,height:2000},deviceScaleFactor:1});
    page.on('pageerror',e=>{throw e;});
    await page.goto(pathToFileURL(path.join(outDir,'preview.html')).href);
    await page.evaluate(()=>window.ready);
    for(const [name,t] of [['01-hook',1.8],['02-track',6],['03-bolt',10.5]]){
      const img=await page.evaluate(t=>{window.renderFrame(t);return document.getElementById('film').toDataURL('image/png').split(',')[1];},t);
      fs.writeFileSync(path.join(outDir,`${name}.png`),Buffer.from(img,'base64'));
    }
    console.log('Three preview frames rendered.');
    if(process.argv.includes('--stills'))return;
    encoder=spawn(ffmpeg,['-hide_banner','-y','-loglevel','warning','-f','image2pipe','-framerate',String(fps),'-vcodec','mjpeg','-i','pipe:0','-i',path.join(outDir,'sound-design.wav'),'-map','0:v:0','-map','1:a:0','-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p','-r',String(fps),'-c:a','aac','-b:a','192k','-t',String(duration),'-movflags','+faststart',path.join(outDir,'bolt-little-girls.mp4')],{stdio:['pipe','ignore','pipe'],windowsHide:true});
    let log='';encoder.stderr.on('data',b=>log+=b);encoder.stdin.on('error',()=>{});
    const done=once(encoder,'close');
    for(let i=0;i<fps*duration;i++){
      const frame=await page.evaluate(t=>{window.renderFrame(t);return document.getElementById('film').toDataURL('image/jpeg',.97).split(',')[1];},i/fps);
      if(!encoder.stdin.write(Buffer.from(frame,'base64')))await once(encoder.stdin,'drain');
      if(i%60===0)console.log(`Rendered ${i}/${fps*duration} frames`);
    }
    encoder.stdin.end();const [code]=await done;if(code!==0)throw Error(`FFmpeg exited ${code}: ${log}`);
    const mute=spawnSync(ffmpeg,['-hide_banner','-y','-loglevel','error','-i',path.join(outDir,'bolt-little-girls.mp4'),'-c:v','copy','-an','-movflags','+faststart',path.join(outDir,'bolt-little-girls-silent.mp4')],{windowsHide:true,encoding:'utf8'});
    if(mute.status!==0)throw Error(mute.stderr);
    console.log('MP4 complete: 1080x1920, 30 fps, 12 seconds.');
  } finally {await browser.close();if(encoder && encoder.exitCode===null)encoder.kill();}
})().catch(e=>{console.error(e);process.exit(1);});
