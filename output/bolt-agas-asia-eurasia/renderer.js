const canvas = document.getElementById('film');
const ctx = canvas.getContext('2d', { alpha: false });
const W = 1080, H = 1920, timeline = window.TIMELINE;
const clamp = x => Math.min(1, Math.max(0, x));
const ease = x => 1 - (1 - clamp(x)) ** 3;
const logo = new Image(), placeholder = new Image();
logo.src = 'assets/bolt.png';
placeholder.src = 'assets/default-cover.png';
const ink = '#25202e', paper = '#f7f3ec', violet = '#a16bff';

function rect(x,y,w,h,r,fill,stroke) {
  ctx.beginPath(); ctx.roundRect(x,y,w,h,r);
  if(fill){ctx.fillStyle=fill;ctx.fill();}
  if(stroke){ctx.strokeStyle=stroke;ctx.lineWidth=2;ctx.stroke();}
}
function circle(x,y,r,fill){ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fillStyle=fill;ctx.fill();}
function type(str,x,y,size,color=paper,weight=600,align='left',maxWidth=880){
  ctx.textAlign=align;ctx.textBaseline='top';
  while(size>16){ctx.font=`${weight} ${size}px Unbounded`;if(ctx.measureText(str).width<=maxWidth)break;size-=.5;}
  ctx.fillStyle=color;ctx.fillText(str,x,y);return ctx.measureText(str).width;
}
function segment(x1,y1,x2,y2,color,width=3){ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.lineWidth=width;ctx.lineCap='round';ctx.strokeStyle=color;ctx.stroke();}
function roundedImage(img,x,y,w,h,r){ctx.save();ctx.beginPath();ctx.roundRect(x,y,w,h,r);ctx.clip();ctx.drawImage(img,x,y,w,h);ctx.restore();}
function drawLogo(x,y,w){ctx.drawImage(logo,x,y,w,w*logo.naturalHeight/logo.naturalWidth);}
function backdrop(t,revealed){
  ctx.fillStyle='#100d18';ctx.fillRect(0,0,W,H);
  const glow=ctx.createRadialGradient(770,1180,0,620,1000,1100);
  glow.addColorStop(0,revealed?'#4a27676b':'#34233e70');glow.addColorStop(1,'#100d1800');ctx.fillStyle=glow;ctx.fillRect(0,0,W,H);
  ctx.save();ctx.globalAlpha=.13;
  for(let i=0;i<3;i++){ctx.beginPath();ctx.ellipse(540,1020,540+i*180,750+i*180,-.34,0,Math.PI*2);ctx.strokeStyle='#9b72c5';ctx.lineWidth=1;ctx.stroke();}
  ctx.restore();
  rect(114,233,852,4,2,'#ffffff12');rect(114,233,Math.max(2,852*clamp(t/timeline.duration)),4,2,'#b380ff');
}
function quotation(t){
  const last=.15,e=ease((t-(timeline.revealStart-last))/last);
  ctx.save();ctx.translate(0,-18*e);ctx.globalAlpha=1-e*.5;
  const x=82,y=480,w=916,h=842;
  ctx.save();ctx.shadowColor='#00000066';ctx.shadowBlur=65;ctx.shadowOffsetY=24;rect(x,y,w,h,30,paper);ctx.restore();
  rect(x,y,9,h,4,'#a36ef2');
  circle(155,562,27,'#e7daf8');
  type('“',155,546,47,'#7546af',700,'center',80);
  type('без контекста',207,548,24,'#756b80',450);
  for(let i=0;i<3;i++)circle(908+i*12,563,3,'#9e96a4');
  segment(140,620,940,620,'#dfd8e3',2);
  const ys=[703,798,951,1046];
  const active=timeline.lines.findIndex(line=>t>=line.at && t<line.at+line.duration+.13);
  for(let i=0;i<4;i++){
    const selected=active===i;
    if(selected)rect(125,ys[i]-12,829,76,9,'#e9dcfb');
    type(timeline.lines[i].text,146,ys[i],45,selected?'#673495':ink,650,'left',795);
  }
  segment(142,1189,938,1189,'#dfd8e3',2);
  type('…',920,1220,30,'#96889e',450,'right');
  ctx.restore();
}
function playIcon(x,y){circle(x,y,48,violet);ctx.beginPath();ctx.moveTo(x-10,y-18);ctx.lineTo(x-10,y+18);ctx.lineTo(x+20,y);ctx.closePath();ctx.fillStyle='#fff';ctx.fill();}
function track(t){
  const local=t-timeline.revealStart,e=ease(local/.32);
  ctx.save();ctx.globalAlpha=e;ctx.translate(0,(1-e)*24);
  type('ДА, ЭТО',540,312,31,'#bf9bed',550,'center');
  type('СТРОКИ ИЗ ПЕСНИ',540,367,40,paper,700,'center',884);
  ctx.save();ctx.shadowColor='#0006';ctx.shadowBlur=70;ctx.shadowOffsetY=24;rect(130,513,820,1016,38,'#211c2c');ctx.restore();
  rect(130,513,820,1016,38,null,'#41344d');
  drawLogo(180,550,166);
  type('ТРЕК',884,570,18,'#a599b6',500,'right');
  roundedImage(placeholder,306,663,468,468,24);
  type('Азия — Евразия',540,1191,43,paper,650,'center',706);
  type('Агас',540,1268,31,'#b7a9c8',450,'center');
  rect(204,1351,672,4,2,'#4b405b');circle(205,1353,6,'#b78fff');
  segment(403,1411,403,1445,'#b5a7c7',3);
  ctx.beginPath();ctx.moveTo(433,1410);ctx.lineTo(407,1428);ctx.lineTo(433,1446);ctx.closePath();ctx.fillStyle='#b5a7c7';ctx.fill();
  playIcon(540,1428);
  segment(677,1411,677,1445,'#b5a7c7',3);
  ctx.beginPath();ctx.moveTo(647,1410);ctx.lineTo(673,1428);ctx.lineTo(647,1446);ctx.closePath();ctx.fillStyle='#b5a7c7';ctx.fill();
  const cta=ease((local-.7)/.3);ctx.globalAlpha=cta;
  type('Слушай в Bolt',540,1610,32,'#ece1ff',600,'center');
  ctx.restore();
}
window.renderFrame=t=>{
  t=Math.max(0,Math.min(timeline.duration-.001,t));ctx.setTransform(1,0,0,1,0,0);ctx.globalAlpha=1;
  backdrop(t,t>=timeline.revealStart);if(t<timeline.revealStart)quotation(t);else track(t);
};
window.ready=Promise.all([logo.decode(),placeholder.decode(),document.fonts.load('650 45px Unbounded','На горе стоит верблюд'),document.fonts.load('450 24px Unbounded','без контекста'),document.fonts.load('600 32px Unbounded','Слушай в Bolt')]).then(()=>window.renderFrame(0));
const button=document.getElementById('play'),seek=document.getElementById('seek'),clock=document.getElementById('time');
const narration=new Audio('narration.wav');let playing=false,base=0,start=0;
seek.max=timeline.duration-.0333;document.getElementById('spec').textContent=`${timeline.duration} с · 1080 × 1920 · 30 fps`;
function update(t){seek.value=t;clock.textContent=`${t.toFixed(1)} / ${timeline.duration.toFixed(1)}`;window.renderFrame(t);}
function tick(now){if(!playing)return;const t=(now-start)/1000;if(t>=timeline.duration){playing=false;base=0;narration.pause();button.textContent='Ещё раз';update(timeline.duration-.001);return;}update(t);requestAnimationFrame(tick);}
button.onclick=async()=>{await window.ready;if(playing){playing=false;base=Number(seek.value);narration.pause();button.textContent='Продолжить';}else{playing=true;start=performance.now()-base*1000;narration.currentTime=base;narration.play().catch(()=>{});button.textContent='Пауза';requestAnimationFrame(tick);}};
seek.oninput=()=>{playing=false;base=Number(seek.value);narration.pause();button.textContent='Продолжить';update(base);};
clock.textContent=`0.0 / ${timeline.duration.toFixed(1)}`;
