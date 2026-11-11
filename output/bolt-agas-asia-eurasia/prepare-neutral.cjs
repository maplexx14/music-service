const fs=require('node:fs'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const ffmpeg=process.env.FFMPEG_PATH||path.join(process.env.USERPROFILE,'.codex/tmp/bolt-video-tools/node_modules/ffmpeg-static/ffmpeg.exe');
const story=JSON.parse(fs.readFileSync(path.join(__dirname,'neutral-story.json'),'utf8'));
const speech=JSON.parse(fs.readFileSync(path.join(__dirname,'assets/neutral-speech-timing.json'),'utf8'));
function speechBounds(file){
  const wav=fs.readFileSync(file);let format,data;
  for(let offset=12;offset+8<=wav.length;){
    const type=wav.toString('ascii',offset,offset+4),size=wav.readUInt32LE(offset+4),chunk=wav.subarray(offset+8,offset+8+size);
    if(type==='fmt ')format=chunk;if(type==='data')data=chunk;
    offset+=8+size+(size%2);
  }
  if(!format||!data||format.readUInt16LE(0)!==1||format.readUInt16LE(2)!==1||format.readUInt16LE(14)!==16)throw Error('Expected mono PCM16 narration');
  const rate=format.readUInt32LE(4),samples=data.length/2;let first=-1,last=-1;
  for(let i=0;i<samples;i++)if(Math.abs(data.readInt16LE(i*2))>100){if(first<0)first=i;last=i;}
  if(first<0)throw Error('Silent narration');
  return {start:Math.max(0,first/rate-.025),end:Math.min(samples/rate,last/rate+.045)};
}
const inputs=[],filters=[],lines=[],segments=[];
for(const [i,segment]of story.segments.entries()){
  const file=path.join(__dirname,`assets/neutral-line-${i}.wav`),bounds=speechBounds(file);
  const rate=(bounds.end-bounds.start)/(segment.end-segment.start);
  if(rate<.7||rate>1.5)throw Error(`Unnatural speech speed in segment ${i}: ${rate}`);
  inputs.push('-i',file);
  filters.push(`[${i}:a]atrim=start=${bounds.start}:end=${bounds.end},asetpts=PTS-STARTPTS,atempo=${rate},aresample=48000,adelay=${Math.round(segment.start*1000)}:all=1[a${i}]`);
  if(segment.karaoke){
    const words=[...segment.text.matchAll(/\S+/g)].map((match,j)=>{
      const mark=speech[i].words.find(word=>word.character===match.index);
      if(!mark)throw Error(`Missing speech event for ${match[0]}`);
      const next=speech[i].words[j+1];
      const start=segment.start+Math.max(0,mark.start-bounds.start)/rate;
      const end=segment.start+(Math.min(bounds.end,next?next.start-.015:bounds.end-.025)-bounds.start)/rate;
      if(!(start<end&&end<=segment.end))throw Error(`Invalid word timing: ${match[0]}`);
      return {text:match[0],start,end};
    });
    lines.push({text:segment.text,words});
  }
  segments.push({...segment,sourceStart:bounds.start,sourceEnd:bounds.end,playbackRate:rate});
}
filters.push(story.segments.map((_,i)=>`[a${i}]`).join('')+`amix=inputs=${story.segments.length}:normalize=0,apad=pad_dur=2.1,atrim=end_sample=${Math.round(story.duration*48000)},asetpts=N/SR/TB,loudnorm=I=-16:TP=-1.5:LRA=7[narration]`);
const result=spawnSync(ffmpeg,['-hide_banner','-y','-loglevel','error',...inputs,'-filter_complex',filters.join(';'),'-map','[narration]','-ar','48000','-ac','1','-c:a','pcm_s16le','-t',String(story.duration),path.join(__dirname,'assets/neutral-narration.wav')],{windowsHide:true,encoding:'utf8',timeout:30000});
if(result.status!==0)throw Error(result.stderr);
const timing={duration:story.duration,fps:story.fps,timebase:'output',voice:story.voice,lines,segments};
fs.writeFileSync(path.join(__dirname,'neutral-timing.json'),JSON.stringify(timing,null,2)+'\n');
console.log(JSON.stringify({duration:story.duration,words:lines.reduce((n,l)=>n+l.words.length,0),speechRates:segments.map(s=>Number(s.playbackRate.toFixed(3)))},null,2));
