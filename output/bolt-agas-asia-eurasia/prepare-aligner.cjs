const fs=require('node:fs');
const path=require('node:path');
const {Readable}=require('node:stream');
const {pipeline}=require('node:stream/promises');
const dir=path.join(process.env.USERPROFILE,'.codex/tmp/bolt-video-tools/whisper');
async function download(url,name){const dest=path.join(dir,name);if(fs.existsSync(dest)&&fs.statSync(dest).size>1000000)return;const r=await fetch(url,{signal:AbortSignal.timeout(240000)});if(!r.ok)throw Error(`${r.status} ${url}`);await pipeline(Readable.fromWeb(r.body),fs.createWriteStream(dest));console.log(`Downloaded ${name}: ${fs.statSync(dest).size}`);}
(async()=>{
  fs.mkdirSync(dir,{recursive:true});
  const r=await fetch('https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=20');const releases=await r.json();
  const release=releases.find(r=>r.assets?.some(a=>a.name==='whisper-bin-x64.zip'));
  if(!release){console.log(JSON.stringify(releases.map(r=>({tag:r.tag_name,assets:r.assets?.map(a=>a.name)}))));return;}
  const asset=release.assets.find(a=>a.name==='whisper-bin-x64.zip');
  console.log(`Aligner ${release.tag_name}`);
  await Promise.all([download(asset.browser_download_url,'whisper-bin-x64.zip'),download('https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin','ggml-base.bin')]);
})().catch(e=>{console.error(e);process.exit(1);});
