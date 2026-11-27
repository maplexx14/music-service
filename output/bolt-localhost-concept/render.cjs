const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const sharp = require('sharp');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || path.join(process.env.USERPROFILE, 'AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core'));
const ffmpeg = process.env.FFMPEG_PATH || path.join(process.env.USERPROFILE, '.codex/tmp/bolt-video-tools/node_modules/ffmpeg-static/ffmpeg.exe');
const reference = process.env.REFERENCE_PATH || 'C:/Users/maplex/Downloads/Spotify 2.0 Concept 🎶.mp4';
const dir = __dirname, fps = 60, count = 764, duration = count / fps;
const stillsOnly = process.argv.includes('--stills');
const stages = [
  ['01-search',.75],['02-best',1.84],['03-track',2.96],['04-player',3.97],
  ['05-closeup',5.05],['06-action',5.68],['07-transition',6.07],['08-discover',7.18],
  ['09-rhythm',8.50],['10-one-click',9.44],['11-bolt',11.25],['12-outro',12.25],
];
function ffmpegSync(args) {
  const result = spawnSync(ffmpeg, ['-hide_banner','-y','-loglevel','error',...args], { windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr?.toString() || 'FFmpeg did not finish.');
}
async function contactSheet() {
  const columns=3,tileW=480,tileH=294,rows=Math.ceil(stages.length/columns),layers=[];
  for(let i=0;i<stages.length;i++) {
    const [name,t]=stages[i],left=(i%columns)*tileW,top=Math.floor(i/columns)*tileH;
    const frame=await sharp(path.join(dir,name+'.png')).resize(tileW,270).png().toBuffer();
    layers.push({input:frame,left,top});
    layers.push({input:Buffer.from(`<svg width="480" height="24"><rect width="480" height="24" fill="#15101d"/><text x="10" y="17" fill="#d4c4e4" font-family="Arial" font-size="13">${t.toFixed(2)} s · ${name}</text></svg>`),left,top:top+270});
  }
  await sharp({create:{width:columns*tileW,height:rows*tileH,channels:3,background:'#15101d'}}).composite(layers).jpeg({quality:90}).toFile(path.join(dir,'storyboard.jpg'));
}
(async () => {
  const metadata=JSON.parse(fs.readFileSync(path.join(dir,'capture.json'),'utf8'));
  if(metadata.partial&&!stillsOnly)throw new Error('Run capture.cjs without --stills before exporting the film.');
  fs.writeFileSync(path.join(dir,'capture-data.js'),'window.BOLT_CAPTURE = '+JSON.stringify(metadata)+';\n');
  ffmpegSync(['-i',reference,'-vn','-c:a','copy','-movflags','+faststart',path.join(dir,'soundtrack.m4a')]);
  const browser=await chromium.launch({executablePath:process.env.EDGE_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,args:['--allow-file-access-from-files','--disable-background-networking','--force-color-profile=srgb']});
  let encoder;
  try {
    const page=await browser.newPage({viewport:{width:1920,height:1200},deviceScaleFactor:1});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(pathToFileURL(path.join(dir,'composition.html')).href);
    if(errors.length)throw new Error(errors.join('\n'));
    if(!(await page.evaluate(()=>typeof window.renderFrame==='function')))throw new Error('The film renderer did not initialize.');
    await page.evaluate(()=>window.ready);
    for(const [name,t] of stages) {
      const data=await page.evaluate(async t=>{await window.renderFrame(t);return document.getElementById('film').toDataURL('image/png').split(',')[1]},t);
      fs.writeFileSync(path.join(dir,name+'.png'),Buffer.from(data,'base64'));
    }
    if(errors.length)throw new Error(errors.join('\n'));
    await contactSheet();
    console.log('Twelve review frames and storyboard ready.');
    if(stillsOnly)return;
    const movie=path.join(dir,'bolt-localhost-concept.mp4');
    encoder=spawn(ffmpeg,['-hide_banner','-y','-loglevel','warning','-f','image2pipe','-framerate',String(fps),'-vcodec','mjpeg','-i','pipe:0','-i',path.join(dir,'soundtrack.m4a'),'-map','0:v:0','-map','1:a:0','-vf','scale=in_range=full:out_range=tv:in_color_matrix=bt601:out_color_matrix=bt709','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-c:v','libx264','-preset','fast','-crf','17','-pix_fmt','yuv420p','-r',String(fps),'-frames:v',String(count),'-af',`apad,atrim=0:${duration}`,'-c:a','aac','-b:a','192k','-t',String(duration),'-movflags','+faststart',movie],{stdio:['pipe','ignore','pipe'],windowsHide:true});
    let log='';encoder.stderr.on('data',data=>log+=data);encoder.stdin.on('error',()=>{});const done=once(encoder,'close');
    for(let i=0;i<count;i++) {
      const data=await page.evaluate(async t=>{await window.renderFrame(t);return document.getElementById('film').toDataURL('image/jpeg',.98).split(',')[1]},i/fps);
      if(!encoder.stdin.write(Buffer.from(data,'base64')))await once(encoder.stdin,'drain');
      if(i%120===0)console.log(`Film render ${i}/${count}`);
    }
    encoder.stdin.end();const [code]=await done;if(code!==0)throw new Error(log);
    if(errors.length)throw new Error(errors.join('\n'));
    ffmpegSync(['-i',movie,'-c:v','copy','-an','-movflags','+faststart',path.join(dir,'bolt-localhost-concept-silent.mp4')]);
    console.log(`Export complete: 1920 × 1080, ${fps} fps, ${duration.toFixed(3)} s.`);
  } finally {await browser.close();if(encoder&&encoder.exitCode===null)encoder.kill();}
})().catch(error=>{console.error(error);process.exitCode=1});
