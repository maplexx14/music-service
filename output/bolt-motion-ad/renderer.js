/* Deterministic 10.4-second film, landscape and independently laid-out TikTok. */
const canvas=document.getElementById('film'),ctx=canvas.getContext('2d',{alpha:false});
const vertical=new URLSearchParams(location.search).get('format')==='tiktok';
const W=vertical?1080:1920,H=vertical?1920:1080,DURATION=10.4;
canvas.width=W;canvas.height=H;
if(vertical){canvas.style.width='min(86vw,43vh)';canvas.style.aspectRatio='9/16';document.querySelector('nav a').href='bolt-motion-ru-tiktok.mp4'}
const X=vertical?500:960,headerY=vertical?390:191,bodyY=vertical?880:552;
const clamp=x=>Math.max(0,Math.min(1,x));
const ease=x=>1-Math.pow(1-clamp(x),4);
const smooth=x=>{x=clamp(x);return x*x*(3-2*x)};
const mix=(a,b,p)=>a+(b-a)*p;
const logo=new Image(),mark=new Image();logo.src='assets/bolt.webp';mark.src='assets/mark.png';
const C={ink:'#222124',violet:'#351467',white:'#fffaff',muted:'#c6b3ea',accent:'#a37bff'};
function rect(x,y,w,h,color){ctx.fillStyle=color;ctx.fillRect(x,y,w,h)}
function label(str,x,y,size=105,color=C.white,weight=700,align='center'){
  ctx.font=`${weight} ${size}px Geologica, sans-serif`;ctx.fillStyle=color;ctx.textAlign=align;ctx.textBaseline='middle';ctx.fillText(str,x,y);
}
function img(image,x,y,width){const h=width*image.height/image.width;ctx.drawImage(image,x-width/2,y-h/2,width,h)}
function revealText(str,x,y,size,p,color=C.white){
  p=clamp(p);ctx.save();ctx.beginPath();ctx.rect(vertical?75:105,y-size*.7,vertical?850:1710,size*1.4);ctx.clip();ctx.globalAlpha=smooth(p*1.4);label(str,x,y+mix(80,0,ease(p)),size,color);ctx.restore();
}
function intro(t){
  rect(0,0,W,H,C.ink);
  const lines=vertical?[
    {y:680,words:[['Музыка,',.10]]},{y:815,words:[['которая',.40]]},
    {y:950,words:[['звучит',.80]]},{y:1085,words:[['как',1.10],['ты.',1.35]]}
  ]:[{y:448,words:[['Музыка,',.10],['которая',.40]]},{y:587,words:[['звучит',.80],['как',1.10],['ты.',1.35]]}];
  const size=vertical?104:112;ctx.font=`700 ${size}px Geologica`;
  for(const line of lines){
    const gap=26,widths=line.words.map(([s])=>ctx.measureText(s).width),total=widths.reduce((a,b)=>a+b,0)+gap*(widths.length-1);
    let x=X-total/2;
    line.words.forEach(([word,at],i)=>{
      const p=clamp((t-at)/.24);ctx.save();ctx.beginPath();ctx.rect(x-10,line.y-87,widths[i]+20,174);ctx.clip();ctx.globalAlpha=smooth(p*1.6);label(word,x,line.y+mix(125,0,ease(p)),size,C.white,700,'left');ctx.restore();x+=widths[i]+gap;
    });
  }
}
function brandBackground(t){
  rect(0,0,W,H,C.violet);
  const glow=ctx.createRadialGradient(X,bodyY,20,X,bodyY,1250);glow.addColorStop(0,'#6840a61c');glow.addColorStop(1,'#1b083522');ctx.fillStyle=glow;ctx.fillRect(0,0,W,H);
}
function brandEntrance(t){
  brandBackground(t);
  const p=ease((t-2.05)/.24),lift=ease((t-2.35)/.36);
  ctx.save();ctx.globalAlpha=p;ctx.translate(X,mix(vertical?880:540,headerY,lift));ctx.scale(mix(.55,1,p),mix(.55,1,p));
  ctx.save();ctx.globalAlpha=1-lift;img(mark,mix(0,-23,lift),0,mix(236,116,lift));ctx.restore();
  ctx.save();ctx.globalAlpha=lift;img(logo,0,0,vertical?425:355);ctx.restore();ctx.restore();
}
const messages=[
  {at:2.8,end:4.0,text:'Твои любимые треки.',lines:['Твои любимые','треки.'],size:104},
  {at:4.0,end:4.8,text:'Новые открытия.',lines:['Новые','открытия.'],size:110},
  {at:4.8,end:6.0,text:'Тексты в ритме музыки.',lines:['Тексты в ритме','музыки.'],size:99},
  {at:6.0,end:6.8,text:'Без ограничений.',lines:['Без','ограничений.'],size:110},
  {at:6.8,end:7.6,text:'В любое время.',lines:['В любое','время.'],size:110},
  {at:7.6,end:8.4,text:'В твоём ритме.',lines:['В твоём','ритме.'],size:110}
];
function textScenes(t){
  for(const scene of messages){if(t<scene.at||t>=scene.end)continue;
    const p=clamp((t-scene.at)/.18),exit=clamp((t-(scene.end-.10))/.10);
    ctx.save();ctx.globalAlpha=1-exit;
    if(vertical)scene.lines.forEach((text,i)=>revealText(text,X,bodyY+(i-.5)*125-exit*24,92,(t-scene.at-i*.035)/.18));
    else revealText(scene.text,X,bodyY-exit*32,scene.size,p);ctx.restore();
    // A small underline punctuates the arrival, like a musical accent.
    const line=ease((t-scene.at-.07)/.20);ctx.save();ctx.globalAlpha=(1-exit)*.65;rect(X-36*line,vertical?1085:663,72*line,5,C.accent);ctx.restore();
  }
}
function outro(t){
  brandBackground(t);
  const p=ease((t-8.4)/.36);img(logo,X,mix(headerY,vertical?805:447,p),mix(vertical?425:355,vertical?720:660,p));
  revealText('Включай Bolt.',X,vertical?1090:660,80,(t-8.65)/.22);
}
window.renderFrame=t=>{
  t=Math.max(0,Math.min(DURATION-1/60,t));
  if(t<2.0)intro(t);
  else if(t<2.24){intro(1.99);const p=ease((t-2.0)/.24);ctx.save();ctx.beginPath();ctx.rect(0,H*(1-p),W,H*p);ctx.clip();brandEntrance(t);ctx.restore();}
  else if(t<8.4){brandEntrance(t);textScenes(t)}else outro(t);
};
window.ready=Promise.all([document.fonts.load('700 112px Geologica','Музыка, которая звучит как ты.'),document.fonts.load('700 80px Geologica','Bolt'),logo.decode(),mark.decode()]).then(()=>window.renderFrame(0));
const play=document.getElementById('play'),seek=document.getElementById('seek'),time=document.getElementById('time'),sound=document.getElementById('sound');
let running=false,start=0,at=0;
seek.max=DURATION-1/60;time.textContent=`0.0 / ${DURATION.toFixed(1)}`;
function display(t){window.renderFrame(t);seek.value=t;time.textContent=`${t.toFixed(1)} / ${DURATION.toFixed(1)}`}
function tick(now){if(!running)return;at=Math.min(DURATION-1/60,(now-start)/1000);display(at);if(at>=DURATION-1/60){running=false;play.textContent='Смотреть';sound.pause()}else requestAnimationFrame(tick)}
play.onclick=()=>{if(running){running=false;sound.pause();play.textContent='Смотреть';return}if(at>=DURATION-.02)at=0;running=true;start=performance.now()-at*1000;sound.currentTime=at;sound.play().catch(()=>{});play.textContent='Пауза';requestAnimationFrame(tick)};
seek.oninput=()=>{at=Number(seek.value);start=performance.now()-at*1000;sound.currentTime=at;display(at)};
