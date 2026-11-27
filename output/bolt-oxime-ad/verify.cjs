const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const sharp=require('sharp');
const ffmpeg=process.env.FFMPEG_PATH||path.join(process.env.USERPROFILE,'.codex/tmp/bolt-video-tools/node_modules/ffmpeg-static/ffmpeg.exe');
const file=path.join(__dirname,'bolt-oxime-ru.mp4');
(async()=>{
 const decode=spawnSync(ffmpeg,['-hide_banner','-i',file,'-map','0:v:0','-f','null','NUL'],{windowsHide:true,maxBuffer:8*1024*1024});
 const log=decode.stderr.toString();
 fs.writeFileSync(path.join(__dirname,'verification-ffmpeg.txt'),log);
 const count=[...log.matchAll(/frame=\s*(\d+)/g)].at(-1)?.[1];
 const metadata={width:1920,height:1080,fps:60,duration:18,frames:Number(count),audio:/Audio: aac.*48000 Hz, stereo/.test(log),color709:/yuv420p\(tv, bt709/.test(log)};
 if(decode.status!==0||metadata.frames!==1080||!log.includes('1920x1080')||!log.includes('60 fps')||!log.includes('Duration: 00:00:18.00')||!metadata.audio||!metadata.color709)throw Error('Export metadata or decode check failed: '+log);
 const comparisons=[];
 for(const [name,time] of [['01-desk',.72],['06-particles',6.45],['09-player',12.57],['12-bolt',17.13]]){
  const extracted=spawnSync(ffmpeg,['-hide_banner','-loglevel','error','-ss',String(time),'-i',file,'-frames:v','1','-f','image2pipe','-vcodec','png','pipe:1'],{windowsHide:true,maxBuffer:16*1024*1024});
  if(extracted.status!==0)throw Error(extracted.stderr.toString());
  const a=await sharp(extracted.stdout).resize(480,270).removeAlpha().raw().toBuffer();
  const b=await sharp(path.join(__dirname,name+'.jpg')).resize(480,270).removeAlpha().raw().toBuffer();
  let sum=0;for(let i=0;i<a.length;i++)sum+=Math.abs(a[i]-b[i]);const error=sum/a.length;
  comparisons.push({name,time,meanPixelError:Number(error.toFixed(3))});
  if(error>12)throw Error(`Encoded frame diverges from rendered image: ${name}: ${error}`);
 }
 const report={...metadata,decodeErrors:false,files:{videoBytes:fs.statSync(file).size,silentBytes:fs.statSync(path.join(__dirname,'bolt-oxime-ru-silent.mp4')).size},comparisons};
 fs.writeFileSync(path.join(__dirname,'verification.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify(report,null,2));
})().catch(e=>{console.error(e);process.exitCode=1});
