const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const profile = process.env.USERPROFILE;
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || path.join(profile,'AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core'));
const ffmpeg = process.env.FFMPEG_PATH || path.join(profile,'.codex/tmp/bolt-video-tools/node_modules/ffmpeg-static/ffmpeg.exe');
const outDir = __dirname, fps = 30, sr = 48000;
const story=JSON.parse(fs.readFileSync(path.join(outDir,'story.json'),'utf8'));
function readVoice(name){
  const result=spawnSync(ffmpeg,['-hide_banner','-loglevel','error','-i',path.join(outDir,'assets',name),'-f','f32le','-ar',String(sr),'-ac','1','pipe:1'],{windowsHide:true,maxBuffer:16*1024*1024});
  if(result.status!==0)throw Error(result.stderr.toString());
  const raw=result.stdout,samples=Float32Array.from({length:raw.length/4},(_,i)=>raw.readFloatLE(i*4));
  let first=0,last=samples.length-1;while(first<last&&Math.abs(samples[first])<.003)first++;while(last>first&&Math.abs(samples[last])<.003)last--;
  return samples.slice(Math.max(0,first-960),Math.min(samples.length,last+1440));
}
function prepareAudio(){
  let at=.12;
  const voices=story.hook.map((text,i)=>{const samples=readVoice(`line-${i}.wav`);const line={text,at,duration:samples.length/sr,samples};at+=line.duration+.16;return line;});
  const revealStart=Math.round((at+.28)*fps)/fps;
  const reveal=readVoice('reveal.wav'),revealAt=revealStart+.22;
  const duration=Math.ceil(Math.max(12,revealAt+reveal.length/sr+1.15));
  const mix=new Float64Array(duration*sr);
  function add(samples,at,gain){const pos=Math.round(at*sr);for(let i=0;i<samples.length&&pos+i<mix.length;i++)mix[pos+i]+=samples[i]*gain;}
  for(const v of voices)add(v.samples,v.at,1.1);add(reveal,revealAt,1.1);
  let seed=521;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2147483648-1;};
  const effect=new Float32Array(Math.round(.5*sr));let low=0;
  for(let i=0;i<effect.length;i++){const t=i/sr,p=i/effect.length;low=.83*low+.17*random();effect[i]=low*Math.sin(Math.PI*p)*.14+Math.sin(2*Math.PI*70*t)*Math.exp(-t*17)*.09;}
  add(effect,revealStart-.06,1);
  let peak=0;for(const s of mix)peak=Math.max(peak,Math.abs(s));const gain=.88/Math.max(.88,peak);
  const wave=Buffer.alloc(44+mix.length*4);wave.write('RIFF');wave.writeUInt32LE(36+mix.length*4,4);wave.write('WAVEfmt ',8);wave.writeUInt32LE(16,16);wave.writeUInt16LE(1,20);wave.writeUInt16LE(2,22);wave.writeUInt32LE(sr,24);wave.writeUInt32LE(sr*4,28);wave.writeUInt16LE(4,32);wave.writeUInt16LE(16,34);wave.write('data',36);wave.writeUInt32LE(mix.length*4,40);
  for(let i=0;i<mix.length;i++){const n=Math.round(Math.max(-1,Math.min(1,mix[i]*gain))*32767);wave.writeInt16LE(n,44+i*4);wave.writeInt16LE(n,46+i*4);}
  fs.writeFileSync(path.join(outDir,'narration.wav'),wave);
  const timeline={duration,fps,revealStart,lines:voices.map(({samples,...rest})=>rest)};
  fs.writeFileSync(path.join(outDir,'timeline.js'),`window.TIMELINE = ${JSON.stringify(timeline,null,2)};\n`);
  fs.writeFileSync(path.join(outDir,'timeline.json'),JSON.stringify(timeline,null,2)+'\n');return timeline;
}
(async()=>{
  const timeline=prepareAudio();console.log(JSON.stringify({duration:timeline.duration,revealStart:timeline.revealStart}));
  const browser=await chromium.launch({executablePath:process.env.EDGE_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,args:['--disable-background-networking','--allow-file-access-from-files']});
  let encoder;
  try{
    const page=await browser.newPage({viewport:{width:1400,height:2000},deviceScaleFactor:1});
    const errors=[];page.on('pageerror',e=>errors.push(String(e)));
    await page.goto(pathToFileURL(path.join(outDir,'preview.html')).href);await page.evaluate(()=>window.ready);
    for(const [name,t]of [['01-opening',0],['02-quote',timeline.lines[3].at+.2],['03-track',timeline.revealStart+2]]){
      const frame=await page.evaluate(t=>{window.renderFrame(t);return document.getElementById('film').toDataURL('image/png').split(',')[1];},t);
      fs.writeFileSync(path.join(outDir,`${name}.png`),Buffer.from(frame,'base64'));
    }
    if(errors.length)throw Error(errors.join('\n'));
    if(process.argv.includes('--stills'))return;
    encoder=spawn(ffmpeg,['-hide_banner','-y','-loglevel','warning','-f','image2pipe','-framerate',String(fps),'-vcodec','mjpeg','-i','pipe:0','-i',path.join(outDir,'narration.wav'),'-map','0:v:0','-map','1:a:0','-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p','-r',String(fps),'-c:a','aac','-b:a','192k','-t',String(timeline.duration),'-movflags','+faststart',path.join(outDir,'bolt-agas-asia-eurasia.mp4')],{stdio:['pipe','ignore','pipe'],windowsHide:true});
    let log='';encoder.stderr.on('data',b=>log+=b);encoder.stdin.on('error',()=>{});const done=once(encoder,'close');
    for(let i=0;i<fps*timeline.duration;i++){
      const frame=await page.evaluate(t=>{window.renderFrame(t);return document.getElementById('film').toDataURL('image/jpeg',.96).split(',')[1];},i/fps);
      if(!encoder.stdin.write(Buffer.from(frame,'base64')))await once(encoder.stdin,'drain');
      if(i%90===0)console.log(`Rendered ${i}/${fps*timeline.duration} frames`);
    }
    encoder.stdin.end();const [code]=await done;if(code!==0)throw Error(`FFmpeg: ${log}`);
    if(errors.length)throw Error(errors.join('\n'));
    const mute=spawnSync(ffmpeg,['-hide_banner','-y','-loglevel','error','-i',path.join(outDir,'bolt-agas-asia-eurasia.mp4'),'-c:v','copy','-an','-movflags','+faststart',path.join(outDir,'bolt-agas-asia-eurasia-silent.mp4')],{windowsHide:true,encoding:'utf8'});
    if(mute.status!==0)throw Error(mute.stderr);
    console.log(`Complete: 1080x1920, ${fps} fps, ${timeline.duration}s. Narration and transition sound; no song recording.`);
  }finally{await browser.close();if(encoder&&encoder.exitCode===null)encoder.kill();}
})().catch(e=>{console.error(e);process.exit(1);});
