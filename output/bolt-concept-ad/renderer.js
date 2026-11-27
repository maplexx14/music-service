/* Deterministic Bolt interface film. Coordinates inside the UI panel are 800 × 760. */
const canvas=document.getElementById('film'),ctx=canvas.getContext('2d',{alpha:false});
const vertical=new URLSearchParams(location.search).get('format')==='tiktok';
const W=vertical?1080:1920,H=vertical?1920:1080,X=vertical?500:960,Y=vertical?920:540,DURATION=12.8;
canvas.width=W;canvas.height=H;
if(vertical){canvas.style.width='min(86vw,43vh)';canvas.style.aspectRatio='9/16';document.querySelector('nav a').href='bolt-motion-ru-tiktok.mp4'}
const clamp=x=>Math.max(0,Math.min(1,x)),out=x=>1-Math.pow(1-clamp(x),4),smooth=x=>{x=clamp(x);return x*x*(3-2*x)},mix=(a,b,p)=>a+(b-a)*p;
const C={white:'#f7f3ff',sub:'#aaa1b7',accent:'#9864ff',panel:'#141019',line:'#ffffff12',pink:'#ed6cae'};
const asset=name=>{const i=new Image();i.src='assets/'+name;return i};
const logo=asset('bolt.webp'),mark=asset('mark.png'),soad=asset('soad.jpg'),oingo=asset('only-a-lad.jpg'),defaultCover=asset('default-cover.webp');
function box(x,y,w,h,r,color,border){ctx.beginPath();ctx.roundRect(x,y,w,h,r);if(color){ctx.fillStyle=color;ctx.fill()}if(border){ctx.strokeStyle=border;ctx.lineWidth=1;ctx.stroke()}}
function text(s,x,y,size=24,color=C.white,weight=600,align='left'){ctx.font=`${weight} ${size}px Geologica`;ctx.fillStyle=color;ctx.textAlign=align;ctx.textBaseline='middle';ctx.fillText(s,x,y)}
function img(i,x,y,w,h=w,r=12){ctx.save();ctx.beginPath();ctx.roundRect(x,y,w,h,r);ctx.clip();ctx.drawImage(i,x,y,w,h);ctx.restore()}
function circle(x,y,r,color){ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fillStyle=color;ctx.fill()}
function line(x,y,a,b,color,width=2){ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(a,b);ctx.lineWidth=width;ctx.strokeStyle=color;ctx.lineCap='round';ctx.stroke()}
function heart(x,y,size,filled=false,color=C.white){ctx.save();ctx.translate(x,y);ctx.scale(size/24,size/24);ctx.beginPath();ctx.moveTo(0,8);ctx.bezierCurveTo(-17,-2,-12,-14,-3,-9);ctx.bezierCurveTo(-1,-8,0,-6,0,-6);ctx.bezierCurveTo(2,-12,12,-13,12,-4);ctx.bezierCurveTo(12,2,5,6,0,10);if(filled){ctx.fillStyle=color;ctx.fill()}else{ctx.strokeStyle=color;ctx.lineWidth=2.1;ctx.stroke()}ctx.restore()}
function check(x,y,size,color){line(x-size*.45,y,x-size*.1,y+size*.35,color,2.4);line(x-size*.1,y+size*.35,x+size*.5,y-size*.35,color,2.4)}
function background(t){ctx.fillStyle='#09080c';ctx.fillRect(0,0,W,H);const g=ctx.createRadialGradient(X-400+Math.sin(t*.25)*100,Y-250,20,X,Y,Math.max(W,H)*.75);g.addColorStop(0,'#58338230');g.addColorStop(.55,'#28153119');g.addColorStop(1,'#00000000');ctx.fillStyle=g;ctx.fillRect(0,0,W,H)}
function pill(x,y,w,label,active){box(x,y,w,45,23,active?C.accent:'#25202c',active?'#b892ff':'#ffffff0b');text(label,x+w/2,y+22.5,18,active?'#fff':C.sub,600,'center')}
function tile(x,y,title,subtitle,cover,favorite=false){box(x,y,338,105,15,'#211a29','#ffffff0a');if(favorite){const g=ctx.createLinearGradient(x,y,x+100,y+100);g.addColorStop(0,'#663bd2');g.addColorStop(1,'#c69ee3');box(x+8,y+8,89,89,11,g);heart(x+53,y+49,25,true)}else img(cover,x+8,y+8,89,89,11);text(title,x+115,y+40,22);text(subtitle,x+115,y+73,16,C.sub,400)}
const tracks=[{title:'I-E-A-I-A-I-O',artist:'System Of A Down',cover:soad},{title:'Little Girls',artist:'Oingo Boingo',cover:oingo},{title:'Innervision',artist:'System Of A Down',cover:soad}];
function equalizer(x,y,t){for(let i=0;i<4;i++){const h=7+13*(.5+.5*Math.sin(t*8+i*1.7));box(x+i*6,y-h/2,3,h,2,C.accent)}}
function row(y,track,index,t){const highlight=index===1&&t>2.8;box(45,y,710,90,15,highlight?'#282033':'#1c1722',highlight?'#ab7afc44':C.line);img(track.cover,58,y+12,66,66,11);text(track.title,143,y+32,23);text(track.artist,143,y+61,17,C.sub,400);if(index===0)equalizer(685,y+45,t);else{circle(707,y+45,17,'#ffffff09');ctx.beginPath();ctx.moveTo(703,y+37);ctx.lineTo(714,y+45);ctx.lineTo(703,y+53);ctx.closePath();ctx.fillStyle=C.sub;ctx.fill()}}
function library(){tile(45,207,'Понравившиеся','Твои любимые треки',null,true);tile(417,207,'Плейлисты','Музыка под настроение',soad);tile(45,332,'Новые открытия','Найди свой следующий трек',oingo);tile(417,332,'Скачанные','Всегда с тобой',defaultCover);text('Твоя медиатека',45,495,25);row(535,tracks[0],0,0);row(640,tracks[1],1,0)}
function flow(t){
 box(45,202,710,111,18,'#2d1b45','#a375ff33');img(mark,68,227,60,60,0);text('МОЙ ПОТОК',153,240,24);text('Музыка, подобранная для тебя',153,279,18,C.sub,400);equalizer(704,255,t);
 text('Для тебя',45,350,25);text('Обновляется под твой вкус',755,350,16,C.sub,400,'right');tracks.forEach((track,i)=>row(388+i*106,track,i,t));
}
function detail(t){const reveal=out((t-3.2)/.28);ctx.save();ctx.globalAlpha=reveal;ctx.translate(0,24*(1-reveal));
 box(45,202,710,490,20,'#21192c','#ac83ec33');text('ТВОЙ СЛЕДУЮЩИЙ ТРЕК',75,240,15,C.sub,600);
 img(oingo,75,278,170,170,16);text('Little Girls',277,311,34);text('Oingo Boingo',277,358,22,C.sub,400);text('Only A Lad · 1981',277,399,17,C.sub,400);
 const liked=t>=5.2,press=1-.07*Math.sin(clamp((t-5.17)/.14)*Math.PI),pop=1+.15*Math.sin(clamp((t-5.2)/.34)*Math.PI);
 ctx.save();ctx.translate(684,340);ctx.scale(press*pop,press*pop);circle(0,0,35,liked?C.accent:'#34273f');heart(0,-1,25,liked,liked?'#fff':C.sub);ctx.restore();
 const ripple=clamp((t-5.2)/.5);if(ripple>0&&ripple<1){ctx.save();ctx.globalAlpha=(1-ripple)*.5;ctx.strokeStyle=C.accent;ctx.lineWidth=2;ctx.beginPath();ctx.arc(684,340,36+ripple*29,0,Math.PI*2);ctx.stroke();ctx.restore()}
 text('Нашёл. Послушал. Сохранил.',75,493,24);text('Собирай музыку, к которой хочется вернуться.',75,538,17,C.sub,400);
 box(75,579,134,40,20,'#30233e');text('Твой вкус',142,599,16,'#c6a7f7',600,'center');box(224,579,82,40,20,'#30233e');text('Рок',265,599,16,'#c6a7f7',600,'center');
 if(liked){const p=out((t-5.2)/.2);ctx.save();ctx.globalAlpha=p;box(340,577+12*(1-p),385,44,12,'#322443','#a77aee33');check(365,599,15,C.accent);text('Добавлено в понравившиеся',390,599,16,C.white,500);ctx.restore()}
 ctx.restore();
}
function cursor(t){let x,y;
 if(t<1.4){const p=smooth((t-.55)/.65);x=mix(686,352,p);y=mix(563,139,p)}
 else if(t<3.4){const p=smooth((t-2.55)/.65);x=mix(352,707,p);y=mix(139,539,p)}
 else{const p=smooth((t-4.45)/.65);x=mix(707,684,p);y=mix(539,340,p)}
 const alpha=1-smooth((t-5.5)/.25),press=[1.2,3.2,5.2].reduce((n,at)=>n+.13*Math.sin(clamp((t-at+.05)/.14)*Math.PI),0);
 ctx.save();ctx.globalAlpha=alpha;ctx.translate(x+7,y+10);ctx.scale(1-press,1-press);ctx.shadowColor='#000a';ctx.shadowBlur=5;ctx.beginPath();ctx.moveTo(0,0);ctx.lineTo(0,29);ctx.lineTo(8,22);ctx.lineTo(13,34);ctx.lineTo(19,31);ctx.lineTo(14,19);ctx.lineTo(25,18);ctx.closePath();ctx.fillStyle='#fff';ctx.fill();ctx.strokeStyle='#17101f';ctx.lineWidth=1.3;ctx.stroke();ctx.restore();
}
function interfaceFilm(t){
 const enter=out(t/.5),leave=smooth((t-6.65)/.55),baseScale=vertical?1.03:1.17;
 let scale=baseScale,fx=400,fy=380;
 const zoom=smooth((t-2.3)/.7);scale=mix(scale,vertical?1.15:1.4,zoom);fy=mix(fy,425,zoom);
 const detailZoom=smooth((t-3.8)/.6);scale=mix(scale,vertical?1.02:1.17,detailZoom);fy=mix(fy,440,detailZoom);
 const close=smooth((t-4.5)/.6),back=smooth((t-5.7)/.65),focus=close*(1-back);scale=mix(scale,vertical?1.7:2.35,focus);fx=mix(fx,615,focus);fy=mix(fy,382,focus);
 ctx.save();ctx.globalAlpha=enter*(1-leave);ctx.translate(X-500*leave,Y+30*(1-enter));ctx.rotate((1-enter)*.025-leave*.035);ctx.scale(scale*(.97+.03*enter),scale*(.97+.03*enter));ctx.translate(-fx,-fy);
 ctx.shadowColor='#0009';ctx.shadowBlur=60;ctx.shadowOffsetY=20;box(0,0,800,760,28,C.panel);ctx.shadowBlur=0;ctx.shadowOffsetY=0;box(0,0,800,760,28,null,'#ffffff16');
 img(logo,44,37,135,50,0);text('Музыка в твоём ритме',755,60,17,C.sub,500,'right');
 const active=t>=1.2;
 pill(45,115,93,'Все',!active);pill(154,115,142,'Медиатека',false);pill(312,115,161,'Мой поток',active);line(45,182,755,182,C.line);
 const switchP=out((t-1.2)/.24);ctx.save();ctx.beginPath();ctx.rect(0,190,800,560);ctx.clip();
 if(switchP<1){ctx.save();ctx.globalAlpha*=1-switchP;ctx.translate(-45*switchP,0);library();ctx.restore()}
 if(switchP>0){ctx.save();ctx.globalAlpha*=switchP;ctx.translate(45*(1-switchP),0);flow(t);ctx.restore()}
 if(t>=3.2){box(0,190,800,570,0,'#141019');detail(t)}ctx.restore();cursor(t);ctx.restore();
}
function kinetic(lines,t,start,size=78,accent=-1){const p=out((t-start)/.28);ctx.save();ctx.globalAlpha=p;ctx.translate(0,(1-p)*28);lines.forEach((s,i)=>text(s,X,Y+(i-(lines.length-1)/2)*(size*1.35),size,i===accent?C.accent:C.white,500,'center'));ctx.restore()}
function endCard(t){const p=out((t-10.8)/.38);ctx.save();ctx.globalAlpha=p;const width=(vertical?700:600)*(.95+.05*p);img(logo,X-width/2,Y-width*logo.height/logo.width/2,width,width*logo.height/logo.width,0);ctx.restore();const at=out((t-11.2)/.3);ctx.save();ctx.globalAlpha=at;text('Музыка в твоём ритме.',X,Y+(vertical?235:185),vertical?46:45,C.sub,500,'center');ctx.restore()}
window.renderFrame=t=>{t=Math.max(0,Math.min(DURATION-1/60,t));background(t);if(t<7.2)interfaceFilm(t);else if(t<8.8)kinetic(vertical?['Открывай музыку,','которая подходит','тебе.']:['Открывай музыку, которая','подходит тебе.'],t,7.2,vertical?62:77,vertical?2:1);else if(t<9.6)kinetic(vertical?['Сохраняй','любимое.']:['Сохраняй любимое.'],t,8.8,vertical?79:83,vertical?1:0);else if(t<10.8)kinetic(vertical?['Без','ограничений.']:['Без ограничений.'],t,9.6,vertical?84:91,vertical?1:0);else endCard(t)};
window.ready=Promise.all([document.fonts.load('600 34px Geologica','Музыка в твоём ритме.'),document.fonts.load('700 83px Geologica','Без ограничений.'),document.fonts.load('500 77px Geologica','Открывай музыку'),document.fonts.load('600 34px Geologica','Little Girls'),... [logo,mark,soad,oingo,defaultCover].map(i=>i.decode())]).then(()=>window.renderFrame(0));
const play=document.getElementById('play'),seek=document.getElementById('seek'),time=document.getElementById('time'),sound=document.getElementById('sound');let running=false,start=0,at=0;seek.max=DURATION-1/60;
function display(t){window.renderFrame(t);seek.value=t;time.textContent=`${t.toFixed(1)} / ${DURATION.toFixed(1)}`}
function tick(now){if(!running)return;at=Math.min(DURATION-1/60,(now-start)/1000);display(at);if(at>=DURATION-1/60){running=false;play.textContent='Смотреть';sound.pause()}else requestAnimationFrame(tick)}
play.onclick=()=>{if(running){running=false;sound.pause();play.textContent='Смотреть';return}if(at>=DURATION-.02)at=0;running=true;start=performance.now()-at*1000;sound.currentTime=at;sound.play().catch(()=>{});play.textContent='Пауза';requestAnimationFrame(tick)};seek.oninput=()=>{at=Number(seek.value);start=performance.now()-at*1000;sound.currentTime=at;display(at)};
