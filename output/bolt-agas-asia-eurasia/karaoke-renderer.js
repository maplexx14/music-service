const canvas=document.getElementById('film'),ctx=canvas.getContext('2d',{alpha:false});
const W=1080,H=1920,timing=window.KARAOKE,service=document.getElementById('service'),voice=document.getElementById('voice');
const rate=timing.playbackRate||1,outputDuration=timing.duration/rate;
voice.playbackRate=rate;voice.preservesPitch=true;service.playbackRate=rate;
const logo=new Image();logo.src='assets/bolt.png';
const serviceFrame=document.createElement('canvas');serviceFrame.width=W;serviceFrame.height=H;
const serviceCtx=serviceFrame.getContext('2d',{alpha:false});
const clamp=v=>Math.min(1,Math.max(0,v));
const smooth=v=>{v=clamp(v);return v*v*(3-2*v);};
const paper='#f7f3ec';
function rect(x,y,w,h,r,fill,stroke){ctx.beginPath();ctx.roundRect(x,y,w,h,r);if(fill){ctx.fillStyle=fill;ctx.fill();}if(stroke){ctx.strokeStyle=stroke;ctx.lineWidth=2;ctx.stroke();}}
function circle(x,y,r,fill){ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fillStyle=fill;ctx.fill();}
function type(str,x,y,size,color,weight=600,align='left',maxWidth=900){ctx.textAlign=align;ctx.textBaseline='top';while(size>16){ctx.font=`${weight} ${size}px Unbounded`;if(ctx.measureText(str).width<=maxWidth)break;size-=.5;}ctx.fillStyle=color;ctx.fillText(str,x,y);return size;}
function line(x1,y1,x2,y2,color,width=2){ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.strokeStyle=color;ctx.lineWidth=width;ctx.stroke();}

// The same text is painted twice. Only the second paint is clipped horizontally,
// so a partly spoken word fills through its glyphs, without any rectangle behind it.
function karaokeLine(entry,y,t){
  let size=68;
  while(size>16){ctx.font=`650 ${size}px Unbounded`;if(ctx.measureText(entry.text).width<=916)break;size-=.5;}
  const x=(W-ctx.measureText(entry.text).width)/2;
  type(entry.text,x,y,size,'#91869f',650,'left',916);
  ctx.font=`650 ${size}px Unbounded`;
  let cursor=0,filled=0;
  for(const word of entry.words){
    const index=entry.text.indexOf(word.text,cursor);if(index<0)throw Error(`Missing word ${word.text}`);
    const left=ctx.measureText(entry.text.slice(0,index)).width;
    const right=ctx.measureText(entry.text.slice(0,index+word.text.length)).width;
    if(t>=word.end)filled=right;
    else if(t>word.start){filled=left+(right-left)*clamp((t-word.start)/(word.end-word.start));break;}
    else break;
    cursor=index+word.text.length;
  }
  if(t>=entry.words.at(-1).end)filled=ctx.measureText(entry.text).width+2;
  if(filled>0){ctx.save();ctx.beginPath();ctx.rect(x-2,y-8,filled+2,110);ctx.clip();type(entry.text,x,y,size,'#c497ff',650,'left',916);ctx.restore();}
  return filled;
}
function intro(t){
  ctx.fillStyle='#100d18';ctx.fillRect(0,0,W,H);
  const g=ctx.createRadialGradient(770,1180,0,620,1000,1100);g.addColorStop(0,'#34233e70');g.addColorStop(1,'#100d1800');ctx.fillStyle=g;ctx.fillRect(0,0,W,H);
  ctx.save();ctx.globalAlpha=.1;for(let i=0;i<3;i++){ctx.beginPath();ctx.ellipse(540,1020,540+i*180,750+i*180,-.34,0,Math.PI*2);ctx.strokeStyle='#9b72c5';ctx.lineWidth=1;ctx.stroke();}ctx.restore();
  const rows=[
    {words:timing.lines[0].words.slice(0,3),y:540},
    {words:timing.lines[0].words.slice(3),y:650},
    {words:timing.lines[1].words,y:800},
    {words:timing.lines[2].words.slice(0,3),y:1000},
    {words:timing.lines[2].words.slice(3),y:1110},
    {words:timing.lines[3].words,y:1260},
  ];
  for(const row of rows)karaokeLine({text:row.words.map(w=>w.text).join(' '),words:row.words},row.y,t);
}
function recordedService(t,opacity=1){
  const local=t-timing.transitionStart;
  ctx.save();ctx.globalAlpha=opacity;
  // Remove only the sign-in footer from the existing recording, matching
  // the flat card surface before the crossfade, so letters cannot bleed through.
  serviceCtx.drawImage(service,0,0,W,H);
  serviceCtx.fillStyle='#181818';serviceCtx.fillRect(180,1448,720,86);
  ctx.drawImage(serviceFrame,0,0);
  const logoW=272;ctx.drawImage(logo,(W-logoW)/2,200,logoW,logoW*logo.naturalHeight/logo.naturalWidth);
  const click=window.CAPTURE.click,delta=local-window.CAPTURE.clickAt;
  if(delta>=0&&delta<.5){const p=delta/.5;ctx.save();ctx.globalAlpha=opacity*(1-p)*.8;ctx.beginPath();ctx.arc(click.x,click.y,28+p*64,0,Math.PI*2);ctx.strokeStyle='#fff';ctx.lineWidth=5*(1-p)+1;ctx.stroke();ctx.restore();}
  type('Слушай в Bolt',540,1655,30,'#dfc8ff',600,'center');
  type('boltmusic.lat',540,1716,26,'#a99ab7',450,'center');
  ctx.restore();
}
function paint(t){
  ctx.setTransform(1,0,0,1,0,0);ctx.globalAlpha=1;
  if(t<timing.transitionStart+timing.transitionDuration)intro(t);
  else{ctx.fillStyle='#050505';ctx.fillRect(0,0,W,H);}
  if(t>=timing.transitionStart)recordedService(t,smooth((t-timing.transitionStart)/timing.transitionDuration));
}
async function seekService(t){
  const target=Math.max(0,Math.min(service.duration-.05,t-timing.transitionStart));
  if(Math.abs(service.currentTime-target)<.0005&&service.readyState>=2)return;
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(`Video seek timed out at ${target}`)),8000);service.addEventListener('seeked',()=>{clearTimeout(timer);resolve();},{once:true});service.currentTime=target;});
}
window.renderFrame=async t=>{t=Math.max(0,Math.min(timing.duration-.001,t*rate));if(t>=timing.transitionStart)await seekService(t);paint(t);};
window.ready=Promise.all([logo.decode(),document.fonts.load('650 68px Unbounded','На горе стоит верблюд'),document.fonts.load('600 30px Unbounded','Слушай в Bolt'),new Promise((resolve,reject)=>{if(service.readyState>=2)return resolve();service.addEventListener('loadeddata',resolve,{once:true});service.addEventListener('error',()=>reject(Error('Service video failed to load')),{once:true});})]).then(()=>paint(0));
const button=document.getElementById('play'),seek=document.getElementById('seek'),clock=document.getElementById('time');
let playing=false,base=0,start=0,serviceStarted=false;
function stop(){playing=false;voice.pause();service.pause();serviceStarted=false;button.textContent='Продолжить';}
function displayTime(t){seek.value=t;clock.textContent=`${t.toFixed(1)} / ${outputDuration.toFixed(1)}`;}
function tick(now){if(!playing)return;const t=(now-start)/1000,sourceT=t*rate;if(t>=outputDuration){stop();base=0;button.textContent='Ещё раз';displayTime(outputDuration);return;}if(sourceT>=timing.transitionStart&&!serviceStarted){service.currentTime=Math.max(0,sourceT-timing.transitionStart);service.play().catch(()=>{});serviceStarted=true;}paint(sourceT);displayTime(t);requestAnimationFrame(tick);}
button.onclick=async()=>{await window.ready;if(playing){base=Number(seek.value);stop();return;}playing=true;start=performance.now()-base*1000;voice.currentTime=Math.min(base*rate,timing.audioDuration);if(base*rate<timing.audioDuration)voice.play().catch(()=>{});serviceStarted=false;button.textContent='Пауза';requestAnimationFrame(tick);};
seek.oninput=async()=>{stop();base=Number(seek.value);await window.renderFrame(base);displayTime(base);};
seek.max=outputDuration-1/timing.fps;displayTime(0);
