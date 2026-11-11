/* Deterministic canvas timeline. Coordinates are in 1080 × 1920 pixels. */
const canvas = document.getElementById('film');
const ctx = canvas.getContext('2d', { alpha: false });
const W = 1080, H = 1920;
const clamp = v => Math.max(0, Math.min(1, v));
const out = v => 1 - Math.pow(1 - clamp(v), 3);
const smooth = v => { v = clamp(v); return v * v * (3 - 2 * v); };
const C = { white: '#fffaf6', pink: '#ff2fa0', violet: '#a259ff', cyan: '#22e4ff', ink: '#160b29' };
const logo = new Image(), cover = new Image();
logo.src = 'assets/bolt.png';
cover.src = 'assets/only-a-lad.jpg';

function round(x, y, w, h, r, color, stroke) {
  ctx.beginPath(); ctx.roundRect(x, y, w, h, r);
  if (color) { ctx.fillStyle = color; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 2; ctx.stroke(); }
}
function text(str, x, y, size = 32, color = C.white, weight = 500, align = 'left') {
  ctx.font = `${weight} ${size}px Unbounded, sans-serif`;
  ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'top';
  ctx.fillText(str, x, y);
}
function circle(x, y, r, color) {
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
}
function line(x1, y1, x2, y2, color, width = 2) {
  ctx.beginPath();ctx.moveTo(x1, y1);ctx.lineTo(x2, y2);ctx.strokeStyle = color;ctx.lineWidth = width;ctx.lineCap='round';ctx.stroke();
}
function arrow(x, y, size, color, diagonal = false) {
  ctx.save();ctx.translate(x,y);if(diagonal)ctx.rotate(-Math.PI/4);
  line(-size/2,0,size/2,0,color,5);line(size/2,0,size/2-size*.38,-size*.38,color,5);line(size/2,0,size/2-size*.38,size*.38,color,5);ctx.restore();
}
function spark(x,y,r,t,color) {
  ctx.save();ctx.translate(x,y);ctx.rotate(t);ctx.fillStyle=color;ctx.beginPath();
  for(let i=0;i<8;i++){let a=i*Math.PI/4;let d=i%2?r*.22:r;let px=Math.cos(a)*d,py=Math.sin(a)*d;i?ctx.lineTo(px,py):ctx.moveTo(px,py);}
  ctx.closePath();ctx.fill();ctx.restore();
}
function imageRound(img,x,y,w,h,r) {
  ctx.save();ctx.beginPath();ctx.roundRect(x,y,w,h,r);ctx.clip();ctx.drawImage(img,x,y,w,h);ctx.restore();
}
function background(t, scene) {
  const g=ctx.createLinearGradient(0,0,W,H);g.addColorStop(0,'#331064');g.addColorStop(.48,'#6224a6');g.addColorStop(1,'#250b4c');ctx.fillStyle=g;ctx.fillRect(0,0,W,H);
  const glow=ctx.createRadialGradient(180+70*Math.sin(t*.3),600,0,350,650,1100);glow.addColorStop(0,'#a34edc65');glow.addColorStop(1,'#a34edc00');ctx.fillStyle=glow;ctx.fillRect(0,0,W,H);
  ctx.save();ctx.globalAlpha=.15;
  for(let y=0;y<H;y+=22)for(let x=0;x<W;x+=22){circle(x,y,1.3,'#f5cbff');}
  ctx.restore();
  ctx.save();ctx.globalAlpha=.14;ctx.strokeStyle='#c795ff';ctx.lineWidth=2;
  ctx.beginPath();ctx.ellipse(550,980,700,240,-.65+t*.016,0,Math.PI*2);ctx.stroke();
  ctx.beginPath();ctx.ellipse(550,980,900,370,-.65+t*.016,0,Math.PI*2);ctx.stroke();ctx.restore();
  spark(936,340,48,t*.1,C.cyan);spark(124,1460,35,-t*.12,C.pink);
  // Visual progress is always inside the social-video safe area.
  const widths=[3.5,4.9,3.6],starts=[0,3.5,8.4];
  for(let i=0;i<3;i++){round(120+i*281,215,262,5,3,'#ffffff30');const progress=clamp((t-starts[i])/widths[i]);if(progress>0)round(120+i*281,215,262*progress,5,3,C.white);}
}
function forum(t) {
  text('МУЗЫКАЛЬНЫЙ ТРЕД',540,362,26,'#e8d4ff',500,'center');
  const zoom=1+.014*smooth(t/3.4);
  ctx.save();ctx.translate(530,855);ctx.scale(zoom,zoom);ctx.rotate(-.013);ctx.translate(-530,-855);
  round(119,502,840,720,30,C.pink);round(108,492,840,720,30,C.ink);round(100,480,840,720,30,'#fffaf6');
  circle(164,549,28,'#f56a36');text('?',164,527,34,'#fff',700,'center');
  text('вопрос к меломанам',212,522,24,'#22112f',600);
  text('обсуждение музыки',212,561,18,'#948c99',400);
  for(let i=0;i<3;i++)circle(867+i*11,548,3,'#938a98');
  line(146,612,894,612,'#e8e1e7');
  text('Как эту песню',148,660,58,'#20112f',750);
  text('вообще',148,756,64,'#20112f',750);
  const hl=out((t-.45)/.45);round(137,849,734*hl,95,6,'#eee0ff');
  text('выпустили?',148,853,64,'#762bc2',750);
  text('Открыл перевод.',148,996,27,'#6a606f',400);
  text('Теперь есть вопросы.',148,1039,27,'#6a606f',400);
  round(146,1132,27,20,5,null,'#8a7c94');line(152,1152,151,1159,'#8a7c94');text('обсудить',188,1130,19,'#8a7c94',400);
  arrow(865,1145,26,'#8a7c94');
  ctx.restore();
  const a=out((t-1.6)/.3);ctx.save();ctx.globalAlpha=a;text('Сейчас покажу трек',540,1321+(1-a)*15,28,'#f3dfff',400,'center');ctx.restore();
  if(t>3.27){const p=smooth((t-3.27)/.23);ctx.fillStyle=C.pink;ctx.fillRect(-W+W*p,0,W,H);ctx.fillStyle=C.ink;ctx.fillRect(-W-48+W*p,0,W,H);}
}
function reveal(t) {
  const local=t-3.5, e=out(local/.42);
  ctx.save();ctx.globalAlpha=.08;text('OINGO',-25,520,197,C.white,800);text('BOINGO',-32,760,169,C.white,800);ctx.restore();
  text('ДА, ЭТО ПЕСНЯ.',540,337,41,C.white,750,'center');
  ctx.save();ctx.translate(540,792+(1-e)*80);ctx.scale(.94+.06*e,.94+.06*e);ctx.rotate(-.018*(1-e));
  round(-320+15,-320+17,640,640,22,C.pink);round(-320+7,-320+8,640,640,22,C.ink);
  imageRound(cover,-320,-320,640,640,22);
  ctx.restore();
  round(708,1035,126,48,24,C.white);text('1981',771,1047,21,C.ink,700,'center');
  text('Little Girls',540,1174,65,C.cyan,750,'center');
  text('Little Girls',544,1172,65,C.pink,750,'center');
  text('Little Girls',542,1170,65,C.white,750,'center');
  text('Oingo Boingo',540,1271,35,C.white,500,'center');
  text('Only A Lad',540,1337,23,'#dfc0ef',400,'center');
  if(local>2.9){const e2=out((local-2.9)/.3);ctx.save();ctx.globalAlpha=e2;round(337,1442+(1-e2)*12,406,64,32,'#210b3c80','#d5a0fc50');text('Нашёлся в Bolt',540,1461+(1-e2)*12,23,'#f4deff',500,'center');ctx.restore();}
  if(t>8.18){let p=smooth((t-8.18)/.22);ctx.fillStyle=C.cyan;ctx.fillRect(0,H-H*p,W,H);ctx.fillStyle=C.ink;ctx.fillRect(0,H-H*p+40,W,H);}
}
function ending(t) {
  const local=t-8.4,e=out(local/.4);
  ctx.save();ctx.globalAlpha=.38;const g=ctx.createRadialGradient(540,780,50,540,780,680);g.addColorStop(0,'#af50ff');g.addColorStop(1,'#af50ff00');ctx.fillStyle=g;ctx.fillRect(0,0,W,H);ctx.restore();
  ctx.save();ctx.translate(0,(1-e)*32);
  text('Слушай в',540,442,49,C.white,650,'center');
  const logoW=646,logoH=logoW*logo.naturalHeight/logo.naturalWidth;
  ctx.drawImage(logo,540-logoW/2,544,logoW,logoH);
  round(140+9,887+11,800,206,26,C.pink);round(140,887,800,206,26,'#1b0e2e','#bd80f877');
  imageRound(cover,164,911,158,158,14);
  text('Little Girls',351,931,34,C.white,650);text('Oingo Boingo',351,991,24,'#c9acd9',400);
  circle(860,990,43,C.violet);ctx.beginPath();ctx.moveTo(850,971);ctx.lineTo(850,1009);ctx.lineTo(879,990);ctx.closePath();ctx.fillStyle=C.white;ctx.fill();
  const b=1+.012*Math.sin(Math.PI*clamp((local-.6)/.6));
  ctx.save();ctx.translate(540,1248);ctx.scale(b,b);
  round(-382+11,-52+13,764,104,18,C.pink);round(-382+5,-52+6,764,104,18,C.ink);round(-382,-52,764,104,18,C.white);
  text('ССЫЛКА В ПРОФИЛЕ',-337,-17,30,C.ink,650);arrow(324,1,42,C.ink,true);ctx.restore();
  text('Твоя следующая находка — здесь.',540,1394,23,'#e6c9f7',400,'center');ctx.restore();
  spark(907,822,36,.2+local*.13,C.cyan);
}
window.renderFrame = function(t) {
  t=Math.min(11.999,Math.max(0,t));ctx.setTransform(1,0,0,1,0,0);ctx.globalAlpha=1;
  background(t,t<3.5?0:t<8.4?1:2);
  if(t<3.5)forum(t);else if(t<8.4)reveal(t);else ending(t);
};
window.ready = Promise.all([
  logo.decode(),cover.decode(),document.fonts.load('750 64px Unbounded','Как эту песню'),document.fonts.load('650 34px Unbounded','Little Girls'),document.fonts.load('400 24px Unbounded','Теперь есть вопросы')
]).then(()=>{window.renderFrame(0);});
let playing=false, started=0, pausedAt=0;
const button=document.getElementById('play'),seek=document.getElementById('seek'),time=document.getElementById('time');
function showTime(t){seek.value=t;time.textContent=`${t.toFixed(1)} / 12.0`;}
function tick(now){if(!playing)return;let t=(now-started)/1000;if(t>=12){playing=false;pausedAt=0;button.textContent='Ещё раз';return;}window.renderFrame(t);showTime(t);requestAnimationFrame(tick);}
button.onclick=async()=>{await window.ready;if(playing){playing=false;pausedAt=Number(seek.value);button.textContent='Продолжить';}else{playing=true;started=performance.now()-pausedAt*1000;button.textContent='Пауза';requestAnimationFrame(tick);}};
seek.oninput=()=>{playing=false;pausedAt=Number(seek.value);button.textContent='Продолжить';window.renderFrame(pausedAt);showTime(pausedAt);};
