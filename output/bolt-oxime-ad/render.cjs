const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {spawn,spawnSync}=require('node:child_process');
const {once}=require('node:events');
const sharp=require('sharp');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||path.join(process.env.USERPROFILE,'AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core'));
const ffmpeg=process.env.FFMPEG_PATH||path.join(process.env.USERPROFILE,'.codex/tmp/bolt-video-tools/node_modules/ffmpeg-static/ffmpeg.exe');
const root=path.resolve(__dirname,'../..');
const project=JSON.parse(fs.readFileSync(path.join(__dirname,'project.json')));
const stills=process.argv.includes('--stills');
const draft=process.argv.includes('--draft');
const width=draft?1280:project.width,height=Math.round(width*9/16);
const frames=Math.round(project.duration*project.fps);
const shots=[['01-desk',.72],['02-symbol',2.12],['03-ribbons',3.30],['04-vinyl',4.42],['05-playlists',5.36],['06-particles',6.45],['07-columns',7.45],['07-landscape',8.92],['08-notes',10.60],['09-player',12.57],['10-carousel',13.94],['11-light',15.23],['12-bolt',17.13]];
function staticServer(){
 const types={'.html':'text/html;charset=utf-8','.js':'text/javascript;charset=utf-8','.json':'application/json','.png':'image/png','.webp':'image/webp','.woff2':'font/woff2'};
 return http.createServer((req,res)=>{
  const filename=path.resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname));
  if(!filename.startsWith(root+path.sep)){res.writeHead(403);res.end();return}
  fs.readFile(filename,(error,content)=>{if(error){res.writeHead(404);res.end('Missing asset');return}res.setHeader('Content-Type',types[path.extname(filename)]||'application/octet-stream');res.end(content)});
 });
}
async function storyboard(){
 const cellW=384,cellH=238,cols=4,rows=Math.ceil(shots.length/cols),composite=[];
 for(let i=0;i<shots.length;i++){
  const [name,t]=shots[i];const jpeg=await sharp(path.join(__dirname,name+'.jpg')).resize(cellW,216).toBuffer();
  const label=Buffer.from(`<svg width="384" height="22"><rect width="384" height="22" fill="#15101e"/><text x="10" y="16" fill="#ddd0f4" font-family="Arial" font-size="12">${name} · ${t.toFixed(2)}s</text></svg>`);
  composite.push({input:jpeg,left:i%cols*cellW,top:Math.floor(i/cols)*cellH},{input:label,left:i%cols*cellW,top:Math.floor(i/cols)*cellH+216});
 }
 await sharp({create:{width:cols*cellW,height:rows*cellH,channels:3,background:'#15101e'}}).composite(composite).jpeg({quality:91}).toFile(path.join(__dirname,'storyboard.jpg'));
}
(async()=>{
 const server=staticServer();let browser,encoder;
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
 try{
  browser=await chromium.launch({executablePath:process.env.EDGE_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,args:['--disable-background-networking','--enable-webgl','--ignore-gpu-blocklist']});
  const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:1});
  const errors=[],missing=[];page.on('pageerror',e=>errors.push(String(e)));page.on('response',r=>{if(r.status()>=400)missing.push(r.url())});
  await page.goto(`http://127.0.0.1:${server.address().port}/output/bolt-oxime-ad/studio.html?width=${width}`,{waitUntil:'load',timeout:120000});
  await page.evaluate(()=>window.ready);
  console.log(JSON.stringify(await page.evaluate(()=>window.filmInfo)));
  for(const [name,t] of shots){const data=await page.evaluate(t=>{window.renderFrame(t);return document.getElementById('film').toDataURL('image/jpeg',.96).split(',')[1]},t);fs.writeFileSync(path.join(__dirname,name+'.jpg'),Buffer.from(data,'base64'));console.log(`Keyframe ${name} at ${t}s`)}
  await storyboard();
  if(errors.length||missing.length)throw Error(JSON.stringify({errors,missing}));
  if(stills)return;
  const basename=draft?'bolt-oxime-draft':'bolt-oxime-ru';
  encoder=spawn(ffmpeg,['-hide_banner','-y','-loglevel','warning','-f','image2pipe','-framerate',String(project.fps),'-vcodec','mjpeg','-i','pipe:0','-i',path.join(__dirname,'reference-audio.wav'),'-map','0:v:0','-map','1:a:0','-vf','scale=in_range=full:out_range=tv:in_color_matrix=bt601:out_color_matrix=bt709','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-c:v','libx264','-preset','medium','-crf','16','-pix_fmt','yuv420p','-r',String(project.fps),'-c:a','aac','-b:a','192k','-af','afade=t=out:st=17.65:d=0.35','-t',String(project.duration),'-movflags','+faststart',path.join(__dirname,basename+'.mp4')],{windowsHide:true,stdio:['pipe','ignore','pipe']});
  let log='';encoder.stderr.on('data',b=>{log+=b});encoder.stdin.on('error',()=>{});const done=once(encoder,'close');const start=Date.now();
  for(let i=0;i<frames;i++){
   if(encoder.exitCode!==null)throw Error(log);
   const data=await page.evaluate(t=>{window.renderFrame(t);return document.getElementById('film').toDataURL('image/jpeg',.96).split(',')[1]},i/project.fps);
   if(!encoder.stdin.write(Buffer.from(data,'base64')))await once(encoder.stdin,'drain');
   if(i%60===0)console.log(`Rendered ${i}/${frames} · ${((Date.now()-start)/1000).toFixed(1)}s elapsed`);
  }
  encoder.stdin.end();const [code]=await done;if(code!==0)throw Error(log);if(errors.length)throw Error(errors.join('\n'));
  if(!draft){const silent=spawnSync(ffmpeg,['-hide_banner','-y','-loglevel','error','-i',path.join(__dirname,basename+'.mp4'),'-map','0:v:0','-c:v','copy','-an','-movflags','+faststart',path.join(__dirname,basename+'-silent.mp4')],{windowsHide:true});if(silent.status!==0)throw Error(silent.stderr.toString())}
  fs.writeFileSync(path.join(__dirname,'render.json'),JSON.stringify({width,height,fps:project.fps,duration:project.duration,frames,elapsedSeconds:(Date.now()-start)/1000,errors,missing,renderer:await page.evaluate(()=>window.filmInfo.renderer)},null,2));
  console.log(`Complete: ${basename}.mp4 · ${width} × ${height}, ${project.fps} fps, ${project.duration} seconds`);
 }finally{if(encoder&&encoder.exitCode===null)encoder.kill();if(browser)await browser.close();server.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
