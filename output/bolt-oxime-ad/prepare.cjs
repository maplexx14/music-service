const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const assets = path.join(__dirname, 'assets');
const ffmpeg = process.env.FFMPEG_PATH || path.join(process.env.USERPROFILE, '.codex/tmp/bolt-video-tools/node_modules/ffmpeg-static/ffmpeg.exe');
const project = JSON.parse(fs.readFileSync(path.join(__dirname, 'project.json')));
async function logo(source, name, white, darkLetters=false) {
  const {data, info} = await sharp(source).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const corner = [...data.subarray(0, 4)];
  let opaque = 0;
  for(let i=3;i<data.length;i+=4) if(data[i] < 250) opaque++;
  if(!opaque) for(let i=0;i<data.length;i+=4) {
    const d = Math.max(Math.abs(data[i]-corner[0]),Math.abs(data[i+1]-corner[1]),Math.abs(data[i+2]-corner[2]));
    if(d<12) data[i+3]=0;
  }
  if(white) for(let i=0;i<data.length;i+=4) if(Math.max(data[i],data[i+1],data[i+2])<100) data[i]=data[i+1]=data[i+2]=250;
  if(darkLetters) for(let i=0;i<data.length;i+=4) {
    const x=(i/4)%info.width;
    if(x<info.width*.255||x>info.width*.602) {data[i]=36;data[i+1]=30;data[i+2]=49;}
    else if(Math.min(data[i],data[i+1],data[i+2])>183) {data[i]=143;data[i+1]=132;data[i+2]=165;}
  }
  await sharp(data,{raw:info}).trim({background:'#00000000',threshold:5}).png().toFile(path.join(assets,name));
}
(async()=>{
  fs.mkdirSync(assets,{recursive:true});
  await logo(path.join(root,'frontend/src/assets/brand-mark.png'),'mark.png',false);
  await logo(path.join(root,'frontend/src/assets/bolt-wordmark-wide.webp'),'wordmark.png',false);
  await logo(path.join(root,'frontend/src/assets/bolt-wordmark-wide.webp'),'wordmark-white.png',true);
  await logo(path.join(root,'frontend/src/assets/bolt-wordmark-wide.webp'),'wordmark-dark.png',false,true);
  await sharp(path.join(root,'output/bolt-localhost-current-final/mobile-player.png')).png().toFile(path.join(assets,'player.png'));
  const covers = [
    'output/bolt-mobile-concept/assets/artist-1.jpg',
    'output/bolt-mobile-concept/assets/artist-2.jpg',
    'output/bolt-mobile-concept/assets/artist-3.jpg',
    'output/bolt-concept-ad/assets/only-a-lad.jpg',
    'output/bolt-concept-ad/assets/soad.jpg'
  ];
  for(let i=0;i<covers.length;i++) await sharp(path.join(root,covers[i])).resize(768,768,{fit:'cover'}).png().toFile(path.join(assets,`cover-${i}.png`));
  for(const name of ['arimo-cyrillic.woff2','arimo-latin.woff2']) fs.copyFileSync(path.join(root,'frontend/public/fonts',name),path.join(assets,name));
  if(!fs.existsSync(path.join(__dirname,'reference-audio.wav'))) {
    const result=spawnSync(ffmpeg,['-hide_banner','-y','-loglevel','error','-i',project.reference,'-vn','-ar','48000','-c:a','pcm_s16le',path.join(__dirname,'reference-audio.wav')],{windowsHide:true});
    if(result.status!==0) throw Error(result.stderr.toString());
  }
  console.log('Brand, player, five covers and reference soundtrack prepared.');
})().catch(e=>{console.error(e);process.exitCode=1;});
