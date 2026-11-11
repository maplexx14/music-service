const fs=require('node:fs'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||path.join(process.env.USERPROFILE,'AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core'));
const ffmpeg=process.env.FFMPEG_PATH||path.join(process.env.USERPROFILE,'.codex/tmp/bolt-video-tools/node_modules/ffmpeg-static/ffmpeg.exe');
const duration=15.3,fps=30,overlayDuration=7.8;
(async()=>{
  const browser=await chromium.launch({executablePath:process.env.EDGE_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,args:['--allow-file-access-from-files']});let encoder;
  try{
    const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(String(e)));
    await page.goto(pathToFileURL(path.join(__dirname,'camel-overlay.html')).href);await page.evaluate(()=>window.ready);
    for(const [name,t]of [['camel-01-mountain',.95],['camel-02-surprise',2.4],['camel-03-oxygen',6.8]]){
      const frame=await page.evaluate(async t=>{
        const video=document.getElementById('base');
        await new Promise(resolve=>{video.addEventListener('seeked',resolve,{once:true});video.currentTime=t;});
        window.renderFrame(t);const picture=document.createElement('canvas');picture.width=1080;picture.height=1920;
        const c=picture.getContext('2d');c.drawImage(video,0,0,1080,1920);c.drawImage(document.getElementById('film'),0,0);
        return picture.toDataURL('image/png').split(',')[1];
      },t);fs.writeFileSync(path.join(__dirname,`${name}.png`),Buffer.from(frame,'base64'));
    }
    if(errors.length)throw Error(errors.join('\n'));if(process.argv.includes('--stills'))return;
    encoder=spawn(ffmpeg,['-hide_banner','-y','-loglevel','warning','-i',path.join(__dirname,'bolt-agas-karaoke-v3.mp4'),'-f','image2pipe','-framerate',String(fps),'-vcodec','png','-i','pipe:0','-filter_complex','[0:v][1:v]overlay=eof_action=pass:shortest=0:format=auto[v]','-map','[v]','-map','0:a:0','-c:v','libx264','-preset','fast','-crf','17','-pix_fmt','yuv420p','-r',String(fps),'-c:a','copy','-t',String(duration),'-movflags','+faststart',path.join(__dirname,'bolt-agas-karaoke-v4.mp4')],{stdio:['pipe','ignore','pipe'],windowsHide:true});
    let log='';encoder.stderr.on('data',b=>log+=b);encoder.stdin.on('error',()=>{});const done=once(encoder,'close');
    const count=Math.round(overlayDuration*fps);
    for(let i=0;i<count;i++){
      const frame=await page.evaluate(t=>{window.renderFrame(t);return document.getElementById('film').toDataURL('image/png').split(',')[1];},i/fps);
      if(!encoder.stdin.write(Buffer.from(frame,'base64')))await once(encoder.stdin,'drain');
      if(i%60===0)console.log(`Animated ${i}/${count} frames`);
    }
    encoder.stdin.end();const [code]=await done;if(code!==0)throw Error(log);if(errors.length)throw Error(errors.join('\n'));
    console.log('Complete: 15.3s, 1080x1920, 30fps; v3 audio copied unchanged.');
  }finally{await browser.close();if(encoder&&encoder.exitCode===null)encoder.kill();}
})().catch(e=>{console.error(e);process.exit(1);});
