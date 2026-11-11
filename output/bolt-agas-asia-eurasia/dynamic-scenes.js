const inheritedReady=window.ready,dynamicVideo=document.getElementById('base');
const dynamicLogo=new Image();dynamicLogo.src='assets/bolt.png';
const dynamicFrame=document.createElement('canvas');dynamicFrame.width=W;dynamicFrame.height=H;
const dynamicCtx=dynamicFrame.getContext('2d',{alpha:false});
const dynamicTiming=window.DYNAMIC_TIMING;
const finalTime=s=>dynamicTiming.timebase==='output'?s:s/1.1-(s>=4.47?.7:0);
const dynamicLines=dynamicTiming.lines.map(line=>line.words.map(word=>({...word,start:finalTime(word.start),end:finalTime(word.end)})));
const dynamicReveal=8.9/1.1-.7;
const dynamicShots=[
  {start:0,end:1.72,rows:[dynamicLines[0].slice(0,3),dynamicLines[0].slice(3)]},
  {start:1.72,end:3.36,rows:[dynamicLines[1].slice(0,2),dynamicLines[1].slice(2)]},
  {start:3.36,end:5.58,rows:[dynamicLines[2].slice(0,3),dynamicLines[2].slice(3)]},
  {start:5.58,end:dynamicReveal,rows:[dynamicLines[3].slice(0,1),dynamicLines[3].slice(1)]},
];

function dText(s,x,y,size,color='#f5edff',weight=700,align='center',maxWidth=904){
  ctx.textAlign=align;ctx.textBaseline='top';
  while(size>20){ctx.font=`${weight} ${size}px Unbounded`;if(ctx.measureText(s).width<=maxWidth)break;size-=.5;}
  ctx.fillStyle=color;ctx.fillText(s,x,y);return size;
}
function dBackground(t,scene){
  const shades=['#25133a','#321627','#182237','#142b32'];
  ctx.fillStyle='#100d18';ctx.fillRect(0,0,W,H);
  const glow=ctx.createRadialGradient(530,730,50,540,760,950);glow.addColorStop(0,shades[scene]);glow.addColorStop(1,'#100d18');ctx.fillStyle=glow;ctx.fillRect(0,0,W,H);
  ctx.save();ctx.globalAlpha=.18;
  for(let i=0;i<3;i++){ctx.beginPath();ctx.ellipse(540,800,320+i*180,360+i*170,-.3+t*.018,0,Math.PI*2);ctx.strokeStyle='#a388be';ctx.lineWidth=2;ctx.stroke();}
  ctx.restore();
}
function dDust(x,y,age,direction=1){
  if(age<0||age>.55)return;
  const p=age/.55;
  for(let i=0;i<7;i++){ctx.save();ctx.globalAlpha=(1-p)*.6;ellipse(x+direction*(30+i*20)*p,y-(22+i%3*10)*Math.sin(p*Math.PI),4+i%3,3,'#d5b8c6');ctx.restore();}
}
function dLines(t,scene){
  const shot=dynamicShots[scene],arrival=scene===0?1:ease((t-shot.start)/.12);
  ctx.save();ctx.globalAlpha=arrival;ctx.translate(0,(1-arrival)*20);
  shot.rows.forEach((words,row)=>{
    const text=words.map(w=>w.text).join(' '),y=1288+row*151;
    let size=scene===3?102:row===1?100:86;
    while(size>20){ctx.font=`750 ${size}px Unbounded`;if(ctx.measureText(text).width<=912)break;size-=.5;}
    const width=ctx.measureText(text).width,x=(W-width)/2;
    dText(text,x,y,size,'#a89bb6',750,'left',912);
    let cursor=0,filled=0;
    for(const word of words){const i=text.indexOf(word.text,cursor),left=ctx.measureText(text.slice(0,i)).width,right=ctx.measureText(text.slice(0,i+word.text.length)).width;
      if(t>=word.end)filled=right;else if(t>word.start){filled=left+(right-left)*clamp((t-word.start)/(word.end-word.start));break;}else break;cursor=i+word.text.length;}
    if(t>=words.at(-1).end)filled=width+2;
    if(filled>0){ctx.save();ctx.beginPath();ctx.rect(x-2,y-7,filled+3,132);ctx.clip();dText(text,x,y,size,scene===3?'#95eedb':'#cc9fff',750,'left',912);ctx.restore();}
  });
  ctx.restore();
}
function dWide(t){
  const z=1.65+.18*smooth((t-.6)/.6);
  ctx.save();ctx.translate(540,843);ctx.scale(z,z);ctx.translate(-540,-320);
  mountain(t);camel(t);dDust(450,446,t-.75,-1);dDust(610,446,t-.75,1);ctx.restore();
}
function dReaction(t){
  const local=t-1.72,z=3.6+.35*ease(local/.22);
  ctx.save();ctx.beginPath();ctx.rect(0,260,W,930);ctx.clip();
  ctx.translate(493,765);ctx.scale(z,z);ctx.translate(-636,-245);camel(2.25+local*.32);ctx.restore();
  const a=ease((local-.08)/.18),scale=.8+.2*a;
  ctx.save();ctx.globalAlpha=a;ctx.translate(822,482);ctx.rotate(-.1);ctx.scale(scale,scale);dText('?',0,0,160,'#ebc3ff',750);ctx.restore();
  ctx.save();ctx.globalAlpha=.5*a;stroke('M 201 471 L 234 519 M 150 543 L 209 569','#c6a0dc',7);ctx.restore();
}
function dDash(t){
  const local=t-3.36,second=local>=1.17,age=local-(second?1.17:0),direction=second?-1:1;
  const x=second?575+100*(1-ease(age/.32)):470-105*(1-ease(age/.32));
  ctx.save();ctx.globalAlpha=.2;
  for(let i=0;i<5;i++){const y=430+i*126;stroke(`M ${direction>0?120:960} ${y} L ${direction>0?300:780} ${y}`,'#9bc3ef',3);}
  ctx.restore();
  ctx.save();ctx.translate(x,838);ctx.scale(direction*1.84,1.84);ctx.translate(-540,-320);
  mountain(1);camel(Math.min(.94,age*1.65));dDust(435,447,age-.35,-1);ctx.restore();
}
function dOxygen(t){
  const local=t-5.58;
  ctx.save();ctx.translate(407,897);ctx.scale(1.57,1.57);ctx.translate(-540,-320);mountain(1);camel(5.9+local*.5);ctx.restore();
  for(let i=0;i<5;i++){
    const age=local-.12-i*.22;if(age<0)continue;
    const p=clamp(age/1.4),r=(i%2?42:74)*ease(age/.24),x=680+i*46+Math.sin(p*3+i)*14,y=851-p*390-i*8;
    ctx.save();ctx.globalAlpha=1-smooth((p-.8)/.2);ellipse(x,y,r,r,'#79ebd521');ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.strokeStyle='#8ce9d2';ctx.lineWidth=3;ctx.stroke();if(i%2===0&&age>.14)label('O₂',x,y,40,'#c6fff0');ctx.restore();
  }
  if(local>.65){const p=clamp((local-.65)/.5);ctx.save();ctx.globalAlpha=1-p;ctx.beginPath();ctx.arc(747,640,70+p*160,0,Math.PI*2);ctx.strokeStyle='#8eeedb';ctx.lineWidth=4;ctx.stroke();ctx.restore();}
}
function dIntro(t){
  const scene=t<1.72?0:t<3.36?1:t<5.58?2:3;
  dBackground(t,scene);
  if(scene===0)dWide(t);else if(scene===1)dReaction(t);else if(scene===2)dDash(t);else dOxygen(t);
  dLines(t,scene);
}
// Camera keyframes use one affine transform throughout. A quintic blend has
// zero velocity and acceleration at each hold, avoiding crop and scale jumps.
const endingCameraKeys=[
  {t:dynamicReveal,z:.965,y:30},
  {t:8.08,z:1,y:0},
  {t:8.92,z:1,y:0},
  {t:9.50,z:1.11,y:-123.2},
  {t:10.10,z:1.11,y:-123.2},
  {t:10.76,z:1.26,y:1110-1.26*1377},
  {t:11.44,z:1.26,y:1110-1.26*1377},
  {t:12.22,z:.95,y:13},
  {t:15.30,z:.95,y:13},
];
function endingEase(x){x=clamp(x);return x*x*x*(x*(x*6-15)+10);}
function endingCamera(t){
  for(let i=1;i<endingCameraKeys.length;i++){
    const a=endingCameraKeys[i-1],b=endingCameraKeys[i];
    if(t<=b.t){const p=endingEase((t-a.t)/(b.t-a.t));return {z:a.z+(b.z-a.z)*p,y:a.y+(b.y-a.y)*p};}
  }
  return endingCameraKeys.at(-1);
}
function dService(t){
  dynamicCtx.drawImage(dynamicVideo,0,0,W,H);dynamicCtx.fillStyle='#181818';dynamicCtx.fillRect(180,1448,720,86);
  ctx.fillStyle='#050505';ctx.fillRect(0,0,W,H);
  const finish=endingEase((t-11.92)/.65);
  if(finish>0){const glow=ctx.createRadialGradient(540,265,20,540,265,365);glow.addColorStop(0,`rgba(133,79,208,${.14*finish})`);glow.addColorStop(1,'rgba(133,79,208,0)');ctx.fillStyle=glow;ctx.fillRect(0,0,W,620);}
  const camera=endingCamera(t),z=camera.z;
  ctx.save();ctx.beginPath();ctx.roundRect(72,330,936,1260,36);ctx.clip();
  ctx.save();ctx.translate(540,camera.y);ctx.scale(z,z);ctx.drawImage(dynamicFrame,-540,0);ctx.restore();
  const clickTime=(8.9+window.DYNAMIC_CAPTURE.clickAt)/1.1-.7,delta=t-clickTime;
  if(delta>=0&&delta<.52){
    const p=clamp(delta/.52),spread=8*endingEase(p),alpha=.72*(1-endingEase(p));
    const buttonX=540+(220-540)*z-spread,buttonY=(window.DYNAMIC_CAPTURE.click.y-48)*z+camera.y-spread;
    ctx.save();ctx.globalAlpha=alpha;ctx.beginPath();ctx.roundRect(buttonX,buttonY,640*z+2*spread,96*z+2*spread,48*z+spread);ctx.strokeStyle='#ede1ff';ctx.lineWidth=3;ctx.stroke();
    if(delta<.16){ctx.globalAlpha=.2*(1-delta/.16);ellipse(540,window.DYNAMIC_CAPTURE.click.y*z+camera.y,28,28,'#fff');}
    ctx.restore();
  }
  ctx.restore();
  const logoW=272+48*finish,logoY=202-6*finish;
  ctx.drawImage(dynamicLogo,(W-logoW)/2,logoY,logoW,logoW*dynamicLogo.naturalHeight/dynamicLogo.naturalWidth);
  // The CTA stays readable throughout: its size and position change continuously,
  // with no opacity reset between the button close-up and the final hold.
  const heading=endingEase((t-11.82)/.62),address=endingEase((t-12.0)/.65);
  dText('Слушай в Bolt',540,1642-15*heading,32+12*heading,'#dfc8ff',650);
  const addressY=1721-20*address;
  dText('boltmusic.lat',540,addressY,27+9*address,'#d0bde0',500);
  const addressWidth=ctx.measureText('boltmusic.lat').width;
  const underline=endingEase((t-12.72)/.42);
  if(underline>0){
    ctx.save();ctx.globalAlpha=underline;stroke(`M ${540-addressWidth/2} ${addressY+46} L ${540-addressWidth/2+addressWidth*underline} ${addressY+46}`,'#9f76d1',2);
    const arrowX=540+addressWidth/2+28+6*(1-underline),arrowY=addressY+21;
    stroke(`M ${arrowX-7} ${arrowY+7} L ${arrowX+7} ${arrowY-7} M ${arrowX-4} ${arrowY-7} L ${arrowX+7} ${arrowY-7} L ${arrowX+7} ${arrowY+4}`,'#c5a0ee',2.5);ctx.restore();
  }
}
async function dSeek(t){
  const target=Math.max(0,Math.min(dynamicVideo.duration-.05,(t+.7)*1.1-8.9));
  if(Math.abs(dynamicVideo.currentTime-target)<.0005&&dynamicVideo.readyState>=2)return;
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Service seek timed out')),8000);dynamicVideo.addEventListener('seeked',()=>{clearTimeout(timer);resolve();},{once:true});dynamicVideo.currentTime=target;});
}
window.renderFrame=async t=>{
  t=Math.max(0,Math.min(15.299,t));ctx.setTransform(1,0,0,1,0,0);ctx.globalAlpha=1;
  if(t<dynamicReveal){dIntro(t);return;}
  await dSeek(t);
  const p=clamp((t-dynamicReveal)/.35);
  if(p<1){dIntro(dynamicReveal-.01);ctx.save();ctx.beginPath();ctx.arc(747,640,35+ease(p)*1780,0,Math.PI*2);ctx.clip();dService(t);ctx.restore();}
  else dService(t);
};
window.ready=Promise.all([inheritedReady,dynamicLogo.decode(),document.fonts.load('750 100px Unbounded','На горе стоит верблюд кислород'),document.fonts.load('650 41px Unbounded','Слушай в Bolt')]).then(()=>window.renderFrame(0));
document.getElementById('scrub').oninput=e=>window.renderFrame(Number(e.target.value));
