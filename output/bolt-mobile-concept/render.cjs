const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const sharp = require('sharp');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || path.join(process.env.USERPROFILE, 'AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core'));
const ffmpeg = process.env.FFMPEG_PATH || path.join(process.env.USERPROFILE, '.codex/tmp/bolt-video-tools/node_modules/ffmpeg-static/ffmpeg.exe');
const reference = process.env.REFERENCE_PATH || 'C:/Users/maplex/Downloads/Spotify 2.0 Concept 🎶.mp4';
const dir = __dirname, fps = 60;
const edition = JSON.parse(fs.readFileSync(path.join(dir,'project.json'),'utf8'));
const introDuration = edition.introDuration || 0, endingSpeed = edition.endingSpeed || 1;
const count = Math.round((introDuration + edition.sourceDuration + (764 / fps - edition.sourceDuration) / endingSpeed) * fps), duration = count / fps;
const editTime = t => introDuration + (t <= edition.sourceDuration ? t : edition.sourceDuration + (t - edition.sourceDuration) / endingSpeed);
const stillsOnly = process.argv.includes('--stills');
const stages = [['00-home', edition.swipeStart*.6], ['00-swipe', edition.swipeStart+edition.swipeDuration*.6], ...[
  ['01-search',.75],['02-best',1.84],['03-open',2.72],['04-paused',3.78],
  ['05-before-play',4.64],['06-one-tap',4.88],['07-playing',5.85],['08-artists',7.44],
  ['09-rhythm',8.82],['10-one-touch',9.72],['11-bolt',11.25],['12-outro',12.25],
].map(([name,t]) => [name,editTime(t)])];
function ffmpegSync(args) {
  const result = spawnSync(ffmpeg, ['-hide_banner','-y','-loglevel','error',...args], { windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr?.toString() || 'FFmpeg did not finish.');
}
async function contactSheet() {
  const columns=4,tileW=270,tileH=504,rows=Math.ceil(stages.length/columns),layers=[];
  for(let i=0;i<stages.length;i++) {
    const [name,t]=stages[i],left=(i%columns)*tileW,top=Math.floor(i/columns)*tileH;
    const frame=await sharp(path.join(dir,name+'.png')).resize(tileW,480).png().toBuffer();
    layers.push({input:frame,left,top});
    layers.push({input:Buffer.from(`<svg width="270" height="24"><rect width="270" height="24" fill="#15101d"/><text x="10" y="17" fill="#d4c4e4" font-family="Arial" font-size="12">${t.toFixed(2)} s · ${name}</text></svg>`),left,top:top+480});
  }
  await sharp({create:{width:columns*tileW,height:rows*tileH,channels:3,background:'#15101d'}}).composite(layers).jpeg({quality:90}).toFile(path.join(dir,'storyboard.jpg'));
}
(async () => {
  const metadata=JSON.parse(fs.readFileSync(path.join(dir,'capture.json'),'utf8'));
  const intro=JSON.parse(fs.readFileSync(path.join(dir,'intro.json'),'utf8'));
  if(intro.partial||intro.count!==Math.round(introDuration*fps)||!intro.nativeSwipe)throw new Error('Run capture-intro.cjs before rendering.');
  for(const checkpoint of metadata.checkpoints){checkpoint.audioTime??=checkpoint.time;checkpoint.time=checkpoint.frame/metadata.fps;}
  fs.writeFileSync(path.join(dir,'capture.json'),JSON.stringify(metadata,null,2)+'\n');
  if(metadata.partial&&!stillsOnly)throw new Error('Run capture.cjs without --stills before exporting the film.');
  fs.writeFileSync(path.join(dir,'capture-data.js'),'window.BOLT_CAPTURE = '+JSON.stringify(metadata)+';\nwindow.BOLT_INTRO = '+JSON.stringify(intro)+';\nwindow.BOLT_EDITION = '+JSON.stringify({...edition,filmFrames:count,filmDuration:duration})+';\n');
  ffmpegSync(['-i',reference,'-vn','-c:a','copy','-movflags','+faststart',path.join(dir,'soundtrack.m4a')]);
  const duck=`volume='if(lt(t,${4.62+introDuration}),1,if(lt(t,${4.72+introDuration}),1-0.82*(t-${4.62+introDuration})/0.10,if(lt(t,${6.43+introDuration}),0.18,if(lt(t,${6.60+introDuration}),0.18+0.82*(t-${6.43+introDuration})/0.17,1))))':eval=frame`;
  const introDuck=`volume='if(lt(t,${edition.introPauseAt-.025}),0.18,if(lt(t,${edition.introPauseAt+.12}),0.18+0.82*(t-${edition.introPauseAt-.025})/0.145,1))':eval=frame`;
  const playDelay=Math.round((edition.playAt+introDuration)*1000);
  const audioMix=`[0:a]${duck},${introDuck}[bed];[1:a]afade=t=in:st=0:d=0.025,afade=t=out:st=1.73:d=0.17,volume=0.85,adelay=${playDelay}|${playDelay}[track];[2:a]atrim=0:${edition.introPauseAt},afade=t=in:st=0:d=0.025,afade=t=out:st=${edition.introPauseAt-.025}:d=0.025,volume=0.85[introTrack];[bed][track][introTrack]amix=inputs=3:duration=first:normalize=0,alimiter=limit=0.94:level=false,apad,atrim=0:${duration},afade=t=out:st=${duration-.16}:d=0.16[mix]`;
  ffmpegSync(['-i',path.join(dir,'soundtrack.m4a'),'-i',path.join(dir,'assets/demo-track.wav'),'-i',path.join(dir,'assets/intro-track.wav'),'-filter_complex',audioMix,'-map','[mix]','-c:a','aac','-b:a','192k','-movflags','+faststart',path.join(dir,'soundtrack-mixed.m4a')]);
  const browser=await chromium.launch({executablePath:process.env.EDGE_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,args:['--allow-file-access-from-files','--disable-background-networking','--force-color-profile=srgb']});
  let encoder;
  try {
    const page=await browser.newPage({viewport:{width:1080,height:2100},deviceScaleFactor:1});
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
    console.log(`${stages.length} review frames and storyboard ready.`);
    if(stillsOnly)return;
    const movie=path.join(dir,edition.movie);
    encoder=spawn(ffmpeg,['-hide_banner','-y','-loglevel','warning','-f','image2pipe','-framerate',String(fps),'-vcodec','mjpeg','-i','pipe:0','-i',path.join(dir,'soundtrack-mixed.m4a'),'-map','0:v:0','-map','1:a:0','-vf','scale=in_range=full:out_range=tv:in_color_matrix=bt601:out_color_matrix=bt709','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-c:v','libx264','-preset','fast','-crf','17','-pix_fmt','yuv420p','-r',String(fps),'-frames:v',String(count),'-af',`apad,atrim=0:${duration}`,'-c:a','aac','-b:a','192k','-t',String(duration),'-movflags','+faststart',movie],{stdio:['pipe','ignore','pipe'],windowsHide:true});
    let log='';encoder.stderr.on('data',data=>log+=data);encoder.stdin.on('error',()=>{});const done=once(encoder,'close');
    for(let i=0;i<count;i++) {
      const data=await page.evaluate(async t=>{await window.renderFrame(t);return document.getElementById('film').toDataURL('image/jpeg',.98).split(',')[1]},i/fps);
      if(!encoder.stdin.write(Buffer.from(data,'base64')))await once(encoder.stdin,'drain');
      if(i%120===0)console.log(`Film render ${i}/${count}`);
    }
    encoder.stdin.end();const [code]=await done;if(code!==0)throw new Error(log);
    if(errors.length)throw new Error(errors.join('\n'));
    ffmpegSync(['-i',movie,'-c:v','copy','-an','-movflags','+faststart',path.join(dir,edition.silentMovie)]);
    console.log(`Export complete: 1080 × 1920 (9:16), ${fps} fps, ${duration.toFixed(3)} s.`);
  } finally {await browser.close();if(encoder&&encoder.exitCode===null)encoder.kill();}
})().catch(error=>{console.error(error);process.exitCode=1});
