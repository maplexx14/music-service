const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {pathToFileURL}=require('node:url');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||path.join(process.env.USERPROFILE,'AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core'));
const ffmpeg=process.env.FFMPEG_PATH||path.join(process.env.USERPROFILE,'.codex/tmp/bolt-video-tools/node_modules/ffmpeg-static/ffmpeg.exe');
const dir=__dirname,previous=path.resolve(dir,'../bolt-localhost-concept');

function decodedIntro(movie) {
  const width=320,height=180,size=width*height;
  const result=spawnSync(ffmpeg,['-hide_banner','-loglevel','error','-ss','0.1','-i',movie,'-t','1.25','-vf',`scale=${width}:${height},format=gray`,'-fps_mode','passthrough','-f','rawvideo','pipe:1'],{windowsHide:true,maxBuffer:12*1024*1024});
  if(result.status!==0)throw new Error(result.stderr.toString());
  const count=result.stdout.length/size;if(!Number.isInteger(count))throw new Error('Partial decoded frame.');
  const hashes=new Set();let duplicates=0,peakDifference=0,peakFrame=0;
  for(let i=0;i<count;i++) {
    const frame=result.stdout.subarray(i*size,(i+1)*size);hashes.add(crypto.createHash('sha256').update(frame).digest('hex'));
    if(i===0)continue;const before=result.stdout.subarray((i-1)*size,i*size);
    if(frame.equals(before))duplicates++;
    let difference=0;for(let px=0;px<size;px++)difference+=Math.abs(frame[px]-before[px]);
    if(difference/size>peakDifference){peakDifference=difference/size;peakFrame=i;}
  }
  return {fromSeconds:.1,throughSeconds:1.35,decodedFrames:count,uniqueFrames:hashes.size,consecutiveDuplicateFrames:duplicates,peakMeanPixelChange:Number(peakDifference.toFixed(4)),peakChangeAtSeconds:Number((.1+peakFrame/60).toFixed(4))};
}

async function trajectory(browser,folder,legacy) {
  const page=await browser.newPage();
  try {
    await page.goto(pathToFileURL(path.join(folder,'composition.html')).href);await page.evaluate(()=>window.ready);
    return await page.evaluate(legacy=>{
      const anchors=[{x:120,y:60},{x:241,y:124},{x:212,y:328}],fps=60;
      function project(point,c) {
        let x=(point.x-c.x)*c.s,y=(point.y-c.y)*c.s,z=0;
        const ry=c.ry*Math.PI/180,rx=c.rx*Math.PI/180,rz=c.rz*Math.PI/180;
        let nextX=Math.cos(ry)*x+Math.sin(ry)*z;z=-Math.sin(ry)*x+Math.cos(ry)*z;x=nextX;
        let nextY=Math.cos(rx)*y-Math.sin(rx)*z;z=Math.sin(rx)*y+Math.cos(rx)*z;y=nextY;
        nextX=Math.cos(rz)*x-Math.sin(rz)*y;nextY=Math.sin(rz)*x+Math.cos(rz)*y;x=nextX;y=nextY;
        const depth=1+z/2200;return {x:c.ox+x/depth,y:c.oy+y/depth};
      }
      const frames=[];
      for(let frame=0;frame<70;frame++) {
        const t=frame/fps,c=camera(t),before=camera(Math.max(0,t-1/fps));
        const speed=Math.hypot(c.ox-before.ox,c.oy-before.oy)+Math.abs(c.s-before.s)*window.BOLT_CAPTURE.width+Math.hypot(c.x-before.x,c.y-before.y)*c.s;
        const samples=legacy?(speed>8?5:1):8,shutter=legacy?.38:.6;
        const points=anchors.map(anchor=>{
          let x=0,y=0;
          for(let j=0;j<samples;j++) {
            const at=Math.max(0,t-(1-j/Math.max(1,samples-1))*shutter/fps),p=project(anchor,camera(at));x+=p.x/samples;y+=p.y/samples;
          }
          return {x,y};
        });
        frames.push({t,samples,points});
      }
      return frames;
    },legacy);
  } finally {await page.close();}
}

function movement(frames) {
  let maxStep=0,maxVelocityChange=0,modeChanges=0;
  for(let anchor=0;anchor<frames[0].points.length;anchor++) {
    let vx=0,vy=0;
    for(let i=1;i<frames.length;i++) {
      const a=frames[i-1].points[anchor],b=frames[i].points[anchor],dx=b.x-a.x,dy=b.y-a.y;
      maxStep=Math.max(maxStep,Math.hypot(dx,dy));maxVelocityChange=Math.max(maxVelocityChange,Math.hypot(dx-vx,dy-vy));vx=dx;vy=dy;
    }
  }
  for(let i=1;i<frames.length;i++)if(frames[i].samples!==frames[i-1].samples)modeChanges++;
  return {peakDisplacementPixelsPerFrame:Number(maxStep.toFixed(4)),peakVelocityChangePixelsPerFrame:Number(maxVelocityChange.toFixed(4)),shutterModeChanges:modeChanges};
}

(async()=>{
  const browser=await chromium.launch({executablePath:process.env.EDGE_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,args:['--allow-file-access-from-files','--disable-background-networking']});
  let before,after;
  try {
    const results=await Promise.allSettled([trajectory(browser,previous,true),trajectory(browser,dir,false)]);
    if(results.some(r=>r.status!=='fulfilled'))throw new Error(results.filter(r=>r.status==='rejected').map(r=>String(r.reason)).join('\n'));
    before=movement(results[0].value);after=movement(results[1].value);
  } finally {await browser.close();}
  const report={openingThroughSeconds:69/60,previous:before,current:after,peakStepReductionPercent:Number((100*(1-after.peakDisplacementPixelsPerFrame/before.peakDisplacementPixelsPerFrame)).toFixed(1)),decodedPrevious:decodedIntro(path.join(previous,'bolt-localhost-concept.mp4')),decodedCurrent:decodedIntro(path.join(dir,'bolt-localhost-concept-ru.mp4'))};
  fs.writeFileSync(path.join(dir,'motion-audit.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
})().catch(error=>{console.error(error);process.exitCode=1});
