const fs=require('node:fs'),path=require('node:path');
const {pathToFileURL}=require('node:url'),{spawn,spawnSync}=require('node:child_process'),{once}=require('node:events');
const profile=process.env.USERPROFILE;
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||path.join(profile,'AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core'));
const ffmpeg=process.env.FFMPEG_PATH||path.join(profile,'.codex/tmp/bolt-video-tools/node_modules/ffmpeg-static/ffmpeg.exe');
const dir=__dirname,fps=60,duration=12.8,sr=48000;
const vertical=process.argv.includes('--tiktok'),width=vertical?1080:1920,height=vertical?1920:1080;
const basename=vertical?'bolt-motion-ru-tiktok':'bolt-motion-ru';
// Original electronic backing: 150 BPM, percussion, bass and a short synth motif.
function makeAudio(){
  const n=Math.round(sr*duration),L=new Float64Array(n),R=new Float64Array(n);let seed=71473;
  const noise=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2147483648-1};
  function add(at,len,fn,gain=1,pan=0){const pos=Math.round(at*sr),count=Math.round(len*sr);for(let i=0;i<count&&pos+i<n;i++){if(pos+i<0)continue;const v=fn(i/sr,i/count)*gain;L[pos+i]+=v*(1-pan*.35);R[pos+i]+=v*(1+pan*.35)}}
  for(let beat=0;beat<32;beat++){
    const at=beat*.4;
    add(at,.28,t=>Math.sin(2*Math.PI*(46*t+75*.017*(1-Math.exp(-t/.017))))*Math.exp(-t*17),.56);
    if(beat%2)add(at,.14,t=>(noise()*.8+Math.sin(2*Math.PI*180*t)*.2)*Math.exp(-t*30),.22);
    for(let half=0;half<2;half++)add(at+half*.2,.055,t=>noise()*Math.exp(-t*85),half?.085:.055,half?.55:-.55);
    const bass=[55,55,65.406,49][Math.floor(beat/4)%4];add(at+.02,.34,t=>(Math.sin(2*Math.PI*bass*t)+.22*Math.sin(2*Math.PI*bass*2*t))*Math.min(1,t/.012)*Math.exp(-t*7),.17);
    if(beat>=5){const freq=[440,523.251,659.255,587.33,523.251,440,391.995,523.251][beat%8];const synth=t=>(Math.sin(2*Math.PI*freq*t)+.22*Math.sin(2*Math.PI*freq*2*t))*Math.min(1,t/.008)*Math.exp(-t*9);add(at+.20,.32,synth,.075,beat%2?.4:-.4);add(at+.40,.32,synth,.025,beat%2?-.5:.5);}
  }
  for(const at of [1.2,3.2,4.5,5.7,7.2,8.8,9.6,10.8]){let low=0;add(at-.1,.22,(t,p)=>{low=low*.72+noise()*.28;return low*Math.pow(Math.sin(Math.PI*p),2)},.12);}
  for(const at of [1.2,3.2,5.2])add(at,.065,t=>(Math.sin(2*Math.PI*1100*t)+noise()*.25)*Math.exp(-t*85),.11);
  add(5.22,.8,t=>[659.255,830.609,987.767].reduce((v,f)=>v+Math.sin(2*Math.PI*f*t),0)/3*Math.min(1,t/.012)*Math.exp(-t*7),.07);
  add(10.9,1.3,t=>[440,554.365,659.255].reduce((v,f)=>v+Math.sin(2*Math.PI*f*t),0)/3*Math.min(1,t/.02)*Math.exp(-t*3),.12);
  const wav=Buffer.alloc(44+n*4);wav.write('RIFF');wav.writeUInt32LE(36+n*4,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(2,22);wav.writeUInt32LE(sr,24);wav.writeUInt32LE(sr*4,28);wav.writeUInt16LE(4,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(n*4,40);
  for(let i=0;i<n;i++){const t=i/sr,fade=Math.min(1,t/.025,(duration-t)/.55);wav.writeInt16LE(Math.round(Math.tanh(L[i]*1.2)*26000*fade),44+i*4);wav.writeInt16LE(Math.round(Math.tanh(R[i]*1.2)*26000*fade),46+i*4)}fs.writeFileSync(path.join(dir,'soundtrack.wav'),wav);
}
(async()=>{
  makeAudio();const browser=await chromium.launch({executablePath:process.env.EDGE_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,args:['--disable-background-networking','--allow-file-access-from-files']});let encoder;
  try{
    const page=await browser.newPage({viewport:{width,height:height+120},deviceScaleFactor:1});const errors=[];page.on('pageerror',e=>errors.push(String(e)));const url=pathToFileURL(path.join(dir,'preview.html'));if(vertical)url.searchParams.set('format','tiktok');await page.goto(url.href);await page.evaluate(()=>window.ready);
    for(const [name,t] of [['01-library',.65],['02-flow',2.2],['03-track',4.3],['04-like',5.45],['05-saved',6.5],['06-copy',8.3],['07-unlimited',10.3],['08-bolt',12]]){const b=await page.evaluate(t=>{window.renderFrame(t);return document.getElementById('film').toDataURL('image/png').split(',')[1]},t);fs.writeFileSync(path.join(dir,(vertical?'tiktok-':'')+name+'.png'),Buffer.from(b,'base64'))}
    if(errors.length)throw Error(errors.join('\n'));console.log('Eight keyframes ready.');if(process.argv.includes('--stills'))return;
    encoder=spawn(ffmpeg,['-hide_banner','-y','-loglevel','warning','-f','image2pipe','-framerate',String(fps),'-vcodec','mjpeg','-i','pipe:0','-i',path.join(dir,'soundtrack.wav'),'-map','0:v:0','-map','1:a:0','-vf','scale=in_range=full:out_range=tv:in_color_matrix=bt601:out_color_matrix=bt709','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-c:v','libx264','-preset','fast','-crf','17','-pix_fmt','yuv420p','-r',String(fps),'-c:a','aac','-b:a','192k','-t',String(duration),'-movflags','+faststart',path.join(dir,basename+'.mp4')],{stdio:['pipe','ignore','pipe'],windowsHide:true});let log='';encoder.stderr.on('data',b=>log+=b);encoder.stdin.on('error',()=>{});const done=once(encoder,'close');
    for(let i=0;i<fps*duration;i++){const b=await page.evaluate(t=>{window.renderFrame(t);return document.getElementById('film').toDataURL('image/jpeg',.97).split(',')[1]},i/fps);if(!encoder.stdin.write(Buffer.from(b,'base64')))await once(encoder.stdin,'drain');if(i%120===0)console.log(`Rendered ${i}/${fps*duration}`)}
    encoder.stdin.end();const [code]=await done;if(code!==0)throw Error(log);if(errors.length)throw Error(errors.join('\n'));
    const result=spawnSync(ffmpeg,['-hide_banner','-y','-loglevel','error','-i',path.join(dir,basename+'.mp4'),'-c:v','copy','-an','-movflags','+faststart',path.join(dir,basename+'-silent.mp4')],{windowsHide:true});if(result.status!==0)throw Error(result.stderr.toString());console.log(`Complete: ${width} × ${height}, 60 fps, ${duration} seconds.`);
  }finally{await browser.close();if(encoder&&encoder.exitCode===null)encoder.kill()}
})().catch(e=>{console.error(e);process.exitCode=1});
